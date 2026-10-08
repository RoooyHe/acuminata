// Pure tool handler computations for the agent.
// Read handlers receive a read-only store; write handlers receive the same context
// and only compute. The orchestrator applies their _sideEffects through named
// store operations — no raw SQL here.
// No side effects here: no DB writes, no broadcasts, no queue mutations.

function searchRecords(args, ctx) {
  const read = ctx.readStore;
  const query = args.query || "";
  const limit = Math.min(args.limit || 50, 200);
  const minScore = args.min_score || 0;
  const domain = args.domain || "";
  return read.searchRecords(query, limit, minScore, domain);
}

function getRecordDetails(args, ctx) {
  return ctx.readStore.getRecordDetails(args.id) || { error: "Record not found" };
}

function getStatistics(args, ctx) {
  return ctx.readStore.getStatistics();
}

function getRecommendations(args, ctx) {
  const status = args.status !== undefined ? args.status : 0;
  const limit = args.limit || 50;
  return ctx.readStore.getRecommendations(status, limit);
}

function getWatchlist(args, ctx) {
  const wl = ctx.readStore.getWatchlist();
  return { watchlist: wl, count: wl.length };
}

function getAgentProfile(args, ctx) {
  return ctx.readStore.getAgentProfile();
}

function deleteRecords(args, ctx) {
  const ids = args.ids;
  if (!ids || ids.length === 0) return { error: "No IDs provided" };
  return {
    reason: args.reason || "",
    _sideEffects: {
      deleteIds: ids,
      reason: args.reason || "",
    },
  };
}

function updateRegexRule(args, ctx) {
  const domain = args.domain;
  const regexFilter = args.regex_filter || "";
  const regexTarget = args.regex_target || "url";
  const idx = ctx.watchlist.findIndex((w) => w.domain === domain);
  if (idx === -1) return { error: "Domain not found in watchlist" };
  return {
    updated: domain,
    regex_filter: regexFilter,
    regex_target: regexTarget,
    reason: args.reason || "",
    _sideEffects: {
      domain,
      regexFilter,
      regexTarget,
      reason: args.reason || "",
    },
  };
}

function updateRecordScore(args, ctx) {
  const id = args.id;
  const score = Math.max(0, Math.min(100, args.score || 0));
  return {
    updated: id,
    score,
    _sideEffects: {
      id,
      score,
    },
  };
}

function addRecord(args, ctx) {
  const now = Date.now();
  const record = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    url: args.url,
    title: args.title || "",
    domain: args.domain,
    matchedRule: args.matched_rule,
    tabId: 0,
    timestamp: now,
  };
  return {
    added: record.id,
    url: args.url,
    reason: args.reason || "",
    _sideEffects: {
      record,
      reason: args.reason || "",
    },
  };
}

const HANDLERS = {
  search_records: searchRecords,
  get_record_details: getRecordDetails,
  get_statistics: getStatistics,
  get_recommendations: getRecommendations,
  get_watchlist: getWatchlist,
  get_agent_profile: getAgentProfile,
  delete_records: deleteRecords,
  update_regex_rule: updateRegexRule,
  update_record_score: updateRecordScore,
  add_record: addRecord,
};

function getHandler(name) {
  return HANDLERS[name];
}

function getAllHandlerNames() {
  return Object.keys(HANDLERS);
}

module.exports = {
  HANDLERS,
  getHandler,
  getAllHandlerNames,
};
