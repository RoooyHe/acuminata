// @ts-check
/// <reference path="../shared/types.d.ts" />

/** @type {import("../shared/types").WatchlistEntry[]} */
let watchlist = [];
/** @type {import("../shared/types").HistoryRecord[]} */
let records = [];
let enabled = true;
let searchQuery = "";
/** @type {{ total: number; today: number; sites: number; enabled: boolean; domainCounts: Record<string, number>; topDomain: string|null; topDomainCount: number; }|null} */
let stats = null;
/** @type {Set<string>} */
let selectedIds = new Set();

// 作品主视图状态
/** @type {Array<Object>} */
let works = [];
let worksPage = 1;
let worksTotal = 0;
let worksSort = "score";
let worksSite = "all";
const worksPageSize = 50;

// 未归属访问 + 适配器健康度
/** @type {{ unattributedCount: number, adapters: Array<{key:string,label:string,kind:string,matched:number,dropped:number,suspect:boolean}> }|null} */
let health = null;
let worksView = "works";
/** @type {Array<Object>} */
let unattributed = [];
let unattributedPage = 1;
let unattributedTotal = 0;
let unattributedQuery = "";

// 作品详情状态：{ work, sources, visits }；null 表示正在看作品列表
/** @type {Object|null} */
let currentWork = null;

// --- 基础工具函数 ---
/**
 * @param {number} ts
 * @returns {string}
 */
function formatTime(ts) {
  return window.sharedUtils.formatTime(ts);
}

/**
 * @param {string} val
 * @returns {string}
 */
function getDomainColor(val) {
  return window.sharedUtils.getDomainColor(val, watchlist);
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return window.sharedUtils.escapeHtml(str);
}

/**
 * @param {string} msg
 * @param {"success"|"error"} [type="success"]
 */
function showToast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show";
  setTimeout(() => el.classList.remove("show"), 2500);
}

function setWsStatus(connected) {
  const dot = document.getElementById("wsDot");
  const txt = document.getElementById("wsStatusText");
  dot.className = "ws-dot " + (connected ? "on" : "");
  txt.textContent = connected ? "ONLINE" : "OFFLINE";
}

function dateGroupLabel(ts) {
  return window.sharedUtils.dateGroupLabel(ts);
}

// --- 渲染逻辑 ---
function renderStats() {
  if (!stats) return;
  document.getElementById("statTotal").textContent = stats.total;
  document.getElementById("statToday").textContent = stats.today;
  document.getElementById("statSites").textContent =
    stats.sites || watchlist.length;
  document.getElementById("statTopSite").textContent = stats.topDomain || "-";
}

function renderWatchlist() {
  const container = document.getElementById("watchlist");
  const counts = (stats && stats.domainCounts) || {};
  if (watchlist.length === 0) {
    container.innerHTML =
      '<div style="color:var(--muted-fg); font-size:12px">暂无监控站点</div>';
    return;
  }
  container.innerHTML = watchlist
    .map(
      (entry) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border:1px solid var(--border); border-radius:6px; background:#1a1a1a">
      <div style="display:flex; align-items:center; gap:8px">
        <div style="width:8px; height:8px; border-radius:50%; background:${entry.color}"></div>
        <span style="font-family:var(--font-mono); font-weight:600">${escapeHtml(entry.domain)}</span>
        <span class="badge">${escapeHtml(entry.label || "未命名")}</span>
        ${entry.regexFilter ? `<span style="color:var(--warning); font-size:10px" title="正则: ${escapeHtml(entry.regexFilter)}">[.*]</span>` : ""}
      </div>
      <div style="display:flex; align-items:center; gap:12px">
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--muted-fg)">${counts[entry.label || entry.domain] || 0} hits</span>
        <button class="btn btn-ghost" data-action="remove-entry" data-domain="${escapeHtml(entry.domain)}" style="padding:2px 6px">×</button>
      </div>
    </div>
  `,
    )
    .join("");
}

// 行内容由 shared/works-view.js 算好，这里只把它画出来。
function renderRecords() {
  const container = document.getElementById("recordsContainer");
  const view = window.worksView.buildWorkDetailView({
    visits: records,
    query: searchQuery,
    watchlist,
  });

  if (view.visits.length === 0) {
    container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted-fg)">${view.visitsEmptyText}</div>`;
    return;
  }

  container.innerHTML = view.visits
    .map((r) => {
      const groupHeader = r.groupLabel
        ? `<div class="date-group-header">${r.groupLabel}</div>`
        : "";
      const edition = r.edition
        ? `<span class="badge">${escapeHtml(r.edition)}</span>`
        : "";
      return `${groupHeader}
      <div class="data-item" data-url="${encodeURIComponent(r.url)}">
        <input type="checkbox" class="rec-checkbox" data-action="rec-select" data-id="${r.id}" ${selectedIds.has(r.id) ? "checked" : ""}>
        <div class="item-body">
          <div class="item-title">${escapeHtml(r.title)}</div>
          <div class="item-meta">
            <span class="badge" style="border-color:${r.color}; color:${r.color}">${escapeHtml(r.label)}</span>
            ${edition}
            <span>${r.timeText}</span>
            <span>停留 ${r.dwellText}</span>
            <span class="item-url">${escapeHtml(r.url)}</span>
          </div>
        </div>
        <div class="item-actions">
          <button class="btn-pin-text ${r.pinned ? "on" : ""}" data-action="rec-pin" data-id="${r.id}">${r.pinned ? "Pinned" : "Pin"}</button>
          ${
            r.pinned
              ? `
            <div class="score-group">
              <button class="score-btn" data-action="rec-score-down" data-id="${r.id}">−</button>
              <span class="score-val">${r.score}</span>
              <button class="score-btn" data-action="rec-score-up" data-id="${r.id}">+</button>
            </div>
          `
              : ""
          }
        </div>
      </div>
    `;
    })
    .join("");
}

