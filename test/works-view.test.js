// 作品列表视图模型：行内容、空态、加载更多、按站点筛选后的行。
// 这个模块同时要能被浏览器 <script> 加载，所以这里的 require 本身也是一种验证。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildWorksView, siteLabel } = require("../shared/works-view");

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

console.log("\nworks-view tests passed");
