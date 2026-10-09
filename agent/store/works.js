// Works domain: the content itself, fused across sites. `works` is the surrogate
// key (docs/adr/0007); `work_keys` holds the identity keys that merge into it;
// `work_ambiguities` records the pairs that must not be silently merged (ADR-0002).
// Reads join `records` (a visit's workId), so a works test also needs that table.
// Testable with works + records: `WorkStore.schema(db)` + `VisitStore.schema(db)`.

const {
  resolveWorkScore,
  identityKeysFor,
  mirrorGroupFor,
  siteKeyFor,
} = require("../cluster");
const { KEY_KINDS, CONFIDENCE } = require("../identity");
const { uuid, now } = require("./ids");
const { fromJson } = require("./json-column");

// 作品列表行的聚合 SELECT：getWorksPage 与 getWorkRow 共用，行形状只此一处。
// 来源按 `site`（适配器声明的镜像组的规范域名）聚合：同一站点的镜像只算一个来源；
// site 为空的老库退回 matchedRule。
const WORK_ROW_SELECT = `SELECT w.*,
        COUNT(r.id) AS visitCount,
        COALESCE(MAX(r.timestamp), 0) AS lastVisitAt,
        COUNT(DISTINCT COALESCE(r.site, r.matchedRule)) AS sourceCount,
        COALESCE(GROUP_CONCAT(DISTINCT COALESCE(r.site, r.matchedRule)), '') AS siteRules
 FROM works w
 LEFT JOIN records r ON r.workId = w.id`;

class WorkStore {
  constructor(db, { emit, sites, adapters } = {}) {
    this.db = db;
    this.emit = emit || (() => {});
    this.sites = sites;
    this.adapters = adapters;
  }

  static schema(db) {
    // ── 作品：跨站融合的唯一落点（docs/adr/0007） ──
    // works 用代理键：不存在一个跨站通用的单一身份字段。
    db.exec(`CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 0,
      firstSeen INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER DEFAULT NULL
    )`);

    // work_keys：一部作品可以有多个身份键，任一路命中即归并。
    // PRIMARY KEY (kind, value) 保证一个键值只能指向一部作品。
    db.exec(`CREATE TABLE IF NOT EXISTS work_keys (
      workId TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'medium',
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (kind, value)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wk_work ON work_keys(workId)`);

    // work_ambiguities：同一批身份键指向了不同作品时的歧义记录（ADR-0002）。
    // 判定在写入时做出并落库，不在读取时重新推断；本轮只报告，不做裁决 UI。
    // 成对排序 + 主键去重，重跑（含回填）不会重复记账。
    db.exec(`CREATE TABLE IF NOT EXISTS work_ambiguities (
      workA TEXT NOT NULL,
      workB TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (workA, workB, kind, value)
    )`);
  }

  /**
   * 删掉已经没有任何访问的作品——删除访问不该留下孤儿作品分数。
   * 写入路径（recordVisit / backfillWorks）必然给每部作品挂上至少一条访问，
   * 所以没有访问的作品只可能来自访问被删除，清掉它不丢任何历史。
   * 作品的键与歧义记录随作品一起清掉，不留悬空引用。
   * 条件写成子查询而不是先取 id：clearRecords 可能面对上万部作品，不走参数列表。
   */
  sweepOrphans() {
    const orphan = `SELECT w.id FROM works w
      WHERE NOT EXISTS (SELECT 1 FROM records r WHERE r.workId = w.id)`;
    this.db.run(`DELETE FROM work_keys WHERE workId IN (${orphan})`);
    this.db.run(`DELETE FROM work_ambiguities WHERE workA IN (${orphan}) OR workB IN (${orphan})`);
    this.db.run(`DELETE FROM works WHERE id IN (${orphan})`);
  }

  getWork(id) {
    return this.db.get("SELECT * FROM works WHERE id = ?", [id]) || null;
  }

  getWorkKeys(workId) {
    return this.db.all(
      "SELECT kind, value, confidence FROM work_keys WHERE workId = ? ORDER BY kind",
      [workId],
    );
  }

  /** 兴趣画像用：已看过的作品与它们的分数（分数即偏好的强弱）。 */
  listScoredWorks() {
    return this.db.all("SELECT title, score FROM works ORDER BY score DESC");
  }

  /** 排序用：全部作品身份键。候选撞上任何一个，就是「已经访问过」。 */
  listAllWorkKeys() {
    return this.db.all("SELECT kind, value FROM work_keys");
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
      (k) => KEY_KINDS.includes(k.kind) && k.value && CONFIDENCE[k.confidence] >= floor,
    );
    if (usable.length === 0) return [];

    const clauses = usable.map(() => "(kind = ? AND value = ?)").join(" OR ");
    const params = [];
    for (const k of usable) params.push(k.kind, k.value);

