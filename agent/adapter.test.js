/**
 * 适配器模板跑真页（issue #20）。
 * Run with: node agent/adapter.test.js
 *
 * 夹具是**真实抓下来的 MacCMS 作品页**，不是构造的小样本：
 *   test/fixtures/maccms-aiqiyi.html   /voddetail/237486.html  主题 a_0012（Bootstrap）
 *   test/fixtures/maccms-mgtvtv.html   /tv/94425/             主题 mxpro（Tailwind + Element Plus）
 *
 * 两站签名相同（`var maccms=`）、路由与主题完全不同，正好证明检测按**页面签名**
 * 而不是按域名或 URL 形状（ADR-0006）。aiqiyi 那份与既有的跨站配对夹具
 * （annotated-pair.fixture.js 的 A 站）是同一个页面，所以这里抠出来的编号
 * 必须与那份夹具里的封面哈希对得上。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseHTML } = require("linkedom");
const { coverHash } = require("./identity");
const { AIQIYI } = require("./annotated-pair.fixture");
const { pageGlobals, detect, collect, parseFields, identityForPage } = require("./adapter");
const { loadAdapters } = require("./adapters");

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${msg}` +
      (ok
        ? ""
        : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`),
  );
}
function ok(cond, msg) {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
}

function loadPage(file, url) {
  const html = fs.readFileSync(path.join(__dirname, "..", "test", "fixtures", file), "utf8");
  return { root: parseHTML(html).document, url };
}

// 真页上实测的两个封面哈希（= 内容编号）
const AIQIYI_CODE = "7a3d015c806b178380a48da94e6254ec";
const MGTVTV_CODE = "153e35bbc840e3582c174c13a7680a01";

const adapters = loadAdapters();
const aiqiyi = loadPage("maccms-aiqiyi.html", "https://www.aiqiyi.ai/voddetail/237486.html");
const mgtvtv = loadPage("maccms-mgtvtv.html", "https://www.mgtvtv.com/tv/94425/");

/** 同一个内置适配器的副本，只改一处，用来验证「有序备选」的先后 */
function variant(mutate) {
  const copy = JSON.parse(JSON.stringify(adapters));
  mutate(copy);
  return copy;
}

// ── ① 检测：按页面签名，不按域名、也不按 URL 形状 ──
console.log("\n① 检测");
ok(pageGlobals(aiqiyi.root).has("maccms"), "MacCMS 的签名来自内联脚本里的 var maccms=");
eq(detect(aiqiyi, adapters).name, "MacCMS", "aiqiyi.ai 真页认出 MacCMS");
eq(detect(mgtvtv, adapters).name, "MacCMS", "mgtvtv.com 真页用同一份适配器认出 MacCMS（路由与主题都不同）");
eq(
  detect(aiqiyi, [{ name: "Other", detect: { pageGlobal: "xiuno" } }]),
  null,
  "签名对不上就认不出——检测看的是签名，不是域名",
);
eq(identityForPage(aiqiyi, []), null, "没有适配器时返回 null，调用方保持今天的行为");

// ── ② 采集：选择器与属性都是有序备选，第一个命中的胜出 ──
console.log("\n② 采集");
const aFields = collect(adapters[0], aiqiyi);
ok(aFields.cover.includes("/upload/vod/"), "aiqiyi 取到真封面");
ok(!aFields.cover.includes("load.gif"), "占位 src（load.gif）被属性备选跳过，取的是 data-original");
ok(!!aFields.keywords, "meta[name=keywords] 也采到（parse 的第一路备选）");

const mFields = collect(adapters[0], mgtvtv);
eq(
  mFields.cover,
  "https://img.ukuapi88.com/upload/vod/20261007-1/153e35bbc840e3582c174c13a7680a01.jpg",
  "mgtvtv 真页没有 data-original：选择器备选落到第二条，拿到的是详情页封面而不是推荐位",
);
const many = collect(
  { collect: [{ field: "covers", selector: "img[src*='/upload/vod/']", attr: "src", many: true }] },
  mgtvtv,
);
eq(many.covers.length, 9, "many: true 返回该选择器命中的全部条目");
ok(many.covers[0].includes(MGTVTV_CODE), "多值字段第一条就是详情页封面（文档顺序）");

// ── ③ 解析与身份键 ──
console.log("\n③ 解析与身份键");
const a = identityForPage(aiqiyi, adapters);
eq(a.parsed.code, AIQIYI_CODE, "aiqiyi 真页抠出封面哈希作为内容编号");
eq(a.parsed.code, coverHash(AIQIYI.ogImage), "与既有跨站配对夹具里 A 站的封面哈希一致");
ok(
  a.keys.some((k) => k.kind === "code" && k.value === AIQIYI_CODE && k.confidence === "high"),
  "产出高可信度身份键 code",
);
ok(
  a.keys.some((k) => k.kind === "cover_hash" && k.value === AIQIYI_CODE),
  "同时产出封面哈希身份键",
);
ok(
  a.keys.some((k) => k.kind === "title" && k.confidence === "low"),
  "标题键也在（低可信度，不单独触发合并）",
);

const m = identityForPage(mgtvtv, adapters);
eq(m.parsed.code, MGTVTV_CODE, "另一个 MacCMS 站的真页同样产出内容编号");

const reordered = variant(([ad]) => {
  ad.parse.code.from = ["keywords", "cover"];
});
eq(
  identityForPage(aiqiyi, reordered).parsed.code,
  AIQIYI_CODE,
  "from 是有序备选：前一个字段落空，后一个字段接上",
);

// ── ④ 降级：抠不到编号不丢弃，只是身份退一步 ──
console.log("\n④ 降级");
const noCode = variant(([ad]) => {
  ad.parse.code.from = ["url", "title"];
});
const degraded = identityForPage(aiqiyi, noCode);
eq(degraded.parsed.code, null, "两路字段都不含封面哈希时编号为 null");
ok(!degraded.keys.some((k) => k.kind === "code"), "没有 code 身份键");
ok(degraded.keys.length > 0, "照常返回采集到的字段与其余身份键——适配器不产出「丢弃」这个结论");

// ── ⑤ 内置与用户适配器：同一种格式、同一条管道，没有特权路径 ──
console.log("\n⑤ 内置与用户适配器");
eq(adapters.length, 1, "adapters/ 下读到一个内置适配器");
eq(adapters[0].file, "maccms.json", "内置适配器就是一个 JSON 文件，和用户写的没有区别");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-adapters-"));
try {
  fs.writeFileSync(
    path.join(tmp, "user-site.json"),
    JSON.stringify({
      name: "用户适配器",
      detect: { pageGlobal: "maccms" },
      parse: { code: { from: ["url"], regex: "/voddetail/(?<code>[0-9]+)\\.html" } },
    }),
  );
  fs.writeFileSync(path.join(tmp, "broken.json"), "{ not json");
  fs.writeFileSync(path.join(tmp, "notes.txt"), "ignore me");
  const user = loadAdapters(tmp);
  eq(user.length, 1, "坏 JSON 与非 JSON 文件被跳过，不影响其它适配器");
  eq(user[0].file, "user-site.json", "用户适配器带来源文件名");
  eq(
    identityForPage(aiqiyi, user).parsed.code,
    "237486",
    "用户适配器走的是同一个 detect/collect/parse 管道，产出自己的身份键",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
