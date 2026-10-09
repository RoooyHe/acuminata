// Visits domain: `records` is a visit event (CONTEXT.md: 访问). This module owns
// the whole write path — 列表页丢弃 → 闸门 → 身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库 —
// in one call, `recordVisit`, so the order stays testable (docs/adr/0002/0003/0005).
// It reads sites (watchlist/rules), works (attribution) and the adapters (list pages) as
// collaborators. Testable with records + watchlist + works tables.

const {
  isRepeatVisit,
  computeDailyScore,
  resolveGroup,
  extractPath,
  matchesRegex,
  identityKeysFor,
} = require("../cluster");
const {
  buildDeleteReflectionPrompt: buildDeletePrompt,
  buildRejectReflectionPrompt: buildRejectPrompt,
} = require("../prompts");
const { isListPageUrl } = require("../adapter");
const { uuid, now } = require("./ids");
const { toJson } = require("./json-column");

class VisitStore {
  constructor(db, { emit, sites, works, settings, adapters } = {}) {
    this.db = db;
    this.emit = emit || (() => {});
    this.sites = sites;
    this.works = works;
    this.settings = settings;
    this.adapters = adapters;
  }

  static schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL,
      matchedRule TEXT NOT NULL,
      tabId INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_records_ts ON records(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_records_mr ON records(matchedRule)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_records_dedup ON records(url, tabId, timestamp)`);

    // 后加的列：老库里没有，靠 ALTER 补（已经在的老库不会报错）。
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
      // 采集到的原始字段随访问落库：parse 因此是已存字段的纯函数，
      // 改一次适配器能拿它们重跑全历史（docs/adapters/template.md「重跑」，#27）。
      "pageSignature TEXT DEFAULT '[]'",
      "pageFields TEXT DEFAULT '{}'",
    ];
    for (const col of cols) db.tryExec(`ALTER TABLE records ADD COLUMN ${col}`);
    // workId 由上面的迁移补上，所以索引建在迁移之后。
    // 作品视图的 join 与「删掉没访问的作品」都按 records.workId 找行。
    db.exec(`CREATE INDEX IF NOT EXISTS idx_records_work ON records(workId)`);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  getRecordById(id) {
    return this.db.get("SELECT * FROM records WHERE id = ?", [id]);
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
      const rules = this.sites.rulesFor(filter);
      if (rules) {
        const placeholders = rules.map(() => "?").join(",");
        countSql = `SELECT COUNT(*) as total FROM records WHERE matchedRule IN (${placeholders})`;
        dataSql = `SELECT * FROM records WHERE matchedRule IN (${placeholders}) ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        countParams = rules;
        params = [...rules, pageSize, offset];
      }
    }

    const total = this.db.get(countSql, countParams).total;
    const records = this.db.all(dataSql, params);
    return { records, total, page, pageSize };
  }

  getAllRecords() {
    return this.db.all("SELECT * FROM records ORDER BY timestamp DESC");
  }

  getStats() {
    const total = this.db.get("SELECT COUNT(*) as total FROM records").total;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = this.db.get("SELECT COUNT(*) as count FROM records WHERE timestamp >= ?", [
      todayStart.getTime(),
    ]).count;

    const domainRows = this.db.all(
      "SELECT matchedRule, COUNT(*) as count FROM records GROUP BY matchedRule ORDER BY count DESC",
    );

    const watchlist = this.sites.getWatchlist();
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

    const uniqueSites = new Set(watchlist.map((w) => w.label || w.domain)).size;

    return {
      total,
      today,
      sites: uniqueSites,
      enabled: this.settings ? this.settings.getEnabled() : true,
      domainCounts,
      topDomain,
      topDomainCount,
    };
  }

  /**
   * 按 matchedRule 分组的访问计数：`{ total, stats: { [matchedRule]: count } }`。
   * getStats 按 watchlist 标签聚合、还带今日/站点数等概览；扩展的 getStats
   * 查询要的是原始站点粒度，所以单独一个名字。
   */
  getRuleStats() {
    const stats = {};
    const rows = this.db.all(
      "SELECT matchedRule, COUNT(*) as count FROM records GROUP BY matchedRule",
    );
    for (const r of rows) stats[r.matchedRule] = r.count;
    return {
      total: this.db.scalar("SELECT COUNT(*) as count FROM records"),
      stats,
    };
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
    return this.db.all(sql, params);
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
    const total = this.db.get(`SELECT COUNT(*) as total FROM records ${where}`, params).total;
    const records = this.db.all(
      `SELECT * FROM records ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    return { records, total, page, pageSize };
  }

  /** 未归属访问的总数（作品视图的「未归类」分组要显示它）。 */
  getUnattributedCount() {
    return this.db.get("SELECT COUNT(*) as total FROM records WHERE workId IS NULL").total;
  }

  extractHighValueRecords() {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let rows = this.db.all(
      "SELECT * FROM records WHERE (pinned = 1 OR score > 0) AND timestamp >= ? ORDER BY score DESC, timestamp DESC LIMIT 50",
      [thirtyDaysAgo],
    );
    if (rows.length < 10) {
      rows = this.db.all(
        "SELECT * FROM records WHERE timestamp >= ? ORDER BY pinned DESC, score DESC, timestamp DESC LIMIT 50",
        [thirtyDaysAgo],
      );
    }
    return rows;
  }

  _keptSample() {
    return this.db.all(
      "SELECT * FROM records WHERE pinned = 1 ORDER BY score DESC, timestamp DESC LIMIT 20",
    );
  }

  buildDeleteReflectionPrompt(deletedRecords) {
    return buildDeletePrompt(deletedRecords, this._keptSample());
  }

  buildRejectReflectionPrompt(rejectedRec) {
    return buildRejectPrompt(rejectedRec, this._keptSample());
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  insertRecord(record, opts = {}) {
    const nowTs = now();
    this.db.run(
      "INSERT INTO records (id, url, title, domain, matchedRule, tabId, timestamp, pinned, score, createdAt, updatedAt, favIconUrl, description, ogImage, workId, edition, dwellTime, pageSignature, pageFields) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        toJson(record.pageSignature, "[]"),
        toJson(record.pageFields, "{}"),
      ],
    );
    const full = this.getRecordById(record.id);
    // 广播形状要与扩展/渲染进程约定的一致：记录在 record 字段下。
    // recordVisit 会压掉这次广播，改发一条带作品与统计的（见方法末尾）。
    if (opts.emit !== false) this.emit("recordAdded", { record: full });
    return full;
  }

  /**
   * 接受一条推荐 = 落一条已钉住、记 1 分的访问。它不走浏览器上报那条通道
   * （没有适配器、也没有身份键），所以单独一个具名写入。
   */
  insertPinnedVisit(record) {
    const nowTs = now();
    this.db.run(
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
    this.emit("recordAdded", { record: full });
    return full;
  }

  updateRecord(id, updates, opts = {}) {
    const sets = [];
    const params = [];
    for (const [key, val] of Object.entries(updates)) {
      sets.push(`${key} = ?`);
      params.push(val);
    }
    params.push(id);
    this.db.run(`UPDATE records SET ${sets.join(", ")} WHERE id = ?`, params);
    const record = this.getRecordById(id);
    if (record && opts.emit !== false) this.emit("recordUpdated", { record });
    return record;
  }

  deleteRecords(ids) {
    if (!ids || ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const deleted = this.db.all(`SELECT * FROM records WHERE id IN (${placeholders})`, ids);
    this.db.run(`DELETE FROM records WHERE id IN (${placeholders})`, ids);
    this.works.sweepOrphans();
    this.emit("recordsCleared");
    return { deletedCount: deleted.length, deletedRecords: deleted };
  }

  toggleRecordPin(id, pinned, score) {
    this.db.run("UPDATE records SET pinned = ?, score = ?, updatedAt = ? WHERE id = ?", [
      pinned ? 1 : 0,
      score,
      now(),
      id,
    ]);
    const record = this.getRecordById(id);
    if (record) this.emit("recordUpdated", { record });
    return record;
  }

  /** Set one record's score. Returns the updated row, or null if unknown. */
  updateRecordScore(id, score) {
    this.db.run("UPDATE records SET score = ?, updatedAt = ? WHERE id = ?", [score, now(), id]);
    const record = this.getRecordById(id);
    if (record) this.emit("recordUpdated", { record });
    return record;
  }

  clearRecords() {
    this.db.run("DELETE FROM records");
    this.works.sweepOrphans();
    this.emit("recordsCleared");
  }

  // ── 写入路径：一条访问走一条通道 ──────────────────────────────────────────

  /**
   * 一条来访的访问，从「这一页算不算作品」到「它属于哪部作品」，一次判完：
   *
   *   列表页 → 闸门 → 作品身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库
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
   *         favIconUrl?, description?, ogImage?, pageSignature?, pageFields?}
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
    const watchlist = this.sites.getWatchlist();

    // 1. 分组：label 相同即同一个站点，镜像域名归同一组
    const group = resolveGroup(incoming.matchedRule, incoming.domain, watchlist);

    // 2. 列表页：适配器声明过的列表页不产生访问、也不产生作品身份（ADR-0005）。
    // 判定看适配器的 `list` 声明，不看用户的 regexFilter——那是过滤器，位置是错的。
    if (isListPageUrl(this.adapters, incoming.url)) {
      return { action: "drop", reason: "list-page" };
    }

    // 3. 闸门 + 解析：同一个正则既决定「这一页算不算作品页」，也抠出作品身份
    if (group.rules.length > 0 && !matchesRegex(group.rules, incoming.title, incoming.url)) {
      // 这一页不是作品页，丢弃是有意的。但若适配器写错（正则改版失效），
      // 这里会静默丢历史——调用方必须统计 no-rule-match 并告警（docs/adr/0003）。
      return { action: "drop", reason: "no-rule-match" };
    }

    // 4. 作品身份键。拿不到任何键也照常往下走，只是后面归不到作品（降级而非丢弃）。
    const { extracted, keys } = identityKeysFor(incoming, watchlist, group.rules, this.adapters);

    // 5. 同组同路径去重：镜像上的同一个页面是同一次访问
    const existing = this._findVisitByPath(group.domains, extractPath(incoming.url));

    // 6. 同一标签页 60s 内重报：还是那一次访问，什么都不做（不落库也不广播）
    if (isRepeatVisit(existing, incoming, ts)) {
      return { action: "ignore", keys, extracted };
    }

    // 7. 访问层当日计分：同路径已有访问 → 更新那一张，不新建
    const scored = existing ? computeDailyScore(existing, ts) : null;

    // 8. 作品归属 + 作品层当日计分
    const visit = this.works.recordWorkVisit({ keys, title: incoming.title, timestamp: ts });
    const workId = visit.work ? visit.work.id : null;
    // 适配器的命名捕获组抠出的**版本**随访问落库（来源 = 站点 + 版本）
    const edition = (extracted && extracted.edition) || "";
    const outcome = { work: visit.work, ambiguous: visit.ambiguous, keys, extracted };

    // 9. 落库
    if (existing) {
      const record = this.updateRecord(
        existing.id,
        {
          url: incoming.url,
          domain: incoming.domain,
          matchedRule: incoming.matchedRule,
          pinned: scored.newPinned,
          score: scored.newScore,
          timestamp: ts,
          updatedAt: scored.newUpdatedAt,
          workId,
          edition,
          // 回访没带页面采集（旧上报 / dwell-time）时不要把它抹掉：原始字段是历史事实。
          ...(incoming.pageSignature || incoming.pageFields
            ? {
                pageSignature: toJson(incoming.pageSignature, "[]"),
                pageFields: toJson(incoming.pageFields, "{}"),
              }
            : {}),
        },
        { emit: false },
      );
      // 这次回访把记录从旧作品上挪走了（适配器改版、或认出来的变成了另一部）：
      // 旧作品可能就此没有访问，跟着清掉，不留孤儿分数。
      if (existing.workId && existing.workId !== workId) this.works.sweepOrphans();
      this._emitVisit({
        type: "recordUpdated",
        record,
        workId,
        previousWorkId: existing.workId,
      });
      return { action: "update", record, ...outcome };
    }

    const record = this.insertRecord(
      {
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
        pageSignature: incoming.pageSignature,
        pageFields: incoming.pageFields,
      },
      { emit: false },
    );
    this._emitVisit({ type: "recordAdded", record, workId });
    return { action: "insert", record, ...outcome };
  }

  /**
   * 一条访问落库后的**唯一**一次广播：访问、它所属作品的汇总行、被它离开的旧作品
   * （换了归属时）、以及最新的统计。渲染层靠这些就地更新统计、作品行与打开中的详情，
   * 不再回头拉整页。
   * ponytail: 只带受影响的作品行；渲染层并进已加载页，跨页重排留到下一次翻页。
   */
  _emitVisit({ type, record, workId, previousWorkId }) {
    const moved = previousWorkId && previousWorkId !== workId;
    this.emit(type, {
      record,
      work: workId ? this.works.getWorkRow(workId) : null,
      // 旧作品还在就带新行，已经被清掉（无访问）则为 null；渲染层据此删行。
      previousWork: moved ? this.works.getWorkRow(previousWorkId) : null,
      previousWorkId: moved ? previousWorkId : null,
      stats: this.getStats(),
    });
  }

  /**
   * 同组里路径相同的那条访问。镜像站换域名不该产生第二条访问，所以只看路径。
   * @param {string[]} groupDomains
   * @param {string} path - extractPath(url)
   */
  _findVisitByPath(groupDomains, path) {
    const placeholders = groupDomains.map(() => "?").join(",");
    const rows = this.db.all(
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
}

module.exports = { VisitStore };
