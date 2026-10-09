// Shared low-level SQLite plumbing for the domain stores.
// It knows nothing about records, works or settings — only how to talk to sql.js.
// Every domain module takes a Db and uses only these helpers.

const initSqlJs = require("sql.js");
const fs = require("fs");

class Db {
  constructor(sqlDb) {
    this.sql = sqlDb;
    this._onDirty = null;
    /** 库里原来那份文件读不出来时为 { backupPath }（挪不动时 backupPath 是 null）。 */
    this.recovered = null;
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

/**
 * sql.js 对坏文件是「打开成功、第一次查询才报错」：`new Database(buf)` 之后
 * 建表/查询才抛 "file is not a database"，那时已经晚了（init 抛出去，窗口开不出来）。
 * 所以这里主动查一次 sqlite_master 探活。
 */
function isReadable(sqlDb) {
  try {
    sqlDb.exec("SELECT count(*) FROM sqlite_master");
    return true;
  } catch (e) {
    return false;
  }
}

/** 损坏的库挪到旁边，绝不删用户数据——读不出来也留着，也许还能人工救。 */
function moveAside(dbPath) {
  const backupPath = `${dbPath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(dbPath, backupPath);
    return backupPath;
  } catch (e) {
    return null; // 挪不动（被占用等）：原文件保持不动，至少别卡在启动上
  }
}

async function openDatabase(dbPath) {
  const SQL = await initSqlJs();
  let bytes = null;
  let unreadable = false;
  try {
    bytes = fs.readFileSync(dbPath);
  } catch (e) {
    // 没有文件 = 首次运行；其它读失败（被占住、路径是个目录…）是「有文件但读不出来」，
    // 不能当成没有库——那会静默地拿空库盖上去。
    unreadable = e.code !== "ENOENT";
  }
  if (!bytes && !unreadable) return new Db(new SQL.Database());

  if (bytes) {
    let sqlDb = null;
    try {
      sqlDb = new SQL.Database(bytes);
    } catch (e) {
      sqlDb = null;
    }
    if (sqlDb && isReadable(sqlDb)) return new Db(sqlDb);
    if (sqlDb) sqlDb.close();
  }

  // 文件在但不是能读的库：挪开它，空库启动，把备份路径带回去报给用户。
  const db = new Db(new SQL.Database());
  db.recovered = { backupPath: moveAside(dbPath) };
  return db;
}

/**
 * 原子落盘：先写同目录临时文件，再 rename 整体替换（POSIX 与 NTFS 都是原子的）。
 * 进程在保存中途被杀，最多留下一个 `.tmp`，目标文件始终是完整的上一份。
 * shortcut: 不做 fsync —— 扛得住进程被杀，扛不住断电丢最后几笔。
 */
function saveDatabase(dbPath, bytes) {
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(bytes));
  fs.renameSync(tmpPath, dbPath);
}

module.exports = { Db, openDatabase, saveDatabase };
