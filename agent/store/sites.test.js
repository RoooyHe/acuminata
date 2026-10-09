// Sites domain only needs the `watchlist` table — no RecordStore.
const assert = require("assert");
const { openDatabase } = require("./db");
const { SiteStore } = require("./sites");

async function run() {
  const db = await openDatabase(":memory:");
  SiteStore.schema(db); // 只带自己的 schema
  const events = [];
  const sites = new SiteStore(db, (type, payload) => events.push({ type, payload }));

  sites.seedDefaults();
  assert.strictEqual(sites.getWatchlist().length, 1, "空库首次启动有一个默认站点");
  assert.strictEqual(sites.getWatchlist()[0].domain, "bilibili.com", "默认站点是 bilibili.com");
  sites.seedDefaults();
  assert.strictEqual(sites.getWatchlist().length, 1, "再次 seed 不重复添加");

  assert.strictEqual(
    sites.addWatchlist({ domain: "example.com", label: "某站", color: "#fff" }),
    true,
    "新增站点",
  );
  assert.strictEqual(
    sites.addWatchlist({ domain: "example.com", label: "重复", color: "#fff" }),
    false,
    "重复新增返回 false",
  );
  const lastAdd = events.at(-1);
  assert.strictEqual(lastAdd.type, "watchlistUpdated", "站点变更广播 watchlistUpdated");
  assert.ok(Array.isArray(lastAdd.payload.watchlist), "每次站点变更广播 { watchlist } 数组");

  sites.updateWatchlistRegex("example.com", "/video/", "url");
  const updated = sites.getWatchlist().find((w) => w.domain === "example.com");
  assert.strictEqual(updated.regexFilter, "/video/", "正则规则落库");
  assert.strictEqual(updated.regexTarget, "url", "正则目标落库");
  assert.ok(Array.isArray(events.at(-1).payload.watchlist), "正则变更广播的是 { watchlist }");
  assert.strictEqual(sites.updateWatchlistRegex("nope.com", "x", "url"), null, "未知域名返回 null");

  // 镜像：同 label 的两个域名是一组
  sites.addWatchlist({ domain: "mirror.com", label: "某站", color: "#fff" });
  assert.strictEqual(sites.rulesFor("all"), null, "all 不筛选");
  assert.strictEqual(sites.rulesFor(""), null, "空值不筛选");
  assert.deepStrictEqual(
    sites.rulesFor("某站").sort(),
    ["example.com", "mirror.com"],
    "按 label 拿到组内全部域名",
  );
  assert.deepStrictEqual(sites.rulesFor("raw.example"), ["raw.example"], "未登记的原始域名原样返回");

  sites.removeWatchlist("example.com");
  assert.strictEqual(sites.getWatchlist().length, 2, "删除后剩两个");
  assert.strictEqual(sites.removeWatchlist("example.com"), false, "重复删除返回 false");

  sites.updateWatchlist([{ domain: "only.com", label: "只此一个", color: "#000" }]);
  assert.strictEqual(sites.getWatchlist().length, 1, "整份替换");

  console.log("sites store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
