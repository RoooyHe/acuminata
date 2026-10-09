// 库文件的打开与落盘（issue #54）：
//   · 保存要么整体替换文件，要么旧文件一个字节都不动
//   · 文件在但不是库（保存中途被杀 / 被别的东西写坏）时挪开它、空库启动、带回备份路径
//   · 首次运行（没有文件）照常空库启动
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { openDatabase, saveDatabase } = require("./db");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-db-"));
}

/** 一个大一点的库：文件足够大，写一半被杀才有能被抓到的窗口。 */
async function bigDatabase(marker) {
  const db = await openDatabase(":memory:");
  db.exec("CREATE TABLE t (marker TEXT)");
  db.run("INSERT INTO t VALUES (?)", [marker]);
  db.exec("CREATE TABLE pad (v BLOB)");
  db.run("INSERT INTO pad VALUES (?)", [Buffer.alloc(3 * 1024 * 1024, 7)]);
  return Buffer.from(db.export());
}

async function run() {
  const dir = tmpDir();

  // 首次运行：没有文件也能开出可读的空库，且不报「损坏」。
  const freshPath = path.join(dir, "fresh.db");
  const fresh = await openDatabase(freshPath);
  assert.strictEqual(fresh.recovered, null, "首次运行没有损坏恢复");
  assert.strictEqual(fresh.scalar("SELECT count(*) FROM sqlite_master"), 0, "空库可读");
  fresh.exec("CREATE TABLE t (v TEXT)");
  fresh.run("INSERT INTO t VALUES (?)", ["甲"]);

  saveDatabase(freshPath, fresh.export());
  assert.ok(fs.existsSync(freshPath), "保存后目标文件在");
  assert.ok(!fs.existsSync(freshPath + ".tmp"), "保存不留临时文件");

  // 保存过的库能再打开，数据还在。
  const full = Buffer.from((await openDatabase(freshPath)).export());
  const reopened = await openDatabase(freshPath);
  assert.strictEqual(reopened.scalar("SELECT v FROM t"), "甲", "重新打开读到已保存的数据");
  assert.strictEqual(reopened.recovered, null, "正常库不算损坏");

  // 文件在但不是数据库：挪到旁边、换成空库、带回备份路径。
  const brokenPath = path.join(dir, "broken.db");
  fs.writeFileSync(brokenPath, "这不是一个 SQLite 文件");
  const recovered = await openDatabase(brokenPath);
  assert.ok(recovered.recovered, "损坏库带回恢复信息");
  assert.strictEqual(
    fs.readFileSync(recovered.recovered.backupPath, "utf8"),
    "这不是一个 SQLite 文件",
    "原文件原封不动地挪到备份路径",
  );
  assert.ok(!fs.existsSync(brokenPath), "损坏的原文件已挪走");
  // 原来就是这一步抛「file is not a database」，于是窗口永远开不出来。
  recovered.exec("CREATE TABLE t (v TEXT)");
  saveDatabase(brokenPath, recovered.export());
  const afterRecovery = await openDatabase(brokenPath);
  assert.strictEqual(afterRecovery.recovered, null, "恢复后写出的库不再算损坏");

  // 半截的库（正是保存中途被杀会留下的形态）也按损坏处理。
  const truncatedPath = path.join(dir, "truncated.db");
  fs.writeFileSync(truncatedPath, full.subarray(0, Math.floor(full.length / 2)));
  const truncated = await openDatabase(truncatedPath);
  assert.ok(truncated.recovered, "半截的库走恢复");
  assert.ok(fs.existsSync(truncated.recovered.backupPath), "半截库也留了备份");

  // 文件在但压根读不出来（这里是路径上放了个目录）：不能当「没有库」静默拿空库盖上去。
  const unreadablePath = path.join(dir, "unreadable.db");
  fs.mkdirSync(unreadablePath);
  const unreadable = await openDatabase(unreadablePath);
  assert.ok(unreadable.recovered, "读不出来的文件也走恢复");
  assert.ok(fs.existsSync(unreadable.recovered.backupPath), "读不出来的文件也挪走留了备份");

  // 写临时文件失败时原库文件一个字节都不动——这就是「要么整体替换，要么旧文件不动」。
  const safePath = path.join(dir, "safe.db");
  saveDatabase(safePath, full);
  const before = fs.readFileSync(safePath);
  fs.mkdirSync(safePath + ".tmp"); // 临时路径被占住，写不进去
  assert.throws(() => saveDatabase(safePath, Buffer.from("新内容")), "临时文件写不进去就抛");
  assert.deepStrictEqual(fs.readFileSync(safePath), before, "目标文件没被动过");

  // 保存中途被 SIGKILL：目标文件要么是旧的完整库、要么是新的完整库，不会是半个。
  const crashPath = path.join(dir, "crash.db");
  const oldFile = path.join(dir, "old.db");
  const newFile = path.join(dir, "new.db");
  fs.writeFileSync(oldFile, await bigDatabase("old"));
  fs.writeFileSync(newFile, await bigDatabase("new"));
  fs.copyFileSync(oldFile, crashPath);

  const writerPath = path.join(dir, "crash-writer.js");
  fs.writeFileSync(
    writerPath,
    `const fs = require("fs");
const [target, aPath, bPath] = process.argv.slice(2);
const a = fs.readFileSync(aPath);
const b = fs.readFileSync(bPath);
for (let i = 0; ; i++) {
  fs.writeFileSync(target + ".tmp", i % 2 ? a : b);
  fs.renameSync(target + ".tmp", target);
}
`,
  );
  const writer = spawn(process.execPath, [writerPath, crashPath, oldFile, newFile], {
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 250));
  writer.kill("SIGKILL");
  await new Promise((r) => writer.once("exit", r));

  const survived = await openDatabase(crashPath);
  assert.strictEqual(survived.recovered, null, "保存中途被杀不会留下读不出的库");
  assert.ok(
    ["old", "new"].includes(survived.scalar("SELECT marker FROM t")),
    "留下的是完整的一份：旧的或新的",
  );

  console.log("db store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
