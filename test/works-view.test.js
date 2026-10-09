// 作品列表视图模型：行内容、空态、加载更多、按站点筛选后的行。
// 这个模块同时要能被浏览器 <script> 加载，所以这里的 require 本身也是一种验证。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {
  buildWorksView,
  buildWorkDetailView,
  siteLabel,
} = require("../shared/works-view");

function check(cond, msg) {
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
}

console.log("Running works-view tests...\n");

const WATCHLIST = [
  { domain: "bilibili.com", label: "B站", color: "#00a1d6" },
  { domain: "dmzj.com", label: "动漫之家", color: "#e11d48" },
];

// --- 空列表 ---
let view = buildWorksView({ works: [], total: 0, site: "all", watchlist: WATCHLIST });
check(view.empty === true && view.rows.length === 0, "空列表 → empty，没有行");
check(view.emptyText === "还没有归入作品的访问", "空列表 → 未归属文案");
check(view.loadMore === null, "空列表 → 没有「加载更多」");

view = buildWorksView({ works: [], total: 0, site: "B站", watchlist: WATCHLIST });
check(view.emptyText === "该站点下暂无作品", "筛选到空 → 站点文案");

// 参数缺失也不炸（渲染层在数据到之前会先画一次）
view = buildWorksView({});
check(view.empty === true && view.emptyText === "还没有归入作品的访问", "缺参数时等同空列表");

// --- 行内容：总分、来源数、访问数、站点 ---
const work = {
  id: "w1",
  title: "进击的巨人",
  score: 7,
  sourceCount: 2,
  visitCount: 5,
  sites: ["bilibili.com", "dmzj.com"],
  lastVisitAt: Date.now() - 1000,
};
view = buildWorksView({ works: [work], total: 1, site: "all", watchlist: WATCHLIST });
const row = view.rows[0];
check(row.score === 7 && row.sourceCount === 2 && row.visitCount === 5, "行带出总分 / 来源数 / 访问数");
check(
  row.sites.map((s) => s.label).join(",") === "B站,动漫之家",
  "站点用监控条目的 label",
);
check(
  row.sites[0].color === "#00a1d6" && row.sites[1].color === "#e11d48",
  "站点带上各自颜色",
);
check(row.lastVisitText && row.lastVisitText !== "无访问", "有访问 → 显示格式化时间");
check(!view.loadMore, "只有一页 → 没有「加载更多」");

// 缺字段的作品用兜底值，不留 undefined
const bare = buildWorksView({ works: [{ id: "w2" }], total: 1, site: "all", watchlist: [] });
check(
  bare.rows[0].title === "未命名作品" &&
    bare.rows[0].score === 0 &&
    bare.rows[0].visitCount === 0 &&
    bare.rows[0].lastVisitText === "无访问",
  "缺字段的作品有兜底值",
);
check(siteLabel("unknown.com", WATCHLIST) === "unknown.com", "认不出的站点用规则本身");

// --- 加载更多 ---
const page = Array.from({ length: 50 }, (_, i) => ({ id: "w" + i, title: "t" + i }));
view = buildWorksView({ works: page, total: 120, site: "all", watchlist: [] });
check(view.loadMore.text === "加载更多 (50 / 120)", "没加载完 → 计数文案");

view = buildWorksView({ works: page, total: 50, site: "all", watchlist: [] });
check(view.loadMore === null, "加载完 → 「加载更多」消失");

// --- 按站点筛选后的行 ---
// 主进程已按站点筛过，模型只负责把剩下的作品画成行。
const filtered = [{ ...work, sites: ["bilibili.com"], sourceCount: 1, visitCount: 3 }];
view = buildWorksView({ works: filtered, total: 1, site: "B站", watchlist: WATCHLIST });
check(
  view.rows[0].sites.length === 1 && view.rows[0].sites[0].label === "B站",
  "筛选后只留下命中站点的行",
);
check(view.rows[0].visitCount === 3, "行的访问数来自筛选后的数据");

// --- 作品详情：来源行（站点 + 版本，同名版本在不同站点各占一行）---
const SOURCES = [
  {
    matchedRule: "bilibili.com",
    edition: "中文字幕",
    visitCount: 2,
    lastVisitAt: Date.now() - 1000,
    lastUrl: "https://bilibili.com/video/smoke",
  },
  {
    matchedRule: "bilibili.com",
    edition: "4K",
    visitCount: 1,
    lastVisitAt: Date.now() - 2000,
    lastUrl: "https://bilibili.com/video/smoke?q=4k",
  },
  {
    matchedRule: "dmzj.com",
    edition: "中文字幕",
    visitCount: 5,
    lastVisitAt: Date.now() - 3000,
    lastUrl: "https://dmzj.com/v/1",
  },
];
let detail = buildWorkDetailView({ sources: SOURCES, watchlist: WATCHLIST });
check(detail.sources.length === 3, "同站点多版本 + 跨站点同版本 → 三行，不合并");
check(
  detail.sources.map((s) => `${s.label}/${s.edition}`).join(",") ===
    "B站/中文字幕,B站/4K,动漫之家/中文字幕",
  "来源行按 (站点, 版本) 各占一行，顺序不变",
);
check(
  detail.sources[0].color === "#00a1d6" && detail.sources[2].color === "#e11d48",
  "来源行带上站点颜色",
);
check(
  detail.sources[0].visitCount === 2 &&
    detail.sources[0].lastVisitText !== "" &&
    detail.sources[0].lastUrl === "https://bilibili.com/video/smoke",
  "来源行带出访问数 / 最近时间 / 最近地址",
);

