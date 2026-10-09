// Agent 分析结果的视图模型：一段画像文字 + 关键词徽章。
// 关键词徽章与失败降级的 HTML 只在这里生成，渲染层只负责把结果贴到 DOM 上。
// 双栖单源：node require（进 npm test）+ 浏览器 <script>（window.agentView）。

(function (root, factory) {
  const shared =
    typeof module === "object" && module.exports
      ? require("./utils")
      : root.sharedUtils;
  const api = factory(shared);
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.agentView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (shared) {
  const TAG_STYLE =
    "border-color: var(--muted-fg); color: var(--foreground); background: var(--muted); font-size: 12px; padding: 3px 10px;";

  /**
   * 把一次分析结果变成界面要的字段。成功走文字 + 徽章，失败只走降级 HTML。
   * @param {{summary?:string, keywords?:string[], error?:string}} [result]
   * @returns {{ isError: boolean, profileText: string, profileHtml: string, tagsHtml: string }}
   */
  function buildAnalysisView(result) {
    const analysis = result || {};
    if (analysis.error) {
      return {
        isError: true,
        profileText: "",
        profileHtml: `<span style="color: var(--danger)">分析失败: ${shared.escapeHtml(analysis.error)}</span>`,
        tagsHtml: "",
      };
    }
    const tagsHtml = (analysis.keywords || [])
      .map(
        (kw) =>
          `<span class="badge" style="${TAG_STYLE}">${shared.escapeHtml(kw)}</span>`,
      )
      .join("");
    return {
      isError: false,
      profileText: analysis.summary || "",
      profileHtml: "",
      tagsHtml,
    };
  }

  return { buildAnalysisView };
});
