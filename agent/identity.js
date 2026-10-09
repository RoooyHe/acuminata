/**
 * Identity — 作品身份键。纯逻辑，无 DB、无网络、无副作用。
 *
 * 一个作品可以有多个身份键，任一路命中即归并（docs/adr/0007）。
 * 每路信号的可信度不同，必须在**这里**分级，而不是在判定器里混着算：
 *   code / cover_hash  高精度低召回
 *   synopsis           中
 *   title              低（高召回，但不可单独用于合并）
 *
 * 本轮刻意实现**两个方向相反的归一化**：
 *   normalizeTitle()     保守 —— 剥站点噪声，**保留**季/集标记（身份用）
 *   titleQueryVariants() 激进 —— 逐级剥到系列名（查元数据站用）
 * 两者混用会把不同季焊成同一部作品，那是 ADR-0002 里最贵的错误。
 */

// 站点噪声：出现在标题尾部、与作品身份无关的词。
// 不包含 第N季 / 第N期 / 加更版 / 第N集 —— 那些是身份的一部分。
const SITE_NOISE = [
  "全集免费观看",
  "高清在线观看",
  "免费在线观看",
  "在线观看",
  "免费观看",
  "手机观看",
  "在线播放",
  "高清播放",
  "完整版",
  "剧情介绍",
  "大结局",
  "在线",
  "高清",
  // 尾部栏目词。只在结尾处剥，且标题必须比它长
  "电视剧",
  "电影",
  "综艺",
  "动漫",
  "纪录片",
];

// 分离符：标题里第一个出现的位置之后就不再是作品名
const SEPARATORS = [" - ", " – ", " — ", " | ", "_", "｜"];

// 季/集标记 —— 这些**不能剥**，它们是身份的一部分。
// 刻意**不包含** 加更版：它是同一部作品的另一个版本，属于「版本」，不属于身份。
// 实测佐证（docs/adr/0008）：电视猫上只有《现在就出发》，没有《…第四季（加更版）》。
const SEASON_MARKER = /第\s*[0-9一二三四五六七八九十百]+\s*[季期部集话話回]|先导片|番外|特别篇/;

/** 去掉书名号、引号、全角空格等装饰，折叠空白。 */
function undecorate(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/[《》〈〉《》「」『』【】]/g, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 身份用的标题归一化：**保守**。
 * 剥掉站点噪声和装饰，保留季/集标记。
 * @returns {string} 归一化标题；拿不到有意义的内容时返回 ""
 */
function normalizeTitle(raw) {
  let s = undecorate(raw);
  if (!s) return "";

  // 1. 在第一个分离符处截断（后面的通常是站点名或栏目名）
  for (const sep of SEPARATORS) {
    const i = s.indexOf(sep);
    if (i > 0) {
      s = s.slice(0, i).trim();
      break;
    }
  }

  // 2. 反复剥掉尾部的括号补充与站点噪声，直到稳定。
  //    括号只有在**不含季/集标记**时才剥：
  //      （1-20全集） → 剥 ；（加更版） → 剥 ；（第二季） → **保留**
  let changed = true;
  while (changed) {
    changed = false;
    const br = s.match(/[（(]([^）)]*)[）)]\s*$/);
    if (br && !SEASON_MARKER.test(br[1])) {
      s = s.slice(0, br.index).trim();
      changed = true;
      continue;
    }
    for (const noise of SITE_NOISE) {
      if (s.length > noise.length && s.endsWith(noise)) {
        s = s.slice(0, -noise.length).trim();
        changed = true;
      }
    }
  }

  // 3. 去掉剥完残留的尾部标点
  s = s.replace(/[·・\-–—|_,，、\s]+$/, "").trim();

  // 4. 只剩噪声时视为拿不到（“高清”、“电视剧”这类）
  if (s.length < 2 || SITE_NOISE.includes(s)) return "";
  return s;
}

/**
 * 查元数据站用的查询变体：**激进**。
 * 从最具体到最宽泛，依次尝试，第一个命中的胜出——与 parse.from / selector / attr 是同一个"有序备选"概念。
 *
 * 实测依据（docs/adr/0008）：电视猫的搜索是精确匹配，
 * `无可替代电视剧` 命中 0，`现在就出发第四季（加更版）` 命中 0，`现在就出发` 命中 1。
 * @returns {string[]} 去重后的查询词，至少一个（原始输入）
 */
