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
 * detect 与 collect 要 DOM，所以它们住在 `shared/page-collect.js`——
 * 那一份同时被扩展注入页面（采集）与测试用真实页面夹具跑（验证），
 * 桌面端只负责 parse（已存字段的纯函数，改一次适配器能重跑全历史）。
 *
 * 抠出来的只是「编号」这个形状，归一化与身份键由 identity.js 说了算——同一个
 * 编号在不同适配器下必须得到同一个结果，所以归一化不能由适配器各写一遍。
 *
 * 内置适配器与用户适配器走的就是这条管道：内置的也是 `adapters/` 下的一个 JSON
 * 文件，由同一个 loader 读进来，没有特权路径（ADR-0006）。
 *
 * ponytail: 模板里的 `{label:"主演"}` / `attr:"a@text"`（按标签文本定位）尚未实现——
 * 内置 MacCMS 适配器用不到它们。`list` 列表页见下面的 `isListPageUrl` / `listFetchTargets`。
 */

const { extractKeys } = require("./identity");
const { collectPage, detectBySignature, collectListEntries } = require("../shared/page-collect");

/** 从 meta / link 这类标签取属性。没有 root（桌面端回传的访问里就只有字段）时为空。 */
function metaOf(root, selector, attr = "content") {
  if (!root) return "";
  const el = root.querySelector(selector);
  return el ? (el.getAttribute(attr) || "").trim() : "";
}

/**
 * 页面自带的那五个字段。适配器没有 `collect` 时，`parse` 只能用它们（模板「字段说明」）。
 *
 * 页面里的那一次（传 `root`）能从 meta 回退着取，桌面端收到回传时（只有字段）
 * 就用回传的值——一个地方定义这五个字段叫什么，两路都调它。
 * @param {{url?:string,title?:string,description?:string,ogImage?:string,
 *          favIconUrl?:string,root?:Object}} source
 */
function builtinFields(source) {
  return {
    url: source.url || "",
    title: source.title || (source.root && source.root.title) || "",
    description: source.description || metaOf(source.root, "meta[name='description']"),
    ogImage: source.ogImage || metaOf(source.root, "meta[property='og:image']"),
    favIconUrl: source.favIconUrl || metaOf(source.root, "link[rel~='icon']", "href"),
  };
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
 * 内置字段 + 扩展回传的采集字段 → 字段表、解析结果与合并后的字段表。
 *
 * 页面里的那一次（`identityForPage`）与桌面端收到回传的那一次
 * （`cluster.identityKeysFor`）走的是这同一个函数，两条路径的结论因此可比。
 * @param {Object} adapter 认下的适配器
 * @param {Object} builtin 内置五个字段（`builtinFields`）
 * @param {Object} [pageFields] 采集字段，按 `adapter.file` 分组（`collectPage` 的产物）
 */
function identityForFields(adapter, builtin, pageFields) {
  const collected = (pageFields && pageFields[adapter.file]) || {};
  const fields = { ...builtin, ...collected };
  const parsed = parseFields(adapter, fields);
  return { fields, parsed, extracted: { ...fields, ...parsed } };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 列表页路径模板 → 匹配 pathname 的正则。忽略域名与查询串，镜像同样命中。
 * 只看路径：带跟踪参数的同一个列表页也要认得出。
 */
function listPathRegex(raw) {
  // 先去掉协议与主机，再切 `{page}`：`new URL` 会把 `{` `}` 百分号编码掉。
  const path = String(raw)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    .split("?")[0];
  const parts = path.split("{page}").map(escapeRegExp);
  try {
    return new RegExp("^" + parts.join("\\d+") + "$");
  } catch (e) {
    return null;
  }
}

/**
 * 这个地址是不是某个适配器声明的列表页。
 *
 * 列表页有三个角色（ADR-0005）：不记录为访问、要被抓取、本身没有作品身份。
 * 判定看适配器的 `list` 声明——不看用户的 `regexFilter`，那是过滤器，不是解析器。
 * 按路径匹配而非域名，所以镜像上的同一个列表页也认得出。
 *
 * @param {Array<Object>} adapters
 * @param {string} url
 */
function isListPageUrl(adapters, url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch (e) {
    return false;
  }
  for (const adapter of adapters || []) {
    for (const list of adapter.list || []) {
      for (const raw of [list && list.url, list && list.pageUrl]) {
        const re = raw && listPathRegex(raw);
        if (re && re.test(path)) return true;
      }
    }
  }
  return false;
}

/**
 * 该抓哪些列表页：用户**登记过**的站点里，适配器声明了列表页的那些。
 *
 * 抓取只在用户点击时触发（ADR-0005），所以这里只回答「点了以后去哪几个地址」；
 * 不登记不抓（CONTEXT.md「站点」：只有显式登记过的站点才纳入），也不翻分页。
 *
 * @returns {Array<{adapterFile, listName, domain, matchedRule, groupLabel, url, list}>}
 */
function listFetchTargets(adapters, watchlist) {
  const targets = [];
  for (const adapter of adapters || []) {
    for (const list of adapter.list || []) {
      if (!list || !list.url) continue;
      let host;
      try {
        host = new URL(list.url).hostname;
      } catch (e) {
        continue;
      }
      const site = (watchlist || []).find(
        (w) => host === w.domain || host.endsWith("." + w.domain),
      );
      if (!site) continue;
      targets.push({
        adapterFile: adapter.file,
        listName: list.name || "",
        domain: host,
        matchedRule: site.domain,
        groupLabel: site.label || site.domain,
        url: list.url,
        list,
      });
    }
  }
  return targets;
}

/**
 * 一页跑完 detect → collect → parse，产出**字段**与**作品身份键**。
 * 认不出平台返回 null（调用方保持今天的行为）；认出来了就一定有 `keys`，
 * 抠不到编号时 `keys` 少一路而已——这里没有「丢弃」这个结论，
 * 降级成「站点 + 路径」的旧身份由调用方决定（ADR-0003）。
 * @returns {{adapter:Object, fields:Object, parsed:Object, keys:Array<Object>}|null}
 */
function identityForPage(page, adapters) {
  const pageData = collectPage(adapters, page.root);
  const adapter = detectBySignature(pageData.pageSignature, adapters);
  if (!adapter) return null;
  const { fields, parsed, extracted } = identityForFields(
    adapter,
    builtinFields(page),
    pageData.pageFields,
  );
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
  builtinFields,
  identityForFields,
  parseFields,
  identityForPage,
  collectListEntries,
  isListPageUrl,
  listFetchTargets,
};
