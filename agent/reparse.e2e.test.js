/**
 * End-to-end: 采集字段落库，改一次适配器能重跑全历史（issue #27）。
 * Run with: node agent/reparse.e2e.test.js
 *
 * 适配器会因为站点改版而失效（parse 的正则抠不出编号）。用户把适配器文件修好后，
 * **历史记录必须能被重新解析**——否则每修一次只有新访问受益。
 *
 * 这要求页面那一次的采集结果留在库里：`records.pageSignature`（页面签名）与
 * `records.pageFields`（各适配器 collect 的字段）。`parse` 因此是已存字段的纯函数，
 * `WorkStore.reparseWorks()` 清空派生结果、拿存下来的字段把全历史重跑一遍，
 * 走的是与实时上报同一条 `identityKeysFor → recordWorkVisit` 通道（docs/adr/0002）。
 *
 * 这里用**临时库文件**而不是内存库：修适配器 = 改 `adapters/*.json` 再重启，
 * 所以要真的重开一次库，第二次 init 读到的是修好的适配器。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { RecordStore } = require("./record-store");
const { identityKeysFor } = require("./cluster");

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-reparse-"));
let dbSeq = 0;
const freshDbPath = () => path.join(tmpDir, `tracker-${dbSeq++}.db`);

// 用户写的适配器：认 `var demo=` 的页面签名，collect 出版本与海报。
// parse 才是会失效的那一半——站点改版后，同一个正则抠不出编号了。
const adapterWithRegex = (regex) => ({
  name: "演示平台",
  file: "demo.json",
  detect: { pageGlobal: "demo" },
  collect: [
    { field: "keywords", selector: "meta[name='keywords']", attr: "content" },
    { field: "poster", selector: "img[data-original]", attr: "data-original" },
  ],
  parse: { code: { from: ["keywords", "url", "title"], regex } },
});

const WATCHLIST = [{ domain: "demo.example", label: "演示站", color: "#fff" }];

const PAGE_FIELDS = {
  "demo.json": {
    keywords: "ABC-123 某剧",
    poster: "https://img.demo.example/upload/vod/x.webp",
  },
};

function pageSignatureVisit(over = {}) {
  return {
    id: "v1",
    url: "https://demo.example/w/ABC-123",
    title: "某剧 第1集",
    domain: "demo.example",
    matchedRule: "demo.example",
    tabId: 1,
    timestamp: DAY1,
    pageSignature: ["demo"],
    pageFields: PAGE_FIELDS,
    ...over,
  };
}

async function openStore(dbPath, adapters) {
  const store = new RecordStore(dbPath, () => {}, { adapters });
  await store.init();
  store.updateWatchlist(WATCHLIST);
  return store;
}

/** 落盘：模拟扩展上报后应用退出，下一次启动从文件读回。 */
function flush(store, dbPath) {
  fs.writeFileSync(dbPath, Buffer.from(store.export()));
}

/**
 * 重跑是整块重建，作品代理键（uuid）会换新的，所以幂等不能比字节。
 * 语义快照 = 作品的分组与分数 + 每条访问归到哪一组 + 身份键 + 原始字段。
 */
function semanticSnapshot(store) {
  const keysByWork = {};
  for (const k of store._dbAll("SELECT workId, kind, value FROM work_keys")) {
    (keysByWork[k.workId] ||= []).push(`${k.kind}:${k.value}`);
  }
  const sig = (workId) => (keysByWork[workId] || []).sort().join("|");
  return JSON.stringify({
    works: store
      ._dbAll("SELECT id, score FROM works")
      .map((w) => `${sig(w.id)}#${w.score}`)
      .sort(),
    records: store
      ._dbAll("SELECT id, workId, edition, pageSignature, pageFields FROM records ORDER BY id")
      .map((r) => `${r.id}:${r.workId ? sig(r.workId) : "null"}:${r.edition}:${r.pageSignature}:${r.pageFields}`),
    keys: store._dbAll("SELECT kind, value FROM work_keys ORDER BY kind, value"),
    ambiguities: store._dbAll("SELECT kind, value FROM work_ambiguities ORDER BY kind, value"),
  });
}