function titleQueryVariants(raw) {
  const base = normalizeTitle(raw);
  if (!base) return [];
  const out = [];
  const push = (v) => {
    const t = (v || "").trim();
    if (t && !out.includes(t)) out.push(t);
  };

  push(base);

  // 去掉尾部的括号补充：第X季（加更版） → 第X季
  push(base.replace(/[（(][^）)]*[）)]\s*$/, ""));
  // 去掉尾部整个季/期标记：现在就出发第四季 → 现在就出发
  const withoutSeason = base.replace(
    /\s*第\s*[0-9一二三四五六七八九十百]+\s*[季期部]\s*$/,
    "",
  );
  push(withoutSeason);
  // 去掉所有季/期/版本标记（含中间的）
  push(
    base
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/\s*第\s*[0-9一二三四五六七八九十百]+\s*[季期部集话話回]\s*/g, "")
      .replace(/加更版|先导片|番外|特别篇/g, "")
      .trim(),
  );
  return out;
}

/**
 * 封面图的内容哈希。同一采集生态内的站点可能共享同一串（docs/adr/0007）。
 * @returns {string} 小写 32 位十六进制；取不到返回 ""
 */
function coverHash(url) {
  if (!url) return "";
  const m = String(url).match(/([0-9a-fA-F]{32})(?=[.\-_/]|$)/);
  return m ? m[1].toLowerCase() : "";
}

/** 简介指纹：去掉每站自己的前导语，取归一化前缀。
 *  截断是常态（实测一方 114 字被截断、另一方 150 字完整），所以绝不能比相等。 */
function synopsisPrefix(raw, len = 40) {
  let s = undecorate(raw);
  if (!s) return "";
  // 砍掉前导语：《X》讲述的是： / 电视剧X剧情介绍： —— 共同正文从第一个冒号后开始
  const colon = s.search(/[:：]/);
  if (colon > 0 && colon <= 30) s = s.slice(colon + 1).trim();
  // 截断标记不算内容
  s = s.replace(/[.．…]+$/, "").trim();
  s = s.replace(/[，。、；！？,.;!?"'“”‘’「」『』\s]+/g, "");
  if (s.length < 12) return "";
  return s.slice(0, len);
}

/** 同一个站点的镜像判定用不到这里 —— 见 cluster.mirrorGroupFor。 */

const CONFIDENCE = { high: 2, medium: 1, low: 0 };

/**
 * 从一条访问里抽出所有作品身份键，按可信度从高到低。
 * @param {{url?:string,title?:string,description?:string,ogImage?:string,extracted?:Object}} input
 *        `extracted` 是适配器命名捕获组的结果，键名即字段名
 * @returns {Array<{kind:string,value:string,confidence:"high"|"medium"|"low"}>}
 */
function extractKeys(input = {}) {
  const { url = "", title = "", description = "", ogImage = "", extracted = {} } = input;
  const keys = [];
  const add = (kind, value, confidence) => {
    const v = (value || "").trim();
    if (v && !keys.some((k) => k.kind === kind && k.value === v)) {
      keys.push({ kind, value: v, confidence });
    }
  };

  // 高精度：适配器明确抠出来的编号
  add("code", extracted.code, "high");
  // 高精度：封面内容哈希
  add("cover_hash", coverHash(extracted.cover) || coverHash(ogImage), "high");
  // 中：简介指纹
  add("synopsis", synopsisPrefix(extracted.desc || description), "medium");
  // 低：归一化标题。它**不能单独触发合并**，只用于生成待确认
  add("title", normalizeTitle(extracted.title || title), "low");

  return keys;
}

/** 可用于自动合并的键（默认：高与中）。低可信度键只入库、不合并。 */
function mergeableKeys(keys, minConfidence = "medium") {
  const floor = CONFIDENCE[minConfidence];
  return (keys || []).filter((k) => CONFIDENCE[k.confidence] >= floor);
}

module.exports = {
  KEY_KINDS: ["code", "cover_hash", "synopsis", "title"],
  CONFIDENCE,
  undecorate,
  normalizeTitle,
  titleQueryVariants,
  coverHash,
  synopsisPrefix,
  extractKeys,
  mergeableKeys,
  SEASON_MARKER,
};
