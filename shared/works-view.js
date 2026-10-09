// 作品视图模型：列表一行显示什么（总分 / 来源数 / 访问数 / 出现的站点）以及
// 作品详情的来源行（站点 + 版本）与访问行（按日期分组）。
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

  /**
   * 作品详情的行：来源（站点 + 版本）与访问（按日期分组）都在这里算成纯数据。
   * 来源行不合并——同名版本在不同站点上、同站点不同版本上，各占一行。
   * @param {Object} options
   * @param {Array<Object>} [options.sources] getWorkDetail 的来源（已按站点+版本分组）
   * @param {Array<Object>} [options.visits] getWorkDetail 的访问（已按时间倒序）
   * @param {Array<Object>} [options.watchlist]
   * @param {string} [options.query] 访问搜索词
   * @returns {{ sources: Array<Object>, visits: Array<Object>, sourcesEmpty: boolean, visitsEmptyText: string }}
   */
  function buildWorkDetailView(options) {
    const sources = (options && options.sources) || [];
    const visits = (options && options.visits) || [];
    const watchlist = (options && options.watchlist) || [];
    const query = (options && options.query) || "";

    const sourceRows = sources.map((s) => ({
      label: siteLabel(s.matchedRule, watchlist),
      color: shared.getDomainColor(s.matchedRule, watchlist),
      edition: s.edition || "",
      visitCount: s.visitCount || 0,
      lastVisitText: s.lastVisitAt ? shared.formatTime(s.lastVisitAt) : "",
      lastUrl: s.lastUrl || "",
    }));

    // 分组按相邻日期标签变化，和原来的渲染顺序一致（不重排访问）。
    let group = "";
    const visitRows = visits
      .filter((r) => !query || shared.matchesSearch(r, query))
      .map((r) => {
        const label = shared.dateGroupLabel(r.timestamp);
        const groupLabel = label === group ? "" : label;
        group = label;
        return {
          id: r.id,
          url: r.url,
          title: r.title || r.url,
          label: siteLabel(r.matchedRule, watchlist),
          color: shared.getDomainColor(r.matchedRule, watchlist),
          edition: r.edition || "",
          timeText: shared.formatTime(r.timestamp),
          dwellText: formatDwell(r.dwellTime),
          pinned: !!r.pinned,
          score: r.score || 0,
          groupLabel,
        };
      });

    return {
      sources: sourceRows,
      visits: visitRows,
      sourcesEmpty: sourceRows.length === 0,
      visitsEmptyText: query ? "未发现匹配的访问" : "这部作品暂无访问",
    };
  }

  /**
   * 停留时长文案。
   * @param {number} [ms]
   * @returns {string}
   */
  function formatDwell(ms) {
    if (!ms) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "秒";
    const m = Math.floor(s / 60);
    return s % 60 ? `${m}分${s % 60}秒` : `${m}分`;
  }

  return { buildWorksView, buildWorkDetailView, siteLabel };
});
