// Seam B: the dispatcher's real handlers, invoked directly with a fake ipcMain
// and an in-memory RecordStore. Asserts the payload shapes the renderer reads
// for 未归属访问 and 适配器健康度 — outside Electron, no window involved.

const assert = require("assert");
const { createIPCDispatcher } = require("../agent/ipc-dispatcher");
const { RecordStore } = require("../agent/record-store");

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("no handler registered for " + channel);
      return fn({ sender: {} }, ...args);
    },
    async invokeFrom(sender, channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error("no handler registered for " + channel);
      return fn({ sender }, ...args);
    },
  };
}

async function runTests() {
  console.log("Running IPC dispatcher tests...\n");

  const store = new RecordStore(":memory:", () => {});
  await store.init();

  const t = Date.now();
  const work = store.recordWorkVisit({
    keys: [{ kind: "code", value: "DISP-1", confidence: "high" }],
    title: "分派器作品",
    timestamp: t,
  });
  // 两路身份键指向不同作品：健康度要能把这对歧义报出来。
  store.recordWorkVisit({
    keys: [{ kind: "cover_hash", value: "c".repeat(32), confidence: "high" }],
    title: "分派器作品乙",
    timestamp: t,
  });
  store.recordWorkVisit({
    keys: [
      { kind: "code", value: "DISP-1", confidence: "high" },
      { kind: "cover_hash", value: "c".repeat(32), confidence: "high" },
    ],
    title: "分派器歧义",
    timestamp: t,
  });
  store.insertRecord({
    id: "d-att-1",
    url: "https://bilibili.com/v/a",
    title: "分派器作品",
    domain: "bilibili.com",
    matchedRule: "bilibili.com",
    tabId: 1,
    timestamp: t,
    workId: work.work.id,
  });
  store.insertRecord({
    id: "d-un-1",
    url: "https://bilibili.com/v/b",
    title: "未归类访问",
    domain: "bilibili.com",
    matchedRule: "bilibili.com",
    tabId: 2,
    timestamp: t + 1,
    workId: null,
  });

  const adapters = [
    { domain: "bilibili.com", matched: 3, dropped: 0, suspect: false },
    { domain: "dead.example", matched: 0, dropped: 25, suspect: true },
  ];
  const ipc = fakeIpcMain();
  createIPCDispatcher(ipc, store, { getAdapterHealth: () => adapters });

  // ── works:unattributed ──
  const page = await ipc.invoke("works:unattributed", 1, 10, "");
  assert.deepStrictEqual(Object.keys(page).sort(), [
    "page",
    "pageSize",
    "records",
    "total",
  ]);
  assert(page.total === 1, "未归属分页 total 为 1");
  assert(page.records[0].id === "d-un-1", "未归属分页返回那条访问");
  assert(page.records[0].workId === null, "返回的记录确实没有 workId");
  console.log("  ✓ works:unattributed 载荷形状正确");

  const searched = await ipc.invoke("works:unattributed", 1, 10, "未归类");
  assert(searched.total === 1, "works:unattributed 支持搜索");
  const noHit = await ipc.invoke("works:unattributed", 1, 10, "没有这条");
  assert(noHit.total === 0 && noHit.records.length === 0, "搜不到返回空页");
  console.log("  ✓ works:unattributed 搜索可用");

  // ── works:health ──
  const health = await ipc.invoke("works:health");
  assert(health.unattributedCount === 1, "健康度携带未归属计数");
  assert(Array.isArray(health.adapters) && health.adapters.length === 2, "健康度携带站点适配器列表");
  assert(health.adapters[1].suspect === true, "失效站点在载荷里被标出");
  assert(
    Array.isArray(health.ambiguousWorks) && health.ambiguousWorks.length === 1,
    "健康度携带歧义作品列表",
  );
  assert(
    [health.ambiguousWorks[0].workA.title, health.ambiguousWorks[0].workB.title]
      .sort()
      .join() === ["分派器作品", "分派器作品乙"].sort().join(),
    "歧义列表指出是哪两部作品",
  );
  console.log("  ✓ works:health 携带未归属计数、适配器命中与歧义作品列表");

  // 未归属页面与健康度看到的是同一个数字
  assert(
    page.total === health.unattributedCount,
    "列表总数与健康度计数一致",
  );
  console.log("  ✓ 未归属列表与健康度计数一致");

  const shell = {};
  const browserCalls = [];
  const browserState = {
    mode: "browser",
    activeTabId: 7,
    tabs: [{
      id: 7,
      title: "Example",
      url: "https://example.com/",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      error: "",
    }],
  };
  const browser = {
    getState: () => browserState,
    navigate: (address) => {
      browserCalls.push(["navigate", address]);
      return browserState;
    },
    action: (action) => {
      browserCalls.push(["action", action]);
      return browserState;
    },
    setMode: (mode) => {
      browserCalls.push(["mode", mode]);
      return browserState;
    },
    newTab: () => {
      browserCalls.push(["new"]);
      return browserState;
    },
    activateTab: (tabId) => {
      browserCalls.push(["activate", tabId]);
      return browserState;
    },
    closeTab: (tabId) => {
      browserCalls.push(["close", tabId]);
      return browserState;
    },
  };
  const opened = [];
  const browserIpc = fakeIpcMain();
  createIPCDispatcher(browserIpc, store, {
    browser,
    getShellWebContents: () => shell,
    openSitePage: (url) => opened.push(url),
  });

  const browserChannels = [
    "browser:state:get",
    "browser:navigate",
    "browser:action",
    "browser:mode:set",
    "browser:tab:new",
    "browser:tab:activate",
    "browser:tab:close",
  ];
  for (const channel of browserChannels) {
    await assert.rejects(browserIpc.invokeFrom({}, channel), /sender/);
  }
  await assert.rejects(
    browserIpc.invokeFrom(shell, "browser:navigate", ""),
  );
  await assert.rejects(
    browserIpc.invokeFrom(shell, "browser:navigate", 42),
  );
  await assert.rejects(
    browserIpc.invokeFrom(shell, "browser:action", "home"),
  );
  await assert.rejects(
    browserIpc.invokeFrom(shell, "browser:mode:set", "agent"),
  );
  for (const channel of ["browser:tab:activate", "browser:tab:close"]) {
    for (const tabId of ["7", 7.5, null]) {
      await assert.rejects(browserIpc.invokeFrom(shell, channel, tabId));
    }
  }
  for (const channel of browserChannels) {
    const args = channel === "browser:navigate" ? ["example.com"]
      : channel === "browser:action" ? ["reload"]
        : channel === "browser:mode:set" ? ["settings"]
          : ["browser:tab:activate", "browser:tab:close"].includes(channel) ? [7]
            : [];
    assert.strictEqual(await browserIpc.invokeFrom(shell, channel, ...args), browserState);
  }
  assert.deepStrictEqual(browserCalls, [
    ["navigate", "example.com"],
    ["action", "reload"],
    ["mode", "settings"],
    ["new"],
    ["activate", 7],
    ["close", 7],
  ]);
  await browserIpc.invoke("records:open-url", "https://example.com/v/1");
  assert.deepStrictEqual(opened, ["https://example.com/v/1"]);
  console.log("  ✓ browser IPC validates every sender, address, action, mode, and integer tab ID");
  console.log("  ✓ every browser route returns the current tab-shaped BrowserState");
  console.log("  ✓ records:open-url keeps mirror resolution and uses the site opener");

  console.log("\n✅ All IPC dispatcher tests passed!");
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