// 未标注版本的来源 → edition 为空串，由渲染层兜底显示
const noEdition = buildWorkDetailView({
  sources: [{ matchedRule: "bilibili.com", visitCount: 1 }],
  watchlist: WATCHLIST,
});
check(noEdition.sources[0].edition === "", "缺版本 → edition 为空串");

// 无来源
check(
  buildWorkDetailView({}).sources.length === 0 &&
    buildWorkDetailView({ sources: [] }).sourcesEmpty === true,
  "无来源 → 没有行，空态标记为真",
);

// --- 作品详情：访问行（按日期分组，可搜索）---
const TODAY = Date.now();
const YESTERDAY = TODAY - 26 * 3600 * 1000;
const VISITS = [
  {
    id: "v1",
    url: "https://bilibili.com/video/smoke",
    title: "SMOKE 预置访问 α",
    matchedRule: "bilibili.com",
    timestamp: TODAY,
    dwellTime: 125000,
    pinned: 1,
    score: 3,
    edition: "中文字幕",
  },
  {
    id: "v2",
    url: "https://dmzj.com/v/1",
    matchedRule: "dmzj.com",
    timestamp: TODAY - 1000,
  },
  {
    id: "v3",
    url: "https://dmzj.com/v/2",
    matchedRule: "dmzj.com",
    timestamp: YESTERDAY,
  },
];
detail = buildWorkDetailView({ visits: VISITS, watchlist: WATCHLIST });
check(detail.visits.length === 3, "每次访问各占一行");
check(
  detail.visits[0].groupLabel !== "" &&
    detail.visits[1].groupLabel === "" &&
    detail.visits[2].groupLabel !== "",
  "同一天只出现一次日期分组头，换天再出一次",
);
check(
  detail.visits[0].label === "B站" &&
    detail.visits[0].edition === "中文字幕" &&
    detail.visits[0].dwellText === "2分5秒" &&
    detail.visits[0].pinned === true &&
    detail.visits[0].score === 3 &&
    detail.visits[0].timeText !== "",
  "访问行带出站点 / 版本 / 停留 / 置顶 / 分数 / 时间",
);
check(
  detail.visits[1].title === "https://dmzj.com/v/1" &&
    detail.visits[1].edition === "" &&
    detail.visits[1].dwellText === "—" &&
    detail.visits[1].pinned === false &&
    detail.visits[1].score === 0,
  "访问行缺字段有兜底值，标题回落到地址",
);

// 无访问 / 搜索不命中
detail = buildWorkDetailView({ visits: [], watchlist: WATCHLIST });
check(
  detail.visits.length === 0 && detail.visitsEmptyText === "这部作品暂无访问",
  "无访问 → 未访问文案",
);
detail = buildWorkDetailView({
  visits: VISITS,
  query: "没有这样的访问",
  watchlist: WATCHLIST,
});
check(
  detail.visits.length === 0 && detail.visitsEmptyText === "未发现匹配的访问",
  "搜索不命中 → 未匹配文案",
);
detail = buildWorkDetailView({
  visits: VISITS,
  query: "dmzj",
  watchlist: WATCHLIST,
});
check(detail.visits.length === 2, "搜索只留下命中的访问行");

// --- 浏览器分支：<script> 加载时挂到 window 上 ---
const sandbox = {};
vm.createContext(sandbox);
for (const file of ["utils.js", "works-view.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "shared", file), "utf8"),
    sandbox,
    { filename: file },
  );
}
check(
  !!sandbox.sharedUtils && typeof sandbox.sharedUtils.formatTime === "function",
  "utils.js 在浏览器分支挂成全局",
);
check(
  !!sandbox.worksView && typeof sandbox.worksView.buildWorksView === "function",
  "works-view.js 在浏览器分支挂成全局",
);
const browserView = sandbox.worksView.buildWorksView({
  works: [work],
  total: 1,
  site: "all",
  watchlist: WATCHLIST,
});
check(browserView.rows[0].sites[0].label === "B站", "浏览器分支能算出同样的行");
check(
  typeof sandbox.worksView.buildWorkDetailView === "function",
  "详情视图模型在浏览器分支同样可用",
);
const browserDetail = sandbox.worksView.buildWorkDetailView({
  sources: SOURCES,
  watchlist: WATCHLIST,
});
check(
  browserDetail.sources.length === 3 &&
    browserDetail.sources[2].label === "动漫之家",
  "浏览器分支能算出同样的来源行",
);

console.log("\nworks-view tests passed");