// 每个 (站点, 版本) 组合各占一行——同名版本在不同站点上必须分别显示。
function renderWorkSources() {
  const container = document.getElementById("workSources");
  const view = window.worksView.buildWorkDetailView({
    sources: (currentWork && currentWork.sources) || [],
    watchlist,
  });
  if (view.sourcesEmpty) {
    container.innerHTML = `<div style="padding:20px; text-align:center; color:var(--muted-fg); font-size:12px">这部作品暂无来源</div>`;
    return;
  }
  container.innerHTML = view.sources
    .map((s) => {
      const edition = s.edition
        ? `<span class="badge">${escapeHtml(s.edition)}</span>`
        : `<span class="badge" style="opacity:0.5">未标注版本</span>`;
      return `
      <div class="data-item" data-open-url="${encodeURIComponent(s.lastUrl)}">
        <div class="item-body">
          <div class="item-title">
            <span class="badge" style="border-color:${s.color}; color:${s.color}">${escapeHtml(s.label)}</span>
            ${edition}
          </div>
          <div class="item-meta">
            <span>${s.visitCount} 次访问</span>
            <span>${s.lastVisitText}</span>
            <span class="item-url">${escapeHtml(s.lastUrl)}</span>
          </div>
        </div>
        <div class="item-actions"><button class="btn-pin-text">打开</button></div>
      </div>`;
    })
    .join("");
}

// 详情页头：分数、来源数、访问数，以及「打开最近一次」。数据变了就地重画。
function renderWorkDetailHeader() {
  if (!currentWork) return;
  document.getElementById("workDetailTitle").textContent =
    currentWork.work.title || "未命名作品";
  document.getElementById("workDetailMeta").innerHTML =
    `<span class="badge">${currentWork.work.score || 0} 分</span>` +
    `<span>${currentWork.sources.length} 个来源</span>` +
    `<span>${records.length} 次访问</span>`;
  const latest = document.getElementById("btnOpenLatest");
  const hasVisits = records.length > 0;
  latest.style.display = hasVisits ? "" : "none";
  latest.onclick = hasVisits
    ? () => window.electronAPI.openUrl(records[0].url)
    : null;
}

// 访问列表收进作品详情：打开一部作品，来源与全部访问都在这里。
async function openWorkDetail(workId) {
  const detail = await window.electronAPI.getWorkDetail(workId);
  if (!detail) return;
  // 同一次打开（广播后刷新）不重置搜索，否则用户正在输入的过滤会被清掉。
  const sameWork = currentWork && currentWork.work.id === workId;
  currentWork = detail;
  records = detail.visits || [];
  if (!sameWork) {
    searchQuery = "";
    selectedIds.clear();
    const search = document.getElementById("searchInput");
    if (search) search.value = "";
  }
  renderWorkDetailHeader();
  renderWorkSources();
  renderRecords();
  updateBatchDeleteBtn();
  document.getElementById("worksListView").style.display = "none";
  document.getElementById("workDetailView").style.display = "block";
}

async function refreshStats() {
  stats = await window.electronAPI.getStatistics();
  enabled = stats.enabled;
  renderStats();
}

// --- 作品主视图 ---
function siteLabel(rule) {
  return window.worksView.siteLabel(rule, watchlist);
}

function renderWorksSiteBar() {
  const bar = document.getElementById("worksSiteBar");
  const labels = Object.keys((stats && stats.domainCounts) || {});
  let html = `<div class="filter-chip ${worksSite === "all" ? "active" : ""}" data-site="all">全部</div>`;
  labels.forEach((label) => {
    html += `<div class="filter-chip ${worksSite === label ? "active" : ""}" data-site="${escapeHtml(label)}">${escapeHtml(label)}</div>`;
  });
  bar.innerHTML = html;
}

// 行内容由 shared/works-view.js 算好，这里只把它画出来。
function renderWorks() {
  const container = document.getElementById("worksContainer");
  const more = document.getElementById("worksLoadMoreContainer");
  const view = window.worksView.buildWorksView({
    works,
    total: worksTotal,
    site: worksSite,
    watchlist,
  });

  if (view.empty) {
    container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted-fg)">${view.emptyText}</div>`;
    more.innerHTML = "";
    return;
  }

  container.innerHTML = view.rows
    .map(
      (r) => `
      <div class="data-item" data-work-id="${r.id}">
        <div class="item-body">
          <div class="item-title">${escapeHtml(r.title)}</div>
          <div class="item-meta">
            <span class="badge">${r.score} 分</span>
            <span>${r.sourceCount} 个来源</span>
            <span>${r.visitCount} 次访问</span>
            ${r.sites
              .map(
                (s) =>
                  `<span class="badge" style="border-color:${s.color}; color:${s.color}">${escapeHtml(s.label)}</span>`,
              )
              .join("")}
            <span>${r.lastVisitText}</span>
          </div>
        </div>
      </div>
    `,
    )
    .join("");

  if (view.loadMore) {
    more.innerHTML = `<button id="btnWorksLoadMore" class="btn btn-ghost">${view.loadMore.text}</button>`;
    document.getElementById("btnWorksLoadMore").onclick = () =>
      loadWorks(worksPage + 1);
  } else {
    more.innerHTML = "";
  }
}

