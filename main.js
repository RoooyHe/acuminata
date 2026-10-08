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
const { evaluateIncoming } = require("./agent/cluster");
const { createAdapterHealth } = require("./agent/adapter-health");

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
      const nowTs = Date.now();
      const findExisting = (groupDomains, path) => {
        const placeholders = groupDomains.map(() => "?").join(",");
        const groupRecords = store._dbAll(
          `SELECT * FROM records WHERE matchedRule IN (${placeholders}) ORDER BY timestamp DESC`,
          groupDomains,
        );
        for (const r of groupRecords) {
          try {
            const u = new URL(r.url);
            if (u.pathname + u.search + u.hash === path) return r;
          } catch (e) {
            if (r.url === path) return r;
          }
        }
        return null;
      };

      const result = evaluateIncoming(msg, store.getWatchlist(), findExisting);
      const dropped = result.action === "drop";
      adapterHealth.note(msg.domain, !dropped);
      // 丢弃/去重都不产生 recordAdded 广播。健康度得自己推一次，
      // 否则「连续丢弃且从未命中」的站点要等下一次无关更新才看得见。
      if (dropped || result.action === "ignore") {
        broadcastToExtensions({
          type: "adapterHealthUpdated",
          adapters: adapterHealth.snapshot(),
        });
      }

      if (result.action === "drop" || result.action === "ignore") return;

      // 作品归属：身份键 → works（docs/adr/0007）。
      // 产不出键时 work 为 null，记录照常存在，只是归不到作品——降级而非丢弃。
      const visit = store.recordWorkVisit({
        keys: result.keys,
        title: (result.record && result.record.title) || msg.title,
        timestamp: nowTs,
      });
      if (visit.ambiguous) {
        console.warn(
          "[Works] 身份键指向多个作品，需要用户裁决:",
          JSON.stringify(result.keys),
        );
      }
      const workId = visit.work ? visit.work.id : null;

      if (result.action === "update") {
        store.updateRecord(result.record.id, {
          url: result.updates.url,
          domain: result.updates.domain,
          matchedRule: result.updates.matchedRule,
          pinned: result.updates.pinned,
          score: result.updates.score,
          timestamp: result.updates.timestamp,
          updatedAt: result.updates.updatedAt,
          workId,
          edition: (result.extracted && result.extracted.edition) || "",
        });
        broadcastToExtensions({ type: "recordUpdated", record: result.record });
        return;
      }

      // insert
      msg.timestamp = nowTs;
      msg.workId = workId;
      // 适配器的命名捕获组抠出的**版本**随访问落库（来源 = 站点 + 版本）。
      msg.edition = (result.extracted && result.extracted.edition) || "";
      const record = store.insertRecord(msg);
      broadcastToExtensions({ type: "recordAdded", record });
      break;
    }
    case "getStats": {
      const stats = {};
      const rows = store._dbAll(
        "SELECT matchedRule, COUNT(*) as count FROM records GROUP BY matchedRule",
      );
      for (const r of rows) stats[r.matchedRule] = r.count;
      const total = store._dbGetScalar("SELECT COUNT(*) as count FROM records");
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
    const response = await aiProviders.callText(prompt);
    const jsonStr = aiProviders.extractJson(response);
    if (jsonStr) {
      const reflection = JSON.parse(jsonStr);
      applyReflection(store, reflection, null);
    }
  } catch (e) {
    console.error("Reflection on delete error:", e);
  }
}

function applyReflection(store, reflection, sourceConvId) {
  if (!reflection || typeof reflection !== "object") return;
  const nowTs = Date.now();

  if (reflection.insight) {
    store.upsertMemory(
      "insight",
      "reflection_" + nowTs,
      JSON.stringify({ insight: reflection.insight, profileUpdate: reflection.profileUpdate || "", time: nowTs }),
      0.5,
      null,
      JSON.stringify(reflection)
    );
  }
  if (Array.isArray(reflection.antiPatterns)) {
    for (const p of reflection.antiPatterns) {
      if (p && typeof p === "string") {
        store.upsertMemory("anti_pattern", p, p, 0.4, sourceConvId, JSON.stringify(reflection));
      }
    }
  }
  if (reflection.preferredDomains && typeof reflection.preferredDomains === "object") {
    for (const [domain, weight] of Object.entries(reflection.preferredDomains)) {
      const w = Math.min(1, Math.max(0, Number(weight) || 0.5));
      store.upsertMemory("preference", domain, domain, w, sourceConvId, JSON.stringify(reflection));
    }
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
