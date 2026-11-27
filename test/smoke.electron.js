// Electron smoke test — boots the REAL app (main.js) with the REAL preload and
// the REAL renderer page, against a throwaway database, and asserts:
//   1. window.electronAPI exists and every route is callable
//   2. every invoke channel round-trips (a handler is actually registered)
//   3. the renderer rendered real data read over IPC
//   4. 站点页打开真页面后自动采集、落库并更新渲染器
// Run with: npm run test:smoke

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { app, BrowserWindow } = require("electron");
const { loadPreloadRoutes } = require("./preload-routes");

const SEED_TITLE = "SMOKE 预置访问 α";
const SEED_WORK_TITLE = "SMOKE 预置作品 β";
const SEED_UNATTR_TITLE = "SMOKE 未归类 γ";
const SEED_VISIT_URL_A = "https://bilibili.com/video/smoke";
const SEED_VISIT_URL_B = "https://tvmao.com/kanju/smoke";
const SEED_EDITION = "中文字幕";
const SEED_DWELL_TEXT = "2分5秒";
const SEED_CANDIDATE_TITLE = "SMOKE 候选 ε";
// 站点页要开一个真页面：用本机 HTTP 伺服一份站点页夹具。
// 它的域名（127.0.0.1）因此要登记成站点，访问才落库（兴趣分析只管登记过的站点）。
const SITE_DOMAIN = "127.0.0.1";
const SITE_PATH = "/v/42";
const SITE_TITLE = "《冒烟作品》";
const TIMEOUT_MS = 120000;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-smoke-"));
const dbPath = path.join(tmpDir, "tracker.db");
process.env.ACUMINATA_DB_PATH = dbPath;
process.env.ACUMINATA_LOCAL_COPY_DIR = path.join(tmpDir, "local-copies");
// 媒体代理的 scheme 要在 app ready 之前登记（Chromium 的规矩）。
// 冒烟测试是在 ready 之后才 require main.js 的，所以这里先登记一次；
// main.js 里那次是第二次，登记函数认得出来，直接跳过。
require("../media-proxy").registerMediaScheme();

const routes = loadPreloadRoutes().routes;

async function seedDatabase() {
  const { RecordStore } = require("../agent/record-store");
  const store = new RecordStore(dbPath);
  await store.init();
  store.addWatchlist({ domain: "tvmao.com", label: "电视猫", color: "#fff" });
  // 站点页伺服在本机：登记它的域名，站点页开出来的访问才落库。
  store.addWatchlist({ domain: SITE_DOMAIN, label: "冒烟站点页", color: "#fff" });
  const ts = Date.now();
  // 预置一部作品，两个站点上是**同名版本**：详情必须分别显示各自的站点。
  const visit = store.recordWorkVisit({
    keys: [{ kind: "code", value: "SMOKE-CODE-1", confidence: "high" }],
    title: SEED_WORK_TITLE,
    timestamp: ts,
  });
  store.insertRecord({
    id: "smoke-1",
    url: SEED_VISIT_URL_A,
    title: SEED_TITLE,
    domain: "bilibili.com",
    matchedRule: "bilibili.com",
    tabId: 1,
    timestamp: ts,
    dwellTime: 125000,
    edition: SEED_EDITION,
    workId: visit.work.id,
  });
  store.insertRecord({
    id: "smoke-2",
    url: SEED_VISIT_URL_B,
    title: SEED_TITLE + " · 电视猫",
    domain: "tvmao.com",
    matchedRule: "tvmao.com",
    tabId: 2,
    timestamp: ts - 60000,
    edition: SEED_EDITION,
    workId: visit.work.id,
  });
  // 一条认不出作品的访问：降级路径，必须仍然可见可浏览。
  store.insertRecord({
    id: "smoke-unattributed-1",
    url: "https://bilibili.com/video/orphan",
    title: SEED_UNATTR_TITLE,
    domain: "bilibili.com",
    matchedRule: "bilibili.com",
    tabId: 2,
    timestamp: Date.now(),
    workId: null,
  });
  // 两路身份键指向不同作品：歧义必须在界面上可见，不是只写进控制台。
  store.recordWorkVisit({
    keys: [{ kind: "code", value: "SMOKE-CONFLICT-A", confidence: "high" }],
    title: "SMOKE 歧义甲",
    timestamp: ts - 120000,
  });
  store.recordWorkVisit({
    keys: [{ kind: "cover_hash", value: "c".repeat(32), confidence: "high" }],
    title: "SMOKE 歧义乙",
    timestamp: ts - 120000,
  });
  store.recordWorkVisit({
    keys: [
      { kind: "code", value: "SMOKE-CONFLICT-A", confidence: "high" },
      { kind: "cover_hash", value: "c".repeat(32), confidence: "high" },
    ],
    title: "SMOKE 歧义丙",
    timestamp: ts - 120000,
  });
  // 候选与推荐分表：候选池里的条目在界面上单独一面，不是推荐面板。
  store.importCandidates({
    adapterFile: "smoke.json",
    listName: "冒烟列表",
    domain: "smoke-cand.example",
    matchedRule: "smoke-cand.example",
    groupLabel: "冒烟站",
    entries: [
      {
        url: "https://smoke-cand.example/tv/1/",
        title: SEED_CANDIDATE_TITLE,
        cover: "https://smoke-cand.example/upload/vod/20260101-1/deadbeef.webp",
      },
    ],
  });
  fs.writeFileSync(dbPath, Buffer.from(store.export()));
}

function waitForWindow() {
  return new Promise((resolve, reject) => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) return resolve(existing);
    const timer = setTimeout(
      () => reject(new Error("no BrowserWindow was created")),
      TIMEOUT_MS,
    );
    app.once("browser-window-created", (_, win) => {
      clearTimeout(timer);
      resolve(win);
    });
  });
}

function waitForLoad(win) {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once("did-finish-load", resolve);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 站点页伺服：在本机开一个 HTTP 口，把站点页夹具发出去。
 * 站点页因此开的是**真页面**（真加载、真执行页内脚本），而不是假的对象。
 *
 * 伺服还发一份清单与两个分片：站点页里的 <video> 拉它们，经媒体代理改写
 * （去广告、地址改绝对）。广告段也备着：它若被请求过，说明广告没被去掉。
 */
function startSiteServer() {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "site-page.html"),
    "utf8",
  );
  const seg0 = fs.readFileSync(path.join(__dirname, "fixtures", "media", "segment-0.ts"));
  const seg1 = fs.readFileSync(path.join(__dirname, "fixtures", "media", "segment-1.ts"));
  const requested = [];
  let origin = "";
  let manifest = "";
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    if (req.url === "/media/index.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(manifest);
      return;
    }
    if (req.url.startsWith("/media/segment-")) {
      const body = req.url.endsWith("segment-1.ts") ? seg1 : seg0;
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Accept-Ranges": "bytes",
        "Content-Length": body.length,
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const popupUrl = `http://localhost:${server.address().port}/popup`;
    res.end(html.replace(
      "</body>",
      `<a id="popupLink" href="${popupUrl}" target="_blank">popup</a></body>`,
    ));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      origin = `http://${SITE_DOMAIN}:${server.address().port}`;
      manifest = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:1",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:1.00000,",
        `${origin}/media/segment-0.ts`,
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-KEY:METHOD=NONE",
        "#EXTINF:3.00000,",
        "/media/ad-0.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:1.00000,",
        `${origin}/media/segment-1.ts`,
        "#EXT-X-ENDLIST",
        "",
      ].join("\n");
      resolve({
        server,
        requested,
        manifest,
        seg0,
        seg1,
        url: `${origin}${SITE_PATH}`,
      });
    });
  });
}

/**
 * 站点页通路：界面上的「打开来源」→ 应用内站点页 → 采集 → 落库。
 *
 * 站点页开的是**真页面**（本机 HTTP 伺服），采集因此跑的是页面上真实的
 * collectPage——站点页注入页面与测试使用的是同一个函数（shared/page-collect.js）。
 * 库里多出来的那条访问、它归到的作品、界面上的作品行与统计，都是这条通路的产物。
 */
