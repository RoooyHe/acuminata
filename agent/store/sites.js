// Sites domain: the watchlist — user-registered sites, their labels/colors and
// regex rules. Mirror grouping is declared by adapters (CONTEXT.md: 站点/镜像);
// the label is a display name (and the key of the UI's site filter), not a grouping key.
// Testable with only the `watchlist` table: `SiteStore.schema(db)`.

const { getGroupDomains } = require("../cluster");

class SiteStore {
  constructor(db, emit) {
    this.db = db;
    this.emit = emit || (() => {});
  }

  static schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS watchlist (
      domain TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#5b8dee'
    )`);
    db.tryExec("ALTER TABLE watchlist ADD COLUMN regexFilter TEXT DEFAULT ''");
    db.tryExec("ALTER TABLE watchlist ADD COLUMN regexTarget TEXT DEFAULT 'url'");
  }

  /** 首次启动给一个默认站点，免得界面空着。 */
  seedDefaults() {
    if (this.db.scalar("SELECT COUNT(*) as c FROM watchlist") === 0) {
      this.addWatchlist({ domain: "bilibili.com", label: "B站", color: "#fb7299" });
    }
  }

  getWatchlist() {
    return this.db.all("SELECT * FROM watchlist");
  }

  _insertEntry(entry) {
    this.db.run(
      "INSERT INTO watchlist (domain, label, color, regexFilter, regexTarget) VALUES (?, ?, ?, ?, ?)",
      [
        entry.domain,
        entry.label || "",
        entry.color || "#5b8dee",
        entry.regexFilter || "",
        entry.regexTarget || "url",
      ],
    );
  }

  addWatchlist(entry) {
    const exists = this.db.get("SELECT domain FROM watchlist WHERE domain = ?", [entry.domain]);
    if (exists) return false;
    this._insertEntry(entry);
    this.emit("watchlistUpdated", this.getWatchlist());
    return true;
  }

  removeWatchlist(domain) {
    const exists = this.db.get("SELECT domain FROM watchlist WHERE domain = ?", [domain]);
    if (!exists) return false;
    this.db.run("DELETE FROM watchlist WHERE domain = ?", [domain]);
    this.emit("watchlistUpdated", this.getWatchlist());
    return true;
  }

  updateWatchlist(entries) {
    this.db.run("DELETE FROM watchlist");
    for (const entry of entries) this._insertEntry(entry);
    this.emit("watchlistUpdated", this.getWatchlist());
  }

  /** Update one watchlist domain's regex rule. Returns the row, or null if unknown. */
  updateWatchlistRegex(domain, regexFilter, regexTarget) {
    const exists = this.db.get("SELECT domain FROM watchlist WHERE domain = ?", [domain]);
    if (!exists) return null;
    this.db.run("UPDATE watchlist SET regexFilter = ?, regexTarget = ? WHERE domain = ?", [
      regexFilter,
      regexTarget,
      domain,
    ]);
    const updated = this.db.get("SELECT * FROM watchlist WHERE domain = ?", [domain]);
    this.emit("watchlistUpdated", { watchlist: this.getWatchlist() });
    return updated;
  }

  /**
   * 把一个站点筛选值（watchlist 标签，或未登记站点的原始 matchedRule）
   * 解析成 matchedRule 列表。“all”/空 返回 null 表示不筛选。
   * 按 label 取域名只是界面筛选，与镜像判定无关（后者由适配器声明）。
   * @param {string} value
   * @returns {string[]|null}
   */
  rulesFor(value) {
    if (!value || value === "all") return null;
    return getGroupDomains(value, this.getWatchlist(), value);
  }
}

module.exports = { SiteStore };