async function runTests() {
  console.log("\n── 采集字段落库 + 重新解析 end-to-end ──\n");

  // ── ① 失效的适配器：访问照常入库、降级未归属，采集结果随访问落库 ──
  console.log("① 失效的适配器：降级，不丢弃");
  const dbPath = freshDbPath();
  const broken = await openStore(dbPath, [adapterWithRegex("编号：(?<code>[A-Z]+-\\d+)")]);
  const visit = broken.recordVisit(pageSignatureVisit());
  assert(visit.action === "insert", "访问照常落库");
  assert(visit.work === null && visit.record.workId === null, "parse 抠不出编号 → 归不到作品");
  assert(broken.getUnattributedCount() === 1, "它在未归属列表里可见");

  const stored = broken.getRecordById("v1");
  assert(
    JSON.parse(stored.pageSignature).includes("demo"),
    "页面签名随访问落库（认平台靠它，不靠域名）",
  );
  const storedFields = JSON.parse(stored.pageFields);
  assert(
    storedFields["demo.json"] && storedFields["demo.json"].keywords === "ABC-123 某剧",
    "各适配器 collect 抽到的字段随访问落库",
  );
  flush(broken, dbPath);

  // ── ② 修好适配器（改 JSON、重启）→ 显式重新解析 → 历史访问归属 ──
  console.log("\n② 修好适配器后重新解析");
  const fixedAdapters = [adapterWithRegex("(?<code>[A-Z]+-\\d+)")];
  const repaired = await openStore(dbPath, fixedAdapters);
  const r = repaired.reparseWorks();
  assert(r.before === 1, "重新解析面对的是全部已有访问");
  assert(r.remaining === 0 && r.assigned === 1, "那条历史访问被重新解释并归属");
  const fixed = repaired.getRecordById("v1");
  assert(fixed.workId !== null, "修好的适配器改善了历史访问的归属");
  assert(
    repaired.getWorkKeys(fixed.workId).some((k) => k.kind === "code" && k.value === "ABC-123"),
    "归属靠修好后 parse 出的内容编号",
  );
  assert(
    JSON.parse(fixed.pageFields)["demo.json"].keywords === "ABC-123 某剧",
    "重跑没有动存的原始字段",
  );

  // ── ③ 重新解析与实时解析共用同一段代码 ──
  console.log("\n③ 与实时解析同源");
  const live = identityKeysFor(pageSignatureVisit(), WATCHLIST, undefined, fixedAdapters).keys;
  const storedKeys = repaired.getWorkKeys(fixed.workId).map((k) => `${k.kind}:${k.value}`);
  assert(live.length > 0, "实时路径产出了身份键");
  assert(
    live.every((k) => storedKeys.includes(`${k.kind}:${k.value}`)),
    "重跑落库的键包含实时路径的每一个键（同一套代码，没有第二份实现）",
  );

  // ── ④ 全历史：已经归属过的访问也按当前适配器重算 ──
  console.log("\n④ 全历史重算");
  const dbB = freshDbPath();
  const v1 = [adapterWithRegex("(?<code>\\d+)")]; // 旧正则抠出的是站内数字 id，指错了编号
  const old = await openStore(dbB, v1);
  const before = old.recordVisit(pageSignatureVisit({ id: "old" }));
  assert(before.work !== null, "旧适配器把访问归到了（错误的）编号上");
  const oldWorkId = before.work.id;
  assert(
    old.getWorkKeys(oldWorkId).some((k) => k.kind === "code" && k.value === "123"),
    "旧编号是站内 id",
  );
  flush(old, dbB);

  const redone = await openStore(dbB, fixedAdapters);
  redone.reparseWorks();
  const moved = redone.getRecordById("old");
  assert(moved.workId !== oldWorkId, "已归属的访问也被重算，换了作品");
  assert(
    redone.getWorkKeys(moved.workId).some((k) => k.kind === "code" && k.value === "ABC-123"),
    "归属换成修正后的内容编号",
  );
  assert(
    redone._dbAll("SELECT id FROM works").length === 1,
    "旧作品没有留下孤儿（重跑清空派生结果后重建）",
  );

  // ── ⑤ 重跑不动作品分数 ──
  console.log("\n⑤ 重跑不动作品分数");
  const dbC = freshDbPath();
  const scoredStore = await openStore(dbC, fixedAdapters);
  for (const [n, ts] of [[1, DAY1], [2, DAY2], [3, DAY3]]) {
    scoredStore.recordVisit(
      pageSignatureVisit({ id: `d${n}`, url: `https://demo.example/w/ABC-123?p=${n}`, timestamp: ts }),
    );
  }
  const scored = scoredStore._dbAll("SELECT score FROM works");
  assert(scored.length === 1 && scored[0].score === 3, "三天三次访问 = 3 分");
  scoredStore.reparseWorks();
  const rescored = scoredStore._dbAll("SELECT score FROM works");
  assert(rescored.length === 1 && rescored[0].score === 3, "重跑按访问时间重建，分数不变");

  // ── ⑥ 幂等：再重跑一次，分组、分数、身份键与原始字段都不变 ──
  console.log("\n⑥ 幂等");
  const snap = semanticSnapshot(scoredStore);
  const again = scoredStore.reparseWorks();
  assert(again.before === 3 && again.assigned === 3, "第二次重跑照样处理全部访问");
  assert(semanticSnapshot(scoredStore) === snap, "分组 / 分数 / 身份键 / 原始字段一个也没变");

  // ── ⑦ 旧访问（没有页面签名）照常按站点规则解析，一端历史不少 ──
  console.log("\n⑦ 没有页面签名的旧访问");
  const dbD = freshDbPath();
  const legacyStore = await openStore(dbD, fixedAdapters);
  legacyStore.addWatchlist({
    domain: "legacy.example",
    label: "旧站",
    color: "#fff",
    regexFilter: "/w/(?<code>[A-Z]+-\\d+)",
    regexTarget: "url",
  });
  legacyStore.insertRecord({
    id: "legacy",
    url: "https://legacy.example/w/LEG-9",
    title: "认不出的旧标题",
    domain: "legacy.example",
    matchedRule: "legacy.example",
    tabId: 2,
    timestamp: DAY1,
    workId: null,
  });
  assert(
    legacyStore.getRecordById("legacy").pageSignature === "[]",
    "没有页面签名的旧行默认是空签名",
  );
  legacyStore.reparseWorks();
  const legacy = legacyStore.getRecordById("legacy");
  assert(legacy.workId !== null, "旧访问照常靠站点规则归属，不因缺页面数据而丢");
  assert(
    legacyStore.getWorkKeys(legacy.workId).some((k) => k.kind === "code" && k.value === "LEG-9"),
    "归属键来自站点规则的命名捕获组",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
