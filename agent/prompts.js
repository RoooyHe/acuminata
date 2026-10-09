// Agent prompt builders — pure functions, no side effects.
// 所有模型提示词的构建处（见 docs/adr/0009）：兴趣归纳、自动清理、
// 删除反思、拒绝推荐都在这里。核对「提示词带了哪些字段」只看这个文件；
// 工具结果另见 agent/tools.js。扩展不再自行拼接提示词或直连模型。

/**
 * Build the tool-driven interest-analysis messages for the agent loop.
 * The analysis prompt half of the outgoing boundary (see docs/adr/0009);
 * tool results are declared separately in agent/tools.js.
 * @param {Array<{title?:string, matchedRule:string, score?:number|null}>} records
 * @param {Array<{domain:string, label?:string}>} watchlist
 * @returns {Array<{role:string, content:string}>}
 */
function buildAnalysisMessages(records, watchlist) {
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

  const sysMsg = `You are a private content recommendation expert. You have access to tools to explore the user's browsing history. Use them to gain deeper insights.

First, call search_records to sample recent records across different domains.
Then call get_statistics to understand the distribution.
Finally, call get_agent_profile to incorporate past learnings.

After gathering data, produce a final analysis as a JSON object:
{ "summary": "One sentence summary of user preferences in the user's language", "keywords": ["keyword1", "keyword2", ...] }

Always respond in the same language as the user's records. Be concise.`;

  const userMsg = `User has ${records.length} high-value records. Sample:\n${recordSummary}\n\nAnalyze their preferences thoroughly using the available tools.`;

  return [
    { role: "system", content: sysMsg },
    { role: "user", content: userMsg },
  ];
}

/**
 * Build the tool-driven cleanup messages for the agent loop.
 * @param {object} stats
 * @param {object} watchlistData
 * @param {{antiPatterns?:Array}} profile
 * @returns {Array<{role:string, content:string}>}
 */
function buildAutoCleanMessages(stats, watchlistData, profile) {
  const sysMsg = `You are a browsing history cleaning assistant. Analyze the user's data and identify records that should be cleaned up. Consider three scenarios:
1. Dead domains: domains in watchlist that have no records in the last 7 days
2. Regex mismatches: records that exist under a group but don't match any active regex filter
3. Low-engagement: records that are not pinned, have score 0 or NULL, and were created more than 14 days ago

Suggest deletions by calling the delete_records tool for junk records, and update_regex_rule if filters need tightening.`;

  const userMsg = `Current statistics: ${JSON.stringify(stats)}\nWatchlist: ${JSON.stringify(watchlistData)}\nUser anti-patterns: ${JSON.stringify(profile.antiPatterns)}\n\nPlease scan the records and suggest cleanup actions.`;

  return [
    { role: "system", content: sysMsg },
    { role: "user", content: userMsg },
  ];
}

/**
 * Build the reflection prompt after a batch delete.
 * @param {Array} deletedRecords
 * @param {Array} sampleKept
 * @returns {string}
 */
function buildDeleteReflectionPrompt(deletedRecords, sampleKept) {
  const deletedSummary = deletedRecords
    .slice(0, 20)
    .map((r) => `- [${r.matchedRule}] ${(r.title || r.url).slice(0, 80)}`)
    .join("\n");
  const keptSummary = sampleKept
    .slice(0, 10)
    .map((r) => `- [${r.matchedRule}] ${(r.title || r.url).slice(0, 80)} (score:${r.score || 0})`)
    .join("\n");

  return (
    "你是一个学习用户偏好的智能代理。用户刚刚删除了以下浏览记录:\n" +
    deletedSummary + "\n\n" +
    "用户保留的高价值记录（样本）:\n" +
    keptSummary + "\n\n" +
    "请分析用户为什么删除这些记录（而不是保留它们），并将分析结果更新到用户档案。\n" +
    "返回严格的 JSON 格式，不要包含任何额外文本：\n" +
    '{ "insight": "一句话总结用户的删除意图", "antiPatterns": ["新增的负面偏好关键词或模式"], "preferredDomains": { "域名": 0.8 }, "profileUpdate": "简要描述档案变更" }'
  );
}

/**
 * Build the reflection prompt after rejecting a recommendation.
 * @param {{title:string, url:string, domain:string, reason?:string}} rec
 * @param {Array} sampleKept
 * @returns {string}
 */
function buildRejectReflectionPrompt(rec, sampleKept) {
  const keptSummary = sampleKept
    .slice(0, 10)
    .map((r) => `- [${r.matchedRule}] ${(r.title || r.url).slice(0, 80)} (score:${r.score || 0})`)
    .join("\n");

  return (
    "你是一个学习用户偏好的智能代理。用户拒绝了一条 AI 推荐：\n" +
    `- 标题: ${rec.title}\n` +
    `- URL: ${rec.url}\n` +
    `- 域名: ${rec.domain}\n` +
    `- 推荐理由: ${rec.reason || "无"}\n\n` +
    "用户保留的高价值记录（样本）:\n" +
    keptSummary + "\n\n" +
    "请分析用户为什么拒绝这条推荐，并总结出可以避免的规律。\n" +
    "返回严格的 JSON 格式，不要包含任何额外文本：\n" +
    '{ "insight": "一句话总结拒绝原因", "antiPatterns": ["应避免的推荐关键词或模式"], "preferredDomains": { "域名": 0.8 }, "profileUpdate": "简要描述档案变更" }'
  );
}

module.exports = {
  buildAnalysisMessages,
  buildAutoCleanMessages,
  buildDeleteReflectionPrompt,
  buildRejectReflectionPrompt,
};
