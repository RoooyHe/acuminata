// RecordStore — composition root and stable facade for the domain stores.
// No IPC, no WebSocket, no Electron. It owns the SQLite handle and the lifecycle
// (open → schema → seed → dirty/export) and wires the domains together:
//
//   settings        设置（含窗口位置、语言、AI 配置）
//   sites           站点（watchlist / 正则规则；镜像由适配器声明）
//   works           作品（身份键、跨站融合、计分、回填）
//   visits          访问（记录、统计、写入路径 recordVisit）
//   candidates      候选（列表页抓来还没排的条目）
//   agent           agent 对话 / 记忆 / 待审批动作 / 画像
//   recommendations 推荐
//
// Each domain module owns its tables and can be tested with `X.schema(db)` alone;
// modules whose reads span another domain take that domain as a collaborator
// (works reads records; visits reads sites + works; recommendations writes via visits).

const { openDatabase } = require("./store/db");
const { SettingsStore } = require("./store/settings");
const { SiteStore } = require("./store/sites");
const { WorkStore } = require("./store/works");
const { VisitStore } = require("./store/visits");
const { CandidateStore } = require("./store/candidates");
const { AgentMemoryStore } = require("./store/agent-memory");
const { RecommendationStore } = require("./store/recommendations");
const { rank, buildProfile } = require("./rank");
const { loadAdapters } = require("./adapters");
const { createAdapterHealth } = require("./adapter-health");

class RecordStore {
  /**
   * @param {string} dbPath
   * @param {Function} [broadcast] - (type, payload) => void
   * @param {{adapters?:Array<Object>, adapterDirs?:string|string[]}} [options]
   *        适配器缺省从内置 `adapters/` 目录读；多个目录时后者覆盖前者（用户目录在后）
   */
  constructor(dbPath, broadcast, options = {}) {
    this.dbPath = dbPath;
    this.broadcast = broadcast || (() => {});
    this.db = null;
    // 适配器只在启动时读一次：写入路径用它，推给扩展去页面采集的也是同一份。
    this._adapters = options.adapters || loadAdapters(options.adapterDirs);
    // 健康度的计数器由访问写入路径维护，随那唯一一条访问广播一起推给客户端。
    this._adapterHealth = createAdapterHealth(this._adapters);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    this.db = await openDatabase(this.dbPath);
    const emit = (type, payload) => this.broadcast(type, payload);

    this._settings = new SettingsStore(this.db, emit);
    this._sites = new SiteStore(this.db, emit);
    this._works = new WorkStore(this.db, { emit, sites: this._sites, adapters: this._adapters });
    this._visits = new VisitStore(this.db, {
      emit,
      sites: this._sites,
      works: this._works,
      settings: this._settings,
      adapters: this._adapters,
      adapterHealth: this._adapterHealth,
    });
    this._agent = new AgentMemoryStore(this.db, emit);
    this._candidates = new CandidateStore(this.db, { emit });
    this._recommendations = new RecommendationStore(this.db, { emit, visits: this._visits });

    for (const module of [
      SettingsStore,
      SiteStore,
      WorkStore,
      VisitStore,
      CandidateStore,
      AgentMemoryStore,
      RecommendationStore,
    ]) {
      module.schema(this.db);
    }
    this._sites.seedDefaults();
    // 老库没有 records.site：按适配器声明的镜像补一次，镜像从一开始就只算一个来源。
    this._visits.backfillSites();
  }

  onDirty(fn) {
    this.db.onDirty(fn);
  }

