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
      status INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL
    )`);
  }

  getRecommendations(limit = 200) {
    return this.db.all("SELECT * FROM recommendations ORDER BY createdAt DESC LIMIT ?", [limit]);
  }

  /** 带状态筛选的读取（agent 工具用）。status 为 undefined 表示不限。 */
  list(status, limit) {
    const where = status !== undefined ? "WHERE status = ?" : "";
    const params = status !== undefined ? [status, limit] : [limit];
    return this.db.all(
      `SELECT * FROM recommendations ${where} ORDER BY createdAt DESC LIMIT ?`,
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
