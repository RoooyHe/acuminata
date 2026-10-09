// 页面采集 —— 适配器管道里需要 DOM 的那一半：认**页面签名**、跑 collect 抽字段。
// Dual-mode single source：CommonJS（扩展打包、node 测试）与浏览器全局。
//
// 整个文件只有一个自足的函数 `collectPage`。扩展用
// `chrome.scripting.executeScript` 把它整段注入页面，`func.toString()` 之后闭包全没了，
// 所以它内部只认参数与浏览器全局，**不要**引用本模块作用域里的任何名字。
// 桌面端的测试用 linkedom 把同一个函数跑在真实抓下来的页面夹具上
// （agent/adapter.test.js、agent/maccms-signature.e2e.test.js），
// 页面里那一次与测试里这一次因此是同一条代码。
//
// 扩展回传的是「它看到了什么」：页面签名 + 各适配器的 collect 规则在这个页面上
// 抽到的字段。**谁算这个页面的适配器由桌面端决定**（`detectBySignature`
// 在 agent/record-store 的写入路径里），判定只有一处，不在页面里也不在扩展里。
// 平台由页面签名认，不按域名、也不按 URL 形状（docs/adr/0006）。
//
// detect 若拿不到编号要降级、不能丢弃（docs/adr/0003）——这里不产出「丢弃」这个结论，
// 抽不到就是空字段，桌面端照常记录访问。

(function (globalRoot, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (globalRoot) globalRoot.acuminataPageCollect = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /**
   * 签名 → 适配器。签名是页面自己报出的平台身份（内联脚本里的 `var maccms=`）。
   * 第一个命中的胜出——适配器按文件名排序读入，内置的没有特权（docs/adr/0006）。
   * @param {Iterable<string>} signature 页面签名（`collectPage().pageSignature`）
   * @param {Array<Object>} adapters
   * @returns {Object|null}
   */
  function detectBySignature(signature, adapters) {
    const names = signature instanceof Set ? signature : new Set(signature || []);
    return (
      (adapters || []).find((a) => {
        const sig = a.detect || {};
        return !!sig.pageGlobal && names.has(sig.pageGlobal);
      }) || null
    );
  }

  /**
   * 在页面里认签名并抽字段。**自足**：注入后模块作用域不存在，只认参数与全局。
   *
   * 字段按来源文件名分组（`pageFields["maccms.json"].cover`），因为
   * 「哪些字段算数」取决于桌面端认下的是哪个适配器——扩展只负责把看到的都带回来。
   *
   * @param {Array<Object>} adapters 桌面端 init 推过来的适配器
   * @param {Object} [doc] 文档；页面里省略（用 document），测试里传 linkedom 的文档
   * @returns {{description:string, ogImage:string, pageSignature:string[], pageFields:Object<string,Object>}}
   */
  function collectPage(adapters, doc) {
    const root = doc || document;

    // 页面签名：内联脚本里出现过的 `var X=` 全局名
    const names = new Set();
    for (const script of root.querySelectorAll("script")) {
      const text = script.textContent || "";
      for (const m of text.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
    }

    const readAttr = (node, attr) => {
      if (attr === "text") return (node.textContent || "").trim();
      if (attr === "html") return node.innerHTML || "";
      return ((node.getAttribute && node.getAttribute(attr)) || "").trim();
    };

    const pickValue = (node, attrs) => {
      for (const attr of attrs) {
        const v = readAttr(node, attr);
        if (v) return v;
      }
      return "";
    };

    const pageFields = {};
    for (const adapter of adapters || []) {
      // 按来源文件名分组：`file` 由 agent/adapters.js 的 loadAdapters 给每个适配器标上，
      // 桌面端认下适配器后就用同一个 file 去取自己那一份（一个值，一处生产）。
      const key = adapter.file;
      if (!key) continue;
      const fields = {};
      for (const rule of adapter.collect || []) {
        if (!rule || !rule.field) continue;
        const selectors = Array.isArray(rule.selector) ? rule.selector : [rule.selector];
        const attrs = Array.isArray(rule.attr) ? rule.attr : [rule.attr];
        // 选择器与属性都是有序备选，第一个产出值的胜出（与 parse.from 同一个概念）
        for (const selector of selectors) {
          const values = [];
          const nodes = selector === "" ? [root] : root.querySelectorAll(selector);
          for (const node of nodes) {
            const v = pickValue(node, attrs);
            if (v) values.push(v);
            if (!rule.many) break;
          }
          if (values.length) {
            fields[rule.field] = rule.many ? values : values[0];
            break;
          }
        }
        if (fields[rule.field] === undefined) fields[rule.field] = rule.many ? [] : null;
      }
      pageFields[key] = fields;
    }

    const meta = (selector) => {
      const el = root.querySelector(selector);
      return el ? (el.getAttribute("content") || "").trim() : "";
    };

    return {
      description: meta("meta[name='description']"),
      ogImage: meta("meta[property='og:image']"),
      pageSignature: Array.from(names),
      pageFields,
    };
  }

  return { collectPage, detectBySignature };
});
