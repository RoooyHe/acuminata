// Agent 分析结果的视图模型：一段画像文字 + 关键词徽章，成功与失败只差一个分支。
// 徽章与失败降级的 HTML 只在这里生成，渲染层不再各写一份。
// 这个模块同时要能被浏览器 <script> 加载，所以这里的 require 本身也是一种验证。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { buildAnalysisView } = require("../shared/agent-view");

function check(cond, msg) {
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
}

console.log("Running agent-view tests...\n");

// --- 成功：文字原样，关键词变成徽章 ---
let view = buildAnalysisView({
  summary: "喜欢深夜看纪录片",
  keywords: ["纪录片", "深夜"],
});
check(view.isError === false, "成功 → 不是错误");
check(view.profileText === "喜欢深夜看纪录片", "画像文字来自 summary");
check(
  (view.tagsHtml.match(/class="badge"/g) || []).length === 2,
  "每个关键词一个徽章",
);
check(view.tagsHtml.includes("纪录片") && view.tagsHtml.includes("深夜"), "徽章带出关键词");

// --- 失败：只有一处生成降级 HTML，徽章为空 ---
view = buildAnalysisView({ error: "连接超时" });
check(view.isError === true, "有 error → 错误态");
check(view.profileHtml.includes("分析失败: 连接超时"), "降级 HTML 带出错误原因");
check(view.tagsHtml === "", "错误态没有徽章");

// --- 转义：关键词与错误都不许变成 HTML ---
view = buildAnalysisView({ summary: "s", keywords: ['<img src=x onerror="1">'] });
check(!view.tagsHtml.includes("<img"), "关键词里的标签被转义");
view = buildAnalysisView({ error: '<script>alert("x")</script>' });
check(!view.profileHtml.includes("<script>"), "错误里的标签被转义");

// --- 缺字段不炸（渲染层在数据到之前会先画一次） ---
view = buildAnalysisView();
check(view.isError === false && view.profileText === "" && view.tagsHtml === "", "缺结果等同空成功");
view = buildAnalysisView({ summary: "只有文字" });
check(view.profileText === "只有文字" && view.tagsHtml === "", "没有关键词就没有徽章");

// --- 浏览器分支：<script> 加载时挂到 window 上 ---
const sandbox = {};
vm.createContext(sandbox);
for (const file of ["utils.js", "agent-view.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "shared", file), "utf8"),
    sandbox,
    { filename: file },
  );
}
check(
  !!sandbox.agentView && typeof sandbox.agentView.buildAnalysisView === "function",
  "agent-view.js 在浏览器分支挂成全局",
);
const browserView = sandbox.agentView.buildAnalysisView({
  summary: "s",
  keywords: ["纪录片"],
});
check(browserView.tagsHtml.includes("纪录片"), "浏览器分支能算出同样的徽章");

console.log("\nagent-view tests passed");
