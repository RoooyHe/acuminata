// Recommendations domain: candidate works proposed to the user, with their reason
// and status. Accepting one lands a pinned visit, so this module asks visits to
// write it rather than touching `records` itself.
// Testable with only the `recommendations` table plus a visits collaborator:
// `RecommendationStore.schema(db)`.

const { uuid, now } = require("./ids");

class RecommendationStore {
  constructor(db, { emit, visits } = {}) {
    this.db = db;
    this.emit = emit || (() => {});
    this.visits = visits;
  }

  static schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      groupLabel TEXT NOT NULL,
      reason TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      status INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    )`);
    // 老库没有 score：排序写入的名次。补上后已裁决的历史行保持 0，不影响。
    db.tryExec("ALTER TABLE recommendations ADD COLUMN score INTEGER NOT NULL DEFAULT 0");
  }

  getRecommendations(limit = 200) {
    return this.db.all(
      "SELECT * FROM recommendations ORDER BY createdAt DESC, score DESC LIMIT ?",
      [limit],
    );
  }

  /**
   * 用新排出来的一批替掉**尚未裁决**的推荐：排序可以重跑，重跑不该堆出重复条目。
   * 已裁决的（接受 / 拒绝）保留——那是用户的历史，不是可重算的结论。
   * @param {Array<{url:string,title:string,domain:string,groupLabel:string,reason:string,score?:number}>} rows
   * @returns {number} 写入条数
   */
  replacePending(rows) {
    this.db.run("DELETE FROM recommendations WHERE status = 0");
    const ts = now();
    for (const r of rows || []) {
      this.db.run(
        "INSERT INTO recommendations (id, url, title, domain, groupLabel, reason, score, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
        [
          uuid(),
          r.url,
          r.title || "",
          r.domain || "",
          r.groupLabel || "",
          r.reason || "",
          r.score || 0,
          ts,
        ],
      );
    }
    this.emit("recommendationsUpdated", { count: (rows || []).length });
    return (rows || []).length;
  }

  /**
   * 带状态筛选的读取（agent 工具用）。status 为 undefined 表示不限。
   * 同一批排出来的名次靠 score：它们共享一个 createdAt，只有 score 分得出先后。
   */
  list(status, limit) {
    const where = status !== undefined ? "WHERE status = ?" : "";
    const params = status !== undefined ? [status, limit] : [limit];
    return this.db.all(
      `SELECT * FROM recommendations ${where} ORDER BY createdAt DESC, score DESC LIMIT ?`,
      params,
    );
  }

  rejectRecommendation(id) {
    const rec = this.db.get("SELECT * FROM recommendations WHERE id = ?", [id]);
    this.db.run("UPDATE recommendations SET status = -1 WHERE id = ?", [id]);
    return rec;
  }

  acceptRecommendation(id) {
    const rec = this.db.get("SELECT * FROM recommendations WHERE id = ?", [id]);
    if (!rec) return null;
    this.db.run("UPDATE recommendations SET status = 1 WHERE id = ?", [id]);
    const nowTs = now();
    return this.visits.insertPinnedVisit({
      id: uuid(),
      url: rec.url,
      title: rec.title,
      domain: rec.domain,
      matchedRule: rec.groupLabel,
      tabId: 0,
      timestamp: nowTs,
    });
  }

  clearRecommendations() {
    this.db.run("DELETE FROM recommendations");
    return true;
  }
}

module.exports = { RecommendationStore };
