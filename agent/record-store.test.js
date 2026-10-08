// Unit tests for RecordStore
const { RecordStore } = require("./record-store");
const path = require("path");
const fs = require("fs");

// Use an in-memory SQLite DB for tests
const TEST_DB = ":memory:";

function createStore() {
  const store = new RecordStore(TEST_DB, () => {});
  return store;
}

async function initStore() {
  const store = createStore();
  await store.init();
  return store;
}

// Test utilities
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function runTests() {
  console.log("Running RecordStore tests...\n");

  // Test 1: Initialization
  console.log("Test: Initialization");
  const store = await initStore();
  assert(store.db !== null, "Database is initialized");
  assert(store.getWatchlist().length === 1, "Default watchlist has 1 entry");
  assert(store.getWatchlist()[0].domain === "bilibili.com", "Default domain is bilibili.com");

  // Test 2: Watchlist CRUD
  console.log("\nTest: Watchlist CRUD");
  assert(store.addWatchlist({ domain: "example.com", label: "Example", color: "#fff" }) === true, "Add watchlist entry");
  assert(store.addWatchlist({ domain: "example.com", label: "Duplicate", color: "#fff" }) === false, "Duplicate add returns false");
  assert(store.getWatchlist().length === 2, "Watchlist has 2 entries");
  assert(store.removeWatchlist("example.com") === true, "Remove watchlist entry");
  assert(store.removeWatchlist("nonexistent.com") === false, "Remove nonexistent returns false");
  assert(store.getWatchlist().length === 1, "Watchlist back to 1 entry");

  // Test 3: Records CRUD
  console.log("\nTest: Records CRUD");
  const record = {
    id: "test-1",
    url: "https://example.com/video/1",
    title: "Test Video",
    domain: "example.com",
    matchedRule: "example.com",
    tabId: 1,
    timestamp: Date.now(),
    score: 0,
  };
  const inserted = store.insertRecord(record);
  assert(inserted.id === "test-1", "Inserted record has correct id");
  assert(inserted.title === "Test Video", "Inserted record has correct title");

  const fetched = store.getRecordById("test-1");
  assert(fetched !== null, "Can fetch record by id");
  assert(fetched.url === record.url, "Fetched record has correct url");

  // Test 4: Pagination
  console.log("\nTest: Pagination");
  const page1 = store.getRecordsPage(1, 10, "all");
  assert(page1.records.length === 1, "Page 1 has 1 record");
  assert(page1.total === 1, "Total is 1");
  assert(page1.page === 1, "Page number is 1");
  assert(page1.pageSize === 10, "Page size is 10");

  // Test 5: Search
  console.log("\nTest: Search");
  // Set score so search (score >= 0) can find it
  store.updateRecord("test-1", { score: 0 });
  const searchResults = store.searchRecords("Test", 10);
  assert(searchResults.length === 1, "Search finds 1 result");
  const noResults = store.searchRecords("Nonexistent", 10);
  assert(noResults.length === 0, "Search for nonexistent returns 0");

  // Test 6: Pin/Score
  console.log("\nTest: Pin/Score");
  const pinned = store.toggleRecordPin("test-1", true, 5);
  assert(pinned.pinned === 1, "Record is pinned");
  assert(pinned.score === 5, "Record has score 5");

  // Test 7: Delete
  console.log("\nTest: Delete");
  const deleteResult = store.deleteRecords(["test-1"]);
  assert(deleteResult.deletedCount === 1, "Deleted 1 record");
  assert(store.getRecordById("test-1") === null, "Record is gone after delete");

  // Test 8: Stats
  console.log("\nTest: Stats");
  const stats = store.getStats();
  assert(typeof stats.total === "number", "Stats has total");
  assert(typeof stats.today === "number", "Stats has today");
  assert(typeof stats.domainCounts === "object", "Stats has domainCounts");

  // Test 9: Agent Profile
  console.log("\nTest: Agent Profile");
  const profile = store.buildAgentProfile();
  assert(typeof profile === "object", "Profile is an object");
  assert(Array.isArray(profile.preferences), "Profile has preferences array");
  assert(Array.isArray(profile.antiPatterns), "Profile has antiPatterns array");

  // Test 10: Recommendations
  console.log("\nTest: Recommendations");
  store._dbRun(
    "INSERT INTO recommendations (id, url, title, domain, groupLabel, reason, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["rec-1", "https://example.com", "Test Rec", "example.com", "example.com", "test", 0, Date.now()]
  );
  const recs = store.getRecommendations();
  assert(recs.length === 1, "Got 1 recommendation");
  assert(store.acceptRecommendation("rec-1") !== null, "Accept recommendation creates record");
  assert(store.clearRecommendations() === true, "Clear recommendations works");

  // Test 11: Pending Actions
  console.log("\nTest: Pending Actions");
  store.insertPendingAction("conv-1", "test_tool", { foo: "bar" });
  const pending = store.getPendingActions();
  assert(pending.length === 1, "Got 1 pending action");
  store.resolvePendingAction(pending[0].id, "approved");
  const afterResolve = store.getPendingActions();
  assert(afterResolve.length === 0, "Pending actions cleared after resolve");

  // Test 12: Conversations & Messages
  console.log("\nTest: Conversations & Messages");
  const convId = store.createConversation("test", "system prompt");
  assert(convId !== null, "Conversation created");
  store.insertMessage(convId, 1, "user", "hello", null, null);
  const messages = store._dbAll("SELECT * FROM agent_messages WHERE conversation_id = ?", [convId]);
  assert(messages.length === 1, "Message inserted");
  store.completeConversation(convId, "done");
  const conv = store._dbGet("SELECT * FROM agent_conversations WHERE id = ?", [convId]);
  assert(conv.summary === "done", "Conversation completed");

  // Test 13: Memories
  console.log("\nTest: Memories");
  store.upsertMemory("preference", "dark_mode", "enabled", 0.8, null, null);
  const memories = store.getMemoriesByType("preference");
  assert(memories.length === 1, "Got 1 memory");
  assert(memories[0].key === "dark_mode", "Memory key is correct");

  // Test 14: High-value records extraction
  console.log("\nTest: High-value records extraction");
  store.insertRecord({
    id: "hv-1",
    url: "https://example.com/hv",
    title: "High Value",
    domain: "example.com",
    matchedRule: "example.com",
    tabId: 1,
    timestamp: Date.now(),
    pinned: 1,
    score: 10,
  });
  const hvRecords = store.extractHighValueRecords();
  assert(hvRecords.some((r) => r.id === "hv-1"), "High-value record found");

  // Test 15: Export
  console.log("\nTest: Export");
  const exported = store.export();
  assert(exported instanceof Uint8Array || Buffer.isBuffer(exported), "Export returns buffer");

  // ── Works：跨站融合（本轮的钱测试） ──
  // 用两个站上真实存在的两类身份键模拟：
  //   A 站 → 封面哈希（MacCMS 采集特征）
  //   B 站 → 简介指纹（跨到元数据站后只剩文本）
  console.log("\nTest: Works — 跨站合并到同一部作品（靠共用的简介指纹桥接）");
  {
    const s = await initStore();
    const day1 = new Date(2026, 2, 1, 10).getTime();
    const day2 = new Date(2026, 2, 2, 10).getTime();

    const coverA = [
      { kind: "cover_hash", value: "c0a55b31c915cab3d80e9863f54f2ee0", confidence: "high" },
    ];
    const coverB = [
      { kind: "cover_hash", value: "b777e80aaef56dbd91d0170c561e7a0b", confidence: "high" },
    ];
    const synopsis = [
      { kind: "synopsis", value: "讲述禀承这一生绝对不能被别人替代理念的女白领徐迟", confidence: "medium" },
    ];

    // A 站，第 1 天
    const a = s.recordWorkVisit({
      keys: [...coverA, ...synopsis],
      title: "无可替代",
      timestamp: day1,
    });
    assert(a.created === true, "A 站第一次访问建了作品");
    assert(a.work.score === 1, "作品分数为 1");
    assert(a.ambiguous === false, "不存在歧义");

    // 再回 A 站，同一天：不加分
    const a2 = s.recordWorkVisit({
      keys: [...coverA, ...synopsis],
      title: "无可替代",
      timestamp: day1 + 3600e3,
    });
    assert(a2.work.id === a.work.id, "同一作品");
    assert(a2.work.score === 1, "同一天不加分");

    // B 站，第 2 天：封面图床完全不同（实测两站图床不相交），
    // 但**简介正文逐字相同**（实测相似度 0.8216，共同前缀 66 字）—— 靠它桥接。
    const b = s.recordWorkVisit({
      keys: [...coverB, ...synopsis],
      title: "无可替代（电视猫）",
      timestamp: day2,
    });
    assert(b.work.id === a.work.id, "B 站靠共用简介指纹落到了同一条作品上");
    assert(b.work.score === 2, "跨站累加：第 2 天 +1，分数为 2");

    // 一作品多键：两个站各自的封面哈希都挂在同一条作品下
    const keys = s.getWorkKeys(a.work.id);
    assert(
      keys.filter((k) => k.kind === "cover_hash").length === 2,
      "两个站各自的封面哈希都挂在这部作品下",
    );
    assert(keys.some((k) => k.kind === "synopsis"), "简介指纹也在");
  }

  // ── 硬约束：没有任何共享键值时不合并（宁可拆，不可合） ──
  console.log("\nTest: Works — 无共享键值则不合并");
  {
    const s = await initStore();
    const t = Date.now();
    // 两个站，各自只有自己的封面哈希，图床不同导致哈希不同，也没有别的信号
    const a = s.recordWorkVisit({
      keys: [{ kind: "cover_hash", value: "1".repeat(32), confidence: "high" }],
      title: "同一部剧",
      timestamp: t,
    });
    const b = s.recordWorkVisit({
      keys: [{ kind: "cover_hash", value: "2".repeat(32), confidence: "high" }],
      title: "同一部剧",
      timestamp: t + 86400e3,
    });
    assert(
      a.work.id !== b.work.id,
      "两站没有任何共享键值 → 拆成两条（这是刻意的，误合更贵）",
    );
    assert(s.getWorkKeys(a.work.id).length === 1, "各自的键各归各家");
  }

  // ── 降级：产不出键时不丢记录 ──
  console.log("\nTest: Works — 产不出键时降级，不丢记录");
  {
    const s = await initStore();
    const none = s.recordWorkVisit({ keys: [], title: "未知", timestamp: Date.now() });
    assert(none.work === null, "无键时归不到任何作品");
    assert(none.created === false, "也没有建空作品");

    // 记录本身照常存在
    const rec = s.insertRecord({
      id: "degraded-1",
      url: "https://unknown.example.com/v/9",
      title: "未知",
      domain: "unknown.example.com",
      matchedRule: "unknown.example.com",
      tabId: 1,
      timestamp: Date.now(),
      workId: none.work ? none.work.id : null,
    });
    assert(rec.id === "degraded-1", "历史一条不少，只是没归到作品");
    assert(rec.workId === null || rec.workId === undefined, "workId 为空");
  }

  // ── 低可信度键：既不建作品也不合并（宁可拆，不可合） ──
  console.log("\nTest: Works — 标题键不建也不合");
  {
    const s = await initStore();
    const titleKey = (v) => [{ kind: "title", value: v, confidence: "low" }];
    const a = s.recordWorkVisit({ keys: titleKey("同名剧"), title: "同名剧", timestamp: Date.now() });
    const b = s.recordWorkVisit({
      keys: titleKey("同名剧"),
      title: "同名剧",
      timestamp: Date.now() + 86400e3,
    });
    assert(a.work === null, "只有标题时归不到作品（降级）");
    assert(b.work === null, "再访问一次也不会凭空建出空作品");
    assert(
      s._dbAll("SELECT * FROM works").length === 0,
      "没有残留任何空作品行",
    );

    // 但一旦有强键把作品建起来，低可信度键会作为待确认队列的种子一起入库
    const strong = s.recordWorkVisit({
      keys: [
        { kind: "code", value: "CCC-3", confidence: "high" },
        ...titleKey("同名剧"),
      ],
      title: "同名剧",
      timestamp: Date.now(),
    });
    assert(strong.work !== null, "有强键时建起作品");
    assert(
      s.getWorkKeys(strong.work.id).some((k) => k.kind === "title"),
      "标题键作为种子一并入库",
    );
  }

  // ── 两个已存在的作品被同一批键命中 → 报告歧义，不静默合并 ──
  console.log("\nTest: Works — 歧义报告");
  {
    const s = await initStore();
    const t = Date.now();
    const x = s.recordWorkVisit({
      keys: [{ kind: "code", value: "AAA-1", confidence: "high" }],
      title: "甲",
      timestamp: t,
    });
    const y = s.recordWorkVisit({
      keys: [{ kind: "cover_hash", value: "a".repeat(32), confidence: "high" }],
      title: "乙",
      timestamp: t,
    });
    assert(x.work.id !== y.work.id, "先建出两个不同的作品");

    const merge = s.recordWorkVisit({
      keys: [
        { kind: "code", value: "AAA-1", confidence: "high" },
        { kind: "cover_hash", value: "a".repeat(32), confidence: "high" },
      ],
      title: "丙",
      timestamp: t,
    });
    assert(merge.ambiguous === true, "两路键指向不同作品时报告歧义（交给用户裁决）");
    assert(merge.work != null, "仍然返回一条作品，不抛错");
  }

  // ── records.workId 能存回来 ──
  console.log("\nTest: Works — records.workId 往返");
  {
    const s = await initStore();
    const w = s.recordWorkVisit({
      keys: [{ kind: "code", value: "BBB-2", confidence: "high" }],
      title: "某剧",
      timestamp: Date.now(),
    });
    const rec = s.insertRecord({
      id: "linked-1",
      url: "https://example.com/tv/1/",
      title: "某剧",
      domain: "example.com",
      matchedRule: "example.com",
      tabId: 1,
      timestamp: Date.now(),
      workId: w.work.id,
    });
    assert(rec.workId === w.work.id, "插入时带上 workId");
    const back = s.getRecordById("linked-1");
    assert(back.workId === w.work.id, "读回来 workId 还在");
  }

  console.log("\n✅ All RecordStore tests passed!");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
