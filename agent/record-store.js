// RecordStore — deep module encapsulating all SQLite persistence.
// No IPC, no WebSocket, no Electron. Pure domain logic + sql.js.

const initSqlJs = require("sql.js");
const path = require("path");
const fs = require("fs");
const {
  buildAnalysisPrompt,
  buildDeleteReflectionPrompt,
  buildRejectReflectionPrompt,
} = require("./prompts");
const {
  resolveWorkScore,
  identityKeysFor,
  isRepeatVisit,
  computeDailyScore,
  resolveGroup,
  getGroupDomains,
  extractPath,
  matchesRegex,
} = require("./cluster");
const { KEY_KINDS, CONFIDENCE } = require("./identity");

function uuid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return Date.now();
}

// ── Constructor ──────────────────────────────────────────────────────────────

class RecordStore {
  /**
   * @param {string} dbPath
   * @param {Function} [broadcast] - (type, payload) => void
   */
  constructor(dbPath, broadcast) {
    this.dbPath = dbPath;
    this.broadcast = broadcast || (() => {});
    this.db = null;
    this._watchers = [];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    const SQL = await initSqlJs();
    try {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } catch (e) {
      this.db = new SQL.Database();
    }
    this._migrate();
    this._seedDefaults();
  }

  _migrate() {
    // Core tables
    this.db.run(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL,
      matchedRule TEXT NOT NULL,
      tabId INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_records_ts ON records(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_records_mr ON records(matchedRule)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_records_dedup ON records(url, tabId, timestamp)`,
    );

    // Migrations
    const cols = [
      "pinned INTEGER DEFAULT 0",
      "score INTEGER DEFAULT NULL",
      "createdAt INTEGER DEFAULT NULL",
      "updatedAt INTEGER DEFAULT NULL",
      "favIconUrl TEXT DEFAULT ''",
      "description TEXT DEFAULT ''",
      "ogImage TEXT DEFAULT ''",
      "dwellTime INTEGER DEFAULT 0",
      "workId TEXT DEFAULT NULL",
      "edition TEXT DEFAULT ''",
    ];
    for (const col of cols) {
      try { this.db.run(`ALTER TABLE records ADD COLUMN ${col}`); } catch (e) {}
    }
    // workId 由上面的迁移补上，所以索引建在迁移之后。
    // 作品视图的 join 与「删掉没访问的作品」都按 records.workId 找行。
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_records_work ON records(workId)`);

    // ── 作品：跨站融合的唯一落点（docs/adr/0007） ──
    // works 用代理键：不存在一个跨站通用的单一身份字段。
    this.db.run(`CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 0,
      firstSeen INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER DEFAULT NULL
    )`);

    // work_keys：一部作品可以有多个身份键，任一路命中即归并。
    // PRIMARY KEY (kind, value) 保证一个键值只能指向一部作品。
    this.db.run(`CREATE TABLE IF NOT EXISTS work_keys (
      workId TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (kind, value)
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wk_work ON work_keys(workId)`);

    // work_ambiguities：同一批身份键指向了不同作品时的歧义记录（ADR-0002）。
    // 判定在写入时做出并落库，不在读取时重新推断；本轮只报告，不做裁决 UI。
    // 成对排序 + 主键去重，重跑（含回填）不会重复记账。
    this.db.run(`CREATE TABLE IF NOT EXISTS work_ambiguities (
      workA TEXT NOT NULL,
      workB TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (workA, workB, kind, value)
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS watchlist (
      domain TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#5b8dee'
    )`);
    try { this.db.run("ALTER TABLE watchlist ADD COLUMN regexFilter TEXT DEFAULT ''"); } catch (e) {}
    try { this.db.run("ALTER TABLE watchlist ADD COLUMN regexTarget TEXT DEFAULT 'url'"); } catch (e) {}

    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      groupLabel TEXT NOT NULL,
      reason TEXT,
      status INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'analysis',
      summary TEXT DEFAULT '',
      system_prompt TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      completed_at INTEGER DEFAULT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      tool_calls TEXT DEFAULT NULL,
      tool_call_id TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_am_conv ON agent_messages(conversation_id)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT DEFAULT '',
      value TEXT DEFAULT '',
      weight REAL DEFAULT 0.5,
      source_conversation_id TEXT,
      source_reflection TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_amm_type ON agent_memories(type)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS agent_pending_actions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '{}',
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER DEFAULT NULL
    )`);
    try { this.db.run("DELETE FROM settings WHERE key = 'agent.profile'"); } catch (e) {}
  }

  _seedDefaults() {
    const count = this._dbGetScalar("SELECT COUNT(*) as c FROM watchlist");
    if (count === 0) {
      this.addWatchlist({
        domain: "bilibili.com",
        label: "B站",
        color: "#fb7299",
      });
    }
  }

  _emit(type, payload) {
    this.broadcast(type, payload);
  }

  // ── Low-level helpers ──────────────────────────────────────────────────────

  _dbAll(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  _dbGet(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  _dbRun(sql, params = []) {
    this.db.run(sql, params);
    this._markDirty();
  }

  _dbGetScalar(sql, params = []) {
    const row = this._dbGet(sql, params);
    if (!row) return null;
    const key = Object.keys(row)[0];
    return row[key];
  }

  _markDirty() {
    // In the real Electron app, this triggers debounced fs write.
    // The store owns the buffer; the caller decides when to export.
    if (this._onDirty) this._onDirty();
  }

  onDirty(fn) {
    this._onDirty = fn;
  }

  export() {
    return this.db.export();
  }

  // ── Watchlist ──────────────────────────────────────────────────────────────

  getWatchlist() {
    return this._dbAll("SELECT * FROM watchlist");
  }

  addWatchlist(entry) {
    const exists = this._dbGet(
      "SELECT domain FROM watchlist WHERE domain = ?",
      [entry.domain],
    );
    if (exists) return false;
    this._dbRun(
      "INSERT INTO watchlist (domain, label, color, regexFilter, regexTarget) VALUES (?, ?, ?, ?, ?)",
      [
        entry.domain,
        entry.label || "",
        entry.color || "#5b8dee",
        entry.regexFilter || "",
        entry.regexTarget || "url",
      ],
    );
    this._emit("watchlistUpdated", this.getWatchlist());
    return true;
  }

  removeWatchlist(domain) {
    const exists = this._dbGet(
      "SELECT domain FROM watchlist WHERE domain = ?",
      [domain],
    );
    if (!exists) return false;
    this._dbRun("DELETE FROM watchlist WHERE domain = ?", [domain]);
    this._emit("watchlistUpdated", this.getWatchlist());
    return true;
  }

  updateWatchlist(entries) {
    this._dbRun("DELETE FROM watchlist");
    const stmt = this.db.prepare(
      "INSERT INTO watchlist (domain, label, color, regexFilter, regexTarget) VALUES (?, ?, ?, ?, ?)",
    );
    for (const entry of entries) {
      stmt.bind([
        entry.domain,
        entry.label || "",
        entry.color || "#5b8dee",
        entry.regexFilter || "",
        entry.regexTarget || "url",
      ]);
      stmt.step();
      stmt.reset();
    }
    stmt.free();
    this._emit("watchlistUpdated", this.getWatchlist());
  }

  /** Update one watchlist domain's regex rule. Returns the row, or null if unknown. */
  updateWatchlistRegex(domain, regexFilter, regexTarget) {
    const exists = this._dbGet(
      "SELECT domain FROM watchlist WHERE domain = ?",
      [domain],
    );
    if (!exists) return null;
    this._dbRun(
      "UPDATE watchlist SET regexFilter = ?, regexTarget = ? WHERE domain = ?",
      [regexFilter, regexTarget, domain],
    );
    const updated = this._dbGet("SELECT * FROM watchlist WHERE domain = ?", [
      domain,
    ]);
    this._emit("watchlistUpdated", { watchlist: this.getWatchlist() });
    return updated;
  }

  // ── Enabled ────────────────────────────────────────────────────────────────

  getEnabled() {
    const row = this._dbGet(
      "SELECT value FROM settings WHERE key = ?",
      ["enabled"],
    );
    return row ? row.value === "true" : true;
  }

  setEnabled(val) {
    this._dbRun(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ["enabled", String(val)],
    );
    this._emit("enabledUpdated", val);
  }

  // ── Locale ────────────────────────────────────────────────────────────────

  getLocale() {
    const row = this._dbGet("SELECT value FROM settings WHERE key = ?", ["locale"]);
    const code = row ? row.value : "zh-CN";
    let data = {};
    try {
      const file = path.join(__dirname, "..", "locales", code + ".json");
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      try {
        const file = path.join(__dirname, "..", "locales", "zh-CN.json");
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e2) {}
    }
    return { code, data };
  }

  setLocale(code) {
    this._dbRun(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ["locale", code],
    );
  }

  // ── AI Config ─────────────────────────────────────────────────────────────

  getAIConfig() {
    const pick = (k) => {
      const row = this._dbGet("SELECT value FROM settings WHERE key = ?", [k]);
      return row ? row.value : null;
    };
    return {
      provider: pick("ai.provider") || "ollama",
      endpoint: pick("ai.endpoint") || "http://127.0.0.1:11434",
      apiKey: pick("ai.apiKey") || "",
      model: pick("ai.model") || "qwen2.5:7b",
    };
  }

  setAIConfig(config) {
    if (config.provider !== undefined)
      this._dbRun(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["ai.provider", config.provider],
      );
    if (config.endpoint !== undefined)
      this._dbRun(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["ai.endpoint", config.endpoint],
      );
    if (config.apiKey !== undefined)
      this._dbRun(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["ai.apiKey", config.apiKey],
      );
    if (config.model !== undefined)
      this._dbRun(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ["ai.model", config.model],
      );
  }

  // ── Window Bounds ──────────────────────────────────────────────────────────

  getWindowBounds() {
    const x = this._dbGet("SELECT value FROM settings WHERE key = 'window.x'");
    const y = this._dbGet("SELECT value FROM settings WHERE key = 'window.y'");
    const w = this._dbGet("SELECT value FROM settings WHERE key = 'window.width'");
    const h = this._dbGet("SELECT value FROM settings WHERE key = 'window.height'");
    if (x && y && w && h) {
      return {
        x: parseInt(x.value, 10),
        y: parseInt(y.value, 10),
        width: parseInt(w.value, 10),
        height: parseInt(h.value, 10),
      };
    }
    return null;
  }

  saveWindowBounds(bounds) {
    const set = (k, v) =>
      this._dbRun(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [k, String(v)],
      );
    set("window.x", bounds.x);
    set("window.y", bounds.y);
    set("window.width", bounds.width);
    set("window.height", bounds.height);
  }

  // ── Records ────────────────────────────────────────────────────────────────

  /**
   * 把一个站点筛选值（watchlist 标签，或未登记站点的原始 matchedRule）
   * 解析成 matchedRule 列表。“all”/空 返回 null 表示不筛选。
   * @param {string} value
   * @returns {string[]|null}
   */
  _siteRules(value) {
    if (!value || value === "all") return null;
    return getGroupDomains(value, this.getWatchlist(), value);
  }

  getRecordById(id) {
    return this._dbGet("SELECT * FROM records WHERE id = ?", [id]);
  }

  getRecordsPage(page, pageSize, filter) {
    const offset = (page - 1) * pageSize;
    let countSql = "SELECT COUNT(*) as total FROM records";
    let dataSql = "SELECT * FROM records ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    let params = [pageSize, offset];
    let countParams = [];

    if (filter === "pinned") {
      countSql = "SELECT COUNT(*) as total FROM records WHERE pinned = 1";
      dataSql = "SELECT * FROM records WHERE pinned = 1 ORDER BY timestamp DESC LIMIT ? OFFSET ?";
      countParams = [];
      params = [pageSize, offset];
    } else if (filter && filter !== "all") {
      const rules = this._siteRules(filter);
      if (rules) {
        const placeholders = rules.map(() => "?").join(",");
        countSql = `SELECT COUNT(*) as total FROM records WHERE matchedRule IN (${placeholders})`;
        dataSql = `SELECT * FROM records WHERE matchedRule IN (${placeholders}) ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        countParams = rules;
        params = [...rules, pageSize, offset];
      }
    }

    const total = this._dbGet(countSql, countParams).total;
    const records = this._dbAll(dataSql, params);
    return { records, total, page, pageSize };
  }

  getAllRecords() {
    return this._dbAll("SELECT * FROM records ORDER BY timestamp DESC");
  }

  getStats() {
    const total = this._dbGet("SELECT COUNT(*) as total FROM records").total;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = this._dbGet(
      "SELECT COUNT(*) as count FROM records WHERE timestamp >= ?",
      [todayStart.getTime()],
    ).count;

    const domainRows = this._dbAll(
      "SELECT matchedRule, COUNT(*) as count FROM records GROUP BY matchedRule ORDER BY count DESC",
    );

    const watchlist = this.getWatchlist();
    const ruleToLabel = {};
    watchlist.forEach((w) => {
      ruleToLabel[w.domain] = w.label || w.domain;
    });

    const domainCounts = {};
    let topDomain = null;
    let topDomainCount = 0;

    for (const r of domainRows) {
      const label = ruleToLabel[r.matchedRule] || r.matchedRule;
      domainCounts[label] = (domainCounts[label] || 0) + r.count;
      if (!topDomain || domainCounts[label] > topDomainCount) {
        topDomain = label;
        topDomainCount = domainCounts[label];
      }
    }

    const uniqueSites = new Set(
      watchlist.map((w) => w.label || w.domain),
    ).size;

    return { total, today, sites: uniqueSites, enabled: this.getEnabled(), domainCounts, topDomain, topDomainCount };
  }

  searchRecords(query, limit = 50, minScore = 0, domain = "") {
    const q = `%${query}%`;
    let sql, params;
    if (domain) {
      sql =
        "SELECT id, url, title, domain, matchedRule, timestamp, pinned, score FROM records WHERE (title LIKE ? OR url LIKE ?) AND score >= ? AND matchedRule = ? ORDER BY timestamp DESC LIMIT ?";
      params = [q, q, minScore, domain, Math.min(limit, 200)];
    } else {
      sql =
        "SELECT id, url, title, domain, matchedRule, timestamp, pinned, score FROM records WHERE (title LIKE ? OR url LIKE ?) AND score >= ? ORDER BY timestamp DESC LIMIT ?";
      params = [q, q, minScore, Math.min(limit, 200)];
    }
    return this._dbAll(sql, params);
  }

  insertRecord(record) {
    const nowTs = now();
    this._dbRun(
      "INSERT INTO records (id, url, title, domain, matchedRule, tabId, timestamp, pinned, score, createdAt, updatedAt, favIconUrl, description, ogImage, workId, edition, dwellTime) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.url,
        record.title || "",
        record.domain,
        record.matchedRule,
        record.tabId || 0,
        record.timestamp || nowTs,
        nowTs,
        record.favIconUrl || "",
        record.description || "",
        record.ogImage || "",
        record.workId || null,
        record.edition || "",
        record.dwellTime || 0,
      ],
    );
    const full = this.getRecordById(record.id);
    // 广播形状要与扩展/渲染进程约定的一致：记录在 record 字段下。
    this._emit("recordAdded", { record: full });
    return full;
  }

  updateRecord(id, updates) {
    const sets = [];
    const params = [];
    for (const [key, val] of Object.entries(updates)) {
      sets.push(`${key} = ?`);
      params.push(val);
    }
    params.push(id);
    this._dbRun(`UPDATE records SET ${sets.join(", ")} WHERE id = ?`, params);
    const record = this.getRecordById(id);
    if (record) this._emit("recordUpdated", record);
    return record;
  }

  deleteRecords(ids) {
    if (!ids || ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const deleted = this._dbAll(`SELECT * FROM records WHERE id IN (${placeholders})`, ids);
    this._dbRun(`DELETE FROM records WHERE id IN (${placeholders})`, ids);
    this._sweepOrphanWorks();
    this._emit("recordsCleared");
    return { deletedCount: deleted.length, deletedRecords: deleted };
  }

  toggleRecordPin(id, pinned, score) {
    this._dbRun(
      "UPDATE records SET pinned = ?, score = ?, updatedAt = ? WHERE id = ?",
      [pinned ? 1 : 0, score, now(), id],
    );
    const record = this.getRecordById(id);
    if (record) this._emit("recordUpdated", record);
    return record;
  }

  /** Set one record's score. Returns the updated row, or null if unknown. */
  updateRecordScore(id, score) {
    this._dbRun("UPDATE records SET score = ?, updatedAt = ? WHERE id = ?", [
      score,
      now(),
      id,
    ]);
    const record = this.getRecordById(id);
    if (record) this._emit("recordUpdated", { record });
    return record;
  }

  clearRecords() {
    this._dbRun("DELETE FROM records");
    this._sweepOrphanWorks();
    this._emit("recordsCleared");
  }

  // ── 写入路径：一条访问走一条通道 ──────────────────────────────────────────

  /**
   * 一条来访的访问，从「这一页算不算作品」到「它属于哪部作品」，一次判完：
   *
   *   闸门 → 作品身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库
   *
   * 这是访问写入路径的**唯一入口**（docs/adr/0002：判定在写入时做出并落库，只做一次）。
   * 链路上有两层意义不同的去重与计分，都在这一个方法里：
   *   - 访问层：`records` 是访问事件。同一组（label 相同 = 同一站点的镜像）里路径相同的
   *     两条来访是同一次访问；同一标签页 60s 内重报则什么也不做。
   *   - 作品层：`works` 跨站融合。同一天最多 +1，无论从哪个站、哪个版本进入。
   *
   * 调用方只给一条来访消息，不再提供查重回调——查重和落库都要读库，
   * 把链路交给调用方拼，得到的就是一条谁也没测过的调用顺序。
   *
   * @param {Object} incoming 扩展上报的访问：
   *        {url, title, domain, matchedRule, tabId, timestamp, id?,
   *         favIconUrl?, description?, ogImage?}
   * @returns {{ action:"drop"|"ignore"|"insert"|"update", reason?:string,
   *            record?:Object, work?:Object|null, ambiguous?:boolean,
   *            keys?:Array<{kind:string,value:string,confidence:string}>, extracted?:Object }}
   *          work 为 null 表示降级：记录照常存在，只是归不到作品。
   *          ambiguous 为 true 表示身份键指向多部作品，按 ADR-0002 不静默合并。
   */
  recordVisit(incoming) {
    // 访问发生的时刻由上报方给出（扩展的浏览器时钟）；缺省才用本机时钟。
    // 这一条对两层计分都成立：访问层与作品层按同一个日期分桶。
    const ts = incoming.timestamp || now();
    const watchlist = this.getWatchlist();

    // 1. 分组：label 相同即同一个站点，镜像域名归同一组
    const group = resolveGroup(incoming.matchedRule, incoming.domain, watchlist);

    // 2. 闸门 + 解析：同一个正则既决定「这一页算不算作品页」，也抠出作品身份
    if (group.rules.length > 0 && !matchesRegex(group.rules, incoming.title, incoming.url)) {
      // 这一页不是作品页，丢弃是有意的。但若适配器写错（正则改版失效），
      // 这里会静默丢历史——调用方必须统计 no-rule-match 并告警（docs/adr/0003）。
      return { action: "drop", reason: "no-rule-match" };
    }

    // 3. 作品身份键。拿不到任何键也照常往下走，只是后面归不到作品（降级而非丢弃）。
    const { extracted, keys } = identityKeysFor(incoming, watchlist, group.rules);

    // 4. 同组同路径去重：镜像上的同一个页面是同一次访问
    const existing = this._findVisitByPath(group.domains, extractPath(incoming.url));

    // 5. 同一标签页 60s 内重报：还是那一次访问，什么都不做（不落库也不广播）
    if (isRepeatVisit(existing, incoming, ts)) {
      return { action: "ignore", keys, extracted };
    }

    // 6. 访问层当日计分：同路径已有访问 → 更新那一张，不新建
    const scored = existing ? computeDailyScore(existing, ts) : null;

    // 7. 作品归属 + 作品层当日计分
    const visit = this.recordWorkVisit({ keys, title: incoming.title, timestamp: ts });
    const workId = visit.work ? visit.work.id : null;
    // 适配器的命名捕获组抠出的**版本**随访问落库（来源 = 站点 + 版本）
    const edition = (extracted && extracted.edition) || "";
    const outcome = { work: visit.work, ambiguous: visit.ambiguous, keys, extracted };

    // 8. 落库
    if (existing) {
      const record = this.updateRecord(existing.id, {
        url: incoming.url,
        domain: incoming.domain,
        matchedRule: incoming.matchedRule,
        pinned: scored.newPinned,
        score: scored.newScore,
        timestamp: ts,
        updatedAt: scored.newUpdatedAt,
        workId,
        edition,
      });
      // 这次回访把记录从旧作品上挪走了（适配器改版、或认出来的变成了另一部）：
      // 旧作品可能就此没有访问，跟着清掉，不留孤儿分数。
      if (existing.workId && existing.workId !== workId) this._sweepOrphanWorks();
      return { action: "update", record, ...outcome };
    }

    const record = this.insertRecord({
      id: incoming.id || uuid(),
      url: incoming.url,
      title: incoming.title || "",
      domain: incoming.domain,
      matchedRule: incoming.matchedRule,
      tabId: incoming.tabId || 0,
      timestamp: ts,
      favIconUrl: incoming.favIconUrl || "",
      description: incoming.description || "",
      ogImage: incoming.ogImage || "",
      workId,
      edition,
    });
    return { action: "insert", record, ...outcome };
  }

  /**
   * 同组里路径相同的那条访问。镜像站换域名不该产生第二条访问，所以只看路径。
   * @param {string[]} groupDomains
   * @param {string} path - extractPath(url)
   */
  _findVisitByPath(groupDomains, path) {
    const placeholders = groupDomains.map(() => "?").join(",");
    const rows = this._dbAll(
      `SELECT * FROM records WHERE matchedRule IN (${placeholders}) ORDER BY timestamp DESC`,
      groupDomains,
    );
    for (const r of rows) {
      try {
        const u = new URL(r.url);
        if (u.pathname + u.search + u.hash === path) return r;
      } catch (e) {
        if (r.url === path) return r;
      }
    }
    return null;
  }

  // ── Works（作品） ────────────────────────────────────────────────────────────
  // 作品是跨站融合的唯一落点；records 降为访问事件。见 docs/adr/0007。

  /**
   * 删掉已经没有任何访问的作品——删除访问不该留下孤儿作品分数。
   * 写入路径（recordVisit / backfillWorks）必然给每部作品挂上至少一条访问，
   * 所以没有访问的作品只可能来自访问被删除，清掉它不丢任何历史。
   * 作品的键与歧义记录随作品一起清掉，不留悬空引用。
   * 条件写成子查询而不是先取 id：clearRecords 可能面对上万部作品，不走参数列表。
   */
  _sweepOrphanWorks() {
    const orphan = `SELECT w.id FROM works w
      WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.workId = w.id)`;
    this._dbRun(`DELETE FROM work_keys WHERE workId IN (${orphan})`);
    this._dbRun(
      `DELETE FROM work_ambiguities WHERE workA IN (${orphan}) OR workB IN (${orphan})`,
    );
    this._dbRun(`DELETE FROM works WHERE id IN (${orphan})`);
  }

  getWork(id) {
    return this._dbGet("SELECT * FROM works WHERE id = ?", [id]) || null;
  }

  getWorkKeys(workId) {
    return this._dbAll(
      "SELECT kind, value, confidence FROM work_keys WHERE workId = ? ORDER BY kind",
      [workId],
    );
  }

  /**
   * 按身份键找出候选作品。返回**全部**命中的不同作品。
   * 返生 2 条以上意味着两件已存在的作品其实是同一部——按 ADR-0002，
   * 那是「误合」风险，应交给用户确认，不在这里静默合并。
   * @param {Array<{kind:string,value:string,confidence:string}>} keys
   * @param {"high"|"medium"|"low"} minConfidence
   * @returns {Array<Object>} works 行，去重
   */
  findWorksByKeys(keys, minConfidence = "medium") {
    const floor = CONFIDENCE[minConfidence];
    const usable = (keys || []).filter(
      (k) =>
        KEY_KINDS.includes(k.kind) &&
        k.value &&
        CONFIDENCE[k.confidence] >= floor,
    );
    if (usable.length === 0) return [];

    const clauses = usable.map(() => "(kind = ? AND value = ?)").join(" OR ");
    const params = [];
    for (const k of usable) params.push(k.kind, k.value);

    return this._dbAll(
      `SELECT DISTINCT w.* FROM work_keys k JOIN works w ON w.id = k.workId WHERE ${clauses}`,
      params,
    );
  }

  /** 把一个身份键挂到作品上。已存在的（kind, value）不重复插入。 */
  linkWorkKeys(workId, keys) {
    const nowTs = now();
    let linked = 0;
    for (const k of keys || []) {
      if (!KEY_KINDS.includes(k.kind) || !k.value) continue;
      const existing = this._dbGet(
        "SELECT workId FROM work_keys WHERE kind = ? AND value = ?",
        [k.kind, k.value],
      );
      if (existing) {
        // 键值已被占用。同一作品：什么也不做；不同作品：那是需要用户裁决的冲突，不静默改指。
        continue;
      }
      this._dbRun(
        "INSERT INTO work_keys (workId, kind, value, confidence, createdAt) VALUES (?, ?, ?, ?, ?)",
        [workId, k.kind, k.value, k.confidence || "medium", nowTs],
      );
      linked++;
    }
    return linked;
  }

  /**
   * 把「这批身份键里有些指向别的作品」的事实落库——那是需要用户裁决的歧义。
   * 判定在写入时做出并留痕（ADR-0002），不在读取时重新推断。
   * 只收参与合并的键（medium 及以上），与 recordWorkVisit 的 ambiguous 同源。
   */
  recordAmbiguities(workId, keys) {
    const nowTs = now();
    for (const k of keys || []) {
      if (!KEY_KINDS.includes(k.kind) || !k.value) continue;
      const owner = this._dbGet(
        "SELECT workId FROM work_keys WHERE kind = ? AND value = ?",
        [k.kind, k.value],
      );
      if (!owner || owner.workId === workId) continue;
      const [a, b] = [workId, owner.workId].sort();
      this._dbRun(
        "INSERT OR IGNORE INTO work_ambiguities (workA, workB, kind, value, createdAt) VALUES (?, ?, ?, ?, ?)",
        [a, b, k.kind, k.value, nowTs],
      );
    }
  }

  /**
   * 一次访问落到作品上：找到就累加计分，找不到就建新的。
   * 计分是**作品层**的：同一天最多 +1，无论从哪个站、哪个版本进入。
   * @returns {{ work: Object|null, created: boolean, ambiguous: boolean }} work 为 null 表示降级（记录仍会存在）
   */
  recordWorkVisit({ keys, title, timestamp } = {}) {
    const ts = timestamp || now();

    // 只有高/中可信度的键才能归属作品。低可信度键（归一化标题）**不建也不合**：
    // 宁可拆、不可合（ADR-0002）。否则每次只有标题的访问都会新建一个空作品，
    // 而且那个作品连一个键都挂不上（键值已被上一个占用）。
    const usable = (keys || []).filter(
      (k) =>
        KEY_KINDS.includes(k.kind) &&
        k.value &&
        CONFIDENCE[k.confidence] >= CONFIDENCE.medium,
    );
    if (usable.length === 0) {
      // 归属不到作品，但记录照常存在——降级而非丢弃。
      return { work: null, created: false, ambiguous: false };
    }

    const matches = this.findWorksByKeys(usable, "medium");
    const ambiguous = matches.length > 1;
    let work = matches[0] || null;
    let created = false;

    const scored = resolveWorkScore(work, ts);

    if (!work) {
      const id = uuid();
      this._dbRun(
        "INSERT INTO works (id, title, score, firstSeen, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [id, title || "", scored.score, ts, scored.createdAt, scored.updatedAt],
      );
      work = this.getWork(id);
      created = true;
    } else {
      this._dbRun(
        "UPDATE works SET score = ?, title = ?, updatedAt = ? WHERE id = ?",
        [scored.score, work.title || title || "", scored.updatedAt, work.id],
      );
      work = this.getWork(work.id);
    }

    // 判定已经做出（work 选定）。只有参与合并的键（usable）指向别的作品才算歧义；
    // 低可信度标题键不参与合并，与 ambiguous 同源。事实落库，界面才看得见。
    this.recordAmbiguities(work.id, usable);

    // 低可信度键（如归一化标题）也入库：它们不参与自动合并，但是待确认队列的种子。
    this.linkWorkKeys(work.id, keys);

    return { work, created, ambiguous };
  }

  /**
   * 分页读取作品，携带聚合字段（来源数、访问数、最近访问时间、站点集合）。
   * 聚合与筛选全部走 SQL：只读一页，不把全部作品读进内存。
   * @param {number} page 1 起
   * @param {number} pageSize
   * @param {{ site?: string, sort?: "score"|"recent" }} [options] site 为 watchlist 的站点标签；"all" 表示不限
   * @returns {{ works: Array<Object>, total: number, page: number, pageSize: number }}
   */
  getWorksPage(page = 1, pageSize = 50, options = {}) {
    const offset = (page - 1) * pageSize;
    const sort = options.sort === "recent" ? "recent" : "score";
    const site = options.site;

    let where = "";
    let filterParams = [];
    const rules = this._siteRules(site);
    if (rules) {
      const placeholders = rules.map(() => "?").join(",");
      where = `WHERE EXISTS (SELECT 1 FROM records r WHERE r.workId = w.id AND r.matchedRule IN (${placeholders}))`;
      filterParams = rules;
    }

    const total = this._dbGet(
      `SELECT COUNT(*) as total FROM works w ${where}`,
      filterParams,
    ).total;

    const orderBy =
      sort === "recent"
        ? "lastVisitAt DESC, w.score DESC"
        : "w.score DESC, lastVisitAt DESC";

    const rows = this._dbAll(
      `SELECT w.*,
              COUNT(r.id) AS visitCount,
              COALESCE(MAX(r.timestamp), 0) AS lastVisitAt,
              COUNT(DISTINCT r.matchedRule) AS sourceCount,
              COALESCE(GROUP_CONCAT(DISTINCT r.matchedRule), '') AS siteRules
       FROM works w
       LEFT JOIN records r ON r.workId = w.id
       ${where}
       GROUP BY w.id
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...filterParams, pageSize, offset],
    );

    const works = rows.map((row) => {
      const sites = row.siteRules ? row.siteRules.split(",") : [];
      delete row.siteRules;
      return { ...row, sites };
    });

    return { works, total, page, pageSize };
  }

  /**
   * 单部作品的详情：它的全部**来源**（站点 + 版本 + 最近地址）与全部**访问**。
   * 来源按 (站点, 版本) 分组——同名版本在不同站点上必须各占一行，不合并。
   * @param {string} workId
   * @returns {{ work: Object, sources: Array<Object>, visits: Array<Object> }|null} 作品不存在时 null
   */
  getWorkDetail(workId) {
    const work = this.getWork(workId);
    if (!work) return null;

    const visits = this._dbAll(
      `SELECT id, url, title, domain, matchedRule, timestamp, dwellTime, pinned, score, edition
       FROM records WHERE workId = ? ORDER BY timestamp DESC`,
      [workId],
    );

    const sources = this._dbAll(
      `SELECT r.matchedRule, r.edition,
              COUNT(*) AS visitCount,
              MAX(r.timestamp) AS lastVisitAt,
              (SELECT r2.url FROM records r2
                 WHERE r2.workId = r.workId AND r2.matchedRule = r.matchedRule AND r2.edition = r.edition
                 ORDER BY r2.timestamp DESC LIMIT 1) AS lastUrl
       FROM records r WHERE r.workId = ?
       GROUP BY r.matchedRule, r.edition
       ORDER BY lastVisitAt DESC`,
      [workId],
    );

    return { work, sources, visits };
  }

  /**
   * 「这条访问该打开哪个地址」：分组（label 相同 = 同一站点的镜像）内
   * **最近访问过**的镜像域名。来源解析只此一处——IPC 层只把地址交给它，
   * 自己不查库、不拼分组。
   *
   * 只换域名、保留路径；认不出分组、组内只有一个域名、或地址解析不了时原样返回。
   * @param {string} url
   * @returns {string}
   */
  resolveOpenUrl(url) {
    try {
      const u = new URL(url);
      const watchlist = this.getWatchlist();
      const entry = watchlist.find(
        (w) => w.domain === u.hostname || url.includes(w.domain),
      );
      if (!entry) return url;
      const domains = getGroupDomains(entry.label || entry.domain, watchlist, entry.domain);
      if (domains.length < 2) return url;
      const placeholders = domains.map(() => "?").join(",");
      const latest = this._dbGet(
        `SELECT domain FROM records WHERE matchedRule IN (${placeholders}) ORDER BY timestamp DESC LIMIT 1`,
        domains,
      );
      if (!latest || !latest.domain) return url;
      u.hostname = latest.domain;
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  /**
   * 未归属访问：认不出作品的访问（workId IS NULL）。
   * 这是降级路径的可见化——它们照常留在 records 里，只是一条都没归到作品。
   * 聚合走 SQL：只读一页，不把全部记录读进内存。
   * @param {number} page 1 起
   * @param {number} pageSize
   * @param {string} [search] 匹配标题 / URL / 站点
   * @returns {{ records: Array<Object>, total: number, page: number, pageSize: number }}
   */
  getUnattributedPage(page = 1, pageSize = 100, search = "") {
    const offset = (page - 1) * pageSize;
    const q = (search || "").trim();
    let where = "WHERE workId IS NULL";
    let params = [];
    if (q) {
      where += " AND (title LIKE ? OR url LIKE ? OR matchedRule LIKE ?)";
      params = [`%${q}%`, `%${q}%`, `%${q}%`];
    }
    const total = this._dbGet(
      `SELECT COUNT(*) as total FROM records ${where}`,
      params,
    ).total;
    const records = this._dbAll(
      `SELECT * FROM records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    return { records, total, page, pageSize };
  }

  /** 未归属访问的总数（作品视图的「未归类」分组要显示它）。 */
  getUnattributedCount() {
    return this._dbGet(
      "SELECT COUNT(*) as total FROM records WHERE workId IS NULL",
    ).total;
  }

  /**
   * 歧义作品列表：同一批身份键指向了不同作品的那些对。
   * 只报告，不提供裁决 UI（本轮 out of scope）。
   * @returns {Array<{kind:string, value:string, createdAt:number,
   *   workA:{id:string,title:string}, workB:{id:string,title:string}}>}
   */
  getAmbiguousWorks() {
    return this._dbAll(
      `SELECT c.kind, c.value, c.createdAt,
              a.id AS aId, a.title AS aTitle,
              b.id AS bId, b.title AS bTitle
       FROM work_ambiguities c
       JOIN works a ON a.id = c.workA
       JOIN works b ON b.id = c.workB
       ORDER BY c.createdAt DESC`,
    ).map((r) => ({
      kind: r.kind,
      value: r.value,
      createdAt: r.createdAt,
      workA: { id: r.aId, title: r.aTitle },
      workB: { id: r.bId, title: r.bTitle },
    }));
  }

  /**
   * 历史回填：把已有访问归入作品（issue #6）。
   *
   * 与实时上报共用同一条身份解析（identityKeysFor）与归属（recordWorkVisit）
   * 代码路径，不存在第二套判定（docs/adr/0002）。
   *
   * 幂等靠两个已存在的不变量，而不是靠额外记账：
   *   - 只处理 workId IS NULL 的记录，已归属的永不被重算；
   *   - 用记录自己的 timestamp 作为判定时刻，所以重跑同一天的工作
   *     不会重复计分（recordWorkVisit → resolveWorkScore 当日不重复加）。
   * 中途失败或退出只留下「后面的还没处理」，再跑一次补齐，不产生重复或损坏。
   *
   * @param {{ onProgress?: Function, batchSize?: number }} [options]
   *        onProgress({ processed, before, assigned, created, remaining }) 每批一次，
   *        before 为回填前的未归属数（与最终返回值同名，界面上一份数一个名字）
   * @returns {{ before:number, assigned:number, created:number, ambiguous:number, remaining:number }}
   */
  backfillWorks({ onProgress, batchSize = 200 } = {}) {
    const watchlist = this.getWatchlist();
    const total = this.getUnattributedCount();
    let assigned = 0;
    let created = 0;
    let ambiguous = 0;
    let processed = 0;

    // 键集分页：按 (timestamp, id) 游标前进。归不掉的记录留在原地，
    // 但游标照样跨过它们，所以不会死循环。
    let cursorTs = -1;
    let cursorId = "";
    for (;;) {
      const rows = this._dbAll(
        `SELECT id, url, title, domain, matchedRule, tabId, timestamp, description, ogImage
         FROM records
         WHERE workId IS NULL AND (timestamp > ? OR (timestamp = ? AND id > ?))
         ORDER BY timestamp, id LIMIT ?`,
        [cursorTs, cursorTs, cursorId, batchSize],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        cursorTs = row.timestamp;
        cursorId = row.id;
        processed++;
        const { keys } = identityKeysFor(row, watchlist);
        const visit = this.recordWorkVisit({
          keys,
          title: row.title,
          timestamp: row.timestamp,
        });
        if (visit.ambiguous) ambiguous++;
        if (visit.created) created++;
        if (visit.work) {
          this._dbRun("UPDATE records SET workId = ? WHERE id = ?", [
            visit.work.id,
            row.id,
          ]);
          assigned++;
        }
      }

      const progress = {
        processed,
        before: total,
        assigned,
        created,
        remaining: total - assigned,
      };
      this._emit("worksBackfilledProgress", progress);
      if (onProgress) onProgress(progress);
    }

    const result = {
      before: total,
      assigned,
      created,
      ambiguous,
      // 每条记录只被游标扫到一次，且要么归属要么原地不动，所以剩余数可以直接算出来。
      remaining: total - assigned,
    };
    this._emit("worksBackfilled", result);
    return result;
  }

  // ── Recommendations ────────────────────────────────────────────────────────

  getRecommendations(limit = 200) {
    return this._dbAll(
      "SELECT * FROM recommendations ORDER BY createdAt DESC LIMIT ?",
      [limit],
    );
  }

  rejectRecommendation(id) {
    const rec = this._dbGet("SELECT * FROM recommendations WHERE id = ?", [id]);
    this._dbRun("UPDATE recommendations SET status = -1 WHERE id = ?", [id]);
    return rec;
  }

  acceptRecommendation(id) {
    const rec = this._dbGet("SELECT * FROM recommendations WHERE id = ?", [id]);
    if (!rec) return null;
    this._dbRun("UPDATE recommendations SET status = 1 WHERE id = ?", [id]);
    const nowTs = now();
    const record = {
      id: `${nowTs}-${Math.random().toString(36).slice(2, 8)}`,
      url: rec.url,
      title: rec.title,
      domain: rec.domain,
      matchedRule: rec.groupLabel,
      tabId: 0,
      timestamp: nowTs,
    };
    this._dbRun(
      "INSERT INTO records (id, url, title, domain, matchedRule, tabId, timestamp, pinned, score, createdAt, updatedAt, favIconUrl, description, ogImage) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, '', '', '')",
      [
        record.id,
        record.url,
        record.title,
        record.domain,
        record.matchedRule,
        record.tabId,
        record.timestamp,
        nowTs,
        nowTs,
      ],
    );
    const full = this.getRecordById(record.id);
    this._emit("recordAdded", full);
    return full;
  }

  clearRecommendations() {
    this._dbRun("DELETE FROM recommendations");
    return true;
  }

  // ── Agent Conversations ────────────────────────────────────────────────────

  createConversation(type, systemPrompt) {
    const id = uuid();
    this._dbRun(
      "INSERT INTO agent_conversations (id, type, system_prompt, created_at) VALUES (?, ?, ?, ?)",
      [id, type, systemPrompt || "", now()],
    );
    return id;
  }

  completeConversation(id, summary) {
    this._dbRun(
      "UPDATE agent_conversations SET summary = ?, completed_at = ? WHERE id = ?",
      [summary || "", now(), id],
    );
  }

  insertMessage(conversationId, round, role, content, toolCalls, toolCallId) {
    const id = uuid();
    this._dbRun(
      "INSERT INTO agent_messages (id, conversation_id, round, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        conversationId,
        round,
        role,
        content || "",
        toolCalls ? JSON.stringify(toolCalls) : null,
        toolCallId || null,
        now(),
      ],
    );
  }

  // ── Agent Memories ─────────────────────────────────────────────────────────

  upsertMemory(type, key, value, weight, sourceConvId, sourceReflection) {
    const existing = this._dbGet(
      "SELECT id, weight FROM agent_memories WHERE type = ? AND key = ?",
      [type, key],
    );
    const nowTs = now();
    const stringValue = typeof value === "string" ? value : JSON.stringify(value);

    if (existing) {
      const newWeight = Math.min(1, Math.max(0, existing.weight * 0.7 + weight * 0.3));
      this._dbRun(
        "UPDATE agent_memories SET value = ?, weight = ?, updated_at = ?, source_reflection = ? WHERE id = ?",
        [stringValue, newWeight, nowTs, sourceReflection || null, existing.id],
      );
    } else {
      this._dbRun(
        "INSERT INTO agent_memories (id, type, key, value, weight, source_conversation_id, source_reflection, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          uuid(),
          type,
          key,
          stringValue,
          weight,
          sourceConvId || null,
          sourceReflection || null,
          nowTs,
          nowTs,
        ],
      );
    }
  }

  getMemoriesByType(type) {
    return this._dbAll(
      "SELECT * FROM agent_memories WHERE type = ? ORDER BY weight DESC",
      [type],
    );
  }

  getAllMemories() {
    return this._dbAll("SELECT * FROM agent_memories ORDER BY updated_at DESC");
  }

  buildAgentProfile() {
    const memories = this.getAllMemories();
    const profile = {
      preferences: memories
        .filter((m) => m.type === "preference")
        .map((m) => ({ key: m.key, weight: m.weight, value: m.value })),
      antiPatterns: memories
        .filter((m) => m.type === "anti_pattern")
        .map((m) => m.key),
      insights: memories
        .filter((m) => m.type === "insight")
        .map((m) => ({ key: m.key, value: m.value, weight: m.weight })),
      domainHealth: {},
      lastUpdated:
        memories.length > 0
          ? Math.max(...memories.map((m) => m.updated_at || 0))
          : null,
    };
    for (const m of memories.filter((m) => m.type === "domain_health")) {
      profile.domainHealth[m.key] = m.weight;
    }
    return profile;
  }

  // ── Pending Actions ────────────────────────────────────────────────────────

  insertPendingAction(conversationId, toolName, args) {
    const id = uuid();
    this._dbRun(
      "INSERT INTO agent_pending_actions (id, conversation_id, tool_name, args, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, conversationId, toolName, JSON.stringify(args), now()],
    );
    return id;
  }

  getPendingActions() {
    return this._dbAll(
      "SELECT * FROM agent_pending_actions WHERE status = 'pending' ORDER BY created_at ASC",
    );
  }

  resolvePendingAction(id, status) {
    this._dbRun(
      "UPDATE agent_pending_actions SET status = ?, resolved_at = ? WHERE id = ?",
      [status, now(), id],
    );
  }

  // ── AI Analysis Helpers ────────────────────────────────────────────────────

  extractHighValueRecords() {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let rows = this._dbAll(
      "SELECT * FROM records WHERE (pinned = 1 OR score > 0) AND timestamp >= ? ORDER BY score DESC, timestamp DESC LIMIT 50",
      [thirtyDaysAgo],
    );
    if (rows.length < 10) {
      rows = this._dbAll(
        "SELECT * FROM records WHERE timestamp >= ? ORDER BY pinned DESC, score DESC, timestamp DESC LIMIT 50",
        [thirtyDaysAgo],
      );
    }
    return rows;
  }

  buildAnalysisPromptForRecords(records, watchlist) {
    return buildAnalysisPrompt(records, watchlist);
  }

  buildDeleteReflectionPrompt(deletedRecords) {
    const keptSample = this._dbAll(
      "SELECT * FROM records WHERE pinned = 1 ORDER BY score DESC, timestamp DESC LIMIT 20",
    );
    return buildDeleteReflectionPrompt(deletedRecords, keptSample);
  }

  buildRejectReflectionPrompt(rejectedRec) {
    const keptSample = this._dbAll(
      "SELECT * FROM records WHERE pinned = 1 ORDER BY score DESC, timestamp DESC LIMIT 20",
    );
    return buildRejectReflectionPrompt(rejectedRec, keptSample);
  }

  // ── Read-only agent view ───────────────────────────────────────────────────

  getAgentReadStore() {
    const self = this;
    return {
      searchRecords(query, limit, minScore, domain) {
        return self.searchRecords(query, limit, minScore, domain);
      },
      getRecordDetails(id) {
        return self.getRecordById(id);
      },
      getStatistics() {
        return self.getStats();
      },
      getRecommendations(status, limit) {
        const where = status !== undefined ? "WHERE status = ?" : "";
        const params = status !== undefined ? [status] : [];
        const sql = `SELECT * FROM recommendations ${where} ORDER BY createdAt DESC LIMIT ?`;
        const p = status !== undefined ? [...params, limit] : [limit];
        return self._dbAll(sql, p);
      },
      getWatchlist() {
        return self.getWatchlist();
      },
      getAgentProfile() {
        return self.buildAgentProfile();
      },
    };
  }

  // Named write operations the agent tools may use. Deliberately narrow: the
  // only way in is these named operations; there is no SQL handle here.
  getAgentWriteStore() {
    const self = this;
    return {
      // agent 新建的访问走的是浏览器上报那条通道本身，不是它的副本。
      recordVisit(incoming) {
        return self.recordVisit(incoming);
      },
      deleteRecords(ids) {
        return self.deleteRecords(ids);
      },
      updateWatchlistRegex(domain, regexFilter, regexTarget) {
        return self.updateWatchlistRegex(domain, regexFilter, regexTarget);
      },
      updateRecordScore(id, score) {
        return self.updateRecordScore(id, score);
      },
    };
  }
}

module.exports = { RecordStore };