async function loadWorks(page) {
  const result = await window.electronAPI.getWorksPage(page, worksPageSize, {
    site: worksSite,
    sort: worksSort,
  });
  works = page === 1 ? result.works : works.concat(result.works);
  worksPage = page;
  worksTotal = result.total;
  renderWorks();
}

// --- 未归类访问 + 适配器健康度 ---
function renderUnattributedGroup() {
  const el = document.getElementById("worksHealth");
  const count = health ? health.unattributedCount : null;
  el.innerHTML = `
    <div class="data-list" style="margin-bottom:16px">
      <div class="data-item" data-action="show-unattributed">
        <div class="item-body">
          <div class="item-title">未归类</div>
          <div class="item-meta">认不出作品的访问；一条都不丢，只是还没归到作品</div>
        </div>
        <div class="item-actions">
          <span class="badge">${count === null ? "…" : count} 条</span>
        </div>
      </div>
    </div>`;
}

function renderAdapterHealth() {
  const el = document.getElementById("adapterHealth");
  const summary = document.getElementById("adapterHealthSummary");
  if (!el) return;
  const adapters = (health && health.adapters) || [];
  if (summary) summary.textContent = adapters.length ? `${adapters.length} 项` : "";
  if (adapters.length === 0) {
    el.innerHTML = `<div style="color:var(--muted-fg); font-size:12px">暂无数据；加载适配器或收到访问后这里会累计命中与丢弃。</div>`;
    return;
  }
  el.innerHTML = adapters
    .map(
      (a) => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid var(--border)">
      <div style="display:flex; align-items:center; gap:8px; min-width:0">
        <span style="font-family:var(--font-mono); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escapeHtml(a.label)}</span>
        ${a.kind === "site" ? '<span style="font-size:10px; color:var(--muted-fg)">站点</span>' : ""}
        ${a.suspect ? '<span class="badge" style="border-color:var(--warning); color:var(--warning)">疑似失效</span>' : ""}
      </div>
      <span style="font-family:var(--font-mono); font-size:11px; color:var(--muted-fg); white-space:nowrap">命中 ${a.matched} / 丢弃 ${a.dropped}</span>
    </div>`,
    )
    .join("");
}

async function loadHealth() {
  health = await window.electronAPI.getWorkHealth();
  renderUnattributedGroup();
  renderAdapterHealth();
  renderAmbiguousWorks();
}

// 歧义作品：同一批身份键指向了不同作品。只报告哪些需要裁决，不给裁决入口。
function renderAmbiguousWorks() {
  const el = document.getElementById("ambiguousWorks");
  const summary = document.getElementById("ambiguousWorksSummary");
  if (!el) return;
  const pairs = (health && health.ambiguousWorks) || [];
  if (summary) summary.textContent = pairs.length ? `${pairs.length} 组` : "";
  if (pairs.length === 0) {
    el.innerHTML = `<div style="color:var(--muted-fg); font-size:12px">没有身份键指向不同作品的访问。</div>`;
    return;
  }
  el.innerHTML = pairs
    .map(
      (p) => `
    <div style="padding:8px 0; border-bottom:1px solid var(--border)">
      <div style="font-size:13px">${escapeHtml(p.workA.title || p.workA.id)} ⟷ ${escapeHtml(p.workB.title || p.workB.id)}</div>
      <div style="font-family:var(--font-mono); font-size:11px; color:var(--muted-fg)">${escapeHtml(p.kind)}: ${escapeHtml(p.value)}</div>
    </div>`,
    )
    .join("");
}

function renderUnattributed() {
  const container = document.getElementById("unattributedContainer");
  const more = document.getElementById("unattributedLoadMoreContainer");

  if (unattributed.length === 0) {
    container.innerHTML = `<div style="padding:40px; text-align:center; color:var(--muted-fg)">${
      unattributedQuery ? "未发现匹配的未归类访问" : "没有未归类的访问"
    }</div>`;
    more.innerHTML = "";
    return;
  }

  let html = "";
  let currentGroup = "";
  for (const r of unattributed) {
    const dateLabel = dateGroupLabel(r.timestamp);
    if (dateLabel !== currentGroup) {
      currentGroup = dateLabel;
      html += `<div class="date-group-header">${dateLabel}</div>`;
    }
    const color = getDomainColor(r.matchedRule);
    html += `
      <div class="data-item" data-url="${encodeURIComponent(r.url)}">
        <div class="item-body">
          <div class="item-title">${escapeHtml(r.title || r.url)}</div>
          <div class="item-meta">
            <span class="badge" style="border-color:${color}; color:${color}">${escapeHtml(siteLabel(r.matchedRule))}</span>
            <span>${formatTime(r.timestamp)}</span>
            <span class="item-url">${escapeHtml(r.url)}</span>
          </div>
        </div>
      </div>`;
  }
  container.innerHTML = html;

  if (unattributed.length < unattributedTotal) {
    more.innerHTML = `<button id="btnUnattributedLoadMore" class="btn btn-ghost">加载更多 (${unattributed.length} / ${unattributedTotal})</button>`;
    document.getElementById("btnUnattributedLoadMore").onclick = () =>
      loadUnattributed(unattributedPage + 1);
  } else {
    more.innerHTML = "";
  }
}

async function loadUnattributed(page) {
  const result = await window.electronAPI.getUnattributedPage(
    page,
    worksPageSize,
    unattributedQuery,
  );
  unattributed = page === 1 ? result.records : unattributed.concat(result.records);
  unattributedPage = page;
  unattributedTotal = result.total;
  renderUnattributed();
}

function showWorksView(view) {
  worksView = view;
  const onWorks = view === "works";
  document.getElementById("worksListView").style.display = onWorks ? "" : "none";
  document.getElementById("workDetailView").style.display = "none";
  document.getElementById("unattributedPanel").style.display = onWorks
    ? "none"
    : "block";
  if (!onWorks) loadUnattributed(1);
}
// 点开一部作品：它的来源与全部访问都在详情里。
document.getElementById("worksContainer").onclick = function (e) {
  const row = e.target.closest("[data-work-id]");
  if (row) openWorkDetail(row.dataset.workId);
};

// 来源行：点击打开该来源的最近地址。
document.getElementById("workSources").onclick = function (e) {
  const row = e.target.closest("[data-open-url]");
  if (row && row.dataset.openUrl) {
    window.electronAPI.openUrl(decodeURIComponent(row.dataset.openUrl));
  }
};

document.getElementById("btnBackToWorks").onclick = function () {
  currentWork = null;
  records = [];
  searchQuery = "";
  selectedIds.clear();
  document.getElementById("worksListView").style.display = "";
  document.getElementById("workDetailView").style.display = "none";
};

// --- 历史回填 / 重新解析（issue #6 / #27）：把已有访问归入作品，进度与前后计数都摆在界面上 ---
let worksJobRunning = false;

function setBackfillStatus(text) {
  const el = document.getElementById("worksBackfillStatus");
  if (el) el.textContent = text;
}

// 回填只补未归属的；重新解析连已归属的一起重算（改一次适配器，全历史受益）。
// 两者是同一条通道、同一份结果形状，界面上只差一个名字。
const worksJobLabel = (op) => (op === "reparse" ? "重新解析" : "回填");

async function runWorksJob(op, call) {
  if (worksJobRunning) return;
  const label = worksJobLabel(op);
  const button = document.getElementById(
    op === "reparse" ? "btnWorksReparse" : "btnWorksBackfill",
  );
  worksJobRunning = true;
  button.disabled = true;
  setBackfillStatus(`${label}中…`);
  try {
    const r = await call();
    let text = `${label}完成：未归属 ${r.before} → ${r.remaining} 条，归入 ${r.assigned} 条访问，新建 ${r.created} 部作品`;
    // 剩下的不是失败：那些访问没有可用的身份键，或身份键指向多部作品。
    if (r.remaining > 0) text += `；${r.remaining} 条没有可用的身份键`;
    if (r.ambiguous > 0) text += `；${r.ambiguous} 条身份键有冲突`;
    setBackfillStatus(text);
    await refreshStats();
    await loadHealth();
    renderWorksSiteBar();
    await loadWorks(1);
  } catch (e) {
    setBackfillStatus(`${label}失败：${(e && e.message) || e}`);
  } finally {
    worksJobRunning = false;
    button.disabled = false;
  }
}

document.getElementById("btnWorksBackfill").onclick = () =>
  runWorksJob("backfill", () => window.electronAPI.backfillWorks());

document.getElementById("btnWorksReparse").onclick = () =>
  runWorksJob("reparse", () => window.electronAPI.reparseWorks());

// --- 事件监听 ---
document.querySelectorAll(".nav-item").forEach((item) => {
  item.onclick = function () {
    document
      .querySelectorAll(".nav-item")
      .forEach((n) => n.classList.remove("active"));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.remove("active"));
    this.classList.add("active");
    document.getElementById(this.dataset.target).classList.add("active");
  };
});

document.getElementById("recordsContainer").onclick = function (e) {
  const selectBtn = e.target.closest("[data-action='rec-select']");
  if (selectBtn) {
    e.stopPropagation();
    if (selectBtn.checked) selectedIds.add(selectBtn.dataset.id);
    else selectedIds.delete(selectBtn.dataset.id);
    updateBatchDeleteBtn();
    return;
  }

  const pinBtn = e.target.closest("[data-action='rec-pin']");
  if (pinBtn) {
    e.stopPropagation();
    const id = pinBtn.dataset.id;
    const rec = records.find((r) => r.id === id);
    if (rec) {
      const newPinned = !rec.pinned;
      const newScore = newPinned && !rec.score ? 1 : rec.score;
      window.electronAPI.toggleRecordPin(id, newPinned, newScore);
      // 后台更新由 broadcast 处理，这里先本地更新体验更好
      rec.pinned = newPinned ? 1 : 0;
      rec.score = newScore;
      renderRecords();
    }
    return;
  }

  const sUp = e.target.closest("[data-action='rec-score-up']");
  const sDown = e.target.closest("[data-action='rec-score-down']");
  if (sUp || sDown) {
    e.stopPropagation();
    const id = (sUp || sDown).dataset.id;
    const rec = records.find((r) => r.id === id);
    if (rec && rec.pinned) {
      const newScore = Math.max(0, (rec.score || 0) + (sUp ? 1 : -1));
      window.electronAPI.toggleRecordPin(id, true, newScore);
      rec.score = newScore;
      renderRecords();
    }
    return;
  }

  const item = e.target.closest(".data-item");
  if (item) {
    window.electronAPI.openUrl(decodeURIComponent(item.dataset.url));
  }
};

function updateBatchDeleteBtn() {
  const btn = document.getElementById("btnBatchDelete");
  btn.style.display = selectedIds.size > 0 ? "block" : "none";
  btn.textContent = `删除选中 (${selectedIds.size})`;
}

document.getElementById("btnBatchDelete").onclick = async function () {
  if (confirm(`确定删除选中的 ${selectedIds.size} 条访问？`)) {
    await window.electronAPI.deleteRecords(Array.from(selectedIds));
    selectedIds.clear();
    updateBatchDeleteBtn();
    refreshStats();
    loadWorks(1);
    if (currentWork) openWorkDetail(currentWork.work.id);
  }
};

document.getElementById("worksSortBar").onclick = function (e) {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  worksSort = chip.dataset.sort;
  document
    .querySelectorAll("#worksSortBar .filter-chip")
    .forEach((c) => c.classList.toggle("active", c === chip));
  loadWorks(1);
};

document.getElementById("worksSiteBar").onclick = function (e) {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  worksSite = chip.dataset.site;
  renderWorksSiteBar();
  loadWorks(1);
};

document.getElementById("worksHealth").onclick = function (e) {
  if (e.target.closest("[data-action='show-unattributed']")) {
    showWorksView("unattributed");
  }
};

document.getElementById("btnUnattributedBack").onclick = function () {
  showWorksView("works");
};

document.getElementById("unattributedSearchInput").oninput = function () {
  unattributedQuery = this.value.trim();
  loadUnattributed(1);
};

document.getElementById("unattributedContainer").onclick = function (e) {
  const item = e.target.closest(".data-item");
  if (item) window.electronAPI.openUrl(decodeURIComponent(item.dataset.url));
};

document.getElementById("searchInput").oninput = function () {
  searchQuery = this.value.trim();
  renderRecords();
};

document.getElementById("btnAdd").onclick = async function () {
  const domain = document
    .getElementById("inputDomain")
    .value.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const label = document.getElementById("inputLabel").value.trim();
  const color = document.getElementById("inputColor").value;
  const regexFilter = document.getElementById("inputRegexFilter").value.trim();
  const regexTarget = document.getElementById("inputRegexTarget").value;

  if (!domain) return showToast("请输入域名", "error");
  const newEntry = { domain, label, color, regexFilter, regexTarget };
  const ok = await window.electronAPI.addToWatchlist(newEntry);
  if (ok) {
    watchlist.push(newEntry);
    renderWatchlist();
    showToast("监控已添加");
    document.getElementById("inputDomain").value = "";
    document.getElementById("inputLabel").value = "";
    document.getElementById("inputRegexFilter").value = "";
  }
};

// 列表项只带域名，点击走容器上的委托监听，不再在渲染时绑定下标。
document.getElementById("watchlist").onclick = function (e) {
  const btn = e.target.closest("[data-action='remove-entry']");
  if (btn) removeEntry(btn.dataset.domain);
};

async function removeEntry(domain) {
  const entry = watchlist.find((w) => w.domain === domain);
  if (!entry) return;
  if (confirm(`停止监控 ${entry.domain}？`)) {
    await window.electronAPI.removeFromWatchlist(domain);
    watchlist = watchlist.filter((w) => w.domain !== domain);
    renderWatchlist();
    refreshStats();
  }
}

document.getElementById("enabledToggle").onchange = async function () {
  enabled = this.checked;
  await window.electronAPI.setEnabled(enabled);
  document.getElementById("toggleLabel").textContent = enabled
    ? "追踪开启中"
    : "追踪已暂停";
};

document.getElementById("btnExport").onclick = async function () {
  const data = await window.electronAPI.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `site-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast("数据已导出");
};

document.getElementById("btnClear").onclick = async function () {
  if (confirm("警告：将永久清空所有浏览记录！")) {
    await window.electronAPI.clearRecords();
    records = [];
    renderRecords();
    refreshStats();
    showToast("记录已清空");
  }
};

document.getElementById("btnSaveAiConfig").onclick = async function () {
  await window.electronAPI.setAiConfig({
    provider: document.getElementById("inputAiProvider").value,
    endpoint: document.getElementById("inputAiEndpoint").value,
    apiKey: document.getElementById("inputAiApiKey").value,
    model: document.getElementById("inputAiModel").value,
  });
  showToast("AI 配置已保存");
};

// --- 初始化与监听 ---
async function init() {
  setWsStatus(false);
  watchlist = await window.electronAPI.getWatchlist();
  await refreshStats();
  await loadHealth();
  document.getElementById("enabledToggle").checked = enabled;
  renderWatchlist();
  renderWorksSiteBar();
  loadWorks(1);
  loadCandidates();
  setWsStatus(true);

  const aiCfg = await window.electronAPI.getAiConfig();
  document.getElementById("inputAiProvider").value = aiCfg.provider || "ollama";
  document.getElementById("inputAiEndpoint").value =
    aiCfg.endpoint || "http://127.0.0.1:11434";
  document.getElementById("inputAiApiKey").value = aiCfg.apiKey || "";
  document.getElementById("inputAiModel").value = aiCfg.model || "qwen2.5:7b";
}

// 一条访问的广播：统计、作品列表行、打开中的详情、未归类列表各自就地更新。
// 广播已经带上需要的东西（stats / work / record），不再回头拉整页。
function applyVisitUpdate(data) {
  if (data.stats) {
    stats = data.stats;
    enabled = stats.enabled;
    renderStats();
    renderWatchlist();
    renderWorksSiteBar();
  }
  if (data.work || data.previousWorkId) {
    const hadRow = data.work && works.some((w) => w.id === data.work.id);
    // 先把旧作品的行改掉或删掉（换归属时），再把新的并进来，最后只重画一次。
    if (data.previousWorkId) {
      const prev = works.findIndex((w) => w.id === data.previousWorkId);
      if (prev !== -1) {
        if (data.previousWork) works[prev] = data.previousWork;
        else {
          works = window.worksView.removeWorkRow(works, data.previousWorkId);
          worksTotal = Math.max(0, worksTotal - 1);
        }
      }
    }
    if (data.work) {
      works = window.worksView.mergeWorkRow(works, data.work, {
        sort: worksSort,
        site: worksSite,
        watchlist,
        limit: worksPage * worksPageSize,
      });
      if (!hadRow && works.some((w) => w.id === data.work.id)) worksTotal += 1;
    }
    renderWorks();
  }

  const rec = data.record;
  if (!rec) return;
  if (currentWork) {
    const merged = window.worksView.mergeVisitInDetail(currentWork, rec);
    if (merged.changed) {
      currentWork = merged.detail;
      if (data.work && data.work.id === currentWork.work.id) {
        currentWork.work = { ...currentWork.work, score: data.work.score };
      }
      records = currentWork.visits;
      renderWorkDetailHeader();
      renderWorkSources();
      renderRecords();
      updateBatchDeleteBtn();
    }
  }
  if (worksView === "unattributed") {
    const merged = window.worksView.mergeUnattributedRow(
      unattributed,
      rec,
      unattributedQuery,
    );
    unattributed = merged.records;
    unattributedTotal = Math.max(0, unattributedTotal + merged.delta);
    renderUnattributed();
  }
}

window.electronAPI.onUpdate((data) => {
  if (data.type === "recordAdded" || data.type === "recordUpdated") {
    applyVisitUpdate(data);
  } else if (data.type === "recordsCleared") {
    // deleteRecords() 也会发这个事件（部分删除），所以不能一律清空：
    // 打开中的作品要重新读取，否则详情会留着旧表头与空列表。
    loadWorks(1);
    refreshStats();
    loadHealth();
    if (worksView === "unattributed") loadUnattributed(1);
    if (currentWork) {
      openWorkDetail(currentWork.work.id);
    } else {
      records = [];
      renderRecords();
    }
  } else if (data.type === "adapterHealthUpdated") {
    // 命中与丢弃都改健康度，由主进程每次访问后主动推一份快照。
    if (data.health) health = data.health;
    renderUnattributedGroup();
    renderAdapterHealth();
    renderAmbiguousWorks();
  } else if (data.type === "worksBackfilledProgress") {
    setBackfillStatus(`${worksJobLabel(data.op)}中… ${data.processed} / ${data.before}`);
  } else if (data.type === "candidatesUpdated") {
    loadCandidates();
  } else if (data.type === "recommendationsUpdated") {
    loadRecommendations();
  } else if (data.type === "agentPendingUpdated") {
    loadPendingActions();
  }
  if (data.type === "agent_status") {
    // ✅ 新增：拦截 Agent 思维状态并在界面上输出
    const consoleBox = document.getElementById("agent-console-box"); // 假设您在 UI 里创建了这个终端容器
    if (consoleBox) {
      const msgLine = document.createElement("div");
      // 用 JetBrains Mono 字体输出，带有打字机质感
      msgLine.style.fontFamily = "'JetBrains Mono', monospace";
      msgLine.style.fontSize = "12px";
      msgLine.style.color = data.status === "paused" ? "#eab308" : "#a7a7a7"; // 等待审批标黄，其余默认灰色
      msgLine.style.marginBottom = "4px";
      msgLine.textContent = data.message;

      consoleBox.appendChild(msgLine);
      // 自动滚动到底部
      consoleBox.scrollTop = consoleBox.scrollHeight;
    }
  }
});

const agentInputEl = document.getElementById("agentCommandInput");
const agentSubmitBtn = document.getElementById("btnSubmitCommand");
const agentRunBtn = document.getElementById("btnRunAgent");

// 把一次分析结果画到面板上：成功/失败的 HTML 都由 shared/agent-view.js 生成。
function renderAnalysis(analysis) {
  const view = window.agentView.buildAnalysisView(analysis);
  const profileEl = document.getElementById("aiProfileText");
  if (view.isError) profileEl.innerHTML = view.profileHtml;
  else profileEl.textContent = view.profileText;
  document.getElementById("aiTags").innerHTML = view.tagsHtml;
}

// 唯一触发路径：输入框回车、发送按钮、唤醒按钮都从这里进。
async function triggerAgentWithCommand(customCommand) {
  const consoleBox = document.getElementById("agent-console-box");
  const command =
    typeof customCommand === "string" ? customCommand.trim() : "";

  // UI 状态锁定
  agentInputEl.disabled = true;
  agentSubmitBtn.disabled = true;
  agentSubmitBtn.innerHTML = "⏳";
  agentRunBtn.style.opacity = "0.7";
  agentRunBtn.style.pointerEvents = "none";

  // 清空上一次的记录，并把用户的输入打印到终端上
  if (consoleBox) {
    consoleBox.innerHTML = "";
    if (command) {
      consoleBox.innerHTML += `<div style='color: #fff; font-size: 12px; margin-bottom: 8px;'>➜ ${escapeHtml(command)}</div>`;
    }
    consoleBox.innerHTML +=
      "<div style='color: #a7a7a7; font-size: 12px;'>[系统] 正在建立与大模型的链接...</div>";
  }

  document.getElementById("aiProfileText").innerHTML =
    "<span style='color: var(--muted-fg); font-family: var(--font-mono);'>[System] Agent is analyzing...</span>";
  document.getElementById("aiTags").innerHTML = "";

  try {
    const analysis = await window.electronAPI.triggerAgentAnalysis(command);
    renderAnalysis(analysis);
    if (analysis.error) {
      showToast(String(analysis.error), "error");
    } else {
      loadRecommendations();
      loadPendingActions();
      showToast("Agent 报告已生成");
    }
  } catch (e) {
    showToast(String(e), "error");
  } finally {
    // 恢复 UI 状态
    agentInputEl.disabled = false;
    agentSubmitBtn.disabled = false;
    agentSubmitBtn.innerHTML = "发送";
    agentRunBtn.style.opacity = "1";
    agentRunBtn.style.pointerEvents = "auto";
    agentRunBtn.innerHTML = "✨ 重新推演";
    agentInputEl.value = ""; // 清空输入框
    agentInputEl.focus();
  }
}

// 回车与发送按钮行为一致：都读输入框的值，走同一条路径。
agentInputEl.addEventListener("keypress", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    triggerAgentWithCommand(this.value);
  }
});

