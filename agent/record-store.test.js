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

    const conflicts = s.getAmbiguousWorks();
    assert(conflicts.length === 1, "歧义落库，健康度里能看到它");
    assert(
      [conflicts[0].workA.id, conflicts[0].workB.id].sort().join() ===
        [x.work.id, y.work.id].sort().join(),
      "冲突记录指出的正是那两个作品",
    );

    // 再报一次同样的歧义：成对去重，不重复记账（回填重跑也走这条路）。
    s.recordWorkVisit({
      keys: [
        { kind: "code", value: "AAA-1", confidence: "high" },
        { kind: "cover_hash", value: "a".repeat(32), confidence: "high" },
      ],
      title: "丙",
      timestamp: t,
    });
    assert(s.getAmbiguousWorks().length === 1, "重复歧义不会重复记账");
  }

  // ── 低可信度标题键不参与合并，也不该被报成歧义 ──
  console.log("\nTest: Works — 标题键不报歧义");
  {
    const s = await initStore();
    const t = Date.now();
    s.recordWorkVisit({
      keys: [
        { kind: "code", value: "DDD-1", confidence: "high" },
        { kind: "title", value: "同名剧", confidence: "low" },
      ],
      title: "同名剧",
      timestamp: t,
    });
    // 另一部作品，标题归一化后同名——但高可信度键不同，它们不是同一部。
    const other = s.recordWorkVisit({
      keys: [
        { kind: "code", value: "DDD-2", confidence: "high" },
        { kind: "title", value: "同名剧", confidence: "low" },
      ],
      title: "同名剧",
      timestamp: t,
    });
    assert(other.ambiguous === false, "同标题不是歧义（标题键不参与合并）");
    assert(
      s.getAmbiguousWorks().length === 0,
      "低可信度标题键不会被报成需要裁决的歧义",
    );
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

  // ── 作品列表：聚合字段 + 分页 + 站点筛选 + 排序 ──
  console.log("\nTest: Works — 分页读取携带聚合字段");
  {
    const s = await initStore();
    s.addWatchlist({ domain: "tvmao.com", label: "电视猫", color: "#fff" });
    const day1 = new Date(2026, 2, 1, 10).getTime();
    const day2 = new Date(2026, 2, 2, 10).getTime();
    const day3 = new Date(2026, 2, 3, 10).getTime();
    const synopsis = [
      { kind: "synopsis", value: "聚合测试的共用简介", confidence: "medium" },
    ];

    // 作品甲：两站、三次访问、最近 day2、分数 2
    const jia = s.recordWorkVisit({
      keys: [
        { kind: "cover_hash", value: "a".repeat(32), confidence: "high" },
        ...synopsis,
      ],
      title: "甲作品",
      timestamp: day1,
    });
    s.recordWorkVisit({ keys: [...synopsis], title: "甲作品", timestamp: day2 });
    s.insertRecord({ id: "j1", url: "https://bilibili.com/v/1", title: "甲作品", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: day1, workId: jia.work.id });
    s.insertRecord({ id: "j2", url: "https://bilibili.com/v/1", title: "甲作品", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: day1 + 3600e3, workId: jia.work.id });
    s.insertRecord({ id: "j3", url: "https://tvmao.com/k/1", title: "甲作品", domain: "tvmao.com", matchedRule: "tvmao.com", tabId: 2, timestamp: day2, workId: jia.work.id });

    // 作品乙：单站、最近 day3、分数 1
    const yi = s.recordWorkVisit({
      keys: [{ kind: "code", value: "YI-1", confidence: "high" }],
      title: "乙作品",
      timestamp: day3,
    });
    s.insertRecord({ id: "y1", url: "https://tvmao.com/k/2", title: "乙作品", domain: "tvmao.com", matchedRule: "tvmao.com", tabId: 2, timestamp: day3, workId: yi.work.id });

    const byScore = s.getWorksPage(1, 10, { sort: "score" });
    assert(byScore.total === 2, "总作品数为 2");
    assert(byScore.works[0].id === jia.work.id, "按分数降序时甲作品在前");
    assert(byScore.works[0].score === 2, "甲作品分数为 2");
    assert(byScore.works[0].visitCount === 3, "甲作品访问数为 3");
    assert(byScore.works[0].sourceCount === 2, "甲作品来源数为 2");
    assert(byScore.works[0].lastVisitAt === day2, "甲作品最近访问时间为 day2");
    assert(
      byScore.works[0].sites.slice().sort().join(",") === "bilibili.com,tvmao.com",
      "甲作品站点集合为两个站",
    );

    const byRecent = s.getWorksPage(1, 10, { sort: "recent" });
    assert(byRecent.works[0].id === yi.work.id, "按最近访问排序时乙作品在前");

    const paged = s.getWorksPage(1, 1, { sort: "score" });
    assert(paged.works.length === 1, "每页 1 条时只返回 1 条");
    assert(paged.total === 2, "分页时总数仍是 2");
    const page2 = s.getWorksPage(2, 1, { sort: "score" });
    assert(page2.works[0].id === yi.work.id, "第二页拿到乙作品（没有把全部作品读进内存）");

    const bySite = s.getWorksPage(1, 10, { site: "B站" });
    assert(bySite.total === 1, "按站点筛选：B站下只有 1 部作品");
    assert(bySite.works[0].id === jia.work.id, "筛出的正是出现在 B站 的甲作品");
  }

  // ── 站点筛选：未登记站点的原始域名也要真的过滤 ──
  console.log("\nTest: Works — 未登记站点的原始域名筛选");
  {
    const s = await initStore(); // 默认只有 bilibili.com
    const t = Date.now();
    const raw = s.recordWorkVisit({
      keys: [{ kind: "code", value: "RAW-1", confidence: "high" }],
      title: "未登记站作品",
      timestamp: t,
    });
    s.insertRecord({ id: "raw-1", url: "https://example.com/v/1", title: "未登记站作品", domain: "example.com", matchedRule: "example.com", tabId: 1, timestamp: t, workId: raw.work.id });
    const other = s.recordWorkVisit({
      keys: [{ kind: "code", value: "RAW-2", confidence: "high" }],
      title: "B站作品",
      timestamp: t,
    });
    s.insertRecord({ id: "raw-2", url: "https://bilibili.com/v/2", title: "B站作品", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: t, workId: other.work.id });

    const byRaw = s.getWorksPage(1, 10, { site: "example.com" });
    assert(byRaw.total === 1, "按未登记站点的原始域名筛选只返回 1 部作品");
    assert(byRaw.works[0].id === raw.work.id, "筛出的正是该域名下的作品");

    const byLabel = s.getWorksPage(1, 10, { site: "B站" });
    assert(byLabel.total === 1, "按登记站点的标签筛选只返回 1 部作品");
    assert(byLabel.works[0].id === other.work.id, "标签筛选命中该站的作品");
  }

  // ── 未归属访问：降级路径的可见化 ──
  console.log("\nTest: Works — 未归属访问");
  {
    const s = await initStore();
    const t = Date.now();
    const w = s.recordWorkVisit({
      keys: [{ kind: "code", value: "OWNED-1", confidence: "high" }],
      title: "已归属作品",
      timestamp: t,
    });
    s.insertRecord({ id: "att-1", url: "https://bilibili.com/v/a", title: "已归属作品", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: t, workId: w.work.id });
    s.insertRecord({ id: "un-1", url: "https://bilibili.com/v/b", title: "认不出的甲", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: t + 1, workId: null });
    s.insertRecord({ id: "un-2", url: "https://example.com/v/c", title: "认不出的乙", domain: "example.com", matchedRule: "example.com", tabId: 2, timestamp: t + 2, workId: null });

    assert(s.getUnattributedCount() === 2, "未归属计数为 2");
    const all = s.getUnattributedPage(1, 10);
    assert(all.total === 2 && all.records.length === 2, "未归属列表拿到 2 条");
    assert(all.records[0].id === "un-2", "按时间倒序：最新的未归属在前");
    assert(all.records.every((r) => r.workId === null), "列表里没有已归属的记录");

    const found = s.getUnattributedPage(1, 10, "认不出的甲");
    assert(found.total === 1 && found.records[0].id === "un-1", "按标题搜索未归属访问");
    const byUrl = s.getUnattributedPage(1, 10, "example.com/v/c");
    assert(byUrl.total === 1 && byUrl.records[0].id === "un-2", "按 URL 搜索未归属访问");
    const missing = s.getUnattributedPage(1, 10, "不存在的词");
    assert(missing.total === 0 && missing.records.length === 0, "搜不到时返回空，不是错误");

    const paged = s.getUnattributedPage(2, 1, "");
    assert(paged.records.length === 1 && paged.total === 2, "未归属列表分页只读一页");
  }

  // ── 作品详情：来源（站点 + 版本）+ 访问 ──
  console.log("\nTest: 作品详情 — 来源与访问");
  {
    const s = await initStore();
    s.addWatchlist({ domain: "tvmao.com", label: "电视猫", color: "#fff" });
    const day1 = new Date(2026, 3, 1, 10).getTime();
    const day2 = new Date(2026, 3, 2, 10).getTime();
    const w = s.recordWorkVisit({
      keys: [{ kind: "code", value: "DETAIL-1", confidence: "high" }],
      title: "详情作品",
      timestamp: day1,
    });
    const workId = w.work.id;

    // 来源 1：B站 / 中文字幕
    s.insertRecord({ id: "d1", url: "https://bilibili.com/v/1", title: "详情作品", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: day1, dwellTime: 120000, edition: "中文字幕", workId });
    // 来源 2：同一站点、另一个版本
    s.insertRecord({ id: "d2", url: "https://bilibili.com/v/2", title: "详情作品 无码", domain: "bilibili.com", matchedRule: "bilibili.com", tabId: 1, timestamp: day1 + 3600e3, edition: "无码", workId });
    // 来源 3：电视猫 / 中文字幕 —— 与来源 1 同名版本，必须分别显示
    s.insertRecord({ id: "d3", url: "https://tvmao.com/k/1", title: "详情作品", domain: "tvmao.com", matchedRule: "tvmao.com", tabId: 2, timestamp: day2, dwellTime: 5000, edition: "中文字幕", workId });
    // 来源 4：电视猫 / 没有版本标注
    s.insertRecord({ id: "d4", url: "https://tvmao.com/k/1?p=2", title: "详情作品", domain: "tvmao.com", matchedRule: "tvmao.com", tabId: 2, timestamp: day2 + 3600e3, edition: "", workId });

    const detail = s.getWorkDetail(workId);
    assert(detail.work.id === workId, "详情返回该作品");
    assert(detail.visits.length === 4, "列出全部 4 次访问");
    assert(detail.visits[0].id === "d4", "访问按时间倒序（最近在前）");
    assert(detail.visits.find((v) => v.id === "d1").dwellTime === 120000, "访问携带停留时长");
    assert(detail.visits.find((v) => v.id === "d1").edition === "中文字幕", "访问携带版本");

    assert(detail.sources.length === 4, "四个来源全部列出，不合并成一行");
    const biliZh = detail.sources.find((x) => x.matchedRule === "bilibili.com" && x.edition === "中文字幕");
    const tvZh = detail.sources.find((x) => x.matchedRule === "tvmao.com" && x.edition === "中文字幕");
    assert(!!biliZh && !!tvZh, "同名版本在不同站点分别显示（各自的站点可辨认）");
    assert(biliZh.lastUrl === "https://bilibili.com/v/1", "来源携带最近地址");
    assert(tvZh.lastUrl === "https://tvmao.com/k/1", "电视猫来源的最近地址");
    assert(biliZh.visitCount === 1 && tvZh.visitCount === 1, "来源携带访问次数");

    // 无来源 / 无访问：空状态，不崩
    const empty = s.recordWorkVisit({
      keys: [{ kind: "code", value: "DETAIL-EMPTY", confidence: "high" }],
      title: "空作品",
      timestamp: day1,
    });
    const emptyDetail = s.getWorkDetail(empty.work.id);
    assert(emptyDetail.sources.length === 0, "没有来源时返回空数组");
    assert(emptyDetail.visits.length === 0, "没有访问时返回空数组");

    assert(s.getWorkDetail("no-such-work") === null, "不存在的作品返回 null");
  }

  // ── 一条访问走一条通道（issue #14） ──
  // 闸门 → 身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库，一次调用判完。
  // 调用方不再提供查重回调，所以这些规则只能在 store 上测。
  console.log("\nTest: recordVisit — 一条访问走一条通道");
  {
    const s = await initStore();
    s.addWatchlist({
      domain: "example.com",
      label: "某站",
      color: "#fff",
      regexFilter: "/video/(?<code>[0-9]+)",
      regexTarget: "url",
    });
    // 镜像：同一个站点（同 label）的另一个域名，只多提供一条版本规则
    s.addWatchlist({
      domain: "example-mirror.com",
      label: "某站",
      color: "#fff",
      regexFilter: "(?<edition>中文字幕|无码)",
      regexTarget: "title",
    });
    // 元数据站：规则只当闸门，抽不出任何字段
    s.addWatchlist({
      domain: "tvmao.com",
      label: "电视猫",
      color: "#fff",
      regexFilter: "/kanju/",
      regexTarget: "url",
    });

    const day1 = new Date(2026, 4, 1, 10).getTime();
    const day2 = new Date(2026, 4, 2, 10).getTime();
    const visit = (over = {}) =>
      s.recordVisit({
        id: `v-${over.id || "1"}`,
        url: "https://example.com/video/123",
        title: "某剧 第1集",
        domain: "example.com",
        matchedRule: "example.com",
        tabId: 1,
        timestamp: day1,
        favIconUrl: "https://example.com/favicon.ico",
        description: "简介",
        ogImage: "https://example.com/og.jpg",
        ...over,
      });

    // ① 闸门：列表页不进库，但带出原因（适配器健康度靠它统计，docs/adr/0003）
    const listPage = visit({ id: "list", url: "https://example.com/article/9" });
    assert(listPage.action === "drop", "列表页被闸门丢弃");
    assert(listPage.reason === "no-rule-match", "丢弃带出原因");
    assert(s.getRecordsPage(1, 10, "all").total === 0, "被丢弃的页面没有产生访问");

    // ② 第一条访问：身份键 → 作品 → 落库，全在一次调用里
    const first = visit();
    assert(first.action === "insert", "作品页落库一条访问");
    assert(first.extracted.code === "123", "从命名捕获组抠出内容编号");
    assert(
      first.keys.some((k) => k.kind === "code" && k.confidence === "high"),
      "产出了高可信度的身份键",
    );
    assert(first.work !== null, "归入了一部作品");
    assert(first.record.workId === first.work.id, "访问的 workId 指向那部作品");
    assert(first.record.favIconUrl === "https://example.com/favicon.ico", "保留 favIconUrl");
    assert(
      first.record.description === "简介" && first.record.ogImage === "https://example.com/og.jpg",
      "保留 description 与 ogImage",
    );

    // ③ 同一标签页 60s 内重报：还是那一次访问（连 id 都不沿用）
    const repeat = visit({ id: "repeat", timestamp: day1 + 5000 });
    assert(repeat.action === "ignore", "60s 内重报判为同一次访问");
    assert(s.getRecordsPage(1, 10, "all").total === 1, "没有产生第二条访问");
    assert(s._dbAll("SELECT * FROM works").length === 1, "也没有多建作品");

    // ④ 同一天、同组同路径、另一个标签页：更新那一条，不当日重复计分
    const sameDay = visit({ id: "tab3", tabId: 3, timestamp: day1 + 3600e3 });
    assert(sameDay.action === "update", "同组同路径的第二次来访是更新，不是新建");
    assert(s.getRecordsPage(1, 10, "all").total === 1, "访问仍然只有一条");
    assert(sameDay.record.pinned === 1 && sameDay.record.score === 1, "首次回访钉住并记 1 分");
    assert(sameDay.work.score === 1, "同一天作品分数不加");

    // ⑤ 隔天再访：访问层与作品层各自 +1
    const nextDay = visit({ id: "day2", tabId: 3, timestamp: day2 });
    assert(nextDay.record.score === 2, "隔天回访访问层 +1");
    assert(nextDay.work.score === 2, "隔天回访作品层 +1");

    // ⑥ 拿不到身份键：记录照常存在，只是没有归属（降级而非丢弃）
    const orphan = visit({
      id: "orphan",
      url: "https://tvmao.com/kanju/xyz",
      title: "",
      domain: "tvmao.com",
      matchedRule: "tvmao.com",
      tabId: 2,
      timestamp: day2,
    });
    assert(orphan.action === "insert", "认不出的页面照常落库");
    assert(orphan.work === null && orphan.record.workId === null, "归不到作品，workId 为空");
    assert(s.getUnattributedCount() === 1, "它在未归属列表里可见");

    // ⑦ 镜像换域名、同一路径：同一次访问（版本照样落库），作品不变
    const mirror = visit({
      id: "mirror",
      url: "https://example-mirror.com/video/123",
      title: "某剧 中文字幕",
      domain: "example-mirror.com",
      matchedRule: "example-mirror.com",
      tabId: 4,
      timestamp: day2 + 3600e3,
    });
    assert(mirror.action === "update", "镜像域名上的同一路径是同一次访问");
    assert(mirror.record.edition === "中文字幕", "适配器抠出的版本随访问落库");
    assert(mirror.work.id === first.work.id, "镜像上的访问归到同一部作品");
    assert(mirror.work.score === 2, "同一天不在作品层重复计分");
    assert(s.getRecordsPage(1, 10, "all").total === 2, "两个站两条访问，一条不少");
  }

  console.log("\nTest: 删除访问后不留孤儿作品分数（issue #18）");
  {
    const s = await initStore();
    s.addWatchlist({
      domain: "example.com",
      label: "某站",
      color: "#fff",
      regexFilter: "/video/(?<code>[0-9]+)",
      regexTarget: "url",
    });
    const day1 = new Date(2026, 5, 1, 10).getTime();
    const day2 = new Date(2026, 5, 2, 10).getTime();
    const visit = (over = {}) =>
      s.recordVisit({
        id: "del-1",
        url: "https://example.com/video/7",
        title: "剧",
        domain: "example.com",
        matchedRule: "example.com",
        tabId: 1,
        timestamp: day1,
        ...over,
      });

    // 同一部作品的两条访问（路径不同、身份键相同：尾斜杠）
    const a = visit({ id: "del-1", url: "https://example.com/video/7" });
    const workId = a.work.id;
    visit({ id: "del-2", url: "https://example.com/video/7/", tabId: 2, timestamp: day2 });
    assert(s.getWork(workId).score === 2, "同一部作品两次跨天访问，分数为 2");
    assert(s.getWorksPage(1, 10).total === 1, "作品视图里有它");

    // 删掉其中一条：作品还有别的访问，作品与分数必须保留
    s.deleteRecords(["del-1"]);
    assert(s.getWork(workId) !== null, "作品还有别的访问时不被删掉");
    assert(s.getWork(workId).score === 2, "分数不变（判定已做出并落库）");
    assert(s.getWorksPage(1, 10).total === 1, "作品仍在视图里");

    // 删掉最后一条：作品与它的身份键一起消失，不留孤儿分数
    s.deleteRecords(["del-2"]);
    assert(s.getWork(workId) === null, "删掉最后一条访问，作品行不再存在");
    assert(s.getWorksPage(1, 10).total === 0, "作品视图里没有留下没有访问的分数");
    assert(s._dbAll("SELECT * FROM work_keys").length === 0, "身份键跟着作品一起清掉");
    assert(s.getUnattributedCount() === 0, "也没有留下未归属的访问");

    // 清空全部访问同样不留孤儿分数
    visit({ id: "del-3" });
    assert(s.getWorksPage(1, 10).total === 1, "重新建起作品");
    s.clearRecords();
    assert(s.getWorksPage(1, 10).total === 0, "clearRecords 后没有孤儿作品分数");

    // 适配器改版后，回访把记录从旧作品上挪走了：旧作品同样不该留下孤儿分数
    visit({ id: "rew-1" });
    const rewritten = s.getRecordById("rew-1").workId;
    assert(rewritten !== null, "改版前归到了作品");
    s.updateWatchlistRegex("example.com", "/video/", "url");
    const detached = visit({ id: "rew-2", tabId: 2, timestamp: day2 });
    assert(detached.record.workId === null, "改版后回访认不出作品");
    assert(s.getWork(rewritten) === null, "旧作品没有访问了，不留孤儿分数");
    assert(s._dbAll("SELECT * FROM work_keys").length === 0, "它的身份键也一起清掉");
    assert(s.getRecordsPage(1, 10, "all").total === 1, "访问本身还在，只是未归属");
  }

  console.log("\n✅ All RecordStore tests passed!");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
