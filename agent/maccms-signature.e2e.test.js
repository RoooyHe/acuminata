/**
 * End-to-end: 装上就能用 —— 没有用户正则的 MacCMS 站点也拿得到编号身份键（issue #26）。
 * Run with: node agent/maccms-signature.e2e.test.js
 *
 * 今天扩展回传的只有五个固定字段（url / title / favIconUrl / description / ogImage），
 * 而真实 MacCMS 页**没有** og:image（模板文档实测），封面只存在于
 * `<img data-original="/upload/vod/…">` 里——所以编号根本到不了桌面端。
 *
 * 这个测试跑的是补上的那一半：
 *
 *   扩展在页面上认签名 → collect 抽字段 → 回传（pageSignature / pageFields）
 *     → 桌面端按签名认适配器 → parse → 身份键 → 作品归属
 *
 * 页面那一步用的是 `shared/page-collect.js` 的 `collectPage`——与扩展注入页面的
 * 是同一个函数，这里只是把页面换成真实抓下来的夹具（linkedom）。
 * 跨站配对沿用既有夹具（agent/annotated-pair.fixture.js）：A = aiqiyi.ai（MacCMS），
 * B = tvmao.com（元数据站），用户标注为同一部《无可替代》。
 */

const fs = require("fs");
const path = require("path");
const { parseHTML } = require("linkedom");
const { RecordStore } = require("./record-store");
const { collectPage } = require("../shared/page-collect");
const { AIQIYI, TVMAO } = require("./annotated-pair.fixture");

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

// 与 agent/adapter.test.js 同一个页面：真实抓下来的 MacCMS 作品页
const AIQIYI_HTML = fs.readFileSync(
  path.join(__dirname, "..", "test", "fixtures", "maccms-aiqiyi.html"),
  "utf8",
);
const AIQIYI_CODE = "7a3d015c806b178380a48da94e6254ec";

// 用户只登记了站点，**没写过任何正则**——这正是本轮的验收条件
const WATCHLIST_NO_REGEX = [
  { domain: "aiqiyi.ai", label: "爱奇艺镜像", color: "#fff" },
  { domain: "tvmao.com", label: "电视猫", color: "#fff" },
];

async function openStore() {
  const store = new RecordStore(":memory:", () => {});
  await store.init();
  store.updateWatchlist(WATCHLIST_NO_REGEX);
  return store;
}

async function runTests() {
  console.log("\n── 页面签名回传 → MacCMS 自动身份键 end-to-end ──\n");

  const day1 = new Date(2026, 2, 1, 10).getTime();
  const day2 = new Date(2026, 2, 2, 10).getTime();

  // ── ① 旧路：只有五个固定字段。真页没有 og:image，编号到不了桌面端 ──
  console.log("① 对照：只回传五个固定字段");
  const bare = await openStore();
  const old = bare.recordVisit({
    ...AIQIYI,
    ogImage: "",
    id: "r-a-old",
    timestamp: day1,
  });
  assert(old.action === "insert", "没有用户正则时访问照常落库");
  assert(
    !old.keys.some((k) => k.confidence === "high"),
    "五个固定字段里拿不到高可信度键（真页没有 og:image）——这就是本轮要补的那一半",
  );

  // ── ② 扩展看到的东西：页面签名 + 适配器在真页上抽到的字段 ──
  console.log("\n② 扩展在真页上采集");
  const store = await openStore();
  const seen = collectPage(store.getAdapters(), parseHTML(AIQIYI_HTML).document);
  assert(seen.pageSignature.includes("maccms"), "回传的页面签名里有 maccms（平台身份）");
  assert(seen.ogImage === "", "真页确实没有 og:image，与模板文档的实测一致");
  const cover = seen.pageFields["maccms.json"] && seen.pageFields["maccms.json"].cover;
  assert(
    typeof cover === "string" && cover.includes(AIQIYI_CODE),
    "适配器的 collect 在真页上抽到封面（编号就在这个 URL 里）",
  );
  // 走一遍扩展 → WebSocket → 桌面端的序列化：非 JSON 的形状（Set、Map、DOM 节点）会在这里露馅
  const reported = JSON.parse(JSON.stringify(seen));

  // ── ③ 桌面端：按签名认适配器 → parse → 编号身份键 ──
  console.log("\n③ 桌面端按签名认适配器");
  const a = store.recordVisit({
    ...AIQIYI,
    ogImage: reported.ogImage,
    pageSignature: reported.pageSignature,
    pageFields: reported.pageFields,
    id: "r-a",
    timestamp: day1,
  });
  assert(a.action === "insert", "作品页落库");
  assert(
    a.keys.some((k) => k.kind === "code" && k.value === AIQIYI_CODE && k.confidence === "high"),
    "没有用户正则也拿到了编号身份键（高可信度）",
  );
  assert(
    a.keys.some((k) => k.kind === "cover_hash" && k.value === AIQIYI_CODE),
    "封面哈希身份键也在",
  );
  assert(!!a.work, "归入了一部作品");

  // ── ④ 跨站归并：沿用既有的真实跨站配对夹具 ──
  console.log("\n④ 跨站归并");
  const b = store.recordVisit({ ...TVMAO, id: "r-b", timestamp: day2 });
  assert(b.work.id === a.work.id, "另一站上的同一部作品归并成一条");
  assert(b.work.score === 2, "跨站跨天累加：分数为 2");
  assert(
    store.getWorkKeys(a.work.id).some((k) => k.kind === "code" && k.value === AIQIYI_CODE),
    "作品下挂着内容编号身份键",
  );

  // ── ⑤ 出现在作品视图里 ──
  console.log("\n⑤ 作品视图");
  const page = store.getWorksPage(1, 50, {});
  assert(page.total === 1, "两个站合起来只占作品视图里的一行");
  assert(page.works[0].id === a.work.id, "那一行就是这部作品");
  assert(page.works[0].sites.includes("aiqiyi.ai"), "它的来源里有 MacCMS 站");
  assert(store.getUnattributedCount() === 0, "没有访问掉在未归属里");

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
