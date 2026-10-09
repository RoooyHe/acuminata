// Sandboxed preload: may only require `electron` (local requires are not allowed
// under sandbox:true). Shared view-model utils reach the renderer via <script>.
const { contextBridge, ipcRenderer } = require("electron");

// ── Route table ──────────────────────────────────────────────────────────────
// Single list of every renderer-callable surface.
//   name    → property exposed on window.electronAPI
//   channel → IPC channel; must match a handler registered by agent/ipc-dispatcher.js
//   invoke  → true: ipcRenderer.invoke, false: ipcRenderer.on (main → renderer event)

const ROUTES = [
  // Records
  { name: "getRecordsPage", channel: "records:page", invoke: true },
  { name: "getWorksPage", channel: "works:page", invoke: true },
  { name: "getWorkDetail", channel: "works:detail", invoke: true },
  { name: "getWorkHealth", channel: "works:health", invoke: true },
  { name: "getUnattributedPage", channel: "works:unattributed", invoke: true },
  { name: "backfillWorks", channel: "works:backfill", invoke: true },
  { name: "reparseWorks", channel: "works:reparse", invoke: true },
  { name: "getRecords", channel: "records:list", invoke: true },
  { name: "getStatistics", channel: "records:stats", invoke: true },
  { name: "clearRecords", channel: "records:clear", invoke: true },
  { name: "deleteRecords", channel: "records:delete", invoke: true },
  { name: "exportData", channel: "records:export", invoke: true },
  { name: "toggleRecordPin", channel: "records:pin", invoke: true },
  { name: "openUrl", channel: "records:open-url", invoke: true },
  // Watchlist
  { name: "getWatchlist", channel: "watchlist:get", invoke: true },
  { name: "addToWatchlist", channel: "watchlist:add", invoke: true },
  { name: "removeFromWatchlist", channel: "watchlist:remove", invoke: true },
  // Settings
  { name: "getEnabled", channel: "settings:enabled", invoke: true },
  { name: "setEnabled", channel: "settings:set-enabled", invoke: true },
  { name: "getBounds", channel: "settings:bounds", invoke: true },
  { name: "saveBounds", channel: "settings:save-bounds", invoke: true },
  // Locale
  { name: "getLocale", channel: "locale:get", invoke: true },
  { name: "setLocale", channel: "locale:set", invoke: true },
  // AI
  { name: "getAiConfig", channel: "ai:config:get", invoke: true },
  { name: "setAiConfig", channel: "ai:config:set", invoke: true },
  // Recommendations
  { name: "getRecommendations", channel: "recommendations:list", invoke: true },
  { name: "rejectRecommendation", channel: "recommendations:reject", invoke: true },
  { name: "acceptRecommendation", channel: "recommendations:accept", invoke: true },
  { name: "clearRecommendations", channel: "recommendations:clear", invoke: true },
  // Agent
  { name: "agentGetPending", channel: "agent:pending", invoke: true },
  { name: "agentApproveActions", channel: "agent:approve", invoke: true },
  { name: "agentDismissActions", channel: "agent:dismiss", invoke: true },
  { name: "agentGetProfile", channel: "agent:profile", invoke: true },
  { name: "triggerAgentAnalysis", channel: "agent:analyze", invoke: true },
  { name: "agentAutoClean", channel: "agent:auto-clean", invoke: true },
  // Data-update events (broadcast from main)
  { name: "onUpdate", channel: "data-update", invoke: false },
];

// ── Generate API ─────────────────────────────────────────────────────────────

const api = {};

for (const route of ROUTES) {
  if (route.invoke) {
    api[route.name] = (...args) => ipcRenderer.invoke(route.channel, ...args);
  } else {
    api[route.name] = (callback) =>
      ipcRenderer.on(route.channel, (_, data) => callback(data));
  }
}

contextBridge.exposeInMainWorld("electronAPI", api);

// Exposed for the IPC contract test so preload's channel list is not a second
// handwritten copy that can silently drift from the dispatcher's handlers.
if (typeof module !== "undefined" && module.exports) module.exports = { ROUTES };