agentSubmitBtn.onclick = () => triggerAgentWithCommand(agentInputEl.value);

// 唤醒按钮：空指令 = 默认分析；只绑定这一次。
agentRunBtn.onclick = () => triggerAgentWithCommand("");

async function loadRecommendations() {
  const container = document.getElementById("recommendationsContainer");
  try {
    const recs = await window.electronAPI.getRecommendations();
    if (recs.length === 0) {
      container.innerHTML =
        '<div style="padding:40px; text-align:center; color:var(--muted-fg)">暂无推荐内容</div>';
      return;
    }
    container.innerHTML = recs
      .map(
        (r) => `
      <div class="data-item" id="rec-${r.id}">
        <div class="item-body">
          <div class="item-title">${escapeHtml(r.title)}</div>
          <div class="item-meta">
            <span class="badge" style="background: rgba(168,85,247,0.1); color: #c084fc; border-color: rgba(168,85,247,0.3);">✨ ${escapeHtml(r.reason || "")}</span>
            <span class="item-url">Source: ${escapeHtml(r.domain)}</span>
          </div>
        </div>
        <div class="item-actions">
          <button class="btn-pin-text" style="color: #10b981; border-color: #10b981; background: transparent;" data-action="rec-accept" data-id="${r.id}">吸收</button>
          <button class="btn-pin-text" style="color: var(--muted-fg); border-color: var(--border); background: transparent;" data-action="rec-reject" data-id="${r.id}">排斥</button>
        </div>
      </div>
    `,
      )
      .join("");
  } catch (e) {
    container.innerHTML =
      '<div style="padding:40px; text-align:center; color:var(--muted-fg)">加载推荐失败</div>';
  }
}

