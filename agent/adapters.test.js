/**
 * 适配器加载（issue #28）：内置目录与**用户目录**同一段代码、同一种格式。
 * Run with: node agent/adapters.test.js
 *
 * 用户把 JSON 适配器放进用户目录（打包后内置的 adapters/ 不可写），程序启动时
 * 与内置的一起加载——没有特权路径（docs/adr/0006）。读进来只当**数据**：
 * JSON.parse，不 require、不 eval（docs/adr/0003）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadAdapters, ADAPTER_DIR } = require("./adapters");

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  try {
    assert.ok(cond, msg);
    passed++;
    console.log(`  ✓ ${msg}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${msg}\n      ${e.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-adapters-"));
const userDir = path.join(tmp, "user");

function write(dir, file, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

console.log("Running adapters tests...\n");

// ── ① 内置目录：一个 JSON 文件 = 一个适配器，带来源文件名 ──
console.log("① 内置目录");
const builtin = loadAdapters();
ok(builtin.length === 1, "adapters/ 下读到一个内置适配器");
ok(builtin[0].file === "maccms.json", "带来源文件名 file");
ok(builtin[0].name === "MacCMS", "读到的是真适配器的内容");
ok(loadAdapters(ADAPTER_DIR).length === 1, "显式传单目录与缺省一致");
ok(loadAdapters(path.join(tmp, "does-not-exist")).length === 0, "目录不存在返回空，不抛错");

// ── ② 用户目录与内置目录同一条管道：多个目录合起来加载 ──
console.log("\n② 用户目录与内置同一条管道");
write(
  userDir,
  "user-site.json",
  JSON.stringify({
    name: "用户站",
    detect: { pageGlobal: "mysite" },
    parse: { code: { from: ["url"], regex: "/w/(?<code>[A-Z0-9-]+)" } },
  }),
);
// 同名文件：后一个目录覆盖前一个（用户可以修内置适配器，而不动用程序文件）
write(
  userDir,
  "maccms.json",
  JSON.stringify({ name: "MacCMS（用户修改）", detect: { pageGlobal: "maccms" } }),
);

const both = loadAdapters([ADAPTER_DIR, userDir]);
ok(both.length === 2, "内置与用户适配器合起来加载");
ok(both.some((a) => a.file === "user-site.json"), "用户目录里的适配器被加载");
ok(
  both.find((a) => a.file === "maccms.json").name === "MacCMS（用户修改）",
  "同名文件由用户目录覆盖——同一种格式，没有特权路径",
);

// ── ③ 只当数据读：非 JSON 与坏 JSON 都不执行、不炸 ──
console.log("\n③ 只当数据读");
const dataDir = path.join(tmp, "data");
write(
  dataDir,
  "user-site.json",
  JSON.stringify({
    name: "用户站",
    detect: { pageGlobal: "mysite" },
    parse: { code: { from: ["url"], regex: "/w/(?<code>[A-Z0-9-]+)" } },
  }),
);
write(dataDir, "notes.txt", "ignore me");
write(dataDir, "evil.js", "module.exports = { name: '我不该被执行' }");
write(dataDir, "bad.json", "{ not json");
write(dataDir, "code.json", "require('fs').writeFileSync('pwned','1')");

const dataOnly = loadAdapters(dataDir);
ok(dataOnly.length === 1, "非 JSON、坏 JSON、语法像 JS 的文件都被跳过");
ok(dataOnly[0].file === "user-site.json", "只剩下合法的那个 JSON 适配器");
ok(!fs.existsSync(path.join(process.cwd(), "pwned")), "适配器里的代码文本没有被执行");
ok(
  dataOnly[0].parse &&
    typeof dataOnly[0].parse.code.regex === "string" &&
    typeof dataOnly[0].detect.pageGlobal === "string",
  "读进来的是纯数据（字符串 / 对象），不是函数",
);

// ── ④ 坏文件只跳过自己，不连累整批 ──
console.log("\n④ 单个坏文件不连累整批");
write(dataDir, "another.json", JSON.stringify({ name: "另一个", detect: { pageGlobal: "other" } }));
const still = loadAdapters(dataDir);
ok(still.length === 2, "坏 JSON 旁边的合法适配器照样加载");

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