function activeBrowserTab(state) {
  return state && state.tabs.find((tab) => tab.id === state.activeTabId);
}

async function openSitePageAndWait(win, siteUrl) {
  await submitAddress(win, siteUrl);

  const deadline = Date.now() + 15000;
  let records = [];
  let browserState = null;
  while (Date.now() < deadline) {
    [records, browserState] = await Promise.all([
      win.webContents.executeJavaScript(`window.electronAPI.getRecords()`),
      win.webContents.executeJavaScript(`window.electronAPI.getBrowserState()`),
    ]);
    const active = activeBrowserTab(browserState);
    if (records.some((r) => r.url === siteUrl) && active && active.url === siteUrl) break;
    await sleep(50);
  }

  const mine = records.filter((r) => r.url === siteUrl);
  return {
    count: mine.length,
    record: mine[0] || null,
    browserState,
  };
}

function getSiteView(mainWin, contentsId) {
  const views = mainWin.contentView.children.filter(
    (child) => child.webContents && child.webContents !== mainWin.webContents,
  );
  return contentsId
    ? views.find((child) => child.webContents.id === contentsId) || null
    : views[0] || null;
}

async function clickTab(win, tabId, close = false) {
  await win.webContents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(close ? "[data-close-tab-id]" : "[data-tab-id]")};
    const id = ${JSON.stringify(String(tabId))};
    const closing = ${JSON.stringify(close)};
    const button = Array.from(document.querySelectorAll(selector))
      .find((el) => (closing ? el.dataset.closeTabId : el.dataset.tabId) === id);
    if (!button) throw new Error("tab control not found: " + id);
    button.click();
  })()`);
}

async function waitForTabUrl(win, tabId, url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript("window.electronAPI.getBrowserState()");
    const tab = state.tabs.find((entry) => entry.id === tabId);
    if (tab && tab.url === url && !tab.isLoading) return state;
    await sleep(50);
  }
  return null;
}

async function submitAddress(win, address) {
  await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById("browserAddress");
    const form = document.getElementById("browserAddressForm");
    if (!input || !form) throw new Error("browser address form is missing");
    input.focus();
    input.value = ${JSON.stringify(address)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
  })()`);
}

async function waitForBrowserUrl(win, url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(
      "window.electronAPI.getBrowserState()",
    );
    const active = activeBrowserTab(state);
    if (active && active.url === url && !active.isLoading) return state;
    await sleep(50);
  }
  return null;
}

async function waitForBrowserState(win, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(
      "window.electronAPI.getBrowserState()",
    );
    if (predicate(state)) return state;
    await sleep(50);
  }
  return null;
}

async function clickBrowserAction(win, action, expectedUrl) {
  await win.webContents.executeJavaScript(
    `document.getElementById(${JSON.stringify("browser" + action[0].toUpperCase() + action.slice(1))}).click()`,
  );
  return waitForBrowserUrl(win, expectedUrl);
}

async function setBrowserModeAndWait(win, mode) {
  await win.webContents.executeJavaScript(
    `document.getElementById("browserSettings").click()`,
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await win.webContents.executeJavaScript(
      "window.electronAPI.getBrowserState()",
    );
    const visible = await win.webContents.executeJavaScript(
      `!document.getElementById("agentWorkspace").hidden`,
    );
    if (state.mode === mode && visible === (mode === "settings")) return state;
    await sleep(50);
  }
  return null;
}