// ── 候选池 ──────────────────────────────────────────────────────────────────
// 候选与推荐分开：候选是抓来还没排的原始条目（ADR-0005），推荐是排完序带理由的。

/** @type {Array<Object>} */
let candidates = [];

async function loadCandidates() {
  const container = document.getElementById("candidatesContainer");
  try {
    candidates = await window.electronAPI.getCandidates();
  } catch (e) {
    container.innerHTML =
      '<div style="padding:40px; text-align:center; color:var(--muted-fg)">加载候选失败</div>';
    return;
  }
  if (candidates.length === 0) {
    container.innerHTML =
      '<div style="padding:40px; text-align:center; color:var(--muted-fg)">暂无候选。点「抓取候选」从已登记站点的列表页抓一批。</div>';
    return;
  }
  container.innerHTML = candidates
    .map((c) => {
      let cover = "";
      try {
        cover = (JSON.parse(c.fields) || {}).cover || "";
      } catch (e) {
        cover = "";
      }
      return `
      <div class="data-item" id="cand-${c.id}">
        ${
          cover
            ? `<img src="${escapeHtml(cover)}" loading="lazy" style="width:56px;height:80px;object-fit:cover;border-radius:4px;flex:0 0 auto;">`
            : ""
        }
        <div class="item-body">
          <div class="item-title">${escapeHtml(c.title || c.url)}</div>
          <div class="item-meta">
            <span class="badge" style="background:transparent; color:var(--muted-fg); border-color:var(--border);">${escapeHtml(c.groupLabel || c.domain)}</span>
            <span class="item-url">${escapeHtml(c.listName ? c.listName + " · " : "")}${escapeHtml(c.domain)}</span>
          </div>
        </div>
        <div class="item-actions">
          <button class="btn-pin-text" data-action="candidate-open" data-url="${escapeHtml(c.url)}">打开</button>
          <button class="btn-pin-text" style="color: var(--muted-fg)" data-action="candidate-remove" data-id="${c.id}">移除</button>
        </div>
      </div>`;
    })
    .join("");
}

