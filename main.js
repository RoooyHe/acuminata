const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const { RecordStore } = require("./agent/record-store");
const { ADAPTER_DIR } = require("./agent/adapters");
const { createIPCDispatcher } = require("./agent/ipc-dispatcher");
const { createExecuteTool } = require("./agent/tools/orchestrator");
const {
  getTool,
  getReadTools,
  getWriteTools,
  getOpenAITools,
  getAnthropicTools,
} = require("./agent/tools");
const { agentLoop, executeApprovedActions } = require("./agent/executor");
const { createAIProviders } = require("./agent/providers");
const { createAdapterHealth } = require("./agent/adapter-health");
const { listFetchTargets, collectListEntries } = require("./agent/adapter");
const { reflectPrompt } = require("./agent/analysis-pipeline");
const { applyReflection } = require("./agent/reflect");

const EXTENSION_PORT = 8766;
// Explicit override only (used by the smoke test); otherwise the user's real DB.
const DB_PATH = process.env.ACUMINATA_DB_PATH
  ? process.env.ACUMINATA_DB_PATH
  : path.join(app.getPath("userData"), "tracker.db");
// 用户写的适配器放在这里（打包后内置的 adapters/ 在 asar 里、不可写）。
// 与内置适配器同一种格式、同一个 loader，同名时用户目录覆盖内置（ADR-0006）。
const USER_ADAPTER_DIR = path.join(app.getPath("userData"), "adapters");

let mainWindow;
let extensionServer;
let extensionClients = new Set();
let store;
let aiConfig = {
  provider: "ollama",
  endpoint: "http://127.0.0.1:11434",
  apiKey: "",
  model: "qwen2.5:7b",
};

// ── Node.js transport for agent/providers.js ─────────────────────────────────

function nodeHttpRequest(urlStr, options, timeout) {
  const url = new URL(urlStr);
  const http = url.protocol === "https:" ? require("https") : require("http");
  const body = options.body || "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || "POST",
        headers: Object.assign(
          {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          options.headers || {}
        ),
        timeout: timeout || 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(
              new Error(
                "HTTP " + res.statusCode + " → " + urlStr + " : " + data.slice(0, 200)
              )
            );
            return;
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on("error", (e) => reject(new Error(e.message + " → " + urlStr)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout → " + urlStr));
    });
    req.write(body);
    req.end();
  });
}

const aiProviders = createAIProviders(
  () => aiConfig,
  nodeHttpRequest
);

function getAIConfig() {
  return aiConfig;
}

// ── Composition root ─────────────────────────────────────────────────────────

async function init() {
  // 目录先建出来：用户才找得到往哪儿放适配器（不存在时 loadAdapters 也只是读空）。
  try {
    fs.mkdirSync(USER_ADAPTER_DIR, { recursive: true });
  } catch (e) { /* 建不出来就当没有用户适配器 */ }
  store = new RecordStore(DB_PATH, (type, data) => {
    broadcastToExtensions({ type, ...data });
  }, { adapterDirs: [ADAPTER_DIR, USER_ADAPTER_DIR] });
  // 适配器健康度按已加载的适配器初始化：从未命中的也能在界面上被看见。
  adapterHealth = createAdapterHealth(store.getAdapters());

  await store.init();

  // Debounced save
  let saveTimer = null;
  store.onDirty(() => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.writeFileSync(DB_PATH, Buffer.from(store.export()));
      } catch (e) { /* ignore */ }
    }, 1000);
  });

  // Flush on quit
  app.on("before-quit", () => {
    if (saveTimer) clearTimeout(saveTimer);
    try {
      fs.writeFileSync(DB_PATH, Buffer.from(store.export()));
    } catch (e) { /* ignore */ }
    if (extensionServer) extensionServer.close();
  });

  // Agent tooling
  const executeTool = createExecuteTool({
    writeStore: store.getAgentWriteStore(),
    watchlist: store.getWatchlist(),
    triggerReflectionOnDelete: triggerReflectionOnDelete,
    getTool,
    readStore: store.getAgentReadStore(),
  });

  // IPC
  createIPCDispatcher(ipcMain, store, {
    providers: aiProviders,
    executeTool,
    getAdapterHealth: () => adapterHealth.snapshot(),
    fetchCandidates: fetchCandidates,
    // agent 执行进度不是 store 的状态变更，走传输层自己的广播，不问 store 要事件。
    // ponytail: executor 交来整条事件对象，这里按封装前的线上形状（整条对象当 type）
    // 转发，保持无行为变化。代价是 agent_status 在渲染端一直不可见
    // （ui/renderer.js 按 data.type === "agent_status" 判断）；修这个形状是行为变更，另开。
    broadcastAgentEvent: (event) => broadcastToExtensions({ type: event }),
  });

  // Extension server
  startExtensionServer();

  // Window
  createWindow();
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function broadcastToExtensions(data) {
  const msg = JSON.stringify(data);
  extensionClients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("data-update", data);
  }
}

