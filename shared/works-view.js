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

  /**
   * 一条访问落库后，就地更新作品列表里那一行。
   * 已加载的行直接替成新汇总并重排；不在列表里的新作品按当前筛选插入。
   * 列表本身不重拉（那是整页刷新），只动受影响的一行。
   * @param {Array<Object>} works 已加载的作品行
   * @param {Object} work getWorkRow 的汇总行
   * @param {{sort?:string, site?:string, watchlist?:Array<Object>, limit?:number}} [options]
   * @returns {Array<Object>} 新数组
   */
  function mergeWorkRow(works, work, options) {
    const opts = options || {};
    const list = (works || []).slice();
    const idx = list.findIndex((w) => w.id === work.id);
    if (idx === -1) {
      const site = opts.site;
      const matchesSite =
        !site ||
        site === "all" ||
        (work.sites || []).some(
          (rule) => siteLabel(rule, opts.watchlist) === site,
        );
      if (!matchesSite) return list;
      list.push(work);
    } else {
      list[idx] = work;
    }
    // 与 getWorksPage 的排序一致：score 为 (score DESC, lastVisitAt DESC)，recent 反之。
    const recent = opts.sort === "recent";
    list.sort((a, b) => {
      const av = recent ? a.lastVisitAt || 0 : a.score || 0;
      const bv = recent ? b.lastVisitAt || 0 : b.score || 0;
      if (av !== bv) return bv - av;
      const at = recent ? a.score || 0 : a.lastVisitAt || 0;
      const bt = recent ? b.score || 0 : b.lastVisitAt || 0;
      return bt - at;
    });
    return typeof opts.limit === "number" && opts.limit > 0
      ? list.slice(0, opts.limit)
      : list;
  }

  /**
   * 从已加载的作品行里去掉一条（那条访问换归属后旧作品无访问被清掉）。
   * @param {Array<Object>} works
   * @param {string} id
   * @returns {Array<Object>} 新数组
   */
  function removeWorkRow(works, id) {
    return (works || []).filter((w) => w.id !== id);
  }

  /**
   * 从访问列表推导来源行（站点 + 版本），与 store 的聚合同形。
   * 站点用 `visit.site`（适配器声明的镜像组的规范域名），镜像因此只算一个来源；
   * 老记录没有 site 时退回 matchedRule。
   * 一条新访问只改一条来源行（或新增一行），不需要回头查库。
   * @param {Array<Object>} visits
   * @returns {Array<Object>}
   */
  function deriveSources(visits) {
    const byKey = new Map();
    for (const v of visits || []) {
      const site = v.site || v.matchedRule;
      const key = (site || "") + "\u0000" + (v.edition || "");
      let s = byKey.get(key);
      if (!s) {
        s = {
          matchedRule: site,
          edition: v.edition || "",
          visitCount: 0,
          lastVisitAt: 0,
          lastUrl: "",
        };
        byKey.set(key, s);
      }
      s.visitCount++;
      if ((v.timestamp || 0) >= s.lastVisitAt) {
        s.lastVisitAt = v.timestamp || 0;
        s.lastUrl = v.url || "";
      }
    }
    return Array.from(byKey.values()).sort(
      (a, b) => b.lastVisitAt - a.lastVisitAt,
    );
  }

  /**
   * 把一条访问合并进打开中的作品详情：只动受影响的那一行（新增/替换/移出），
   * 来源行随访问列表重算。作品不受影响时原样返回。
   * @param {{work:Object, visits:Array<Object>, sources:Array<Object>}} detail
   * @param {Object} record
   * @returns {{detail:Object, changed:boolean}}
   */
  function mergeVisitInDetail(detail, record) {
    const visits = (detail.visits || []).slice();
    const idx = visits.findIndex((v) => v.id === record.id);
    if (record.workId !== detail.work.id) {
      // 这条访问从这部作品上移走了：删掉它，其余不动。
      if (idx === -1) return { detail, changed: false };
      visits.splice(idx, 1);
    } else {
      if (idx === -1) visits.push(record);
      else visits[idx] = record;
      visits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    return {
      detail: { ...detail, visits, sources: deriveSources(visits) },
      changed: true,
    };
  }

  /**
   * 把一条访问合并进「未归类」列表（workId 为空才属于它）。
   * delta 告诉调用方总数该加减多少（插入为 +1，移出为 -1）。
   * @param {Array<Object>} records
   * @param {Object} record
   * @param {string} [query]
   * @returns {{records:Array<Object>, delta:number}}
   */
  function mergeUnattributedRow(records, record, query) {
    const list = (records || []).slice();
    const idx = list.findIndex((r) => r.id === record.id);
    const belongs =
      record.workId == null && (!query || shared.matchesSearch(record, query));
    if (belongs) {
      if (idx === -1) {
        list.unshift(record);
        return { records: list, delta: 1 };
      }
      list[idx] = record;
      return { records: list, delta: 0 };
    }
    if (idx !== -1) {
      list.splice(idx, 1);
      return { records: list, delta: -1 };
    }
    return { records: list, delta: 0 };
  }

  return {
    buildWorksView,
    buildWorkDetailView,
    siteLabel,
    mergeWorkRow,
    removeWorkRow,
    deriveSources,
    mergeVisitInDetail,
    mergeUnattributedRow,
  };
});
