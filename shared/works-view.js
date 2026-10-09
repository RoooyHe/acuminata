// 作品列表的行视图模型：一行显示什么（总分 / 来源数 / 访问数 / 出现的站点）
// 在这里算成纯数据，渲染层只负责把它画出来。
// 双栖单源：node require（进 npm test）+ 浏览器 <script>（window.worksView）。
// 站点筛选由主进程查询完成（record-store.getWorksPage），这里只负责把结果变成行。

(function (root, factory) {
  const shared =
    typeof module === "object" && module.exports
      ? require("./utils")
      : root.sharedUtils;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.worksView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (shared) {
  /**
   * 站点的显示名：监控条目上的 label 优先，认不出就用规则本身。
   * @param {string} rule
   * @param {Array<{domain:string, label?:string}>} watchlist
   * @returns {string}
   */
  function siteLabel(rule, watchlist) {
    const entry = (watchlist || []).find((w) => w.domain === rule);
    return entry ? entry.label || entry.domain : rule;
  }

  /**
   * @param {Object} options
   * @param {Array<Object>} options.works getWorksPage 返回的一页作品
   * @param {number} options.total 筛选后的作品总数
   * @param {string} options.site 当前站点筛选（"all" 或 watchlist 的 label）
   * @param {Array<Object>} options.watchlist
   * @returns {{ rows: Array<Object>, empty: boolean, emptyText: string, loadMore: {text:string}|null }}
   */
  function buildWorksView(options) {
    const works = (options && options.works) || [];
    const watchlist = (options && options.watchlist) || [];
    const site = (options && options.site) || "all";
    const total = (options && options.total) || 0;

    const rows = works.map((w) => ({
      id: w.id,
      title: w.title || "未命名作品",
      score: w.score || 0,
      sourceCount: w.sourceCount || 0,
      visitCount: w.visitCount || 0,
      sites: (w.sites || []).map((rule) => ({
        label: siteLabel(rule, watchlist),
        color: shared.getDomainColor(rule, watchlist),
      })),
      lastVisitText: w.lastVisitAt
        ? shared.formatTime(w.lastVisitAt)
        : "无访问",
    }));

    return {
      rows,
      empty: rows.length === 0,
      emptyText:
        site !== "all" ? "该站点下暂无作品" : "还没有归入作品的访问",
      loadMore:
        rows.length > 0 && rows.length < total
          ? { text: `加载更多 (${rows.length} / ${total})` }
          : null,
    };
  }

  return { buildWorksView, siteLabel };
});
