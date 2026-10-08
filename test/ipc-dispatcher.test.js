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
      return fn({}, ...args);
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
  console.log("  ✓ works:health 携带未归属计数与适配器命中情况");

  // 未归属页面与健康度看到的是同一个数字
  assert(
    page.total === health.unattributedCount,
    "列表总数与健康度计数一致",
  );
  console.log("  ✓ 未归属列表与健康度计数一致");

  console.log("\n✅ All IPC dispatcher tests passed!");
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
