/**
 * End-to-end test: 一条访问从捕获到归入作品，走完整管线。
 * Run with: node agent/works.e2e.test.js
 *
 * 用本轮实测的真实数据（docs/adr/0007、docs/adr/0008）：
 *   A = aiqiyi.ai /voddetail/237486.html      MacCMS 站，有内容编号（站内 id）与封面哈希
 *   B = tvmao.com  /kanju/YmFfZmsg           元数据站，没有封面，只有文本
 *   用户标注：这两条是同一部《无可替代》
 *
 * 这个测试回答的是整个产品的第一个可观测问题：
 *   两个站上的同一部作品，会不会被归成一条、分数会不会累加。
 *
 * 上报走的是真正的那一条通道（RecordStore.recordVisit），不是测试自己拼的
 * 「抽键 → 归属 → 落库」——拼出来的顺序与生产不一样过一次（每次都当新访问插入），
 * 而那种差异只有在这里才看得出来。
 */

const { RecordStore } = require("./record-store");

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

const {
  AIQIYI,
  TVMAO,
  WATCHLIST,
} = require("./annotated-pair.fixture");

async function runTests() {
  console.log("\n── works end-to-end ──\n");

  const store = new RecordStore(":memory:", () => {});
  await store.init();
  // 适配器来自 store（写入路径只读它一份），不再由测试单独拿着一份
  store.updateWatchlist(WATCHLIST);

  const day1 = new Date(2026, 2, 1, 10).getTime();
  const day2 = new Date(2026, 2, 2, 10).getTime();

  // 一次调用走完整条链路：闸门 → 身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库
  function visit(page, ts) {
    return store.recordVisit({
      ...page,
      id: page.id || `r-${page.domain}-${ts}`,
      timestamp: ts,
    });
  }

  // ── ① A 站第 1 天 ──
  console.log("① A 站（aiqiyi，MacCMS）第 1 天");
  const a = visit(AIQIYI, day1);
  assert(a.action === "insert", "作品页落库");
  assert(a.extracted.siteId === "237486", "命名捕获组抠出了站内 id");
  assert(!!a.work, "归入了一部作品");
  assert(a.work.score === 1, "作品分数为 1");
  assert(
    a.keys.some((k) => k.kind === "cover_hash"),
    "产出了封面哈希键",
  );

  // ── ② A 站同一天再回一次（另一个标签页） ──
  console.log("\n② A 站同一天再回一次");
  const a2 = visit({ ...AIQIYI, tabId: 3 }, day1 + 3600e3);
  assert(a2.action === "update", "同组同路径的再次来访是同一次访问，不是新的一条");
  assert(a2.work.id === a.work.id, "归到同一条作品");
  assert(a2.work.score === 1, "同一天不加分");

  // ── ③ B 站第 2 天（元数据站，无封面，无编号） ──
  console.log("\n③ B 站（tvmao，元数据站）第 2 天");
  const b = visit(TVMAO, day2);
  assert(b.action === "insert", "元数据站的作品页落库");
  assert(Object.keys(b.extracted).length === 0, "闸门规则抽不出任何字段（预期）");
  assert(!b.keys.some((k) => k.confidence === "high"), "没有任何高可信度键");
  assert(!!b.work, "仍然归入了一部作品（靠文本指纹）");

  // ── ④ 这就是本轮要证明的事 ──
  console.log("\n④ 结果");
  assert(b.work.id === a.work.id, "✅ 两个站的同一部作品被归成一条");
  assert(b.work.score === 2, "✅ 跨站跨天累加：分数为 2");

  const keys = store.getWorkKeys(a.work.id);
  assert(
    keys.some((k) => k.kind === "cover_hash"),
    "作品下挂着 A 站的封面哈希",
  );
  assert(
    keys.some((k) => k.kind === "synopsis"),
    "作品下挂着两站共用的简介指纹",
  );
  assert(
    keys.some((k) => k.kind === "title"),
    "归一化标题键也入库了（不参与合并，留给待确认队列）",
  );

  const recs = store._dbAll("SELECT id, workId FROM records");
  assert(
    recs.length === 2,
    "两个站各一条访问：A 站的两回来访是同一条的更新，不是新的一条",
  );
  assert(
    recs.every((r) => r.workId === a.work.id),
    "两条访问都挂到了同一条作品上",
  );

  // ── ⑤ 降级验证：完全认不出的访问不丢 ──
  console.log("\n⑤ 降级：认不出作品时历史不丢");
  const orphan = visit(
    {
      url: "https://unknown.example.com/v/9",
      title: "未知页",
      description: "",
      ogImage: "",
      domain: "unknown.example.com",
      matchedRule: "unknown.example.com",
      tabId: 9,
    },
    day2 + 3600e3,
  );
  assert(
    orphan.action === "insert",
    "没有适配器规则的域名不会被闸门丢弃（域名过滤在扩展那一层）",
  );
  assert(orphan.work === null, "也归不到作品——这是降级路径");
  assert(
    store.getRecordById(`r-unknown.example.com-${day2 + 3600e3}`) !== null,
    "记录照样入库，历史一条不少",
  );
  // 登记过、但没有闸门规则也没有捕获组的站点：照常插入，只是归不到作品
  store.addWatchlist({ domain: "unknown.example.com", label: "未知", color: "#fff" });
  const deg = visit(
    {
      id: "orphan-1",
      url: "https://unknown.example.com/v/10",
      title: "",
      description: "",
      ogImage: "",
      domain: "unknown.example.com",
      matchedRule: "unknown.example.com",
      tabId: 9,
    },
    day2,
  );
  assert(deg.action === "insert", "无规则时照常插入");
  assert(deg.work === null, "归不到作品");
  assert(
    store.getRecordById("orphan-1") !== null,
    "记录仍然存在——降级而非丢弃",
  );

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
