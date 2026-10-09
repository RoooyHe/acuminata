/**
 * 适配器 —— `docs/adapters/template.md` 那份模板的真实实现。
 *
 * 一个适配器是一份 JSON，读进来只当**数据**用（`agent/adapters.js`），
 * 不执行其中的任何代码（ADR-0003）。三件事，一个方向：
 *
 *   detect  —— 按**页面签名**认出平台，不按域名、也不按 URL 形状（ADR-0006）
 *   collect —— 从 DOM 抽出具名字段；选择器与属性都是**有序备选**，第一个命中的胜出
 *   parse   —— 用命名捕获组正则从字段里抠身份字段；`from` 也是有序备选
 *
 * 抠出来的只是「编号」这个形状，归一化与身份键由 identity.js 说了算——同一个
 * 编号在不同适配器下必须得到同一个结果，所以归一化不能由适配器各写一遍。
 *
 * 内置适配器与用户适配器走的就是这条管道：内置的也是 `adapters/` 下的一个 JSON
 * 文件，由同一个 loader 读进来，没有特权路径（ADR-0006）。
 *
 * 这里只用 `root.querySelectorAll` 与 `RegExp`，没有 Node API，所以同一份代码
 * 在扩展（页面里）与测试（linkedom 解析真实页面夹具）里都能跑。
 *
 * ponytail: 模板里的 `{label:"主演"}` / `attr:"a@text"`（按标签文本定位）与
 * `list` 列表页尚未实现——内置 MacCMS 适配器用不到它们，`list` 归后续的候选（#30）。
 */

const { extractKeys } = require("./identity");

/** 页面签名：内联脚本里出现过的 `var X=` 全局名。MacCMS 两站都靠 `var maccms={...}` 报出平台。 */
function pageGlobals(root) {
  const names = new Set();
  for (const script of root.querySelectorAll("script")) {
    const text = script.textContent || "";
    for (const m of text.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  }
  return names;
}

/**
 * 认出这一页属于哪个适配器。只看签名：`detect.pageGlobal` 在页面的全局名里。
 * @param {{root:Object, url?:string}} page
 * @param {Array<Object>} adapters
 * @returns {Object|null}
 */
function detect(page, adapters) {
  const globals = pageGlobals(page.root);
  return (
    (adapters || []).find((a) => {
      const sig = a.detect || {};
      return !!sig.pageGlobal && globals.has(sig.pageGlobal);
    }) || null
  );
}

function readAttr(node, attr) {
  if (attr === "text") return (node.textContent || "").trim();
  if (attr === "html") return node.innerHTML || "";
  return ((node.getAttribute && node.getAttribute(attr)) || "").trim();
}

/** 一个节点上按属性备选取值：第一个非空的胜出。 */
function pickValue(node, attrs) {
  for (const attr of attrs) {
    const v = readAttr(node, attr);
    if (v) return v;
  }
  return "";
}

function nodesFor(root, selector) {
  return selector === "" ? [root] : root.querySelectorAll(selector);
}

/**
 * 一条 collect 规则取一个字段。三层都是有序备选，由外到内：
 * 选择器 → 该选择器命中的节点 → 节点上的属性。第一个产出值的胜出。
 * `many` 返回该选择器命中的全部值（每个节点取它自己第一个非空属性）。
 */
function collectField(root, selectors, attrs, many) {
  for (const selector of selectors) {
    const values = [];
    for (const node of nodesFor(root, selector)) {
      const v = pickValue(node, attrs);
      if (v) values.push(v);
      if (!many) break;
    }
    if (values.length) return many ? values : values[0];
  }
  return many ? [] : null;
}

/** 页面自带的那五个字段。适配器没有 `collect` 时，`parse` 只能用它们（模板「字段说明」）。 */
function builtinFields(page) {
  const root = page.root;
  const attr = (selector, name) => {
    const el = root.querySelector(selector);
    return el ? (el.getAttribute(name) || "").trim() : "";
  };
  return {
    url: page.url || "",
    title: page.title || root.title || "",
    description: page.description || attr("meta[name='description']", "content"),
    ogImage: page.ogImage || attr("meta[property='og:image']", "content"),
    favIconUrl: page.favIconUrl || attr("link[rel~='icon']", "href"),
  };
}

/**
 * 采集：每条 collect 规则抽一个具名字段。选择器与属性都是有序备选。
 * @returns {Object} 字段名 → 值（`many` 为数组，抽不到为 null / []）
 */
function collect(adapter, page) {
  const out = {};
  for (const rule of adapter.collect || []) {
    if (!rule || !rule.field) continue;
    const selectors = Array.isArray(rule.selector) ? rule.selector : [rule.selector];
    const attrs = Array.isArray(rule.attr) ? rule.attr : [rule.attr];
    out[rule.field] = collectField(page.root, selectors, attrs, !!rule.many);
  }
  return out;
}

/**
 * 解析：每条 parse 规则从 `from` 里的字段逐个尝试命名捕获组正则，
 * 第一个抠出值的字段胜出。读的只有入参字段，所以是纯函数——改一次适配器
 * 就能拿存下来的原始字段重跑全历史（模板「重跑」）。
 * @returns {Object} 字段名 → 值或 null
 */
function parseFields(adapter, fields) {
  const out = {};
  for (const [name, rule] of Object.entries(adapter.parse || {})) {
    out[name] = null;
    let regex;
    try {
      regex = new RegExp(rule.regex);
    } catch (e) {
      continue; // 坏正则只是这一条规则不生效
    }
    for (const from of rule.from || []) {
      const raw = fields[from];
      const text = Array.isArray(raw) ? raw.join(" ") : raw;
      if (!text) continue;
      const m = regex.exec(String(text));
      const value = m && m.groups ? m.groups[name] : null;
      if (value) {
        out[name] = value;
        break;
      }
    }
  }
  return out;
}

/**
 * 一页跑完 detect → collect → parse，产出**字段**与**作品身份键**。
 * 认不出平台返回 null（调用方保持今天的行为）；认出来了就一定有 `keys`，
 * 抠不到编号时 `keys` 少一路而已——这里没有「丢弃」这个结论，
 * 降级成「站点 + 路径」的旧身份由调用方决定（ADR-0003）。
 * @returns {{adapter:Object, fields:Object, parsed:Object, keys:Array<Object>}|null}
 */
function identityForPage(page, adapters) {
  const adapter = detect(page, adapters);
  if (!adapter) return null;
  const fields = { ...builtinFields(page), ...collect(adapter, page) };
  const parsed = parseFields(adapter, fields);
  const extracted = { ...fields, ...parsed };
  const keys = extractKeys({
    url: fields.url,
    title: fields.title,
    description: fields.description,
    ogImage: fields.ogImage,
    extracted,
  });
  return { adapter, fields, parsed, keys };
}

module.exports = {
  pageGlobals,
  detect,
  collect,
  parseFields,
  identityForPage,
};
