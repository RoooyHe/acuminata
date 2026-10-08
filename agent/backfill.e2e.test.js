/**
 * End-to-end test: 历史回填（issue #6）。
 * Run with: node agent/backfill.e2e.test.js
 *
 * 升级之前写入的 records 里 workId 全为空。回填要把这些已有访问归入作品，
 * 而且必须：幂等、复用实时的身份解析与归属路径、跨站配对结果与实时一致。
 *
 * 数据集沿用 works.e2e.test.js 的已标注跨站配对（agent/annotated-pair.fixture.js），
 * 只是把它当作「升级前就已经躺在库里的历史」直接插入，workId 为 null。
 */

const { RecordStore } = require("./record-store");
const { identityKeysFor } = require("./cluster");
const { AIQIYI, TVMAO, WATCHLIST } = require("./annotated-pair.fixture");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const DAY1 = new Date(2026, 2, 1, 10).getTime();
const DAY2 = new Date(2026, 2, 2, 10).getTime();
const DAY3 = new Date(2026, 2, 3, 10).getTime();

// 升级前的写入路径：只有访问事件，没有作品归属。
function seedLegacy(store) {
  const rows = [
    ["legacy-a1", AIQIYI, DAY1],
    ["legacy-a2", AIQIYI, DAY2],
    ["legacy-b1", TVMAO, DAY3],
  ];
  for (const [id, page, ts] of rows) {
    store.insertRecord({ ...page, id, timestamp: ts, workId: null });
  }
}

function snapshot(store) {
  return {
    works: store._dbAll("SELECT * FROM works ORDER BY id"),
    records: store._dbAll("SELECT id, workId FROM records ORDER BY id"),
    keys: store._dbAll("SELECT workId, kind, value FROM work_keys ORDER BY kind, value"),
  };
}

async function runTests() {
  console.log("\n── 历史回填 end-to-end ──\n");

  const store = new RecordStore(":memory:", () => {});
  await store.init();
  seedLegacy(store);

  // ── ① 回填前：历史躺在库里，但一条都没归属 ──
  console.log("① 回填前的状态");
  assert(store.countUnassignedRecords() === 3, "3 条历史访问全部未归属");
  const empty = store.getWorksPage(1, 50);
  assert(empty.total === 0, "作品列表是空的——界面上还看不到跨站融合");

  // ── ② 回填 ──
  console.log("\n② 回填");
  const progress = [];
  const r = store.backfillWorks({ batchSize: 2, onProgress: (p) => progress.push(p) });
  assert(r.before === 3, "报告回填前的未归属数：3");
  assert(r.remaining === 0, "报告回填后的未归属数：0");
  assert(r.assigned === 3, "3 条访问被归入作品");
  assert(r.created === 1, "只新建了 1 部作品");
  assert(progress.length === 2, "进度分了 2 批上报（不是静默跑）");
  assert(
    progress[0].processed + progress[0].remaining === 3,
    "第一批进度自洽：已处理 + 剩余 = 总数",
  );

  // ── ③ 结果：两个站的历史归成一条 ──
  console.log("\n③ 回填结果：跨站融合");
  const works = store._dbAll("SELECT * FROM works");
  assert(works.length === 1, "两个站的同一部作品归成 1 条");
  const work = works[0];
  assert(work.score === 3, "三天各计一次：分数为 3");
  assert(
    store._dbAll("SELECT id FROM records WHERE workId IS NULL").length === 0,
    "没有访问还留在未归属状态",
  );

  const page = store.getWorksPage(1, 50);
  assert(page.total === 1, "作品列表里能看到它");
  const row = page.works[0];
  assert(row.visitCount === 3, "聚合出 3 次访问");
  assert(row.sourceCount === 2, "聚合出 2 个来源");
  assert((row.sites || []).length === 2, "站点集合包含两个站");
  assert(row.lastVisitAt === DAY3, "最近访问时间取最新那条");

  // ── ④ 复用实时路径：身份键与实时上报算出来的完全一致 ──
  console.log("\n④ 身份解析与实时上报同源");
  const live = identityKeysFor(AIQIYI, WATCHLIST).keys;
  const stored = store
    ._dbAll("SELECT kind, value FROM work_keys WHERE workId = ?", [work.id])
    .map((k) => `${k.kind}:${k.value}`);
  assert(live.length > 0, "实时路径用夹具产出了身份键");
  assert(
    live.every((k) => stored.includes(`${k.kind}:${k.value}`)),
    "回填落库的身份键包含了实时路径的每一个键（同一套代码，没有第二份实现）",
  );
  assert(
    stored.some((k) => k.startsWith("cover_hash:")),
    "A 站的封面哈希也在作品键里",
  );
  assert(
    stored.some((k) => k.startsWith("synopsis:")),
    "两站共用的简介指纹也在作品键里",
  );

  // ── ⑤ 幂等：重跑不改归属、不重复建作品 ──
  console.log("\n⑤ 重跑回填");
  const before2 = snapshot(store);
  const r2 = store.backfillWorks();
  assert(r2.before === 0, "重跑时没有未归属的访问");
  assert(r2.assigned === 0 && r2.created === 0, "重跑什么也没做");
  assert(
    JSON.stringify(snapshot(store)) === JSON.stringify(before2),
    "works / records.workId / work_keys 一个字节都没变",
  );

  // ── ⑥ 中途失败：再跑一次补齐，不产生重复或损坏 ──
  // 回填逐条落库，而且 recordWorkVisit（写 works/work_keys）与写回 records.workId
  // 在同一个同步回合里完成——中途没有 await，DB 又是整块 buffer 导出。
  // 所以「跑一半退出」在磁盘上只能是「某个同步回合之前的完整快照」：
  // 要么作品和记录的归属都在，要么都不在，不存在半写。这里用进度回调抛错
  // 制造那一刻的状态，再重跑。重复建作品或改归属都会被抓出来。
  console.log("\n⑥ 中途失败后重跑");
  const store2 = new RecordStore(":memory:", () => {});
  await store2.init();
  seedLegacy(store2);
  let threw = false;
  try {
    store2.backfillWorks({
      batchSize: 2,
      onProgress: () => {
        throw new Error("模拟中途退出");
      },
    });
  } catch (e) {
    threw = true;
  }
  assert(threw, "回填在中途真的中断了");
  const partial = store2.countUnassignedRecords();
  assert(partial === 1, "中断处留下一批已处理、一批未处理");

  const r3 = store2.backfillWorks();
  assert(r3.remaining === 0, "重跑补齐了剩下的访问");
  assert(r3.assigned === partial, "只补了剩下的，没有重复处理");
  const works2 = store2._dbAll("SELECT * FROM works");
  assert(works2.length === 1, "重跑没有重复建作品");
  assert(works2[0].score === 3, "分数仍然是 3，没有被重复计分");

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
