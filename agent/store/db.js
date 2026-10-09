// Shared low-level SQLite plumbing for the domain stores.
// It knows nothing about records, works or settings — only how to talk to sql.js.
// Every domain module takes a Db and uses only these helpers.

const initSqlJs = require("sql.js");
const fs = require("fs");

class Db {
  constructor(sqlDb) {
    this.sql = sqlDb;
    this._onDirty = null;
  }

  all(sql, params = []) {
    const stmt = this.sql.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    const stmt = this.sql.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  }

  scalar(sql, params = []) {
    const row = this.get(sql, params);
    if (!row) return null;
    const key = Object.keys(row)[0];
    return row[key];
  }

  run(sql, params = []) {
    this.sql.run(sql, params);
    this.markDirty();
  }

  /** DDL and schema tweaks do not change data, so they do not mark the file dirty. */
  exec(sql) {
    this.sql.run(sql);
  }

  /** For migrations that may already have been applied (ADD COLUMN / DROP key). */
  tryExec(sql) {
    try {
      this.sql.run(sql);
    } catch (e) {
      /* already applied */
    }
  }

  markDirty() {
    if (this._onDirty) this._onDirty();
  }

  onDirty(fn) {
    this._onDirty = fn;
  }

  export() {
    return this.sql.export();
  }
}

async function openDatabase(dbPath) {
  const SQL = await initSqlJs();
  let sqlDb;
  try {
    sqlDb = new SQL.Database(fs.readFileSync(dbPath));
  } catch (e) {
    sqlDb = new SQL.Database();
  }
  return new Db(sqlDb);
}

module.exports = { Db, openDatabase };
