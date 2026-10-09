/**
 * 候选 end-to-end（issue #30）：适配器声明的列表页产出候选，而不是访问。
 * Run with: node agent/candidates.e2e.test.js
 *
 * 夹具是**真实抓下来的 MacCMS 列表页**，不是构造的小样本：
 *   test/fixtures/maccms-mgtvtv-list.html   /show/2-1/              主题 mxpro
 *   test/fixtures/maccms-aiqiyi-list.html   /vodshow/2-----------1.html  主题 a_0012
 *
 * 两个主题的条目选择器、封面取法完全不同，却由同一份平台适配器声明——
 * 证明列表页与访问页共用同一种「有序备选」写法（docs/adapters/template.md）。
 *
 * 再用临时库证明 ADR-0005 的三个角色：声明的列表页
 *   - 不被记成一次访问
 *   - 本身不产生作品身份
 *   - 条目落成候选（而不是访问）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseHTML } = require("linkedom");
const { RecordStore } = require("./record-store");
const {
  collectListEntries,
  isListPageUrl,
  listFetchTargets,
} = require("./adapter");
const { loadAdapters } = require("./adapters");

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${msg}` +
      (ok
        ? ""
        : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`),
  );
}
function ok(cond, msg) {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
}

function loadList(file, url) {
  const html = fs.readFileSync(path.join(__dirname, "..", "test", "fixtures", file), "utf8");
  return { doc: parseHTML(html).document, url };
}

const adapters = loadAdapters();
const mac = adapters.find((a) => a.file === "maccms.json");
const mgtvtv = loadList("maccms-mgtvtv-list.html", "https://www.mgtvtv.com/show/2-1/");
const aiqiyi = loadList("maccms-aiqiyi-list.html", "https://aiqiyi.ai/vodshow/2-----------1.html");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-candidates-"));
const dbPath = path.join(tmpDir, "tracker.db");

async function runTests() {
  console.log("\n── 候选 end-to-end（真列表页夹具）──\n");

  // ── ① 列表页条目 → 原始字段 ──
  console.log("① 列表页条目");
  const mgtEntries = collectListEntries(mac.list[0], mgtvtv.doc, mgtvtv.url);
  ok(mgtEntries.length > 10, "mgtvtv 列表页抽出多个条目");
  eq(mgtEntries[0].url, "https://www.mgtvtv.com/tv/94940/", "条目的相对地址补成绝对地址");
  ok(mgtEntries[0].title.length > 0, "条目带标题");
  ok(mgtEntries[0].cover.includes("/upload/vod/"), "条目带封面（scan 到 /upload/vod/）");

  const aiqEntries = collectListEntries(mac.list[1], aiqiyi.doc, aiqiyi.url);
  ok(aiqEntries.length > 10, "aiqiyi 列表页抽出多个条目");
  ok(aiqEntries[0].url.startsWith("https://aiqiyi.ai/voddetail/"), "条目地址绝对化");
  ok(aiqEntries[0].cover.includes("/upload/vod/"), "另一个主题的封面来自 data-original");

  // ── ② 列表页的三个角色：靠适配器声明，不靠 regexFilter ──
  console.log("\n② 列表页的角色");
  ok(isListPageUrl(adapters, "https://www.mgtvtv.com/show/2-3/"), "分页模板命中的也是列表页");
  ok(
    isListPageUrl(adapters, "https://mgtvtv-mirror.com/show/2-3/"),
    "镜像域名上的同一个列表页也认得出（只比路径）",
  );
  ok(isListPageUrl(adapters, "https://www.mgtvtv.com/show/2-3/?from=home"), "带查询参数的列表页也认得出（只看路径）");
  ok(
    isListPageUrl(adapters, "https://aiqiyi.ai/vodshow/2--------2---1.html"),
    "aiqiyi 真页分页 href 命中的是列表页",
  );
  ok(
    !isListPageUrl(adapters, "https://aiqiyi.ai/vodshow/2-----------2011.html"),
    "年份筛选（同样的 vodshow 前缀）不是声明的列表页",
  );
  ok(!isListPageUrl(adapters, "https://www.mgtvtv.com/tv/94939/"), "作品页不是列表页");

  const registered = listFetchTargets(adapters, [{ domain: "mgtvtv.com", label: "芒果" }]);
  eq(registered.length, 1, "只抓用户登记过的站点");
  eq(registered[0].matchedRule, "mgtvtv.com", "候选的分组取登记站点");
  eq(registered[0].groupLabel, "芒果", "候选的来源站点带上分组标签");
  eq(listFetchTargets(adapters, [{ domain: "bilibili.com" }]).length, 0, "没登记的站点一个都不抓");

  // ── ③ 临时库：列表页不产生访问、不产生作品；条目落成候选 ──
  console.log("\n③ 一条列表页访问");
  const store = new RecordStore(dbPath, () => {});
  await store.init();
  store.addWatchlist({ domain: "mgtvtv.com", label: "芒果", color: "#fff" });

  const before = store._dbAll("SELECT id FROM records").length;
  const dropped = store.recordVisit({
    id: "list-1",
    url: "https://www.mgtvtv.com/show/2-3/",
    title: "电视剧列表",
    domain: "www.mgtvtv.com",
    matchedRule: "mgtvtv.com",
    tabId: 1,
    timestamp: Date.now(),
  });
  eq(dropped.action, "drop", "列表页被丢弃");
  eq(dropped.reason, "list-page", "丢弃原因来自适配器的列表声明");
  eq(store._dbAll("SELECT id FROM records").length, before, "列表页没有产生访问");
  eq(store._dbAll("SELECT id FROM works").length, 0, "列表页本身没有产生作品身份");

  const imported = store.importCandidates({
    adapterFile: mac.file,
    listName: mac.list[0].name,
    domain: registered[0].domain,
    matchedRule: registered[0].matchedRule,
    groupLabel: registered[0].groupLabel,
    entries: mgtEntries,
  });
  eq(imported.inserted, mgtEntries.length, "条目落成候选");
  const pool = store.getCandidates();
  eq(pool.length, mgtEntries.length, "候选池里就是刚抓来的那些");
  ok(
    pool.every((c) => c.matchedRule === "mgtvtv.com" && c.listName === "最新更新"),
    "每条候选都带来源站点与列表页名",
  );
  ok(JSON.parse(pool[0].fields).cover.includes("/upload/vod/"), "候选带着原始字段");
  eq(store._dbAll("SELECT id FROM records").length, before, "候选不是访问（records 没变）");

  // ── ④ 排序：候选 → 推荐（issue #31）──
  console.log("\n④ 排序成推荐");
  const seen = pool[0];
  const seenHash = JSON.parse(seen.fields).cover.match(/([0-9a-f]{32})/)[1];
  const seenWork = store.recordWorkVisit({
    keys: [{ kind: "code", value: seenHash, confidence: "high" }],
    title: seen.title,
    timestamp: Date.now(),
  });
  store.insertRecord({
    id: "seen-1",
    url: seen.url,
    title: seen.title,
    domain: "www.mgtvtv.com",
    matchedRule: "mgtvtv.com",
    tabId: 1,
    timestamp: Date.now(),
    workId: seenWork.work.id,
  });

  const written = store.rankCandidates();
  const recs = store.getRecommendations();
  eq(written, mgtEntries.length - 1, "看过的那条不出现，其余都排成推荐");
  ok(!recs.some((r) => r.url === seen.url), "已经访问过的作品不作为推荐");
  ok(
    recs.every((r) => r.reason && r.reason.length > 0),
    "每条推荐都带理由（列表页条目没有元数据，退回站点兜底）",
  );
  ok(recs.every((r) => r.domain === "www.mgtvtv.com"), "推荐带着来源站点");
  ok(recs.every((r) => r.groupLabel === "芒果"), "推荐带着分组标签");
  ok(
    recs.some((r) => r.reason.includes("芒果")),
    "理由写清了来源站点：" + recs[0].reason,
  );

  // 重跑不堆重复：替掉未裁决的那批，条数不变。
  const again = store.rankCandidates();
  eq(again, recs.length, "重跑条数不变");
  eq(store.getRecommendations().length, recs.length, "重跑不堆出重复推荐");

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
