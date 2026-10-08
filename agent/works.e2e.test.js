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
 */

const { RecordStore } = require("./record-store");
const { evaluateIncoming } = require("./cluster");

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

// ── 真实抓到的字段 ────────────────────────────────────────────────────────────
const AIQIYI = {
  url: "https://www.aiqiyi.ai/voddetail/237486.html",
  title:
    "《无可替代》高清在线观看 - 国产剧 - 爱奇艺|在线视频网站-海量正版高清视频在线观看",
  description:
    "《无可替代》讲述的是：讲述禀承“这一生绝对不能被别人替代”理念的女白领徐迟，在职场上过关斩将，与公司合伙人叶信之一路携手厮杀，最终成为无可替代之人的故事。 “黑莲花”徐迟与“精狐狸”叶信之互相扶持又相爱相杀！金牌编剧张巍全...",
  ogImage:
    "https://www.mdzypic.com/upload/vod/20260928-1/7a3d015c806b178380a48da94e6254ec.webp",
  domain: "aiqiyi.ai",
  matchedRule: "aiqiyi.ai",
  tabId: 1,
};
const TVMAO = {
  url: "https://www.tvmao.com/kanju/YmFfZmsg",
  title: "无可替代剧情介绍（1-20全集）大结局_电视剧_电视猫",
  description:
    "电视剧无可替代剧情介绍：讲述禀承“这一生绝对不能被别人替代”理念的女白领徐迟，在职场上过关斩将，与公司合伙人叶信之一路携手厮杀，最终成为无可替代之人的故事。 “黑莲花”徐迟与“精狐狸”叶信之互相扶持又相爱相杀！金牌编剧张巍全新都市力作，快节奏短剧模式，直击当下年轻人痛点。",
  ogImage: "",
  domain: "tvmao.com",
  matchedRule: "tvmao.com",
  tabId: 2,
};

// ── 适配器 ────────────────────────────────────────────────────────────────────
// A 站：作品页 URL 里抠出站内 id（命名捕获组 = 闸门变解析器）
// B 站：元数据站，规则只当闸门，没有捕获组 → 走降级，靠文本指纹归属
const WATCHLIST = [
  {
    domain: "aiqiyi.ai",
    label: "爱奇艺镜像",
    color: "#fff",
    regexFilter: "/voddetail/(?<siteId>[0-9]+)\\.html",
    regexTarget: "url",
  },
  {
    domain: "tvmao.com",
    label: "电视猫",
    color: "#fff",
    regexFilter: "/kanju/",
    regexTarget: "url",
  },
];

async function runTests() {
  console.log("\n── works end-to-end ──\n");

  const store = new RecordStore(":memory:", () => {});
  await store.init();

  const day1 = new Date(2026, 2, 1, 10).getTime();
  const day2 = new Date(2026, 2, 2, 10).getTime();

  async function visit(page, ts) {
    const msg = { ...page, timestamp: ts };
    const res = evaluateIncoming(msg, WATCHLIST, () => null);
    if (res.action === "drop" || res.action === "ignore") {
      return { dropped: res.reason };
    }
    const v = store.recordWorkVisit({
      keys: res.keys,
      title: page.title,
      timestamp: ts,
    });
    store.insertRecord({
      ...msg,
      id: `r-${page.domain}-${ts}`,
      workId: v.work ? v.work.id : null,
    });
    return { ...v, keys: res.keys, extracted: res.extracted };
  }

  // ── ① A 站第 1 天 ──
  console.log("① A 站（aiqiyi，MacCMS）第 1 天");
  const a = await visit(AIQIYI, day1);
  assert(!a.dropped, "作品页没有被丢弃");
  assert(a.extracted.siteId === "237486", "命名捕获组抠出了站内 id");
  assert(!!a.work, "归入了一部作品");
  assert(a.work.score === 1, "作品分数为 1");
  assert(
    a.keys.some((k) => k.kind === "cover_hash"),
    "产出了封面哈希键",
  );

  // ── ② A 站同一天再回一次 ──
  console.log("\n② A 站同一天再回一次");
  const a2 = await visit({ ...AIQIYI, tabId: 3 }, day1 + 3600e3);
  assert(a2.work.id === a.work.id, "归到同一条作品");
  assert(a2.work.score === 1, "同一天不加分");

  // ── ③ B 站第 2 天（元数据站，无封面，无编号） ──
  console.log("\n③ B 站（tvmao，元数据站）第 2 天");
  const b = await visit(TVMAO, day2);
  assert(!b.dropped, "元数据站的作品页没有被丢弃");
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
  assert(recs.length === 3, "三次访问都在 records 里，一条不少");
  assert(
    recs.every((r) => r.workId === a.work.id),
    "三条访问都挂到了同一条作品上",
  );

  // ── ⑤ 降级验证：完全认不出的访问不丢 ──
  console.log("\n⑤ 降级：认不出作品时历史不丢");
  const orphan = await visit(
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
    !orphan.dropped,
    "没有适配器规则的域名不会被 evaluateIncoming 丢弃（域名过滤在扩展那一层）",
  );
  assert(orphan.work === null, "也归不到作品——这是降级路径");
  assert(
    store.getRecordById(`r-unknown.example.com-${day2 + 3600e3}`) !== null,
    "记录照样入库，历史一条不少",
  );
  // 但如果它在 watchlist 里却没有可用键，就会降级成「无作品」的记录
  const W2 = [{ domain: "unknown.example.com", label: "未知", color: "#fff" }];  const res = evaluateIncoming(
    { url: "https://unknown.example.com/v/9", title: "", domain: "unknown.example.com", matchedRule: "unknown.example.com", tabId: 9, timestamp: day2 },
    W2,
    () => null,
  );
  assert(res.action === "insert", "无规则时照常插入");
  const deg = store.recordWorkVisit({ keys: res.keys, title: "", timestamp: day2 });
  assert(deg.work === null, "归不到作品");
  store.insertRecord({
    ...res.record,
    id: "orphan-1",
    workId: deg.work ? deg.work.id : null,
  });
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
