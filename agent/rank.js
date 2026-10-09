/**
 * Rank — 排序：候选 → 推荐（带理由）。纯函数：无 DB、无网络、无副作用。
 *
 * 排序输入是**兴趣画像**（以作品为单位归纳的偏好，CONTEXT.md），不是站点的
 * 最新更新顺序——没有画像命中的候选只能靠站点的「最新更新」当兜底。
 *
 * 元数据（ADR-0008）由调用方取好、按候选地址传进来：本文件不发请求，也就不会
 * 因为元数据站慢或挂掉而卡住管线；某条候选没有元数据，它照样按廉价信号排出来。
 *
 * 推荐理由只在本文件的 recommendationReason() 里写。
 */

const { normalizeTitle, extractKeys } = require("./identity");
const { siteKeyFor } = require("./cluster");
const { identityForFields } = require("./adapter");

/** 候选的原始字段：库里存的是 JSON 文本，也接受已经是对象的。 */
function candidateFields(candidate) {
  const raw = candidate && candidate.fields;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

/**
 * 候选的身份键：与访问走同一条解析（适配器 parse + extractKeys），
 * 「这条候选是不是已经看过的作品」才能和 work_keys 直接比。
 */
function candidateKeys(candidate, adapters) {
  const fields = candidateFields(candidate);
  const adapter = (adapters || []).find((a) => a.file === candidate.adapterFile);
  const builtin = { url: candidate.url, title: candidate.title, ogImage: fields.cover || "" };
  const { extracted } = adapter
    ? identityForFields(adapter, builtin, { [adapter.file]: fields })
    : { extracted: { ...builtin, ...fields } };
  return extractKeys({
    url: candidate.url,
    title: candidate.title,
    description: fields.description || "",
    ogImage: fields.cover || "",
    extracted,
  });
}

/** 记忆里的一个词条能拆成的关键词（去掉分隔符，至少两个字）。 */
function keywordsIn(text) {
  if (!text) return [];
  let s = String(text);
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object") {
      s = [obj.insight, obj.profileUpdate].filter(Boolean).join(" ");
    }
  } catch (e) {
    /* 不是 JSON，就是一句普通文本 */
  }
  return s
    .split(/[\s,，、;；:：|/（）()【】\[\]{}"'“”]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !w.includes(".")); // 带点的当域名，不是内容词
}

/**
 * 兴趣画像：已看过的作品（标题按作品分数加权）、它们的身份键、常访问的站点，
 * 以及 agent 记忆里学到的词。
 * @param {{works?:Array, keys?:Array, sites?:Array, memories?:Array}} [rows]
 * @returns {{titles:Array<{value,weight}>, codes:string[],
 *            keywords:Array<{value,weight}>, sites:Array<{value,weight}>}}
 */
function buildProfile({ works = [], keys = [], sites = [], memories = [] } = {}) {
  const titles = new Map();
  const weight = (v, w) => titles.set(v, Math.max(titles.get(v) || 0, w));
  for (const w of works) {
    const t = normalizeTitle(w.title);
    if (t) weight(t, w.score || 1);
  }

  const codes = new Set();
  for (const k of keys) {
    if (!k || !k.value) continue;
    if (k.kind === "code" || k.kind === "cover_hash") codes.add(k.value);
    // 低可信度标题键不参与合并，但「看过这个标题」本身就是偏好。
    else if (k.kind === "title") weight(k.value, 1);
  }

  const keywords = new Map();
  for (const m of memories || []) {
    if (!m || m.type === "anti_pattern") continue; // 用户排斥过的不拿来推荐
    if (m.type !== "preference" && m.type !== "insight") continue;
    for (const word of keywordsIn(m.value || m.key)) {
      keywords.set(word, Math.max(keywords.get(word) || 0, m.weight || 0.5));
    }
  }

  return {
    titles: [...titles].map(([value, w]) => ({ value, weight: w })),
    codes: [...codes],
    keywords: [...keywords].map(([value, w]) => ({ value, weight: w })),
    sites: (sites || [])
      .filter((s) => s && s.site)
      .map((s) => ({ value: s.site, weight: s.visits })),
  };
}

/**
 * 一条候选命中了哪些画像信号。元数据没有时只看标题 / 站点（廉价信号）。
 * 站点亲和度按规范域名存（镜像算一个）：候选的 matchedRule 与规范化后的域名
 * 任一命中都算来自常看的站点。
 * @returns {{keyword:string, series:string, site:boolean, groupLabel:string, score:number}}
 */
function signalsFor(candidate, profile, meta, adapters) {
  const fields = candidateFields(candidate);
  const official = normalizeTitle((meta && meta.name) || "");
  const title = official || normalizeTitle(candidate.title);
  const haystack = [
    candidate.title,
    fields.title,
    fields.keywords,
    fields.description,
    meta && meta.name,
    meta && meta.actors,
    meta && meta.type,
  ]
    .filter(Boolean)
    .join(" ");

  const keyword = (profile.keywords || [])
    .map((k) => k.value)
    .find((w) => w && haystack.includes(w));

  let series = "";
  let seriesWeight = 0;
  // shortcut: 同系列靠标题包含判断，短标题偶有误判；接入元数据后改用系列字段
  for (const t of profile.titles || []) {
    const v = t.value;
    if (!v || !title || title === v) continue;
    if ((title.includes(v) || v.includes(title)) && Math.min(title.length, v.length) >= 2) {
      if ((t.weight || 1) > seriesWeight) {
        series = v;
        seriesWeight = t.weight || 1;
      }
    }
  }

  const siteKey = candidate.domain ? siteKeyFor(candidate.domain, adapters) : "";
  const site = (profile.sites || []).some(
    (s) => s.value === candidate.matchedRule || s.value === siteKey,
  );

  let score = 0;
  if (keyword) score += 4;
  if (series) score += 3;
  if (site) score += 2;

  return {
    keyword: keyword || "",
    series,
    site,
    groupLabel: candidate.groupLabel || candidate.matchedRule || candidate.domain || "",
    score,
  };
}

/** 推荐理由**只在这里写**（权重从高到低，最多两条）。 */
function recommendationReason(signals) {
  const parts = [];
  if (signals.keyword) parts.push(`与你兴趣画像相符：${signals.keyword}`);
  if (signals.series) parts.push(`与看过的《${signals.series}》同系列`);
  if (signals.site) parts.push(`来自你常看的站点「${signals.groupLabel}」`);
  if (parts.length === 0) parts.push(`「${signals.groupLabel}」最新更新`);
  return parts.slice(0, 2).join("；");
}

/**
 * 把候选排成推荐：已经访问过的不出现，画像命中越多的越靠前，同分时新抓的靠前。
 * @param {Array<Object>} candidates 候选行（fields 为 JSON 文本或对象）
 * @param {Object} profile `buildProfile` 的产物
 * @param {{seenKeys?:string[], adapters?:Array<Object>, metadata?:Object, limit?:number}} [options]
 *        seenKeys 为 `"kind:value"` 的作品身份键；metadata 按候选地址给出
 *        `{name, actors, type}`（ADR-0008），取不到就是没有
 * @returns {Array<{url,title,domain,groupLabel,reason,score}>}
 */
function rank(candidates, profile = {}, options = {}) {
  const seen = new Set(options.seenKeys || []);
  const adapters = options.adapters || [];
  const metadata = options.metadata || {};
  const rows = [];

  for (const candidate of candidates || []) {
    if (!candidate || !candidate.url) continue;
    // 已经访问过的作品不是推荐（ADR-0005：候选与推荐分表的理由）。
    const known = candidateKeys(candidate, adapters).some((k) =>
      seen.has(`${k.kind}:${k.value}`),
    );
    if (known) continue;

    const meta = metadata[candidate.url] || null;
    const signals = signalsFor(candidate, profile, meta, adapters);
    rows.push({
      url: candidate.url,
      title: (meta && meta.name) || candidate.title || "",
      domain: candidate.domain || "",
      groupLabel: signals.groupLabel,
      reason: recommendationReason(signals),
      score: signals.score,
      updatedAt: candidate.updatedAt || 0,
    });
  }

  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.updatedAt - a.updatedAt ||
      String(a.title).localeCompare(String(b.title)),
  );
  return rows.slice(0, options.limit || 50);
}

module.exports = { rank, buildProfile, candidateKeys, recommendationReason };