document.getElementById("btnCandidatesFetch").onclick = async function () {
  const btn = this;
  btn.disabled = true;
  btn.textContent = "抓取中…";
  try {
    const res = await window.electronAPI.fetchCandidates();
    if (res.failures && res.failures.length) {
      // 抓取失败必须可见，不能静默（ADR-0005）。
      showToast(`抓取失败：${res.failures[0].url} — ${res.failures[0].error}`, "error");
    } else {
      showToast(`新增 ${res.inserted} 条，更新 ${res.updated} 条`);
    }
    await loadCandidates();
  } catch (e) {
    showToast(String(e), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "抓取候选";
  }
};

document.getElementById("btnCandidatesClear").onclick = async function () {
  if (!confirm("清空所有候选？")) return;
  await window.electronAPI.clearCandidates();
  await loadCandidates();
  showToast("候选已清空");
};

// 排序：候选池 → 带理由的推荐（推荐列表在 AI 标签页）。可重跑，重跑替换未裁决的那批。
document.getElementById("btnCandidatesRank").onclick = async function () {
  const btn = this;
  btn.disabled = true;
  btn.textContent = "排序中…";
  try {
    const count = await window.electronAPI.rankCandidates();
    await loadRecommendations();
    showToast(count > 0 ? `排出 ${count} 条推荐` : "没有可推荐的候选（都看过了？）");
  } catch (e) {
    showToast(String(e), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "排序成推荐";
  }
};

document.getElementById("candidatesContainer").addEventListener(
  "error",
  (e) => {
    // 封面图挂了就隐藏，不留一个破图图标（不用内联 handler）。
    if (e.target && e.target.tagName === "IMG") e.target.style.display = "none";
  },
  true,
);

document.getElementById("candidatesContainer").onclick = async function (e) {
  const removeBtn = e.target.closest("[data-action='candidate-remove']");
  if (removeBtn) {
    e.stopPropagation();
    await window.electronAPI.removeCandidate(removeBtn.dataset.id);
    const item = document.getElementById("cand-" + removeBtn.dataset.id);
    if (item) item.remove();
    return;
  }
  const openBtn = e.target.closest("[data-action='candidate-open']");
  if (openBtn) {
    e.stopPropagation();
    window.electronAPI.openUrl(openBtn.dataset.url);
  }
};

async function loadPendingActions() {
  const btn = document.getElementById("btnAgentPending");
  try {
    const actions = await window.electronAPI.agentGetPending();
    if (!actions || actions.length === 0) {
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    btn.textContent = `待审批 (${actions.length})`;
  } catch (e) {
    btn.style.display = "none";
  }
}

document.getElementById("btnAutoClean").onclick = async function () {
  if (!confirm("Agent 将扫描记录并建议清理。是否继续？")) return;
  const btn = this;
  btn.style.opacity = "0.7";
  btn.style.pointerEvents = "none";
  try {
    const res = await window.electronAPI.agentAutoClean();
    if (res.error) {
      showToast(String(res.error), "error");
    } else {
      showToast("自动清理完成");
      loadPendingActions();
    }
  } catch (e) {
    showToast(String(e), "error");
  }
  btn.style.opacity = "1";
  btn.style.pointerEvents = "auto";
};

document.getElementById("btnClearRecs").onclick = async function () {
  if (!confirm("清空所有 AI 推荐？")) return;
  await window.electronAPI.clearRecommendations();
  document.getElementById("recommendationsContainer").innerHTML =
    '<div style="padding:40px; text-align:center; color:var(--muted-fg)">暂无推荐内容</div>';
  showToast("推荐已清空");
};

document.getElementById("recommendationsContainer").onclick = async function (
  e,
) {
  const acceptBtn = e.target.closest("[data-action='rec-accept']");
  const rejectBtn = e.target.closest("[data-action='rec-reject']");
  if (acceptBtn) {
    e.stopPropagation();
    const id = acceptBtn.dataset.id;
    await window.electronAPI.acceptRecommendation(id);
    const item = document.getElementById("rec-" + id);
    if (item) item.style.opacity = "0.3";
    showToast("已录入追踪库");
    refreshStats();
    loadWorks(1);
  }
  if (rejectBtn) {
    e.stopPropagation();
    const id = rejectBtn.dataset.id;
    await window.electronAPI.rejectRecommendation(id);
    const item = document.getElementById("rec-" + id);
    if (item) item.remove();
    showToast("已从推荐中移除");
  }
};

document.getElementById("btnAgentPending").onclick = async function () {
  const actions = await window.electronAPI.agentGetPending();
  if (!actions || actions.length === 0) {
    showToast("无待审批动作");
    return;
  }
  const lines = actions
    .map((a) => `工具: ${a.tool}\n参数: ${JSON.stringify(a.args, null, 2)}\n`)
    .join("\n---\n");
  if (
    confirm(
      `待审批 ${actions.length} 个动作:\n\n${lines}\n\n点确定批准全部，点取消驳回全部。`,
    )
  ) {
    const ids = actions.map((a) => a.id);
    await window.electronAPI.agentApproveActions(ids);
    showToast("已批准");
  } else {
    const ids = actions.map((a) => a.id);
    await window.electronAPI.agentDismissActions(ids);
    showToast("已驳回");
  }
  loadPendingActions();
  refreshStats();
  loadWorks(1);
};

init();
