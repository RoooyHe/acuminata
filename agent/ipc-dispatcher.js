// IPCDispatcher — maps channel names to RecordStore methods.
// Replaces scattered ipcMain.handle calls with a single registration point.

const { shell } = require("electron");

function createIPCDispatcher(ipcMain, store, deps = {}) {
  const { providers, executeTool, getAdapterHealth } = deps;
  const readStore = store.getAgentReadStore();

  ipcMain.handle("records:page", (_, page, pageSize, filter) =>
    store.getRecordsPage(page, pageSize, filter),
  );

  ipcMain.handle("works:page", (_, page, pageSize, options) =>
    store.getWorksPage(page, pageSize, options),
  );

  ipcMain.handle("works:unattributed", (_, page, pageSize, search) =>
    store.getUnattributedPage(page, pageSize, search),
  );

  // 归属健康度：未归属访问数 + 每站点适配器命中情况。
  ipcMain.handle("works:health", () => ({
    unattributedCount: store.getUnattributedCount(),
    adapters: getAdapterHealth(),
  }));

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

  ipcMain.handle("records:open-url", (_, url) => {
    try {
      const u = new URL(url);
      const watchlist = store.getWatchlist();
      const entry = watchlist.find(
        (w) => w.domain === u.hostname || url.includes(w.domain),
      );
      if (entry) {
        const groupLabel = entry.label || entry.domain;
        const groupDomains = watchlist
          .filter((w) => (w.label || w.domain) === groupLabel)
          .map((w) => w.domain);
        if (groupDomains.length > 1) {
          const placeholders = groupDomains.map(() => "?").join(",");
          const latest = store._dbGet(
            `SELECT domain FROM records WHERE matchedRule IN (${placeholders}) ORDER BY timestamp DESC LIMIT 1`,
            groupDomains,
          );
          if (latest && latest.domain) {
            u.hostname = latest.domain;
            shell.openExternal(u.toString());
            return;
          }
        }
      }
    } catch (e) {
      // ignore
    }
    shell.openExternal(url);
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
    for (const id of actionIds) store.resolvePendingAction(id, "approved");
    store._emit("agentPendingUpdated", store.getPendingActions());
    return results;
  });

  ipcMain.handle("agent:dismiss", (_, actionIds) => {
    for (const id of actionIds) store.resolvePendingAction(id, "dismissed");
    store._emit("agentPendingUpdated", store.getPendingActions());
    return { dismissed: actionIds.length };
  });

  ipcMain.handle("agent:profile", () => store.buildAgentProfile());

  ipcMain.handle("agent:analyze", async (_, customCommand) => {
    return triggerAnalysis(store, providers, executeTool, customCommand);
  });

  ipcMain.handle("agent:auto-clean", async () => {
    return autoClean(store, providers, executeTool);
  });
}

// ── Agent Analysis ───────────────────────────────────────────────────────────

const {
  agentLoop,
  executeApprovedActions,
} = require("./executor");

const {
  buildAnalysisPrompt,
} = require("./prompts");

async function triggerAnalysis(store, providers, executeTool, customCommand) {
  try {
    const records = store.extractHighValueRecords();
    if (records.length === 0) {
      return { error: "No high-value records to analyze.", keywords: [], summary: "" };
    }

    const sysMsg = `You are a private content recommendation expert. You have access to tools to explore the user's browsing history. Use them to gain deeper insights.

First, call search_records to sample recent records across different domains.
Then call get_statistics to understand the distribution.
Finally, call get_agent_profile to incorporate past learnings.

After gathering data, produce a final analysis as a JSON object:
{ "summary": "One sentence summary of user preferences in the user's language", "keywords": ["keyword1", "keyword2", ...] }

Always respond in the same language as the user's records. Be concise.`;

    const watchlist = store.getWatchlist();
    const ruleToLabel = {};
    watchlist.forEach((w) => {
      ruleToLabel[w.domain] = w.label || w.domain;
    });

    const recordSummary = records
      .slice(0, 10)
      .map((r) => {
        const label = ruleToLabel[r.matchedRule] || r.matchedRule;
        return `[${label}] ${(r.title || "").slice(0, 80)} (score:${r.score || 0})`;
      })
      .join("\n");

    const userMsg = `User has ${records.length} high-value records. Sample:\n${recordSummary}\n\nAnalyze their preferences thoroughly using the available tools.`;

    const messages = [
      { role: "system", content: sysMsg },
      { role: "user", content: userMsg },
    ];

    const convId = store.createConversation("analysis", sysMsg);
    store.insertMessage(convId, 0, "user", userMsg, null, null);

    const { result, pendingActions } = await agentLoop(
      messages,
      providers,
      executeTool,
      (type, data) => store._emit(type, data),
      convId,
      store.insertMessage.bind(store),
    );

    store.completeConversation(convId, result || "");

    for (const a of pendingActions) {
      store.insertPendingAction(convId, a.tool, a.args);
    }
    if (pendingActions.length > 0) {
      store._emit("agentPendingUpdated", store.getPendingActions());
    }

    const jsonStr = providers.extractJson(result || "");
    let analysis = { summary: "", keywords: [] };
    if (jsonStr) {
      try { analysis = JSON.parse(jsonStr); } catch (e) {}
    }
    if (!analysis.summary && result) {
      analysis.summary = result.slice(0, 200);
    }

    return {
      summary: analysis.summary || "",
      keywords: analysis.keywords || [],
      recordsAnalyzed: records.length,
      pendingActions: pendingActions.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function autoClean(store, providers, executeTool) {
  try {
    const profile = store.buildAgentProfile();
    const stats = executeTool("get_statistics", {});
    const watchlistData = executeTool("get_watchlist", {});

    const sysMsg = `You are a browsing history cleaning assistant. Analyze the user's data and identify records that should be cleaned up. Consider three scenarios:
1. Dead domains: domains in watchlist that have no records in the last 7 days
2. Regex mismatches: records that exist under a group but don't match any active regex filter
3. Low-engagement: records that are not pinned, have score 0 or NULL, and were created more than 14 days ago

Suggest deletions by calling the delete_records tool for junk records, and update_regex_rule if filters need tightening.`;

    const userMsg = `Current statistics: ${JSON.stringify(stats)}\nWatchlist: ${JSON.stringify(watchlistData)}\nUser anti-patterns: ${JSON.stringify(profile.antiPatterns)}\n\nPlease scan the records and suggest cleanup actions.`;

    const messages = [
      { role: "system", content: sysMsg },
      { role: "user", content: userMsg },
    ];

    const convId = store.createConversation("auto_clean", sysMsg);
    store.insertMessage(convId, 0, "user", userMsg, null, null);

    const { result, pendingActions } = await agentLoop(
      messages,
      providers,
      executeTool,
      (type, data) => store._emit(type, data),
      convId,
      store.insertMessage.bind(store),
    );
    store.completeConversation(convId, result || "");

    for (const a of pendingActions) {
      store.insertPendingAction(convId, a.tool, a.args);
    }
    if (pendingActions.length > 0) {
      store._emit("agentPendingUpdated", store.getPendingActions());
    }

    return { result, pendingActions };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { createIPCDispatcher };