function startExtensionServer() {
  extensionServer = new WebSocket.Server({ port: EXTENSION_PORT });
  console.log(`[Server] Extension WebSocket server running on port ${EXTENSION_PORT}`);

  extensionServer.on("connection", (ws) => {
    console.log("[Server] Extension connected");
    extensionClients.add(ws);

    ws.send(JSON.stringify({ type: "init", watchlist: store.getWatchlist(), enabled: store.getEnabled(), adapters: store.getAdapters() }));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        handleExtensionMessage(ws, msg);
      } catch (e) {
        console.error("[Server] Invalid message:", e);
      }
    });

    ws.on("close", () => {
      extensionClients.delete(ws);
      console.log("[Server] Extension disconnected");
    });

    ws.on("error", (err) => {
      console.error("[Server] WebSocket error:", err);
      extensionClients.delete(ws);
    });
  });
}

// ── 适配器健康度 ──────────────────────────────────────────────────────────────
// 区分「这一页不是作品页」（正常丢弃）与「适配器已失效」（会静默丢整段历史）。
// 见 docs/adr/0003 的后果条：用户自己写适配器，改版是常态，静默失效是头号故障。
// 在 init() 里按已加载的适配器建，故用 let。
let adapterHealth;

// 未归属数 + 每适配器命中情况 + 歧义作品列表：健康度视图读它，一条访问的广播也带它。
function healthSnapshot() {
  return {
    unattributedCount: store.getUnattributedCount(),
    adapters: adapterHealth.snapshot(),
    ambiguousWorks: store.getAmbiguousWorks(),
  };
}

function handleExtensionMessage(ws, msg) {
  switch (msg.type) {
    case "addRecord": {
      // 一条访问走一条通道：列表页 → 闸门 → 身份键 → 同组同路径去重 → 当日计分 →
      // 作品归属 → 落库，全部在 store 内一次判完（docs/adr/0002）。
      // store.recordVisit 自己发出那唯一一条 recordAdded/recordUpdated 广播
      // （带访问 + 作品行 + 统计），这里只补适配器健康度。
      const result = store.recordVisit(msg);
      const dropped = result.action === "drop";
      // 列表页是适配器声明过的正常页面，不算适配器失效（ADR-0005）。
      if (result.reason !== "list-page") adapterHealth.noteVisit(result, msg.domain);
      // 命中与丢弃都各记一次，健康度独立于 recordAdded 广播推给界面。
      broadcastToExtensions({
        type: "adapterHealthUpdated",
        health: healthSnapshot(),
      });
      if (dropped || result.action === "ignore") return;

      // 身份键指向多部作品：按 ADR-0002 那是「误合」风险，不静默合并，
      // 只报到日志等用户裁决（记录已经照常落库）。
      if (result.ambiguous) {
        console.warn(
          "[Works] 身份键指向多个作品，需要用户裁决:",
          JSON.stringify(result.keys),
        );
      }
      break;
    }
    case "getStats": {
      const { total, stats } = store.getRuleStats();
      ws.send(JSON.stringify({ type: "stats", total, stats, enabled: store.getEnabled() }));
      break;
    }
    case "updateWatchlist": {
      store.updateWatchlist(msg.watchlist);
      break;
    }
    case "updateEnabled": {
      store.setEnabled(msg.enabled);
      break;
    }
    case "clearRecords": {
      store.clearRecords();
      break;
    }
    case "recordUpdated": {
      if (msg.record) {
        store.updateRecord(msg.record.id, {
          pinned: msg.record.pinned ? 1 : 0,
          score: msg.record.score,
          description: msg.record.description || "",
          ogImage: msg.record.ogImage || "",
          dwellTime: msg.record.dwellTime || 0,
        });
      }
      break;
    }
    case "exportData": {
      ws.send(JSON.stringify({
        type: "exportData",
        watchlist: store.getWatchlist(),
        records: store.getAllRecords(),
      }));
      break;
    }
  }
}