async function probeGlobalHistory(win, siteUrl) {
  return win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 10000;
    const container = () => document.getElementById("historyContainer");
    const openingVisit = ${JSON.stringify(Boolean(siteUrl))};
    const expectedTitles = openingVisit ? [${JSON.stringify(SITE_TITLE)}] :
      [${JSON.stringify(SEED_TITLE)}, ${JSON.stringify(SEED_UNATTR_TITLE)}];
    document.getElementById("browserHistory").click();
    const search = document.getElementById("historySearchInput");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    let initialText = "";
    let initialActive = false;
    let hasDateGroup = false;
    while (Date.now() < deadline) {
      initialText = container() ? container().textContent : "";
      initialActive = document.getElementById("history").classList.contains("active");
      hasDateGroup = !!document.querySelector("#historyContainer .date-group-header");
      if (initialActive && expectedTitles.every((title) => initialText.includes(title))) break;
      await sleep(50);
    }

    if (!openingVisit) {
      search.value = ${JSON.stringify(SEED_UNATTR_TITLE)};
      search.dispatchEvent(new Event("input", { bubbles: true }));
      let searchText = "";
      while (Date.now() < deadline) {
        searchText = container().textContent;
        if (searchText.includes(${JSON.stringify(SEED_UNATTR_TITLE)}) &&
          !searchText.includes(${JSON.stringify(SEED_TITLE)})) break;
        await sleep(50);
      }

      search.value = "没有这条访问";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      let emptyText = "";
      while (Date.now() < deadline) {
        emptyText = container().textContent;
        if (emptyText.includes("没有找到匹配的访问")) break;
        await sleep(50);
      }
      return { initialText, initialActive, hasDateGroup, searchText, emptyText };
    }

    search.value = ${JSON.stringify(SITE_TITLE)};
    search.dispatchEvent(new Event("input", { bubbles: true }));
    let row = null;
    while (!row && Date.now() < deadline) {
      row = Array.from(document.querySelectorAll("#historyContainer [data-url]"))
        .find((el) => decodeURIComponent(el.dataset.url) === ${JSON.stringify(siteUrl)});
      if (!row) await sleep(50);
    }
    if (row) row.click();
    let state = null;
    while (Date.now() < deadline) {
      state = await window.electronAPI.getBrowserState();
      if (state.mode === "browser" && state.tabs.find((tab) => tab.id === state.activeTabId).url === ${JSON.stringify(siteUrl)}) break;
      await sleep(50);
    }
    return {
      initialText,
      initialActive,
      hasDateGroup,
      clicked: !!row,
      state,
      workspaceHidden: document.getElementById("agentWorkspace").hidden,
    };
  })()`);
}

/**
 * 站点页里的视频：清单经媒体代理改写后，广告段不该被拉过（issue #75）。
 */
async function probeSiteMedia(mainWin, siteUrl) {
  const siteView = getSiteView(mainWin);
  if (!siteView || !siteView.webContents.getURL().startsWith(siteUrl)) {
    return { duration: 0, readyState: 0, error: "no embedded site view" };
  }
  const deadline = Date.now() + 15000;
  let out = { duration: 0, readyState: 0, error: "timeout" };
  while (Date.now() < deadline) {
    out = await siteView.webContents.executeJavaScript(`(() => {
      const v = document.querySelector("video[data-acuminata-native-player]") || document.getElementById("player");
      if (!v) return { duration: 0, readyState: 0, error: "no video element" };
      return { duration: v.duration, readyState: v.readyState, error: v.error && v.error.message };
    })()`);
    if (out.readyState >= 1) break;
    await sleep(100);
  }
  return out;
}

async function saveSiteWorkLocalCopy(win, workId) {
  return win.webContents.executeJavaScript(`(async () => {
    const out = { saved: false, detailText: "", worksRowText: "", toast: "", error: "" };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const back = document.getElementById("btnBackToWorks");
      if (back) back.click();
      const rowDeadline = Date.now() + 10000;
      let row = null;
      while (!row && Date.now() < rowDeadline) {
        row = Array.from(document.querySelectorAll("#worksContainer [data-work-id]"))
          .find((el) => el.dataset.workId === ${JSON.stringify(workId)} &&
            el.textContent.includes(${JSON.stringify(SITE_TITLE)}));
        if (!row) await sleep(50);
      }
      if (!row) throw new Error("找不到目标作品行");
      row.click();

      const detailDeadline = Date.now() + 10000;
      let detail = document.getElementById("workDetailView");
      while (Date.now() < detailDeadline) {
        detail = document.getElementById("workDetailView");
        if (detail.style.display !== "none" &&
          document.getElementById("workDetailTitle").textContent.includes(${JSON.stringify(SITE_TITLE)})) break;
        await sleep(50);
      }
      if (detail.style.display === "none") throw new Error("作品详情没有打开");

      const button = document.getElementById("btnSaveLocalCopy");
      button.click();
      const saveDeadline = Date.now() + 35000;
      while (Date.now() < saveDeadline) {
        out.detailText = document.getElementById("workDetailMeta").textContent || "";
        const savedRow = document.querySelector(
          "#worksContainer [data-work-id=" + CSS.escape(${JSON.stringify(workId)}) + "]"
        );
        out.worksRowText = savedRow ? savedRow.textContent : "";
        if (button.textContent === "已存本机" &&
          out.detailText.includes("已存本机")) {
          out.saved = true;
          break;
        }
        await sleep(100);
      }
      if (!out.saved) out.error = "等待已存本机超时";
    } catch (error) {
      out.error = String((error && error.message) || error);
    }
    out.toast = (document.getElementById("toast") || {}).textContent || "";
    return out;
  })()`);
}

function snapshotFiles(root) {
  const files = {};
  if (!root || !fs.existsSync(root)) return files;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else files[path.relative(root, filename)] = fs.readFileSync(filename);
    }
  }
  walk(root);
  return files;
}

// Runs inside the renderer: the only place where window.electronAPI is real.
function pageProbe(invokeRoutes) {
  return `(async () => {
    const routes = ${JSON.stringify(invokeRoutes)};
    const api = window.electronAPI;
    const out = {
      hasAPI: !!api && typeof api === "object",
      hasSharedUtils: !!window.sharedUtils && typeof window.sharedUtils.formatTime === "function",
      hasWorksView: !!window.worksView && typeof window.worksView.buildWorksView === "function",
      hasAgentView: !!window.agentView && typeof window.agentView.buildAnalysisView === "function",
      missingRoutes: [],
      unregistered: [],
      watchlistText: "",
      watchlistRemoveDomain: "",
      watchlistRemoveInline: false,
      candidatesText: "",
      worksText: "",
      worksRowHtml: "",
      ambiguousText: "",
      backfillText: "",
      reparseText: "",
      worksHealthText: "",
      unattributedText: "",
      sourcesText: "",
      sourcesRowHtml: "",
      visitsText: "",
      visitRowHtml: "",
      detailVisible: false,
      hasOpenLatest: false,
    };
    if (!out.hasAPI) return out;

    for (const r of routes) {
      if (typeof api[r.name] !== "function") out.missingRoutes.push(r.name);
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 10000;

    // Wait for the renderer's async init() to paint the works list.
    const worksRendered = () => {
      const wrk = document.getElementById("worksContainer");
      return !!wrk && wrk.textContent.includes(${JSON.stringify(SEED_WORK_TITLE)});
    };
    while (!worksRendered() && Date.now() < deadline) await sleep(50);
    out.worksText = (document.getElementById("worksContainer") || {}).textContent || "";
    out.worksRowHtml = (document.querySelector("#worksContainer [data-work-id]") || {}).outerHTML || "";
    out.ambiguousText = (document.getElementById("ambiguousWorks") || {}).textContent || "";

    // 候选单独一面：真实渲染器把候选池画出来，而不是与推荐共用一个空面板。
    const candRendered = () => {
      const c = document.getElementById("candidatesContainer");
      return !!c && c.textContent.includes(${JSON.stringify(SEED_CANDIDATE_TITLE)});
    };
    while (!candRendered() && Date.now() < deadline) await sleep(50);
    out.candidatesText =
      (document.getElementById("candidatesContainer") || {}).textContent || "";

    // 「未归类」是一个可浏览的分组：点开它，未归属的访问要列出来。
    out.worksHealthText = (document.getElementById("worksHealth") || {}).textContent || "";
    const group = document.querySelector("#worksHealth [data-action='show-unattributed']");
    if (group) group.click();
    const unattRendered = () => {
      const u = document.getElementById("unattributedContainer");
      return !!u && u.textContent.includes(${JSON.stringify(SEED_UNATTR_TITLE)});
    };
    while (!unattRendered() && Date.now() < deadline) await sleep(50);
    out.unattributedText = (document.getElementById("unattributedContainer") || {}).textContent || "";
    // 回到作品列表，再看作品详情。
    const backToList = document.getElementById("btnUnattributedBack");
    if (backToList) backToList.click();
    while (
      document.getElementById("worksListView").style.display === "none" &&
      Date.now() < deadline
    ) await sleep(50);

    // 点开作品：它的来源（站点 + 版本）与访问都在详情里。
    const row = document.querySelector("#worksContainer [data-work-id]");
    if (row) row.click();
    const detailShown = () => {
      const d = document.getElementById("workDetailView");
      const src = document.getElementById("workSources");
      return (
        !!d && d.style.display !== "none" &&
        !!src && src.textContent.includes(${JSON.stringify(SEED_EDITION)})
      );
    };
    while (!detailShown() && Date.now() < deadline) await sleep(50);

    const detail = document.getElementById("workDetailView");
    const sources = document.getElementById("workSources");
    const visits = document.getElementById("recordsContainer");
    const latest = document.getElementById("btnOpenLatest");
    out.detailVisible = !!detail && detail.style.display !== "none";
    out.sourcesText = sources ? sources.textContent : "";
    out.sourcesRowHtml = (document.querySelector("#workSources [data-open-url]") || {}).outerHTML || "";
    out.visitsText = visits ? visits.textContent : "";
    out.visitRowHtml = (document.querySelector("#recordsContainer [data-url]") || {}).outerHTML || "";
    out.hasOpenLatest = !!latest && latest.style.display !== "none";
    const wl = document.getElementById("watchlist");
    out.watchlistText = wl ? wl.textContent : "";
    // AC3：列表项带稳定的 domain 键，且不带渲染时绑定的内联 handler。
    const removeBtn = document.querySelector(
      "#watchlist [data-action='remove-entry']",
    );
    out.watchlistRemoveDomain = removeBtn ? removeBtn.dataset.domain || "" : "";
    out.watchlistRemoveInline = removeBtn
      ? /onclick=/i.test(removeBtn.outerHTML)
      : false;

    // Round-trip every route. A missing handler rejects with distinctive text;
    // channels that need arguments may reject with a handler-level error, which
    // still proves the invoke reached a handler, so only the former is a failure.
    for (const r of routes) {
      if (typeof api[r.name] !== "function") continue;
      try {
        await api[r.name]();
        if (r.name === "newBrowserTab") {
          const browserState = await api.getBrowserState();
          await api.closeBrowserTab(browserState.activeTabId);
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/No handler registered/i.test(msg)) {
          out.unregistered.push(r.channel + " (" + msg + ")");
        }
      }
    }

    // 回填是一次可观察的操作：按钮点下去，进度与最终计数要落到状态行上。
    const backfillBtn = document.getElementById("btnWorksBackfill");
    const backfillStatus = document.getElementById("worksBackfillStatus");
    if (backfillBtn) {
      backfillBtn.click();
      const backfillDeadline = Date.now() + 10000;
      while (
        backfillStatus &&
        !/回填完成|回填失败/.test(backfillStatus.textContent) &&
        Date.now() < backfillDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    out.backfillText = backfillStatus ? backfillStatus.textContent : "";

    // 重新解析也是同一种可观察的操作：适配器改好后点它，全历史重跑。
    const reparseBtn = document.getElementById("btnWorksReparse");
    if (reparseBtn) {
      reparseBtn.click();
      const reparseDeadline = Date.now() + 10000;
      while (
        backfillStatus &&
        !/重新解析完成|重新解析失败/.test(backfillStatus.textContent) &&
        Date.now() < reparseDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    out.reparseText = backfillStatus ? backfillStatus.textContent : "";
    return out;
  })()`;
}

async function main() {
  await seedDatabase();
  require("../main.js");

  await app.whenReady();
  const win = await waitForWindow();
  win.show();
  win.focus();

  // Acceptance: the renderer console must be free of errors (e.g. failed IPC).
  // Electron 42 passes the details object first; the positional level/message are
  // deprecated fallbacks.
  const consoleErrors = [];
  win.webContents.on("console-message", (...args) => {
    const details = args[0];
    const level = details && typeof details === "object" ? details.level : args[1];
    const message = details && typeof details === "object" ? details.message : args[2];
    if (level === "error" || level === 3) consoleErrors.push(String(message));
  });

  await waitForLoad(win);

  let startupBrowser = null;
  const startupDeadline = Date.now() + 5000;
  while (Date.now() < startupDeadline) {
    startupBrowser = await win.webContents.executeJavaScript(`(async () => ({
      state: await window.electronAPI.getBrowserState(),
      toolbar: !!document.getElementById("browserToolbar"),
      addressFocus: document.activeElement === document.getElementById("browserAddress"),
      agentHidden: document.getElementById("agentWorkspace").hidden,
      stripChildren: Array.from(document.getElementById("browserTabStrip").children).map((el) => el.id),
      logoLoaded: document.getElementById("browserLogo").complete && document.getElementById("browserLogo").naturalWidth > 0,
      tabListRole: document.getElementById("browserTabs").getAttribute("role"),
      chromeHeight: document.getElementById("browserChrome").getBoundingClientRect().height,
      stripHeight: document.getElementById("browserTabStrip").getBoundingClientRect().height,
      toolbarRow: document.getElementById("browserBack").parentElement.id,
      visibleWindows: 0,
    }))()`);
    if (startupBrowser.addressFocus) break;
    await sleep(50);
  }

  const invokeRoutes = routes
    .filter((r) => r.invoke)
    .map((r) => ({ name: r.name, channel: r.channel }));
  await setBrowserModeAndWait(win, "settings");
  const seededHistoryProbe = await probeGlobalHistory(win, null);
  const probe = await win.webContents.executeJavaScript(
    pageProbe(invokeRoutes),
  );

  const site = await startSiteServer();
  const siteVisit = await openSitePageAndWait(win, site.url);
  const siteView = getSiteView(win);
  const siteContentsId = siteView ? siteView.webContents.id : 0;
  const initialLayout = siteView ? {
    bounds: siteView.getBounds(),
    content: win.getContentBounds(),
    visible: siteView.getVisible(),
    toolbarHeight: await win.webContents.executeJavaScript(
      `document.getElementById("browserToolbar").getBoundingClientRect().height`,
    ),
    tabStripHeight: await win.webContents.executeJavaScript(
      `document.getElementById("browserTabStrip").getBoundingClientRect().height`,
    ),
    noPreload: await siteView.webContents.executeJavaScript(
      `typeof window.electronAPI === "undefined"`,
    ),
  } : null;
  const historyProbe = await probeGlobalHistory(win, site.url);
  win.setSize(1000, 720);
  await sleep(250);
  const resizedLayout = siteView ? {
    bounds: siteView.getBounds(),
    content: win.getContentBounds(),
  } : null;

  const popupUrl = `http://localhost:${site.server.address().port}/popup`;
  const beforePopupRecords = await win.webContents.executeJavaScript(
    "window.electronAPI.getRecords()",
  );
  await siteView.webContents.executeJavaScript(
    `document.getElementById("popupLink").click()`,
  );
  const popupState = await waitForBrowserUrl(win, popupUrl);
  const afterPopupRecords = await win.webContents.executeJavaScript(
    "window.electronAPI.getRecords()",
  );
  const popupProbe = {
    state: popupState,
    sameContents: getSiteView(win) && getSiteView(win).webContents.id === siteContentsId,
    windowCount: BrowserWindow.getAllWindows().length,
    visibleWindowCount: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    visitsUnchanged: afterPopupRecords.length === beforePopupRecords.length,
  };

  await submitAddress(win, "file:///tmp/not-a-site.html");
  await sleep(200);
  const invalidAddress = {
    state: await win.webContents.executeJavaScript("window.electronAPI.getBrowserState()"),
    error: await win.webContents.executeJavaScript(
      `document.getElementById("browserError").textContent`,
    ),
  };

  const backState = await clickBrowserAction(win, "back", site.url);
  const forwardState = await clickBrowserAction(win, "forward", popupUrl);
  const backAgainState = await clickBrowserAction(win, "back", site.url);
  const loadsBeforeReload = site.requested.filter((url) => url === SITE_PATH).length;
  await win.webContents.executeJavaScript(
    `document.getElementById("browserReload").click()`,
  );
  const reloadState = await waitForBrowserUrl(win, site.url);
  const reloadDeadline = Date.now() + 5000;
  while (
    site.requested.filter((url) => url === SITE_PATH).length === loadsBeforeReload &&
    Date.now() < reloadDeadline
  ) await sleep(50);
  const reloaded = site.requested.filter((url) => url === SITE_PATH).length > loadsBeforeReload;

  await siteView.webContents.executeJavaScript(`window.__settingsMarker = "preserved"`);
  const settingsState = await setBrowserModeAndWait(win, "settings");
  const hiddenSite = {
    id: siteView.webContents.id,
    url: siteView.webContents.getURL(),
    visible: siteView.getVisible(),
    marker: await siteView.webContents.executeJavaScript(`window.__settingsMarker`),
  };
  const restoredState = await setBrowserModeAndWait(win, "browser");
  const restoredSite = {
    id: siteView.webContents.id,
    url: siteView.webContents.getURL(),
    visible: siteView.getVisible(),
    marker: await siteView.webContents.executeJavaScript(`window.__settingsMarker`),
  };
  const siteMedia = await probeSiteMedia(win, site.url);
  const adRequested = site.requested.includes("/media/ad-0.ts");
  // 等渲染器把这次广播画完（作品行、统计都该就地更新）。
  const siteDeadline = Date.now() + 5000;
  let siteProbe = null;
  while (Date.now() < siteDeadline) {
    siteProbe = await win.webContents.executeJavaScript(`({
      worksText: (document.getElementById('worksContainer') || {}).textContent || '',
      statTotal: (document.getElementById('statTotal') || {}).textContent || '',
    })`);
    if (siteProbe.worksText.includes(SITE_TITLE)) break;
    await sleep(50);
  }

  const workId = siteVisit.record ? siteVisit.record.workId : "";
  await setBrowserModeAndWait(win, "settings");
  const agentSourceClicked = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 10000;
    let row = null;
    while (!row && Date.now() < deadline) {
      row = document.querySelector(
        "#worksContainer [data-work-id=" + CSS.escape(${JSON.stringify(workId)}) + "]"
      );
      if (!row) await sleep(50);
    }
    if (!row) return false;
    row.click();
    let source = null;
    while (!source && Date.now() < deadline) {
      source = Array.from(document.querySelectorAll("#workSources [data-open-url]"))
        .find((el) => decodeURIComponent(el.dataset.openUrl) === ${JSON.stringify(site.url)});
      if (!source) await sleep(50);
    }
    if (!source) return false;
    source.click();
    return true;
  })()`);
  const agentSourceState = await waitForBrowserUrl(win, site.url);
  const agentSourceSameContents = getSiteView(win) &&
    getSiteView(win).webContents.id === siteContentsId;
  const beforeSaveRecords = workId
    ? await win.webContents.executeJavaScript("window.electronAPI.getRecords()")
    : [];
  const beforeSaveWorks = workId
    ? await win.webContents.executeJavaScript(
        "window.electronAPI.getWorksPage(1, 50, {site:'all', sort:'score'})",
      )
    : { works: [] };
  const beforeSaveWork = beforeSaveWorks.works.find((work) => work.id === workId);
  const beforeSaveHealth = await win.webContents.executeJavaScript(
    "window.electronAPI.getWorkHealth()",
  );
  await setBrowserModeAndWait(win, "settings");
  const localCopyUi = await saveSiteWorkLocalCopy(win, workId);
  const localSaveState = await win.webContents.executeJavaScript(
    "window.electronAPI.getBrowserState()",
  );
  await setBrowserModeAndWait(win, "settings");
  localCopyUi.detailText = await win.webContents.executeJavaScript(
    `document.getElementById("workDetailMeta").textContent`,
  );
  localCopyUi.worksRowText = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector(
      "#worksContainer [data-work-id=" + CSS.escape(${JSON.stringify(workId)}) + "]"
    );
    return row ? row.textContent : "";
  })()`);
  localCopyUi.workspaceVisible = await win.webContents.executeJavaScript(
    `!document.getElementById("agentWorkspace").hidden`,
  );
  const savedDetail = workId
    ? await win.webContents.executeJavaScript(
        `window.electronAPI.getWorkDetail(${JSON.stringify(workId)})`,
      )
    : null;
  const afterSaveRecords = workId
    ? await win.webContents.executeJavaScript("window.electronAPI.getRecords()")
    : [];
  const afterSaveWorks = workId
    ? await win.webContents.executeJavaScript(
        "window.electronAPI.getWorksPage(1, 50, {site:'all', sort:'score'})",
      )
    : { works: [] };
  const afterSaveWork = afterSaveWorks.works.find((work) => work.id === workId);
  const afterSaveHealth = await win.webContents.executeJavaScript(
    "window.electronAPI.getWorkHealth()",
  );
  const savedDirectory = savedDetail && savedDetail.localCopy
    ? savedDetail.localCopy.directory
    : "";
  const savedFiles = snapshotFiles(savedDirectory);
  const savedManifest = savedFiles["index.m3u8"]
    ? savedFiles["index.m3u8"].toString("utf8")
    : "";
  const savedSegments = Object.entries(savedFiles)
    .filter(([name]) => name.startsWith("segments" + path.sep) && name.endsWith(".ts"))
    .map(([, body]) => body);

  const requestCountBeforeReuse = site.requested.length;
  const reuseContentsId = getSiteView(win) && getSiteView(win).webContents.id;
  const reuseUrl = getSiteView(win) && getSiteView(win).webContents.getURL();
  const reusedSave = savedDetail && savedDetail.localCopy
    ? await win.webContents.executeJavaScript(
        `window.electronAPI.saveLocalCopy(${JSON.stringify(workId)})`,
      )
    : null;
  const afterReuseState = await win.webContents.executeJavaScript(
    "window.electronAPI.getBrowserState()",
  );
  const reuseDidNotNavigate = getSiteView(win) &&
    getSiteView(win).webContents.id === reuseContentsId &&
    getSiteView(win).webContents.getURL() === reuseUrl &&
    afterReuseState.mode === "settings";
  const afterReuseFiles = snapshotFiles(savedDirectory);
  const reuseFilesUnchanged =
    Object.keys(savedFiles).length === Object.keys(afterReuseFiles).length &&
    Object.entries(savedFiles).every(([name, body]) =>
      afterReuseFiles[name] && afterReuseFiles[name].equals(body));
  const reuseRequestCountUnchanged = site.requested.length === requestCountBeforeReuse;

  const tabAContents = siteView.webContents;
  await tabAContents.executeJavaScript(`window.__tabMarker = "A"`);
  await win.webContents.executeJavaScript(`document.getElementById("browserNewTab").click()`);
  const newTabState = await waitForBrowserState(win, (state) =>
    state.tabs.length === 2 && state.activeTabId !== siteContentsId && state.mode === "browser");
  const tabBId = newTabState ? newTabState.activeTabId : 0;
  const newTabFocused = await win.webContents.executeJavaScript(
    `document.activeElement === document.getElementById("browserAddress")`,
  );
  const urlB = site.url.replace(SITE_PATH, "/v/43");
  const secondVisit = await openSitePageAndWait(win, urlB);
  const tabBContents = getSiteView(win, tabBId) && getSiteView(win, tabBId).webContents;
  if (tabBContents) await tabBContents.executeJavaScript(`window.__tabMarker = "B"`);

  const pageRequests = (url) => site.requested.filter((entry) => entry === new URL(url).pathname).length;
  const switchRequestCounts = [pageRequests(site.url), pageRequests(urlB)];
  await clickTab(win, siteContentsId);
  const switchedA = await waitForBrowserState(win, (state) => state.activeTabId === siteContentsId);
  const switchedAProbe = {
    idA: tabAContents.id,
    idB: tabBContents && tabBContents.id,
    urlA: tabAContents.getURL(),
    markerA: await tabAContents.executeJavaScript(`window.__tabMarker`),
    markerB: tabBContents ? await tabBContents.executeJavaScript(`window.__tabMarker`) : null,
    visibleA: getSiteView(win, siteContentsId) && getSiteView(win, siteContentsId).getVisible(),
    visibleB: getSiteView(win, tabBId) && getSiteView(win, tabBId).getVisible(),
    urlB: tabBContents && tabBContents.getURL(),
  };
  await clickTab(win, tabBId);
  const switchedB = await waitForBrowserState(win, (state) => state.activeTabId === tabBId);
  const switchRequestsUnchanged = pageRequests(site.url) === switchRequestCounts[0] &&
    pageRequests(urlB) === switchRequestCounts[1];

  const urlBNext = site.url.replace(SITE_PATH, "/v/44");
  await submitAddress(win, urlBNext);
  await waitForTabUrl(win, tabBId, urlBNext);
  const isolatedA = {
    id: tabAContents.id,
    url: tabAContents.getURL(),
    marker: await tabAContents.executeJavaScript(`window.__tabMarker`),
    requests: pageRequests(site.url),
  };
  const tabBackState = await clickBrowserAction(win, "back", urlB);
  const tabForwardState = await clickBrowserAction(win, "forward", urlBNext);
  const beforeTabReload = pageRequests(urlBNext);
  await win.webContents.executeJavaScript(`document.getElementById("browserReload").click()`);
  const tabReloadState = await waitForBrowserUrl(win, urlBNext);
  const tabReloadDeadline = Date.now() + 5000;
  while (pageRequests(urlBNext) === beforeTabReload && Date.now() < tabReloadDeadline) await sleep(50);
  const isolatedAAfter = {
    id: tabAContents.id,
    url: tabAContents.getURL(),
    marker: await tabAContents.executeJavaScript(`window.__tabMarker`),
    requests: pageRequests(site.url),
  };
  const independentHistory = tabBackState && tabForwardState && tabReloadState &&
    pageRequests(urlBNext) > beforeTabReload &&
    JSON.stringify(isolatedAAfter) === JSON.stringify(isolatedA);

  let nativeBeforeSettings = null;
  if (tabBContents) {
    const nativeDeadline = Date.now() + 10000;
    while (Date.now() < nativeDeadline) {
      const native = await tabBContents.executeJavaScript(`(() => {
        const original = document.getElementById("player");
        if (original) {
          original.muted = true;
          original.play().catch(() => {});
        }
        const video = document.querySelector("video[data-acuminata-native-player]");
        if (!video) return null;
        video.muted = true;
        video.play().catch(() => {});
        window.__settingsNative = video;
        return { src: video.currentSrc, time: video.currentTime };
      })()`);
      if (native) {
        nativeBeforeSettings = native;
        break;
      }
      await sleep(100);
    }
  }
  const multiSettings = await setBrowserModeAndWait(win, "settings");
  const allViewsHiddenInSettings = win.contentView.children
    .filter((child) => child.webContents && child.webContents !== win.webContents)
    .every((view) => !view.getVisible());
  const settingsUrlBeforeReject = activeBrowserTab(multiSettings).url;
  await submitAddress(win, "file:///tmp/rejected-in-settings.html");
  await sleep(200);
  const rejectedInSettings = await win.webContents.executeJavaScript(`(async () => ({
    state: await window.electronAPI.getBrowserState(),
    workspaceVisible: !document.getElementById("agentWorkspace").hidden,
    pressed: document.getElementById("browserSettings").getAttribute("aria-pressed"),
  }))()`);
  await sleep(400);
  const multiRestored = await setBrowserModeAndWait(win, "browser");
  const nativeAfterSettings = tabBContents ? await tabBContents.executeJavaScript(`(() => {
    const video = document.querySelector("video[data-acuminata-native-player]");
    return video ? {
      same: video === window.__settingsNative,
      src: video.currentSrc,
      time: video.currentTime,
      error: video.error && video.error.message,
    } : null;
  })()`) : null;
  const nativePreserved = nativeBeforeSettings && nativeAfterSettings &&
    nativeAfterSettings.same && nativeAfterSettings.src === nativeBeforeSettings.src &&
    nativeAfterSettings.time >= nativeBeforeSettings.time && !nativeAfterSettings.error;

  await clickTab(win, siteContentsId);
  await waitForBrowserState(win, (state) => state.activeTabId === siteContentsId);
  const popupOriginUrl = tabAContents.getURL();
  const popupRequestCount = pageRequests(site.url);
  if (tabBContents) await tabBContents.executeJavaScript(`document.getElementById("popupLink").click()`);
  const popupUrlB = `http://localhost:${site.server.address().port}/popup`;
  const popupDeadline = Date.now() + 10000;
  while (tabBContents && tabBContents.getURL() !== popupUrlB && Date.now() < popupDeadline) await sleep(50);
  const popupOnlyOrigin = tabBContents && tabBContents.id === tabBId &&
    tabBContents.getURL() === popupUrlB && tabAContents.getURL() === popupOriginUrl &&
    pageRequests(site.url) === popupRequestCount && BrowserWindow.getAllWindows().length === 1;

  await clickTab(win, tabBId);
  await waitForBrowserState(win, (state) => state.activeTabId === tabBId);
  const activeBeforeBackgroundClose = { id: tabBContents.id, url: tabBContents.getURL() };
  await clickTab(win, siteContentsId, true);
  const backgroundCloseState = await waitForBrowserState(win, (state) =>
    !state.tabs.some((tab) => tab.id === siteContentsId) && state.activeTabId === tabBId);
  const backgroundClosePreservedActive = backgroundCloseState && tabAContents.isDestroyed() &&
    !getSiteView(win, siteContentsId) && tabBContents.id === activeBeforeBackgroundClose.id &&
    tabBContents.getURL() === activeBeforeBackgroundClose.url;

  await win.webContents.executeJavaScript(`document.getElementById("browserNewTab").click()`);
  const tabCState = await waitForBrowserState(win, (state) => state.tabs.length === 2);
  const tabCId = tabCState && tabCState.activeTabId;
  const urlC = site.url.replace(SITE_PATH, "/v/45");
  await openSitePageAndWait(win, urlC);
  const tabCContents = getSiteView(win, tabCId).webContents;
  await win.webContents.executeJavaScript(`document.getElementById("browserNewTab").click()`);
  const tabDState = await waitForBrowserState(win, (state) => state.tabs.length === 3);
  const tabDId = tabDState && tabDState.activeTabId;
  const urlD = site.url.replace(SITE_PATH, "/v/46");
  await openSitePageAndWait(win, urlD);
  const tabDContents = getSiteView(win, tabDId).webContents;
  await clickTab(win, tabCId);
  await waitForBrowserState(win, (state) => state.activeTabId === tabCId);
  await setBrowserModeAndWait(win, "settings");
  await clickTab(win, tabCId, true);
  const rightNeighborState = await waitForBrowserState(win, (state) =>
    state.activeTabId === tabDId && state.mode === "settings" && !state.tabs.some((tab) => tab.id === tabCId));
  await clickTab(win, tabDId, true);
  const leftNeighborState = await waitForBrowserState(win, (state) =>
    state.activeTabId === tabBId && state.mode === "settings" && !state.tabs.some((tab) => tab.id === tabDId));
  await setBrowserModeAndWait(win, "browser");
  await clickTab(win, tabBId, true);
  const lastCloseState = await waitForBrowserState(win, (state) =>
    state.tabs.length === 1 && state.tabs[0].url === "" &&
    state.tabs[0].id !== tabBId && state.activeTabId === state.tabs[0].id);
  const repeatedCloseState = await win.webContents.executeJavaScript(
    `window.electronAPI.closeBrowserTab(${tabBId})`,
  );
  const freshBlankView = lastCloseState && getSiteView(win, lastCloseState.activeTabId);
  const lastClosePreservedWindow = lastCloseState && tabBContents.isDestroyed() &&
    tabCContents.isDestroyed() && tabDContents.isDestroyed() && freshBlankView &&
    !freshBlankView.getVisible() && BrowserWindow.getAllWindows().length === 1 &&
    BrowserWindow.getAllWindows()[0].isVisible() && repeatedCloseState.tabs.length === 1 &&
    repeatedCloseState.activeTabId === lastCloseState.activeTabId;

  site.server.close();

  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  expect(
    startupBrowser && startupBrowser.toolbar && startupBrowser.addressFocus &&
      startupBrowser.agentHidden && startupBrowser.state.mode === "browser" &&
      startupBrowser.state.tabs.length === 1 &&
      activeBrowserTab(startupBrowser.state) &&
      activeBrowserTab(startupBrowser.state).url === "" &&
      activeBrowserTab(startupBrowser.state).id === startupBrowser.state.activeTabId &&
      JSON.stringify(startupBrowser.stripChildren) ===
        JSON.stringify(["browserLogo", "browserTabs", "browserNewTab", "browserSettings"]) &&
      startupBrowser.logoLoaded && startupBrowser.tabListRole === "tablist" &&
      startupBrowser.chromeHeight === 88 && startupBrowser.stripHeight === 40 &&
      startupBrowser.toolbarRow === "browserToolbar",
    "startup is not the two-row tabbed browser surface: " + JSON.stringify(startupBrowser),
  );
  expect(probe.hasAPI, "window.electronAPI is not an object");
  expect(
    probe.hasSharedUtils,
    "window.sharedUtils was not provided by the shared utils <script>",
  );
  expect(
    probe.hasWorksView,
    "window.worksView was not provided by the shared works-view <script>",
  );
  expect(
    probe.hasAgentView,
    "window.agentView was not provided by the shared agent-view <script>",
  );
  expect(
    probe.watchlistRemoveDomain.length > 0 && !probe.watchlistRemoveInline,
    "watchlist row does not expose a delegated remove key: " +
      probe.watchlistRemoveDomain,
  );
  expect(
    probe.missingRoutes.length === 0,
    "routes missing from electronAPI: " + probe.missingRoutes.join(", "),
  );
  expect(
    probe.unregistered.length === 0,
    "channels with no registered handler: " + probe.unregistered.join(", "),
  );
  expect(
    probe.watchlistText.includes("bilibili.com"),
    "renderer did not render the seeded watchlist entry",
  );
  expect(
    probe.worksText.includes(SEED_WORK_TITLE),
    "renderer did not render the seeded work",
  );
  expect(
    probe.worksText.includes("1 分"),
    "renderer did not render the work's score",
  );
  expect(
    probe.worksText.includes("B站"),
    "renderer did not render the work's site",
  );
  // 行的 HTML 形状（类名与字段顺序）由视图模型决定，抽出来后必须一字不变。
  expect(
    /<div class="data-item" data-work-id="[^"]+">\s*<div class="item-body">\s*<div class="item-title">[^<]*<\/div>\s*<div class="item-meta">\s*<span class="badge">\d+ 分<\/span>\s*<span>\d+ 个来源<\/span>\s*<span>\d+ 次访问<\/span>/.test(
      probe.worksRowHtml,
    ),
    "renderer did not render the work row as before: " + probe.worksRowHtml,
  );
  expect(
    probe.ambiguousText.includes("SMOKE 歧义甲") &&
      probe.ambiguousText.includes("SMOKE 歧义乙"),
    "renderer did not surface ambiguous works: " + probe.ambiguousText,
  );
  expect(
    probe.candidatesText.includes(SEED_CANDIDATE_TITLE),
    "renderer did not render the seeded candidate in its own panel: " +
      probe.candidatesText,
  );
  expect(probe.detailVisible, "clicking a work did not open its detail");
  expect(
    probe.sourcesText.includes("B站") && probe.sourcesText.includes("电视猫"),
    "work detail did not list each source separately",
  );
  expect(
    probe.sourcesText.includes(SEED_EDITION),
    "work detail did not render the edition",
  );
  expect(
    probe.sourcesText.includes(SEED_VISIT_URL_A) &&
      probe.sourcesText.includes(SEED_VISIT_URL_B),
    "work detail did not render each source's latest address",
  );
  // 来源行的 HTML 形状（类名与字段顺序）由视图模型决定，抽出来后必须一字不变。
  expect(
    /<div class="data-item" data-open-url="[^"]+">\s*<div class="item-body">\s*<div class="item-title">\s*<span class="badge" style="border-color:#[0-9a-f]+; color:#[0-9a-f]+">[^<]+<\/span>\s*<span class="badge">[^<]+<\/span>\s*<\/div>\s*<div class="item-meta">\s*<span>\d+ 次访问<\/span>\s*<span>[^<]*<\/span>\s*<span class="item-url">[^<]*<\/span>/.test(
      probe.sourcesRowHtml,
    ),
    "renderer did not render the source row as before: " + probe.sourcesRowHtml,
  );
  // 访问行的 HTML 形状同样由视图模型决定。
  expect(
    /<div class="data-item" data-url="[^"]+">\s*<input type="checkbox" class="rec-checkbox" data-action="rec-select" data-id="[^"]+"[^>]*>\s*<div class="item-body">\s*<div class="item-title">[^<]*<\/div>\s*<div class="item-meta">\s*<span class="badge" style="border-color:#[0-9a-f]+; color:#[0-9a-f]+">[^<]+<\/span>\s*<span class="badge">[^<]+<\/span>\s*<span>[^<]+<\/span>\s*<span>停留 [^<]+<\/span>\s*<span class="item-url">[^<]*<\/span>/.test(
      probe.visitRowHtml,
    ),
    "renderer did not render the visit row as before: " + probe.visitRowHtml,
  );
  expect(
    probe.visitsText.includes(SEED_VISIT_URL_A) &&
      probe.visitsText.includes(SEED_VISIT_URL_B),
    "work detail did not render every visit's address",
  );
  expect(
    probe.visitsText.includes(SEED_DWELL_TEXT),
    "work detail did not render the visit's dwell time",
  );
  expect(
    probe.hasOpenLatest,
    "work detail did not offer opening the latest visit",
  );
  expect(
    probe.worksHealthText.includes("未归类"),
    "renderer did not render the 未归类 group",
  );
  expect(
    probe.worksHealthText.includes("1 条"),
    "renderer did not render the unattributed count",
  );
  expect(
    probe.unattributedText.includes(SEED_UNATTR_TITLE),
    "未归类 group did not list the unattributed visit",
  );
  expect(
    /回填完成：未归属 \d+ → \d+ 条/.test(probe.backfillText),
    "renderer did not report backfill progress/counts: " + probe.backfillText,
  );
  expect(
    /重新解析完成：未归属 \d+ → \d+ 条/.test(probe.reparseText),
    "renderer did not report reparse progress/counts: " + probe.reparseText,
  );
  expect(
    consoleErrors.length === 0,
    "renderer console errors: " + consoleErrors.join(" | "),
  );

  expect(
    siteVisit.browserState && siteVisit.browserState.mode === "browser" &&
      activeBrowserTab(siteVisit.browserState) &&
      activeBrowserTab(siteVisit.browserState).url === site.url,
    "address submission did not publish the committed BrowserState: " +
      JSON.stringify(siteVisit.browserState),
  );
  expect(
    initialLayout && initialLayout.visible && initialLayout.noPreload &&
      initialLayout.bounds.x === 0 && initialLayout.bounds.y === 88 &&
      initialLayout.toolbarHeight === 48 && initialLayout.tabStripHeight === 40 &&
      initialLayout.bounds.width === initialLayout.content.width &&
      initialLayout.bounds.height === initialLayout.content.height - 88,
    "site view is not laid out below the real toolbar without a preload: " +
      JSON.stringify(initialLayout),
  );
  expect(
    seededHistoryProbe.initialActive && seededHistoryProbe.hasDateGroup &&
      seededHistoryProbe.initialText.includes(SEED_TITLE) &&
      seededHistoryProbe.initialText.includes(SEED_UNATTR_TITLE) &&
      seededHistoryProbe.searchText.includes(SEED_UNATTR_TITLE) &&
      !seededHistoryProbe.searchText.includes(SEED_TITLE) &&
      seededHistoryProbe.emptyText.includes("没有找到匹配的访问"),
    "toolbar history did not list and search seeded global visits: " + JSON.stringify(seededHistoryProbe),
  );
  expect(
    historyProbe.initialActive && historyProbe.initialText.includes(SITE_TITLE) &&
      historyProbe.clicked && historyProbe.state && historyProbe.state.mode === "browser" &&
      activeBrowserTab(historyProbe.state).url === site.url && historyProbe.workspaceHidden,
    "history search did not open the local fixture visit: " + JSON.stringify(historyProbe),
  );
  expect(
    resizedLayout && resizedLayout.bounds.y === 88 &&
      resizedLayout.bounds.width === resizedLayout.content.width &&
      resizedLayout.bounds.height === resizedLayout.content.height - 88,
    "site view bounds did not follow the window resize: " + JSON.stringify(resizedLayout),
  );
  expect(
    popupProbe.state && activeBrowserTab(popupProbe.state) &&
      !activeBrowserTab(popupProbe.state).error && popupProbe.sameContents &&
      popupProbe.windowCount === 1 && popupProbe.visibleWindowCount === 1 &&
      popupProbe.visitsUnchanged,
    "popup did not reuse the one visible window, or unregistered browsing added a visit: " +
      JSON.stringify(popupProbe),
  );
  expect(
    invalidAddress.state && activeBrowserTab(invalidAddress.state) &&
      activeBrowserTab(invalidAddress.state).url === popupUrl &&
      invalidAddress.error.length > 0,
    "invalid address replaced the page or produced no visible error: " +
      JSON.stringify(invalidAddress),
  );
  expect(
    backState && forwardState && backAgainState && reloadState && reloaded &&
      activeBrowserTab(reloadState) && activeBrowserTab(reloadState).id === siteContentsId,
    "Back, Forward, or Reload did not act on the same site contents",
  );
  expect(
    settingsState && settingsState.mode === "settings" &&
      restoredState && restoredState.mode === "browser" &&
      hiddenSite.id === siteContentsId && restoredSite.id === siteContentsId &&
      hiddenSite.url === site.url && restoredSite.url === site.url &&
      hiddenSite.marker === "preserved" && restoredSite.marker === "preserved" &&
      !hiddenSite.visible && restoredSite.visible,
    "Settings did not preserve the same site contents and URL: " +
      JSON.stringify({ settingsState, restoredState, hiddenSite, restoredSite }),
  );
  expect(
    agentSourceClicked && agentSourceState && agentSourceState.mode === "browser" &&
      agentSourceSameContents,
    "Agent source opening did not return to the same browser contents",
  );
  // 站点页：打开一个真页面 → 库里多一条访问 → 归到作品 → 界面上看得见。
  expect(
    siteVisit.count === 1,
    "站点页开出来之后，库里出现了 " + siteVisit.count + " 条访问（应当只有 1 条）",
  );
  expect(
    !!siteVisit.record && siteVisit.record.tabId === siteContentsId && siteContentsId > 0,
    "站点页访问没有持久化所属 WebContents.id",
  );
  expect(
    !!siteVisit.record && !!siteVisit.record.workId,
    "站点页那条访问没有归到作品（workId 为空）",
  );
  expect(
    !!siteVisit.record && siteVisit.record.description.length > 0,
    "站点页没有把页面上的描述抽回来",
  );
  expect(
    !!siteVisit.record &&
      Array.isArray(JSON.parse(siteVisit.record.pageSignature || "[]")) &&
      JSON.parse(siteVisit.record.pageSignature).includes("maccms"),
    "站点页没有把页面签名抽回来：" +
      JSON.stringify(siteVisit.record && siteVisit.record.pageSignature),
  );
  expect(
    !!siteVisit.record &&
      !!JSON.parse(siteVisit.record.pageFields || "{}")["maccms.json"] &&
      !!JSON.parse(siteVisit.record.pageFields || "{}")["maccms.json"].cover,
    "站点页没有把适配器 collect 抽到的字段带回来",
  );
  expect(
    siteProbe && siteProbe.worksText.includes(SITE_TITLE),
    "站点页那次访问的作品没有出现在作品列表里：" +
      (siteProbe ? siteProbe.worksText : ""),
  );
  expect(
    siteProbe && siteProbe.statTotal !== "",
    "站点页那次访问之后统计没有更新",
  );

  // 站点页里的视频：清单经媒体代理改写，广告段不再被拉（issue #75）。
  expect(
    !adRequested,
    "站点页拉过了广告段（广告没被去掉）：" + JSON.stringify(site.requested),
  );
  expect(
    siteMedia.readyState >= 1,
    "站点页里的视频没有起播：" + JSON.stringify(siteMedia),
  );
  expect(
    siteMedia.duration > 0,
    "站点页里的视频读不到时长：" + JSON.stringify(siteMedia),
  );

  expect(
    localCopyUi.saved && localCopyUi.workspaceVisible && localSaveState.mode === "browser",
    "点击存到本机后没有显示已存本机，或媒体检测没有切到浏览器：" +
      JSON.stringify({ localCopyUi, localSaveState }),
  );
  expect(
    savedDetail && savedDetail.localCopy &&
      path.resolve(savedDetail.localCopy.directory) ===
        path.join(tmpDir, "local-copies", workId) &&
      fs.existsSync(savedDetail.localCopy.directory),
    "本地副本详情没有指向临时根目录下的真实目录：" +
      JSON.stringify(savedDetail && savedDetail.localCopy),
  );
  expect(
    savedManifest === site.manifest && savedManifest.includes("/media/ad-0.ts"),
    "归档的根清单不是服务端原文（含广告引用）：" + JSON.stringify(savedManifest),
  );
  expect(
    savedSegments.some((body) => body.equals(site.seg0)) &&
      savedSegments.some((body) => body.equals(site.seg1)),
    "归档分片与 segment-0.ts / segment-1.ts 夹具的字节不一致",
  );
  expect(
    site.requested.includes("/media/ad-0.ts"),
    "原始归档没有请求广告段：" + JSON.stringify(site.requested),
  );
  expect(
    localCopyUi.detailText.includes("已存本机"),
    "作品详情没有显示已存本机：" + localCopyUi.detailText,
  );
  expect(
    localCopyUi.worksRowText.includes(SITE_TITLE) &&
      localCopyUi.worksRowText.includes("已存本机"),
    "作品列表行没有显示已存本机：" + localCopyUi.worksRowText,
  );
  expect(
    afterSaveRecords.length === beforeSaveRecords.length,
    "保存本地副本改变了访问总数：" +
      `${beforeSaveRecords.length} → ${afterSaveRecords.length}`,
  );
  expect(
    beforeSaveWork && afterSaveWork &&
      afterSaveWork.visitCount === beforeSaveWork.visitCount &&
      afterSaveWork.hasLocalCopy === true,
    "保存本地副本改变了访问数，或数据库行没有本地副本标记：" +
      JSON.stringify({ before: beforeSaveWork, after: afterSaveWork }),
  );
  expect(
    afterSaveHealth.adapters.find((adapter) => adapter.key === "maccms.json").matched ===
      beforeSaveHealth.adapters.find((adapter) => adapter.key === "maccms.json").matched,
    "保存本地副本触发了一次被去重掩盖的页面采集",
  );
  expect(
    reusedSave && reusedSave.reused === true && reuseDidNotNavigate,
    "第二次保存没有复用已有副本，或复用时导航/切换了模式：" +
      JSON.stringify({ reusedSave, reuseDidNotNavigate, afterReuseState }),
  );
  expect(
    reuseFilesUnchanged,
    "第二次保存改变了递归文件名或文件字节",
  );
  expect(
    reuseRequestCountUnchanged,
    "第二次保存增加了上游请求：" +
      `${requestCountBeforeReuse} → ${site.requested.length}`,
  );
  expect(
    newTabState && newTabFocused && secondVisit.count === 1 &&
      secondVisit.record && secondVisit.record.tabId === tabBId &&
      tabBId > 0 && tabBId !== siteContentsId && switchedAProbe.idB === tabBId,
    "New Tab did not create an independent contents with its own persisted visit: " +
      JSON.stringify({ newTabState, secondVisit, tabBId }),
  );
  expect(
    switchedA && switchedB && switchRequestsUnchanged &&
      switchedAProbe.markerA === "A" && switchedAProbe.markerB === "B" &&
      switchedAProbe.visibleA === true && switchedAProbe.visibleB === false &&
      switchedAProbe.urlB === urlB && switchedAProbe.idA === siteContentsId &&
      switchedAProbe.idB === tabBId && switchedAProbe.urlA === site.url,
    "switching real tab controls reloaded, lost, or exposed a background contents: " +
      JSON.stringify({ switchedA, switchedB, switchedAProbe }),
  );
  expect(
    !!independentHistory,
    "Back, Forward, or Reload changed the background tab instead of only the active tab",
  );
  expect(
    multiSettings && multiRestored && multiSettings.activeTabId === tabBId &&
      multiRestored.activeTabId === tabBId && allViewsHiddenInSettings && nativePreserved,
    "Settings did not preserve the active tab and its native page state: " +
      JSON.stringify({ multiSettings, multiRestored, allViewsHiddenInSettings, nativeBeforeSettings, nativeAfterSettings }),
  );
  expect(
    rejectedInSettings.state && rejectedInSettings.state.mode === "settings" &&
      rejectedInSettings.workspaceVisible && rejectedInSettings.pressed === "true" &&
      activeBrowserTab(rejectedInSettings.state).url === settingsUrlBeforeReject,
    "rejected navigation desynchronized Settings mode: " + JSON.stringify(rejectedInSettings),
  );
  expect(
    !!popupOnlyOrigin,
    "popup navigated another tab or created a BrowserWindow",
  );
  expect(
    !!backgroundClosePreservedActive,
    "background close destroyed or navigated the active tab",
  );
  expect(
    rightNeighborState && leftNeighborState && tabCContents.isDestroyed() && tabDContents.isDestroyed(),
    "active close did not choose right then left, or close changed Settings mode",
  );
  expect(
    !!lastClosePreservedWindow,
    "last close did not leave one fresh blank tab in one visible app window: " +
      JSON.stringify({ lastCloseState, repeatedCloseState }),
  );

  if (failures.length) {
    console.error("SMOKE FAILED");
    for (const f of failures) console.error("  ✗ " + f);
    console.error("probe: " + JSON.stringify(probe));
    return 1;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(
    `SMOKE PASSED: ${invokeRoutes.length} channels round-tripped, renderer painted seeded data`,
  );
  return 0;
}

const watchdog = setTimeout(() => {
  console.error("SMOKE FAILED: timed out after " + TIMEOUT_MS + "ms");
  app.exit(1);
}, TIMEOUT_MS);

main()
  .then((code) => {
    clearTimeout(watchdog);
    app.exit(code);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error("SMOKE FAILED: " + (err && err.stack ? err.stack : err));
    app.exit(1);
  });
