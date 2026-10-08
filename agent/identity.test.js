/**
 * Unit tests for agent/identity.js
 * Run with: node agent/identity.test.js
 *
 * 用例取自本轮实测的真实数据（见 docs/adr/0007、docs/adr/0008）：
 *   A = aiqiyi.ai /voddetail/237486.html
 *   B = tvmao.com  /kanju/YmFfZmsg      —— 用户标注：这两条是同一部《无可替代》
 */

const {
  normalizeTitle,
  titleQueryVariants,
  coverHash,
  synopsisPrefix,
  extractKeys,
  mergeableKeys,
} = require("./identity");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}
function eq(actual, expected, message) {
  assert(
    actual === expected,
    `${message}${actual === expected ? "" : `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`}`,
  );
}

const A_TITLE =
  "《无可替代》高清在线观看 - 国产剧 - 爱奇艺|在线视频网站-海量正版高清视频在线观看";
const B_TITLE = "无可替代剧情介绍（1-20全集）大结局_电视剧_电视猫";
const A_DESC =
  '《无可替代》讲述的是：讲述禀承“这一生绝对不能被别人替代”理念的女白领徐迟，在职场上过关斩将，与公司合伙人叶信之一路携手厮杀，最终成为无可替代之人的故事。 “黑莲花”徐迟与“精狐狸”叶信之互相扶持又相爱相杀！金牌编剧张巍全...';
const B_DESC =
  '电视剧无可替代剧情介绍：讲述禀承“这一生绝对不能被别人替代”理念的女白领徐迟，在职场上过关斩将，与公司合伙人叶信之一路携手厮杀，最终成为无可替代之人的故事。 “黑莲花”徐迟与“精狐狸”叶信之互相扶持又相爱相杀！金牌编剧张巍全新都市力作，快节奏爽情节短剧模式，直击当下年轻人痛点，带你职场打怪升级通关！';
const A_COVER =
  "https://img.lzipic.com/upload/vod/20261005-1/c0a55b31c915cab3d80e9863f54f2ee0.webp";

function run() {
  console.log("\n── agent/identity.js unit tests ──\n");

  // ── normalizeTitle：两个真实站点的标题必须收敛到同一个值 ──
  {
    console.log("normalizeTitle: 真实配对收敛");
    eq(normalizeTitle(A_TITLE), "无可替代", "A 站标题 → 无可替代");
    eq(normalizeTitle(B_TITLE), "无可替代", "B 站标题 → 无可替代");
    eq(
      normalizeTitle(A_TITLE),
      normalizeTitle(B_TITLE),
      "两个站点的标题归一后相等",
    );
  }

  // ── normalizeTitle：季/集标记必须保留（这是最贵的错误） ──
  {
    console.log("normalizeTitle: 保留季/集标记");
    eq(
      normalizeTitle("现在就出发第四季（加更版）"),
      "现在就出发第四季",
      "剥掉（加更版），但保留第四季",
    );
    eq(
      normalizeTitle("鱿鱼游戏（第二季）"),
      "鱿鱼游戏（第二季）",
      "含季标记的括号不剥",
    );
    eq(normalizeTitle("鱿鱼游戏 第二季"), "鱿鱼游戏 第二季", "无括号的季标记不剥");
    assert(
      normalizeTitle("鱿鱼游戏（第二季）") !== normalizeTitle("鱿鱼游戏"),
      "第一季与第二季不会被归成同一部",
    );
  }

  // ── normalizeTitle：装饰与噪声 ──
  {
    console.log("normalizeTitle: 装饰与噪声");
    eq(normalizeTitle("《某某》"), "某某", "剥书名号");
    eq(normalizeTitle("某某电视剧"), "某某", "剥尾部栏目词");
    eq(normalizeTitle("某某 高清在线观看"), "某某", "剥尾部噪声");
    eq(normalizeTitle(""), "", "空输入返回空");
    eq(normalizeTitle("高清"), "", "全是噪声时返回空");
    eq(normalizeTitle("某某 - 芒果TV"), "某某", "在分离符处截断");
  }

  // ── titleQueryVariants：查询要逐级放宽（实测：精确匹配，多一字即 0 命中） ──
  {
    console.log("titleQueryVariants: 逐级放宽");
    const v = titleQueryVariants("现在就出发第四季（加更版）");
    assert(v.includes("现在就出发第四季"), "包含去括号后的变体");
    assert(v.includes("现在就出发"), "包含剥到系列名的变体");
    eq(v[0], "现在就出发第四季", "第一个是最具体的变体");
    assert(new Set(v).size === v.length, "变体不重复");
    eq(titleQueryVariants("").length, 0, "空输入返回空数组");
  }

  // ── coverHash ──
  {
    console.log("coverHash");
    eq(
      coverHash(A_COVER),
      "c0a55b31c915cab3d80e9863f54f2ee0",
      "从真实封面 URL 里取出哈希",
    );
    eq(coverHash(A_COVER.toUpperCase().replace("C0A5", "c0a5")), "c0a55b31c915cab3d80e9863f54f2ee0", "统一小写");
    eq(coverHash("https://example.com/no-hash.jpg"), "", "没有哈希时返回空");
    eq(coverHash(""), "", "空输入返回空");
  }

  // ── synopsisPrefix：截断是常态，绝不能比相等 ──
  {
    console.log("synopsisPrefix: 真实配对（一方被截断）");
    const a = synopsisPrefix(A_DESC);
    const b = synopsisPrefix(B_DESC);
    assert(a.length === 40 && b.length === 40, "两侧都产出 40 字指纹");
    eq(a, b, "被截断的一侧与完整的一侧指纹相同");
    assert(!a.includes("《无可替代》"), "前导语被剥掉");
    assert(!a.includes("电视剧"), "另一侧的前导语也被剥掉");
    eq(synopsisPrefix("太短"), "", "过短时返回空，不产生假指纹");
  }

  // ── extractKeys：分级 ──
  {
    console.log("extractKeys: 分级");
    const keys = extractKeys({
      url: "https://www.aiqiyi.ai/voddetail/237486.html",
      title: A_TITLE,
      description: A_DESC,
      extracted: { cover: A_COVER, code: "" },
    });
    const byKind = Object.fromEntries(keys.map((k) => [k.kind, k]));
    eq(byKind.code, undefined, "空字符串的 code 不入库");
    eq(byKind.cover_hash.confidence, "high", "封面哈希是高可信度");
    eq(byKind.synopsis.confidence, "medium", "简介指纹是中可信度");
    eq(byKind.title.confidence, "low", "标题是低可信度");
    eq(byKind.title.value, "无可替代", "标题键已归一化");
  }

  // ── mergeableKeys：低可信度不参与自动合并 ──
  {
    console.log("mergeableKeys: 低可信度不自动合并");
    const keys = extractKeys({
      title: A_TITLE,
      description: A_DESC,
      extracted: { cover: A_COVER },
    });
    const mergeable = mergeableKeys(keys);
    assert(
      !mergeable.some((k) => k.kind === "title"),
      "默认阈值下标题不参与合并（避免误合）",
    );
    assert(
      mergeable.some((k) => k.kind === "cover_hash"),
      "封面哈希参与合并",
    );
    assert(
      mergeableKeys(keys, "low").some((k) => k.kind === "title"),
      "阈值放宽到 low 时标题才参与",
    );
  }

  // ── 空输入不崩 ──
  {
    console.log("extractKeys: 空输入");
    const keys = extractKeys({});
    eq(keys.length, 0, "全空时产不出任何键（调用方据此降级，不丢弃记录）");
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
