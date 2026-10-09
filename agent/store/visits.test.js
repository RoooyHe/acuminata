// Visits domain: records CRUD/reads plus the one write path (recordVisit). It
// collaborates with sites (watchlist/rules) and works (attribution), and reads
// the enabled flag from settings. No RecordStore needed.
const assert = require("assert");
const { openDatabase } = require("./db");
const { SettingsStore } = require("./settings");
const { SiteStore } = require("./sites");
const { WorkStore } = require("./works");
const { VisitStore } = require("./visits");

async function run() {
  const db = await openDatabase(":memory:");
  SettingsStore.schema(db);
  SiteStore.schema(db);
  WorkStore.schema(db);
  VisitStore.schema(db);

  const events = [];
  const emit = (type, payload) => events.push({ type, ...payload });
  const settings = new SettingsStore(db, emit);
  const sites = new SiteStore(db, emit);
  const works = new WorkStore(db, { emit, sites });
  const visits = new VisitStore(db, { emit, sites, works, settings });

  sites.addWatchlist({
    domain: "example.com",
    label: "某站",
    color: "#fff",
    regexFilter: "/video/(?<code>[0-9]+)",
    regexTarget: "url",
  });

  const day1 = new Date(2026, 4, 1, 10).getTime();
  const day2 = new Date(2026, 4, 2, 10).getTime();
  const visit = (over = {}) =>
    visits.recordVisit({
      id: `v-${over.id || "1"}`,
      url: "https://example.com/video/123",
      title: "某剧 第1集",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: day1,
      ...over,
    });

  const dropped = visit({ id: "list", url: "https://example.com/article/9" });
  assert.strictEqual(dropped.action, "drop", "闸门不认的页面被丢弃");
  assert.strictEqual(visits.getRecordsPage(1, 10, "all").total, 0, "丢弃的页面没有落库");

  const first = visit();
  assert.strictEqual(first.action, "insert", "作品页落库一条访问");
  assert.ok(first.work && first.record.workId === first.work.id, "归入一部作品");
  assert.ok(first.keys.some((k) => k.kind === "code"), "抠出内容编号身份键");
  assert.strictEqual(events.filter((e) => e.type === "recordAdded").length, 1, "一次访问一条广播");

  const repeat = visit({ id: "repeat", timestamp: day1 + 5000 });
  assert.strictEqual(repeat.action, "ignore", "60s 内同标签页重报是同一访问");
  assert.strictEqual(visits.getRecordsPage(1, 10, "all").total, 1, "没有多出记录");

  const sameDay = visit({ id: "tab3", tabId: 3, timestamp: day1 + 3600e3 });
  assert.strictEqual(sameDay.action, "update", "同组同路径的另一标签页是更新");
  assert.strictEqual(visits.getRecordsPage(1, 10, "all").total, 1, "访问仍只有一条");
  assert.strictEqual(sameDay.record.pinned, 1, "回访自动钉住");
  assert.strictEqual(sameDay.work.score, 1, "同一天作品不加分");

  const nextDay = visit({ id: "tab3", tabId: 3, timestamp: day2 });
  assert.strictEqual(nextDay.record.score, 2, "隔天访问层 +1");
  assert.strictEqual(nextDay.work.score, 2, "隔天作品层 +1");

  // 记录读取与统计
  const rec = visits.insertRecord({
    id: "plain-1",
    url: "https://example.com/video/9",
    title: "普通记录",
    domain: "example.com",
    matchedRule: "example.com",
    tabId: 9,
    timestamp: day1,
  });
  assert.strictEqual(visits.getRecordById("plain-1").id, "plain-1", "按 id 读回");
  assert.strictEqual(visits.getRecordsPage(1, 10, "example.com").total, 2, "按站点筛选");
  visits.updateRecordScore("plain-1", 0); // 搜索按 score >= 0 过滤，先给个分
  assert.strictEqual(visits.searchRecords("普通", 10).length, 1, "按标题搜索");
  visits.toggleRecordPin("plain-1", true, 5);
  assert.deepStrictEqual(
    [visits.getRecordById("plain-1").pinned, visits.getRecordById("plain-1").score],
    [1, 5],
    "钉住并记分",
  );
  visits.updateRecordScore("plain-1", 9);
  assert.strictEqual(visits.getRecordById("plain-1").score, 9, "改分");
  assert.strictEqual(visits.getRuleStats().total, 2, "站点粒度统计总数");
  assert.strictEqual(visits.getRuleStats().stats["example.com"], 2, "站点粒度统计分站计数");
  assert.strictEqual(visits.getStats().total, 2, "概览统计总数");
  assert.strictEqual(visits.getStats().enabled, true, "统计带 enabled（来自 settings）");
  assert.strictEqual(visits.getUnattributedCount(), 1, "未归属计数");
  assert.deepStrictEqual(
    visits.getSiteAffinity(),
    [{ site: "example.com", visits: 2 }],
    "来源亲和度按站点计数（排序的画像输入）",
  );

  const deleted = visits.deleteRecords(["plain-1"]);
  assert.strictEqual(deleted.deletedCount, 1, "删除返回条数与内容");
  assert.strictEqual(visits.getRecordById("plain-1"), null, "删除后读不到");
  visits.clearRecords();
  assert.strictEqual(visits.getRecordsPage(1, 10, "all").total, 0, "清空全部访问");
  assert.strictEqual(db.scalar("SELECT COUNT(*) as c FROM works"), 0, "清空后不留孤儿作品");

  console.log("visits store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
