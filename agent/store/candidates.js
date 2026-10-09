// Candidates domain: 抓来还没排的条目（候选池）。
//
// 与 `recommendations` 分表（ADR-0005）：候选是**原始事实**——哪个站、哪个列表页、
// 抓到的原始字段；推荐是**排完序、带理由的结论**。分表之前只有推荐一张表，
// 而没有任何东西写它，所以推荐永远是空的。
//
// 只读缓存自己的 `candidates` 表就能测：`CandidateStore.schema(db)`。
//
// 同一地址重抓只更新（列表页会变），不产生第二条候选——地址是候选的自然键。

const { uuid, now } = require("./ids");
const { toJson } = require("./json-column");

class CandidateStore {
  constructor(db, { emit } = {}) {
    this.db = db;
    this.emit = emit || (() => {});
  }

  static schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL,
      matchedRule TEXT NOT NULL,
      groupLabel TEXT NOT NULL,
      adapterFile TEXT NOT NULL DEFAULT '',
      listName TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_candidates_rule ON candidates(matchedRule)`);
  }

  getCandidates(limit = 200) {
    return this.db.all("SELECT * FROM candidates ORDER BY createdAt DESC LIMIT ?", [limit]);
  }

  /**
   * 一批列表页条目 → 候选。
   *
   * 条目来自 `shared/page-collect.js` 的 `collectListEntries`（抓取宿主在隐藏窗口里
   * 跑同一个函数），原始字段整份存下来，重排时不用再抓一次。
   *
   * @param {{adapterFile:string, listName:string, domain:string, matchedRule:string,
   *          groupLabel:string, entries:Array<Object>}} payload
   * @returns {{inserted:number, updated:number}}
   */
  importCandidates({ adapterFile, listName, domain, matchedRule, groupLabel, entries }) {
    const ts = now();
    let inserted = 0;
    let updated = 0;
    for (const entry of entries || []) {
      const url = entry && entry.url;
      if (!url) continue; // 没有地址的条目不是候选
      const fields = toJson(entry, "{}");
      const existing = this.db.get("SELECT id FROM candidates WHERE url = ?", [url]);
      if (existing) {
        this.db.run("UPDATE candidates SET title = ?, fields = ?, updatedAt = ? WHERE id = ?", [
          entry.title || "",
          fields,
          ts,
          existing.id,
        ]);
        updated++;
      } else {
        this.db.run(
          "INSERT INTO candidates (id, url, title, domain, matchedRule, groupLabel, adapterFile, listName, fields, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            uuid(),
            url,
            entry.title || "",
            domain || "",
            matchedRule || "",
            groupLabel || matchedRule || "",
            adapterFile || "",
            listName || "",
            fields,
            ts,
            ts,
          ],
        );
        inserted++;
      }
    }
    if (inserted || updated) this.emit("candidatesUpdated", { inserted, updated });
    return { inserted, updated };
  }

  removeCandidate(id) {
    this.db.run("DELETE FROM candidates WHERE id = ?", [id]);
    this.emit("candidatesUpdated", { removed: 1 });
    return true;
  }

  clearCandidates() {
    this.db.run("DELETE FROM candidates");
    this.emit("candidatesUpdated", { cleared: true });
    return true;
  }
}

module.exports = { CandidateStore };
