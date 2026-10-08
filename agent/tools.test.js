// Agent tool execution tests.
// The four write tools must go through named store operations — never a raw SQL
// handle — and the write path must produce the same results and broadcasts.

const { RecordStore } = require("./record-store");
const { createExecuteTool } = require("./tools/orchestrator");
const { getTool } = require("./tools");

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function runTests() {
  const events = [];
  const store = new RecordStore(":memory:", (type, data) =>
    events.push({ type, ...(data || {}) }),
  );
  await store.init();

  const writeStore = store.getAgentWriteStore();
  const executeTool = createExecuteTool({
    writeStore,
    readStore: store.getAgentReadStore(),
    watchlist: store.getWatchlist(),
    triggerReflectionOnDelete: () => {},
    getTool,
  });

  console.log("Agent write store is a narrow interface");
  assert(
    Object.keys(writeStore).sort().join(",") ===
      "addAgentRecord,deleteRecords,updateRecordScore,updateWatchlistRegex",
    "exposes only the four named operations",
  );
  assert(
    !("db" in writeStore) && !("_dbRun" in writeStore) && !("_dbAll" in writeStore),
    "holds no raw SQL handle",
  );

  console.log("\nadd_record");
  const added = executeTool("add_record", {
    url: "https://bilibili.com/v/1",
    title: "作品一",
    domain: "bilibili.com",
    matched_rule: "bilibili.com",
    reason: "推荐",
  });
  assert(typeof added.added === "string" && added.url === "https://bilibili.com/v/1", "returns added id and url");
  assert(added.reason === "推荐", "returns reason");
  const inserted = store.getRecordById(added.added);
  assert(inserted !== null, "record is persisted");
  assert(inserted.pinned === 1 && inserted.score === 1, "agent-added record is pinned and scored 1");
  const addEvent = events.find((e) => e.type === "recordAdded");
  assert(addEvent && addEvent.record && addEvent.record.id === added.added, "broadcasts recordAdded with the record");

  console.log("\nupdate_record_score");
  const scored = executeTool("update_record_score", { id: added.added, score: 42, reason: "好看" });
  assert(scored.updated === added.added && scored.score === 42, "returns updated id and score");
  assert(store.getRecordById(added.added).score === 42, "score is persisted");
  const scoreEvent = events.find((e) => e.type === "recordUpdated");
  assert(scoreEvent && scoreEvent.record && scoreEvent.record.score === 42, "broadcasts recordUpdated with the record");
  const missing = executeTool("update_record_score", { id: "nope", score: 1 });
  assert(missing.error === "Record not found", "unknown record returns an error");
  const clamped = executeTool("update_record_score", { id: added.added, score: 150 });
  assert(clamped.score === 100 && store.getRecordById(added.added).score === 100, "score is clamped to 0..100");

  console.log("\nupdate_regex_rule");
  const regex = executeTool("update_regex_rule", {
    domain: "bilibili.com",
    regex_filter: "a.*b",
    regex_target: "title",
    reason: "收紧",
  });
  assert(regex.updated === "bilibili.com" && regex.regex_filter === "a.*b" && regex.regex_target === "title", "returns the updated rule");
  const entry = store.getWatchlist().find((w) => w.domain === "bilibili.com");
  assert(entry.regexFilter === "a.*b" && entry.regexTarget === "title", "rule is persisted");
  assert(events.some((e) => e.type === "watchlistUpdated" && Array.isArray(e.watchlist)), "broadcasts watchlistUpdated with the watchlist");
  const badDomain = executeTool("update_regex_rule", { domain: "unknown.com", regex_filter: "x" });
  assert(badDomain.error === "Domain not found in watchlist", "unknown domain returns an error");

  console.log("\ndelete_records");
  const deleted = executeTool("delete_records", { ids: [added.added], reason: "清理" });
  assert(deleted.deleted === 1 && deleted.reason === "清理", "returns deleted count and reason");
  assert(store.getRecordById(added.added) === null, "record is gone");
  assert(events.some((e) => e.type === "recordsCleared"), "broadcasts recordsCleared");
  const noIds = executeTool("delete_records", { ids: [] });
  assert(noIds.error === "No IDs provided", "empty ids returns an error");

  console.log("\nread tools and unknown tool");
  const search = executeTool("search_records", { query: "" });
  assert(Array.isArray(search), "search_records returns records");
  const unknown = executeTool("unknown_tool", {});
  assert(unknown.error === "Unknown tool: unknown_tool", "unknown tool returns an error");

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
