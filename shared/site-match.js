// 站点匹配：一个地址落在哪个**登记站点**上。
//
// 这条规则原先住在扩展里（background.ts 的 extractDomain / matchesWatchlist）。
// 站点页改由 Acuminata 自己承载后（ADR-0011），捕获层与数据层同处一个进程，
// 扩展与桌面端都要用同一条规则 —— 规则只有这一处，两个调用方都从这里取。
//
// 双模单源：CommonJS（扩展打包、node 测试）与浏览器全局。

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.sharedSiteMatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /**
   * 一个地址的主机名：去掉开头的 www.。
   * @param {string} url
   * @returns {string|null} 解析不出来就是 null
   */
  function extractDomain(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, "");
    } catch (e) {
      return null;
    }
  }

  /**
   * 一个地址命中哪个登记站点：域名相同，或是它的子域。
   *
   * 「登记站点」= watchlist 里的条目。没被登记的地址不归任何站点，
   * 因此也不产生访问（兴趣分析只针对用户显式登记的站点，ADR-0003）。
   *
   * @param {string} url
   * @param {Array<{domain:string}>} watchlist
   * @returns {Object|null} 命中的 watchlist 条目
   */
  function matchSite(url, watchlist) {
    const domain = extractDomain(url);
    if (!domain) return null;
    for (const entry of watchlist || []) {
      const pattern = String(entry.domain || "")
        .replace(/^www\./, "")
        .toLowerCase()
        .trim();
      if (!pattern) continue;
      if (domain === pattern || domain.endsWith("." + pattern)) {
        return entry;
      }
    }
    return null;
  }

  return { extractDomain, matchSite };
});
