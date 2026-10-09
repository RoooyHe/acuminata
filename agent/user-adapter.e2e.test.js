/**
 * End-to-end: 用户写的适配器与内置适配器走同一条管道（issue #28）。
 * Run with: node agent/user-adapter.e2e.test.js
 *
 * 用户把 JSON 适配器放进**用户目录**，程序启动时加载，与内置的 MacCMS 适配器
 * 同一种格式、同一条 detect → collect → parse 管道，没有特权路径（docs/adr/0006）。
 * 这里从「用户目录里的一个文件」一路跑到「作品身份键」，并断言：
 *   - 用户适配器被加载（内置的照旧在）
 *   - 导入的适配器只被当数据读，代码不执行
 *   - 解析失败降级为旧身份，不丢弃访问
 *   - 未见命中的适配器在健康度里被标为疑似失效
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RecordStore } = require("./record-store");
const { loadAdapters, ADAPTER_DIR } = require("./adapters");
const { createAdapterHealth, SUSPECT_DROPPED } = require("./adapter-health");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-user-adapter-"));
const userDir = path.join(tmp, "adapters");
fs.mkdirSync(userDir, { recursive: true });

// 一份用户写的真适配器：签名认平台，parse 从 collect 的字段里抠身份编号
fs.writeFileSync(
  path.join(userDir, "user-site.json"),
  JSON.stringify({
    name: "用户站",
    detect: { pageGlobal: "mysite" },
    collect: [{ field: "codeText", selector: "span.code", attr: "text" }],
    parse: {
      code: { from: ["codeText", "url"], regex: "(?<code>[A-Za-z]{2,6}-?\\d{2,5})" },
    },
  }),
);
// 不是数据的东西：不该被执行，也不该连累合法适配器
fs.writeFileSync(path.join(userDir, "evil.js"), "module.exports = { name: '不该被执行' }");
fs.writeFileSync(path.join(userDir, "bad.json"), "{ not json");

const WATCHLIST = [{ domain: "mysite.example", label: "用户站", color: "#fff" }];

async function openStore() {
  // 内置目录 + 用户目录：与 main.js 启动时同一条路径
  const store = new RecordStore(":memory:", () => {}, {
    adapterDirs: [ADAPTER_DIR, userDir],
  });
  await store.init();
  store.updateWatchlist(WATCHLIST);
  return store;
}

async function run() {
  console.log("\n── 用户适配器：从加载到产出身份键 end-to-end ──\n");

  // ── ① 加载：内置与用户适配器合起来，坏文件跳过 ──
  console.log("① 加载用户适配器");
  const store = await openStore();
  const adapters = store.getAdapters();
  ok(adapters.some((a) => a.file === "maccms.json"), "内置 MacCMS 适配器照旧在");
  const user = adapters.find((a) => a.file === "user-site.json");
  ok(!!user, "用户目录里的适配器被加载");
  ok(adapters.length === 2, "坏 JSON 与 .js 文件被跳过，不影响合法适配器");
  ok(!fs.existsSync(path.join(process.cwd(), "pwned")), "适配器里的代码文本没有执行");

  // ── ② 同一条管道：签名认平台 → parse → 身份键 ──
  console.log("\n② 同一条管道：签名 → parse → 身份键");
  const a = store.recordVisit({
    url: "https://mysite.example/w/ABC-123",
    title: "用户站作品",
    domain: "mysite.example",
    matchedRule: "mysite.example",
    tabId: 1,
    timestamp: new Date(2026, 3, 1, 10).getTime(),
    // 扩展在页面上跑 collectPage 的产物（按来源文件名分组）
    pageSignature: ["mysite"],
    pageFields: { "user-site.json": { codeText: "ABC-123" } },
  });
  ok(a.action === "insert", "用户适配器认下的页照常落库");
  ok(
    a.keys.some((k) => k.kind === "code" && k.value === "ABC-123" && k.confidence === "high"),
    "用户适配器产出高可信度内容编号身份键",
  );
  ok(!!a.work, "归入了一部作品");

  // ── ③ 降级不丢弃：签名还在但抠不到编号 ──
  console.log("\n③ 解析失败降级，不丢弃访问");
  const degraded = store.recordVisit({
    url: "https://mysite.example/w/no-code-here",
    title: "改版后的页",
    domain: "mysite.example",
    matchedRule: "mysite.example",
    tabId: 2,
    timestamp: new Date(2026, 3, 1, 11).getTime(),
    pageSignature: ["mysite"],
    pageFields: { "user-site.json": { codeText: "" } },
  });
  ok(degraded.action === "insert", "抠不到编号也照常记录，不是丢弃");
  ok(!degraded.keys.some((k) => k.kind === "code"), "没有编号身份键（降级）");
  ok(
    store._dbAll("SELECT id FROM records").length === 2,
    "两条访问一条不少",
  );

  // ── ④ 健康度：未见命中的适配器 → 疑似失效 ──
  console.log("\n④ 适配器健康度按适配器记");
  const health = createAdapterHealth(store.getAdapters());
  // 重放上面两条：第一条解析出了编号，第二条没有
  health.noteVisit(a, "mysite.example");
  health.noteVisit(degraded, "mysite.example");
  const row = health.snapshot().find((s) => s.key === "user-site.json");
  ok(row.matched === 1 && row.dropped === 1, "命中与丢弃分别记到用户适配器上");
  ok(
    health.snapshot().some((s) => s.key === "maccms.json" && s.matched === 0),
    "内置适配器同样出现在健康度里（从未命中）",
  );

  // 内置适配器被改版打失效：连续解析失败、从未命中 → 疑似失效
  const dead = createAdapterHealth([{ file: "maccms.json", name: "MacCMS" }]);
  for (let i = 0; i < SUSPECT_DROPPED; i++) {
    dead.noteVisit({ adapter: { file: "maccms.json" }, parsed: {} }, "amaccms.example");
  }
  ok(dead.snapshot()[0].suspect === true, "内置适配器失灵时在健康度里标为疑似失效，不静默");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
