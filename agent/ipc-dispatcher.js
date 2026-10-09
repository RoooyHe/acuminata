// IPCDispatcher — maps channel names to RecordStore methods.
// Replaces scattered ipcMain.handle calls with a single registration point.

const { shell } = require("electron");

function createIPCDispatcher(ipcMain, store, deps = {}) {
  const { providers, executeTool, getAdapterHealth, broadcastAgentEvent } = deps;
  const readStore = store.getAgentReadStore();

  ipcMain.handle("records:page", (_, page, pageSize, filter) =>
    store.getRecordsPage(page, pageSize, filter),
  );

  ipcMain.handle("works:page", (_, page, pageSize, options) =>
    store.getWorksPage(page, pageSize, options),
  );

  ipcMain.handle("works:detail", (_, workId) => store.getWorkDetail(workId));

  ipcMain.handle("works:unattributed", (_, page, pageSize, search) =>
    store.getUnattributedPage(page, pageSize, search),
  );

  // 归属健康度：未归属访问数 + 每站点适配器命中情况 + 歧义作品列表。
  ipcMain.handle("works:health", () => ({
    unattributedCount: store.getUnattributedCount(),
    adapters: getAdapterHealth(),
    ambiguousWorks: store.getAmbiguousWorks(),
  }));

  ipcMain.handle("works:backfill", () => store.backfillWorks());

  // 适配器改一次，全历史重跑：清空派生结果后走同一条归属通道（issue #27）。
  ipcMain.handle("works:reparse", () => store.reparseWorks());

  ipcMain.handle("records:list", () => store.getAllRecords());

  ipcMain.handle("records:stats", () => store.getStats());

  ipcMain.handle("records:clear", () => {
    store.clearRecords();
    return true;
  });

  ipcMain.handle("records:delete", (_, ids) => {
    if (!ids || ids.length === 0) return false;
    const result = store.deleteRecords(ids);
    return result.deletedCount > 0;
  });

  ipcMain.handle("records:export", () => {
    return {
      watchlist: store.getWatchlist(),
      records: store.getAllRecords(),
    };
  });

  ipcMain.handle("records:pin", (_, id, pinned, score) => {
    return store.toggleRecordPin(id, pinned, score);
  });

  // 来源解析只有一处：store 把域名换成该分组内最近访问过的镜像，这里只负责打开。
  ipcMain.handle("records:open-url", (_, url) => {
    shell.openExternal(store.resolveOpenUrl(url));
  });

  ipcMain.handle("watchlist:get", () => store.getWatchlist());

  ipcMain.handle("watchlist:add", (_, entry) => {
    return store.addWatchlist(entry);
  });

  ipcMain.handle("watchlist:remove", (_, domain) => {
    return store.removeWatchlist(domain);
  });

  ipcMain.handle("settings:enabled", () => store.getEnabled());
  ipcMain.handle("settings:set-enabled", (_, val) => {
    store.setEnabled(val);
    return true;
  });

  ipcMain.handle("settings:bounds", () => store.getWindowBounds());
  ipcMain.handle("settings:save-bounds", (_, bounds) => {
    store.saveWindowBounds(bounds);
    return true;
  });

  ipcMain.handle("locale:get", () => store.getLocale());
  ipcMain.handle("locale:set", (_, code) => {
    store.setLocale(code);
    return true;
  });

  ipcMain.handle("ai:config:get", () => store.getAIConfig());
  ipcMain.handle("ai:config:set", (_, config) => {
    store.setAIConfig(config);
    return true;
  });

  ipcMain.handle("recommendations:list", () => store.getRecommendations());
  ipcMain.handle("recommendations:reject", (_, id) => {
    store.rejectRecommendation(id);
    return true;
  });
  ipcMain.handle("recommendations:accept", (_, id) => {
    const record = store.acceptRecommendation(id);
    return record;
  });
  ipcMain.handle("recommendations:clear", () => {
    store.clearRecommendations();
    return true;
  });

  ipcMain.handle("agent:pending", () => store.getPendingActions());

  ipcMain.handle("agent:approve", async (_, actionIds) => {
    const results = await executeApprovedActions(
      actionIds,
      executeTool,
      store.getPendingActions.bind(store),
    );
    store.resolvePendingActions(actionIds, "approved");
    return results;
  });

  ipcMain.handle("agent:dismiss", (_, actionIds) => {
    store.resolvePendingActions(actionIds, "dismissed");
    return { dismissed: actionIds.length };
  });

  ipcMain.handle("agent:profile", () => store.buildAgentProfile());

  ipcMain.handle("agent:analyze", async (_, customCommand) => {
    return triggerAnalysis(store, providers, executeTool, broadcastAgentEvent, customCommand);
  });

  ipcMain.handle("agent:auto-clean", async () => {
    return autoClean(store, providers, executeTool, broadcastAgentEvent);
  });
}

// ── Agent Analysis ───────────────────────────────────────────────────────────

const {
  agentLoop,
  executeApprovedActions,
} = require("./executor");

const { analysisFromReply } = require("./analysis-pipeline");
const { buildAnalysisMessages, buildAutoCleanMessages } = require("./prompts");

async function triggerAnalysis(store, providers, executeTool, broadcastAgentEvent, customCommand) {
  try {
    const records = store.extractHighValueRecords();
    if (records.length === 0) {
      return { error: "No high-value records to analyze.", keywords: [], summary: "" };
    }

    const messages = buildAnalysisMessages(records, store.getWatchlist());
    const [sysMsg, userMsg] = messages;

    const convId = store.createConversation("analysis", sysMsg.content);
    store.insertMessage(convId, 0, "user", userMsg.content, null, null);

    const { result, pendingActions } = await agentLoop(
      messages,
      providers,
      executeTool,
      broadcastAgentEvent,
      convId,
      store.insertMessage.bind(store),
    );

    store.completeConversation(convId, result || "");

    // 入队顺带广播队列现状——队列变化的可见性归 store。
    store.insertPendingActions(convId, pendingActions);

    const analysis = analysisFromReply(providers, result || "");

    return {
      summary: analysis.summary,
      keywords: analysis.keywords,
      recordsAnalyzed: records.length,
      pendingActions: pendingActions.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function autoClean(store, providers, executeTool, broadcastAgentEvent) {
  try {
    const profile = store.buildAgentProfile();
    const stats = executeTool("get_statistics", {});
    const watchlistData = executeTool("get_watchlist", {});

    const messages = buildAutoCleanMessages(stats, watchlistData, profile);
    const [sysMsg, userMsg] = messages;

    const convId = store.createConversation("auto_clean", sysMsg.content);
    store.insertMessage(convId, 0, "user", userMsg.content, null, null);

    const { result, pendingActions } = await agentLoop(
      messages,
      providers,
      executeTool,
      broadcastAgentEvent,
      convId,
      store.insertMessage.bind(store),
    );
    store.completeConversation(convId, result || "");

    store.insertPendingActions(convId, pendingActions);

    return { result, pendingActions };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { createIPCDispatcher };
