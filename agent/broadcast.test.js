// 广播契约（issue #53）：每个域事件经主进程的信封铺开后，客户端真正读的
// 具名字段必须在。测试走 store 的真实广播回调 + `toClientMessage`
// （main.js 用的同一个封装），不另写一份信封。
//
// 背景：载荷曾经是裸值（watchlist 数组、enabled 布尔），铺开后只剩事件名，
// 扩展读到 undefined → watchlist 被清空、enabled 读反；一次访问又额外推了
// 一条健康度广播，变成两条。

const assert = require("assert");
const { RecordStore } = require("./record-store");
const { toClientMessage } = require("./broadcast");

function check(cond, msg) {
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
}

(async () => {
  console.log("Running broadcast contract tests...\n");

  // 与 main.js 同一条线：store 的 (type, payload) 经信封变成客户端消息。
  const messages = [];
  const store = new RecordStore(":memory:", (type, payload) =>
    messages.push(toClientMessage(type, payload)),
  );
  await store.init();

  // watchlist：扩展读 msg.watchlist（增 / 删 / 批量同步都要带）
  console.log("Test: watchlist 广播带 watchlist 数组");
  messages.length = 0;
  store.addWatchlist({ domain: "b.example", label: "B", color: "#fff" });
  let msg = messages.filter((m) => m.type === "watchlistUpdated").pop();
  check(
    Array.isArray(msg && msg.watchlist) &&
      msg.watchlist.some((w) => w.domain === "b.example"),
    "新增站点：watchlistUpdated 带 watchlist 数组",
  );

  messages.length = 0;
  store.removeWatchlist("b.example");
  msg = messages.filter((m) => m.type === "watchlistUpdated").pop();
  check(
    Array.isArray(msg && msg.watchlist) &&
      msg.watchlist.length > 0 &&
      !msg.watchlist.some((w) => w.domain === "b.example"),
    "移除站点：watchlistUpdated 带 watchlist 数组，且不清空其余站点",
  );

  messages.length = 0;
  store.updateWatchlist([{ domain: "sync.example", label: "S", color: "#fff" }]);
  msg = messages.filter((m) => m.type === "watchlistUpdated").pop();
  check(
    Array.isArray(msg && msg.watchlist) &&
      msg.watchlist.length === 1 &&
      msg.watchlist[0].domain === "sync.example",
    "批量同步：watchlistUpdated 带 watchlist 数组",
  );

  // enabled：扩展读 msg.enabled
  console.log("\nTest: enabled 广播带 enabled 布尔");
  messages.length = 0;
  store.setEnabled(false);
  msg = messages.filter((m) => m.type === "enabledUpdated").pop();
  check(msg && msg.enabled === false, "关闭追踪：enabledUpdated 带 enabled=false");

  messages.length = 0;
  store.setEnabled(true);
  msg = messages.filter((m) => m.type === "enabledUpdated").pop();
  check(msg && msg.enabled === true, "开启追踪：enabledUpdated 带 enabled=true");

  // record：扩展读 msg.record；一条访问只发一条广播，且带健康度
  console.log("\nTest: record 广播带 record 对象，一条访问一条广播");
  store.addWatchlist({
    domain: "r.example",
    label: "R",
    color: "#fff",
    regexFilter: "/v/(?<code>[0-9]+)",
    regexTarget: "url",
  });
  const visit = (ts) => ({
    id: "r1",
    url: "https://r.example/v/1",
    title: "契约作品",
    domain: "r.example",
    matchedRule: "r.example",
    tabId: 1,
    timestamp: ts,
  });

  messages.length = 0;
  store.recordVisit(visit(Date.now()));
  check(messages.length === 1 && messages[0].type === "recordAdded", "新访问只发一条广播");
  check(
    messages[0].record && messages[0].record.id === "r1",
    "recordAdded 带 record 对象",
  );
  check(
    messages[0].health && Array.isArray(messages[0].health.adapters),
    "recordAdded 带健康度快照（不再另推一条）",
  );

  messages.length = 0;
  store.recordVisit(visit(Date.now() + 26 * 3600 * 1000));
  check(
    messages.length === 1 &&
      messages[0].type === "recordUpdated" &&
      messages[0].record &&
      messages[0].record.id === "r1",
    "回访只发一条 recordUpdated，带 record 对象",
  );

  console.log("\nAll broadcast contract tests passed.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