    return this.db.all(
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
      const existing = this.db.get("SELECT workId FROM work_keys WHERE kind = ? AND value = ?", [
        k.kind,
        k.value,
      ]);
      if (existing) {
        // 键值已被占用。同一作品：什么也不做；不同作品：那是需要用户裁决的冲突，不静默改指。
        continue;
      }
      this.db.run(
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
      const owner = this.db.get("SELECT workId FROM work_keys WHERE kind = ? AND value = ?", [
        k.kind,
        k.value,
      ]);
      if (!owner || owner.workId === workId) continue;
      const [a, b] = [workId, owner.workId].sort();
      this.db.run(
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
      this.db.run(
        "INSERT INTO works (id, title, score, firstSeen, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        [id, title || "", scored.score, ts, scored.createdAt, scored.updatedAt],
      );
      work = this.getWork(id);
      created = true;
    } else {
      this.db.run("UPDATE works SET score = ?, title = ?, updatedAt = ? WHERE id = ?", [
        scored.score,
        work.title || title || "",
        scored.updatedAt,
        work.id,
      ]);
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
    const rules = this.sites.rulesFor(options.site);

    let where = "";
    let filterParams = [];
    if (rules) {
      const placeholders = rules.map(() => "?").join(",");
      where = `WHERE EXISTS (SELECT 1 FROM records r WHERE r.workId = w.id AND r.matchedRule IN (${placeholders}))`;
      filterParams = rules;
    }

    const total = this.db.get(
      `SELECT COUNT(*) as total FROM works w ${where}`,
      filterParams,
    ).total;

    const orderBy =
      sort === "recent"
        ? "lastVisitAt DESC, w.score DESC"
        : "w.score DESC, lastVisitAt DESC";

    const rows = this.db.all(
      `${WORK_ROW_SELECT}
       ${where}
       GROUP BY w.id
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...filterParams, pageSize, offset],
    );

    return { works: rows.map((row) => this._mapWorkRow(row)), total, page, pageSize };
  }

  /**
   * 单部作品的列表行（与 getWorksPage 的行同形），供一条访问落库后就地更新列表用。
   * @param {string} workId
   * @returns {Object|null}
   */
  getWorkRow(workId) {
    const row = this.db.get(`${WORK_ROW_SELECT} WHERE w.id = ? GROUP BY w.id`, [workId]);
    return row ? this._mapWorkRow(row) : null;
  }

  /** 把聚合查询的一行转成列表行（站点列拆成数组）。 */
  _mapWorkRow(row) {
    const sites = row.siteRules ? row.siteRules.split(",") : [];
    delete row.siteRules;
    return { ...row, sites };
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

    const visits = this.db.all(
      `SELECT id, url, title, domain, site, matchedRule, timestamp, dwellTime, pinned, score, edition
       FROM records WHERE workId = ? ORDER BY timestamp DESC`,
      [workId],
    );

    // 来源按**站点**（适配器声明的镜像组）+ 版本分组：镜像合成一个来源，
    // 最近地址取组里最近那一条。site 为空的老库退回 matchedRule。
    const sources = this.db
      .all(
        `SELECT COALESCE(r.site, r.matchedRule) AS siteRule, r.edition,
                COUNT(*) AS visitCount,
                MAX(r.timestamp) AS lastVisitAt,
                (SELECT r2.url FROM records r2
                   WHERE r2.workId = r.workId
                     AND COALESCE(r2.site, r2.matchedRule) = COALESCE(r.site, r.matchedRule)
                     AND r2.edition = r.edition
                   ORDER BY r2.timestamp DESC LIMIT 1) AS lastUrl
         FROM records r WHERE r.workId = ?
         GROUP BY COALESCE(r.site, r.matchedRule), r.edition
         ORDER BY lastVisitAt DESC`,
        [workId],
      )
      .map(({ siteRule, ...s }) => ({ ...s, matchedRule: siteRule }));

    return { work, sources, visits };
  }

  /**
   * 「这条访问该打开哪个地址」：镜像组（适配器声明的 `mirrors`）内
   * **最近访问过**的镜像域名。来源解析只此一处——IPC 层只把地址交给它，
   * 自己不查库、不拼分组。
   *
   * 只换域名、保留路径；认不出镜像组、组内只有一个域名、或地址解析不了时原样返回。
   * @param {string} url
   * @returns {string}
   */
  resolveOpenUrl(url) {
    try {
      const u = new URL(url);
      const watchlist = this.sites.getWatchlist();
      const entry = watchlist.find((w) => w.domain === u.hostname || url.includes(w.domain));
      if (!entry) return url;
      const domains = mirrorGroupFor(entry.domain, this.adapters);
      if (domains.length < 2) return url;
      const placeholders = domains.map(() => "?").join(",");
      const latest = this.db.get(
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
   * 歧义作品列表：同一批身份键指向了不同作品的那些对。
   * 只报告，不提供裁决 UI（本轮 out of scope）。
   * @returns {Array<{kind:string, value:string, createdAt:number,
   *   workA:{id:string,title:string}, workB:{id:string,title:string}}>}
   */
  getAmbiguousWorks() {
    return this.db
      .all(
        `SELECT c.kind, c.value, c.createdAt,
              a.id AS aId, a.title AS aTitle,
              b.id AS bId, b.title AS bTitle
       FROM work_ambiguities c
       JOIN works a ON a.id = c.workA
       JOIN works b ON b.id = c.workB
       ORDER BY c.createdAt DESC`,
      )
      .map((r) => ({
        kind: r.kind,
        value: r.value,
        createdAt: r.createdAt,
        workA: { id: r.aId, title: r.aTitle },
        workB: { id: r.bId, title: r.bTitle },
      }));
  }

  /**
   * 历史回填：把已有访问归入作品（issue #6）。只处理未归属的访问
   * （workId IS NULL）。适配器改好后要重跑**全历史**（含已归属的），
   * 用 reparseWorks——它清空派生结果后走的就是这个方法。
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
   * @param {{ onProgress?: Function, batchSize?: number, op?: "backfill"|"reparse" }} [options]
   *        onProgress({ processed, before, assigned, created, remaining }) 每批一次，
   *        before 为回填前的未归属数（与最终返回值同名，界面上一份数一个名字）
   * @returns {{ before:number, assigned:number, created:number, ambiguous:number, remaining:number }}
   */
  backfillWorks({ onProgress, batchSize = 200, op = "backfill" } = {}) {
    const watchlist = this.sites.getWatchlist();
    const total = this.db.scalar("SELECT COUNT(*) as total FROM records WHERE workId IS NULL");
    let assigned = 0;
    let created = 0;
    let ambiguous = 0;
    let processed = 0;

    // 键集分页：按 (timestamp, id) 游标前进。归不掉的记录留在原地，
    // 但游标照样跨过它们，所以不会死循环。
    let cursorTs = -1;
    let cursorId = "";
    for (;;) {
      const rows = this.db.all(
        `SELECT id, url, title, domain, matchedRule, tabId, timestamp, description, ogImage, pageSignature, pageFields
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
        const { keys, extracted } = identityKeysFor(
          {
            ...row,
            // 存的是 JSON 文本；identityKeysFor 读的是数组 / 对象。
            pageSignature: fromJson(row.pageSignature, []),
            pageFields: fromJson(row.pageFields, {}),
          },
          watchlist,
          undefined,
          this.adapters,
        );
        const visit = this.recordWorkVisit({
          keys,
          title: row.title,
          timestamp: row.timestamp,
        });
        if (visit.ambiguous) ambiguous++;
        if (visit.created) created++;
        if (visit.work) {
          this.db.run("UPDATE records SET workId = ?, edition = ?, site = ? WHERE id = ?", [
            visit.work.id,
            (extracted && extracted.edition) || "",
            siteKeyFor(row.domain, this.adapters),
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
      this.emit("worksBackfilledProgress", { ...progress, op });
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
    this.emit("worksBackfilled", { ...result, op });
    return result;
  }

  /**
   * 显式的重新解析（issue #27）：适配器改好后，把**已有访问**按当前适配器重跑一遍。
   *
   * 采集到的字段随访问存在 records.pageSignature / records.pageFields，`parse`
   * 因此是已存字段的纯函数（docs/adapters/template.md「重跑」）。重跑不改访问本身，
   * 只重算作品的派生结果：清空 workId / works / work_keys / work_ambiguities，再把每条
   * 访问交给与实时上报同一条 `identityKeysFor → recordWorkVisit` 通道——没有第二套解析。
   *
   * 与 backfillWorks 的区别：回填只补未归属的，重跑连已归属的一起重算——
   * 改一次适配器，全历史受益，不只是新访问。
   *
   * 重跑是**先清后建**：清空与重建之间没有事务。中途退出只会留下「派生结果已清、
   * 访问还在」的中间态——再跑一次就补齐，访问本身一条不少。
   *
   * @param {{ onProgress?: Function, batchSize?: number }} [options]
   * @returns {{ before:number, assigned:number, created:number, ambiguous:number, remaining:number }}
   */
  reparseWorks(options = {}) {
    this._clearWorkAttribution();
    return this.backfillWorks({ ...options, op: "reparse" });
  }

  /**
   * 清空作品的派生结果——访问一条不动，workId 归零。
   * works / work_keys / work_ambiguities 全部由 records 推导，所以可以整块重建：
   * 重跑会把它们按当前适配器重新算出来，歧义不会丢——用户的裁决存在 pending actions，
   * 不在这张表里。records.pageSignature / records.pageFields 是原始字段，不在清空之列。
   */
  _clearWorkAttribution() {
    this.db.run("UPDATE records SET workId = NULL, edition = '', site = NULL");
    this.db.run("DELETE FROM work_ambiguities");
    this.db.run("DELETE FROM work_keys");
    this.db.run("DELETE FROM works");
  }
}

module.exports = { WorkStore };