  export() {
    return this.db.export();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  getEnabled() { return this._settings.getEnabled(); }
  setEnabled(val) { return this._settings.setEnabled(val); }
  getLocale() { return this._settings.getLocale(); }
  setLocale(code) { return this._settings.setLocale(code); }
  getAIConfig() { return this._settings.getAIConfig(); }
  setAIConfig(config) { return this._settings.setAIConfig(config); }
  getWindowBounds() { return this._settings.getWindowBounds(); }
  saveWindowBounds(b) { return this._settings.saveWindowBounds(b); }

  // ── Sites ──────────────────────────────────────────────────────────────────

  /** 适配器（内置与用户写在同一个目录）。写路径用它们，扩展也拿这一份去采集页面。 */
  getAdapters() {
    return this._adapters;
  }

  /** 老库的 records.site 迁移（来源键来自适配器声明的镜像）。 */
  backfillSites() { return this._visits.backfillSites(); }

  getWatchlist() { return this._sites.getWatchlist(); }
  addWatchlist(entry) { return this._sites.addWatchlist(entry); }
  removeWatchlist(domain) { return this._sites.removeWatchlist(domain); }
  updateWatchlist(entries) { return this._sites.updateWatchlist(entries); }
  updateWatchlistRegex(domain, regexFilter, regexTarget) {
    return this._sites.updateWatchlistRegex(domain, regexFilter, regexTarget);
  }

  // ── Works ──────────────────────────────────────────────────────────────────

  getWork(id) { return this._works.getWork(id); }
  getWorkKeys(workId) { return this._works.getWorkKeys(workId); }
  findWorksByKeys(keys, min) { return this._works.findWorksByKeys(keys, min); }
  linkWorkKeys(workId, keys) { return this._works.linkWorkKeys(workId, keys); }
  recordAmbiguities(workId, keys) { return this._works.recordAmbiguities(workId, keys); }
  recordWorkVisit(visit) { return this._works.recordWorkVisit(visit); }
  getWorksPage(page, pageSize, options) { return this._works.getWorksPage(page, pageSize, options); }
  getWorkRow(workId) { return this._works.getWorkRow(workId); }
  getWorkDetail(workId) { return this._works.getWorkDetail(workId); }
  resolveOpenUrl(url) { return this._works.resolveOpenUrl(url); }
  getAmbiguousWorks() { return this._works.getAmbiguousWorks(); }
  backfillWorks(options) { return this._works.backfillWorks(options); }
  reparseWorks(options) { return this._works.reparseWorks(options); }

  // ── Visits ─────────────────────────────────────────────────────────────────

  getRecordById(id) { return this._visits.getRecordById(id); }
  getRecordsPage(page, pageSize, filter) { return this._visits.getRecordsPage(page, pageSize, filter); }
  getAllRecords() { return this._visits.getAllRecords(); }
  getStats() { return this._visits.getStats(); }
  getRuleStats() { return this._visits.getRuleStats(); }
  searchRecords(query, limit, minScore, domain) { return this._visits.searchRecords(query, limit, minScore, domain); }
  insertRecord(record, opts) { return this._visits.insertRecord(record, opts); }
  insertPinnedVisit(record) { return this._visits.insertPinnedVisit(record); }
  updateRecord(id, updates, opts) { return this._visits.updateRecord(id, updates, opts); }
  deleteRecords(ids) { return this._visits.deleteRecords(ids); }
  toggleRecordPin(id, pinned, score) { return this._visits.toggleRecordPin(id, pinned, score); }
  updateRecordScore(id, score) { return this._visits.updateRecordScore(id, score); }
  clearRecords() { return this._visits.clearRecords(); }
  recordVisit(incoming) { return this._visits.recordVisit(incoming); }
  getUnattributedPage(page, pageSize, search) { return this._visits.getUnattributedPage(page, pageSize, search); }
  getUnattributedCount() { return this._visits.getUnattributedCount(); }
  getHealthSnapshot() { return this._visits.getHealth(); }
  extractHighValueRecords() { return this._visits.extractHighValueRecords(); }
  buildDeleteReflectionPrompt(records) { return this._visits.buildDeleteReflectionPrompt(records); }
  buildRejectReflectionPrompt(rec) { return this._visits.buildRejectReflectionPrompt(rec); }

  // ── Candidates ─────────────────────────────────────────────────────────────

  getCandidates(limit) { return this._candidates.getCandidates(limit); }
  importCandidates(payload) { return this._candidates.importCandidates(payload); }
  removeCandidate(id) { return this._candidates.removeCandidate(id); }
  clearCandidates() { return this._candidates.clearCandidates(); }

  // ── Recommendations ────────────────────────────────────────────────────────

  /**
   * 排序：把候选排成推荐（issue #31）。走的是「画像 → rank() → 替换未裁决推荐」
   * 这一条通道，排序本身是纯函数（agent/rank.js），这里只负责把库里的事实取出来。
   * 排序可重跑，所以替掉的是尚未裁决的那批。
   * @param {Object} [metadata] 按候选地址给出的元数据（ADR-0008）；取不到就没有
   * @returns {number} 写出的推荐条数
   */
  rankCandidates(metadata) {
    const keys = this._works.listAllWorkKeys();
    const profile = buildProfile({
      works: this._works.listScoredWorks(),
      keys,
      sites: this._visits.getSiteAffinity(),
      memories: this._agent.getAllMemories(),
    });
    // 元数据由调用方取好传进来——rank 不发请求，元数据站不可用也不卡住（ADR-0008）。
    // shortcut: 还没人去电视猫的 JSON 搜索接口取元数据，排序现在只用廉价信号 + 画像；
    // 接上 client 后把它按候选地址塞进 metadata 即可，rank 不用改。
    const recommended = rank(this._candidates.getCandidates(), profile, {
      adapters: this._adapters,
      seenKeys: keys.map((k) => `${k.kind}:${k.value}`),
      metadata: metadata || {},
    });
    return this._recommendations.replacePending(recommended);
  }

  getRecommendations(limit) { return this._recommendations.getRecommendations(limit); }
  rejectRecommendation(id) { return this._recommendations.rejectRecommendation(id); }
  acceptRecommendation(id) { return this._recommendations.acceptRecommendation(id); }
  clearRecommendations() { return this._recommendations.clearRecommendations(); }

  // ── Agent memory ───────────────────────────────────────────────────────────

  createConversation(type, systemPrompt) { return this._agent.createConversation(type, systemPrompt); }
  completeConversation(id, summary) { return this._agent.completeConversation(id, summary); }
  insertMessage(...args) { return this._agent.insertMessage(...args); }
  upsertMemory(...args) { return this._agent.upsertMemory(...args); }
  getMemoriesByType(type) { return this._agent.getMemoriesByType(type); }
  getAllMemories() { return this._agent.getAllMemories(); }
  buildAgentProfile() { return this._agent.buildAgentProfile(); }
  insertPendingAction(conversationId, toolName, args) { return this._agent.insertPendingAction(conversationId, toolName, args); }
  insertPendingActions(conversationId, actions) { return this._agent.insertPendingActions(conversationId, actions); }
  getPendingActions() { return this._agent.getPendingActions(); }
  resolvePendingAction(id, status) { return this._agent.resolvePendingAction(id, status); }
  resolvePendingActions(ids, status) { return this._agent.resolvePendingActions(ids, status); }

  // ── Read-only agent view ───────────────────────────────────────────────────

  getAgentReadStore() {
    return {
      searchRecords: (...a) => this._visits.searchRecords(...a),
      getRecordDetails: (id) => this._visits.getRecordById(id),
      getStatistics: () => this._visits.getStats(),
      getRecommendations: (status, limit) => this._recommendations.list(status, limit),
      getWatchlist: () => this._sites.getWatchlist(),
      getAgentProfile: () => this._agent.buildAgentProfile(),
    };
  }

  // Named write operations the agent tools may use. Deliberately narrow: the
  // only way in is these named operations; there is no SQL handle here.
  getAgentWriteStore() {
    return {
      // agent 新建的访问走的是浏览器上报那条通道本身，不是它的副本。
      recordVisit: (incoming) => this._visits.recordVisit(incoming),
      deleteRecords: (ids) => this._visits.deleteRecords(ids),
      updateWatchlistRegex: (d, f, t) => this._sites.updateWatchlistRegex(d, f, t),
      updateRecordScore: (id, score) => this._visits.updateRecordScore(id, score),
    };
  }

  // ── Test-only SQL helpers ──────────────────────────────────────────────────
  // Kept so white-box tests can seed/assert rows. The composition root and IPC
  // layer must not use them (test/store-encapsulation.test.js enforces that).

  _dbAll(sql, params = []) { return this.db.all(sql, params); }
  _dbGet(sql, params = []) { return this.db.get(sql, params); }
  _dbRun(sql, params = []) { return this.db.run(sql, params); }
  _dbGetScalar(sql, params = []) { return this.db.scalar(sql, params); }
}

module.exports = { RecordStore };
