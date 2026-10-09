// 库文件坏掉时的真实启动（issue #54 AC3）：坏文件挪到一边、空库开工、窗口照常开出来，
// 而且用户看得见发生了什么。原来的行为是 init() 建表时抛 "file is not a database"，
// 窗口永远不出现。跑的是真 main.js + 真 preload + 真渲染器。
// Run with: npm run test:smoke（两个 smoke 一起跑）

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const TIMEOUT_MS = 60000;
const GARBAGE = "这不是一个 SQLite 文件";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-recover-smoke-"));
const dbPath = path.join(tmpDir, "tracker.db");
fs.writeFileSync(dbPath, GARBAGE);
process.env.ACUMINATA_DB_PATH = dbPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForWindow() {
  return new Promise((resolve, reject) => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) return resolve(existing);
    const timer = setTimeout(
      () => reject(new Error("窗口没开出来（库文件坏了就卡在启动）")),
      TIMEOUT_MS,
    );
    app.once("browser-window-created", (_, win) => {
      clearTimeout(timer);
      resolve(win);
    });
  });
}

function waitForLoad(win) {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once("did-finish-load", resolve);
  });
}

/** 恢复通知走真实渲染器的 toast（主进程从磁盘上读不出库时唯一能报给用户的地方）。 */
async function waitForToast(win) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const text = await win.webContents.executeJavaScript(
      '(document.getElementById("toast") || {}).textContent || ""',
    );
    if (text) return text;
    await sleep(50);
  }
  return "";
}

async function main() {
  const win = await waitForWindow();
  win.hide();
  win.on("ready-to-show", () => win.hide());
  await waitForLoad(win);

  const toast = await waitForToast(win);
  const backups = fs.readdirSync(tmpDir).filter((f) => f.includes(".corrupt-"));

  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  expect(backups.length === 1, "坏文件没有挪走留备份：" + JSON.stringify(fs.readdirSync(tmpDir)));
  expect(
    backups.length === 1 && fs.readFileSync(path.join(tmpDir, backups[0]), "utf8") === GARBAGE,
    "备份里的内容和坏文件不一致（不该改它）",
  );
  expect(!fs.existsSync(dbPath), "坏文件还留在原路径上，会被下一次保存直接盖掉");
  expect(
    toast.includes("数据库文件损坏"),
    "界面没有报告库文件损坏，用户会以为历史是凭空没的：toast = " + JSON.stringify(toast),
  );
  expect(toast.includes(".corrupt-"), "界面没有给出备份路径：toast = " + JSON.stringify(toast));

  if (failures.length) {
    console.error("SMOKE(recover) FAILED");
    for (const f of failures) console.error("  ✗ " + f);
    return 1;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("SMOKE(recover) PASSED: 坏库启动照常开窗、挪到备份、界面报告");
  return 0;
}

require("../main.js");

const watchdog = setTimeout(() => {
  console.error("SMOKE(recover) FAILED: timed out after " + TIMEOUT_MS + "ms");
  app.exit(1);
}, TIMEOUT_MS);

main()
  .then((code) => {
    clearTimeout(watchdog);
    app.exit(code);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error("SMOKE(recover) FAILED: " + (err && err.stack ? err.stack : err));
    app.exit(1);
  });
