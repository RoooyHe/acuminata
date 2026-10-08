// Shared view-model utilities — framework-agnostic, side-effect-free.
// Dual-mode single source: CommonJS export (extension bundler) and a browser
// global (`window.sharedUtils`, loaded via <script> in ui/index.html).
// NOTE: sandboxed preload cannot require this file, so renderer gets it via <script>.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.sharedUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /**
   * Escape HTML special characters.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str).replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );
  }

  /**
   * Format a timestamp into a human-readable relative string (Chinese locale).
   * @param {number} ts
   * @returns {string}
   */
  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m前";
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  /**
   * Return a date-group label for a timestamp: "今天", "昨天", or YYYY/MM/DD.
   * @param {number} ts
   * @returns {string}
   */
  function dateGroupLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "今天";
    if (d.toDateString() === yesterday.toDateString()) return "昨天";
    return d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  /**
   * Resolve the display color for a watchlist entry by domain or label.
   * @param {string} val
   * @param {Array<{domain:string, label?:string, color:string}>} watchlist
   * @returns {string}
   */
  function getDomainColor(val, watchlist) {
    const entry = watchlist.find(
      (e) => e.domain === val || e.label === val,
    );
    return entry ? entry.color : "#767d88";
  }

  /**
   * Predicate: does a record match a search query?
   * @param {{title?:string, url?:string, matchedRule?:string}} r
   * @param {string} q
   * @returns {boolean}
   */
  function matchesSearch(r, q) {
    const lower = q.toLowerCase();
    return (
      (r.title && typeof r.title === "string" && r.title.toLowerCase().includes(lower)) ||
      (r.url && typeof r.url === "string" && r.url.toLowerCase().includes(lower)) ||
      (r.matchedRule && typeof r.matchedRule === "string" && r.matchedRule.toLowerCase().includes(lower))
    );
  }

  return { escapeHtml, formatTime, dateGroupLabel, getDomainColor, matchesSearch };
});