// ── Reflection ───────────────────────────────────────────────────────────────

async function triggerReflectionOnDelete(deletedRecords) {
  try {
    const prompt = store.buildDeleteReflectionPrompt(deletedRecords);
    const reflection = await reflectPrompt(aiProviders, prompt);
    applyReflection(store.upsertMemory.bind(store), reflection, null);
  } catch (e) {
    console.error("Reflection on delete error:", e);
  }
}

// ── 候选抓取 ────────────────────────────────────────────────────────────────
// ADR-0005：适配器声明列表页，App 用**隐藏 BrowserWindow** 载入并执行站点的 JS，
// 然后在渲染后的 DOM 上跑与扩展**同一套** collect 选择器（同一个自足函数）。
// 只在用户点击时触发，不登记不抓，也不翻分页。

/** 在隐藏窗口里把一个列表页渲染出来，抽出条目；失败抛出（不静默）。 */
async function loadListEntries(listDecl, pageUrl) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const destroy = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        win.webContents.removeAllListeners();
        reject(new Error("列表页载入超时"));
      }, 20000);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once("did-fail-load", (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`列表页载入失败 ${code} ${desc}`));
      });
      win.loadURL(pageUrl);
    });
    const expr = `(${collectListEntries.toString()})(${JSON.stringify(listDecl)}, document, location.href)`;
    // SPA 的 did-finish-load 早于列表出现：轮询到条目出现为止（ADR-0005）。
    for (let i = 0; i < 25; i++) {
      const entries = await win.webContents.executeJavaScript(expr, true);
      if (entries && entries.length) return entries;
      await new Promise((r) => setTimeout(r, 200));
    }
    return [];
  } finally {
    destroy();
  }
}

/** 点击「抓取候选」后：每个登记站点声明的列表页抓一次，条目落成候选。 */
async function fetchCandidates() {
  const targets = listFetchTargets(store.getAdapters(), store.getWatchlist());
  const failures = [];
  let inserted = 0;
  let updated = 0;
  for (const target of targets) {
    try {
      const entries = await loadListEntries(target.list, target.url);
      const result = store.importCandidates({
        adapterFile: target.adapterFile,
        listName: target.listName,
        domain: target.domain,
        matchedRule: target.matchedRule,
        groupLabel: target.groupLabel,
        entries,
      });
      inserted += result.inserted;
      updated += result.updated;
    } catch (e) {
      // 抓取失败必须可见，不能静默（ADR-0005）。
      failures.push({ url: target.url, error: e.message });
    }
  }
  return { fetched: targets.length, inserted, updated, failures };
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const bounds = store.getWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds ? bounds.width : 960,
    height: bounds ? bounds.height : 680,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 750,
    minHeight: 500,
    title: "Acuminata",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.on("close", () => {
    store.saveWindowBounds(mainWindow.getBounds());
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

app.whenReady().then(init);

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

module.exports = { app };
