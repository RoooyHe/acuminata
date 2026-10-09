const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const { RecordStore } = require("./agent/record-store");
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
const { reflectPrompt } = require("./agent/analysis-pipeline");
const { applyReflection } = require("./agent/reflect");

const EXTENSION_PORT = 8766;
// Explicit override only (used by the smoke test); otherwise the user's real DB.
const DB_PATH = process.env.ACUMINATA_DB_PATH
  ? process.env.ACUMINATA_DB_PATH
  : path.join(app.getPath("userData"), "tracker.db");

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
  store = new RecordStore(DB_PATH, (type, data) => {
    broadcastToExtensions({ type, ...data });
  });

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

    ws.send(JSON.stringify({ type: "init", watchlist: store.getWatchlist(), enabled: store.getEnabled() }));

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
const adapterHealth = createAdapterHealth();

function handleExtensionMessage(ws, msg) {
  switch (msg.type) {
    case "addRecord": {
      // 一条访问走一条通道：闸门 → 身份键 → 同组同路径去重 → 当日计分 →
      // 作品归属 → 落库，全部在 store 内一次判完（docs/adr/0002）。
      const result = store.recordVisit(msg);
      const dropped = result.action === "drop";
      adapterHealth.note(msg.domain, !dropped);
      // 丢弃/去重都不产生 recordAdded 广播。健康度得自己推一次，
      // 否则「连续丢弃且从未命中」的站点要等下一次无关更新才看得见。
      if (dropped || result.action === "ignore") {
        broadcastToExtensions({
          type: "adapterHealthUpdated",
          adapters: adapterHealth.snapshot(),
        });
        return;
      }

      // 身份键指向多部作品：按 ADR-0002 那是「误合」风险，不静默合并，
      // 只报到日志等用户裁决（记录已经照常落库）。
      if (result.ambiguous) {
        console.warn(
          "[Works] 身份键指向多个作品，需要用户裁决:",
          JSON.stringify(result.keys),
        );
      }

      broadcastToExtensions({
        type: result.action === "update" ? "recordUpdated" : "recordAdded",
        record: result.record,
      });
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
