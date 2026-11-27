// Electron smoke test — boots the REAL app (main.js) with the REAL preload and
// the REAL renderer page, against a throwaway database, and asserts:
//   1. window.electronAPI exists and every route is callable
//   2. every invoke channel round-trips (a handler is actually registered)
//   3. the renderer rendered real data read over IPC
//   4. 扩展上报一条访问只走一次调用（WS → addRecord → RecordStore.recordVisit）
//   5. WS 服务端只绑回环，同机器上的另一个地址连不上
// Run with: npm run test:smoke

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { app, BrowserWindow, ipcMain } = require("electron");
const { loadPreloadRoutes } = require("./preload-routes");

const SEED_TITLE = "SMOKE 预置访问 α";
const SEED_WORK_TITLE = "SMOKE 预置作品 β";
const SEED_UNATTR_TITLE = "SMOKE 未归类 γ";
const SEED_VISIT_URL_A = "https://bilibili.com/video/smoke";
const SEED_VISIT_URL_B = "https://tvmao.com/kanju/smoke";
const SEED_EDITION = "中文字幕";
const SEED_DWELL_TEXT = "2分5秒";
// 供主进程那条通路用的站点：带命名捕获组，上报的访问才归得到作品。
const SEED_WS_DOMAIN = "smoke-ws.example";
const SEED_WS_URL = "https://smoke-ws.example/v/42";
const SEED_WS_TITLE = "SMOKE 上报 δ";
const SEED_CANDIDATE_TITLE = "SMOKE 候选 ε";
// 站点页要开一个真页面：用本机 HTTP 伺服一份站点页夹具。
// 它的域名（127.0.0.1）因此要登记成站点，访问才落库（兴趣分析只管登记过的站点）。
const SITE_DOMAIN = "127.0.0.1";
const SITE_PATH = "/v/42";
const SITE_TITLE = "《冒烟作品》";
const TIMEOUT_MS = 60000;
const WS_PORT = 8766;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-smoke-"));
const dbPath = path.join(tmpDir, "tracker.db");
process.env.ACUMINATA_DB_PATH = dbPath;
process.env.ACUMINATA_LOCAL_COPY_DIR = path.join(tmpDir, "local-copies");
// 媒体代理的 scheme 要在 app ready 之前登记（Chromium 的规矩）。
// 冒烟测试是在 ready 之后才 require main.js 的，所以这里先登记一次；
// main.js 里那次是第二次，登记函数认得出来，直接跳过。
require("../media-proxy").registerMediaScheme();

// Count every renderer→main invoke. Wrapping ipcMain.handle before main.js loads
// is what makes "one visit no longer triggers a full re-pull" assertable.
const ipcCounts = {};
const rawHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) =>
  rawHandle(channel, (...args) => {
    ipcCounts[channel] = (ipcCounts[channel] || 0) + 1;
    return fn(...args);
  });

function resetIpcCounts() {
  for (const key of Object.keys(ipcCounts)) delete ipcCounts[key];
}

function readIpcCounts() {
  return Object.entries(ipcCounts)
    .filter(([, n]) => n > 0)
    .map(([channel, n]) => [channel, n]);
}

const routes = loadPreloadRoutes().routes;

async function seedDatabase() {
  const { RecordStore } = require("../agent/record-store");
  const store = new RecordStore(dbPath);
  await store.init();
  store.addWatchlist({ domain: "tvmao.com", label: "电视猫", color: "#fff" });
  // 站点页伺服在本机：登记它的域名，站点页开出来的访问才落库。
  store.addWatchlist({ domain: SITE_DOMAIN, label: "冒烟站点页", color: "#fff" });
  store.addWatchlist({
    domain: SEED_WS_DOMAIN,
    label: "冒烟站",
    color: "#fff",
    regexFilter: "/v/(?<code>[0-9]+)",
    regexTarget: "url",
  });
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
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
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
 * 当一次扩展用：连上主进程的 WS，上报一条访问，再重报同一条。
 *
 * main.js 的 addRecord 分支除此之外没有别的入口——而它正是「一条访问只需一次
 * 调用」的那一次调用（store.recordVisit），所以这里直接走真实的通路。
 * 库里到底写了什么，也按扩展的方式问主进程要（exportData）。
 */
async function reportVisitOverWs() {
  const WebSocket = require("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  const inbox = [];
  ws.on("message", (d) => {
    try {
      inbox.push(JSON.parse(d));
    } catch (e) {
      /* 非 JSON 不入信箱 */
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const visit = {
    id: "smoke-ws-1",
    url: SEED_WS_URL,
    title: SEED_WS_TITLE,
    domain: SEED_WS_DOMAIN,
    matchedRule: SEED_WS_DOMAIN,
    tabId: 7,
    timestamp: Date.now(),
    favIconUrl: "",
    description: "",
    ogImage: "",
  };
  const waitFor = async (pred, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) await sleep(25);
  };

  ws.send(JSON.stringify({ type: "addRecord", ...visit }));
  await waitFor(() =>
    inbox.some((m) => m.type === "recordAdded" || m.type === "recordUpdated"),
  );

  // 同一条访问再报一次（同标签页、60s 内）：库里不该出现第二条
  ws.send(JSON.stringify({ type: "addRecord", ...visit }));
  await sleep(300);

  ws.send(JSON.stringify({ type: "exportData" }));
  await waitFor(() => inbox.some((m) => m.type === "exportData"));
  ws.close();

  const exported = inbox.filter((m) => m.type === "exportData").pop();
  if (!exported) return { count: 0, workId: null };
  const mine = (exported.records || []).filter((r) => r.id === visit.id);
  // 一次上报只该产生一条 record 广播，且带客户端读的 record 与健康度（issue #53）。
  const recordMsgs = inbox.filter(
    (m) => m.type === "recordAdded" || m.type === "recordUpdated",
  );
  return {
    count: mine.length,
    workId: mine[0] ? mine[0].workId : null,
    recordBroadcasts: recordMsgs.length,
    recordHasField: !!(recordMsgs[0] && recordMsgs[0].record),
    recordHasHealth: !!(recordMsgs[0] && recordMsgs[0].health),
  };
}

/**
 * 站点页通路：界面上的「打开来源」→ 应用内站点页 → 采集 → 落库。
 *
 * 站点页开的是**真页面**（本机 HTTP 伺服），采集因此跑的是页面上真实的
 * collectPage——与扩展时期注入页面的那个函数同一份（shared/page-collect.js）。
 * 库里多出来的那条访问、它归到的作品、界面上的作品行与统计，都是这条通路的产物。
 */
async function openSitePageAndWait(win, siteUrl) {
  // 界面上的「打开来源」按钮走的就是 openUrl 这条路由。
  await win.webContents.executeJavaScript(
    `window.electronAPI.openUrl(${JSON.stringify(siteUrl)})`,
  );

  const deadline = Date.now() + 15000;
  let records = [];
  while (Date.now() < deadline) {
    records = await win.webContents.executeJavaScript(
      `window.electronAPI.getRecords()`,
    );
    if (records.some((r) => r.url === siteUrl)) break;
    await sleep(50);
  }

  const mine = records.filter((r) => r.url === siteUrl);
  return {
    count: mine.length,
    record: mine[0] || null,
  };
}

/**
 * 站点页里的视频：清单经媒体代理改写后，广告段不该被拉过（issue #75）。
 * 站点页窗口是站点页自己开的那一个（地址就是站点页的地址）。
 * @param {Object} mainWin 应用自己的窗口
 * @param {string} siteUrl 站点页的地址
 * @returns {Promise<{duration: number, readyState: number, error: string}>}
 */
async function probeSiteMedia(mainWin, siteUrl) {
  const siteWin = BrowserWindow.getAllWindows().find(
    (w) => w !== mainWin && w.webContents.getURL().startsWith(siteUrl),
  );
  if (!siteWin) return { duration: 0, readyState: 0, error: "no site window" };
  const deadline = Date.now() + 15000;
  let out = { duration: 0, readyState: 0, error: "timeout" };
  while (Date.now() < deadline) {
    out = await siteWin.webContents.executeJavaScript(`(() => {
      const v = document.getElementById("player");
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

/**
 * 服务端只许待在回环上：换一个地址、同一个端口，应当连不上。
 * 127.0.0.2 是同机另一个回环地址——绑 0.0.0.0 时能连上、绑 127.0.0.1 时被拒，
 * 所以它不需要网卡就能证明探针本身有效；局域网地址则是同一探针的端到端版本。
 */
async function probeBindWidth() {
  const net = require("net");
  const one = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port: WS_PORT, host });
      socket.on("connect", () => {
        socket.destroy();
        resolve({ host, code: "CONNECTED" });
      });
      socket.on("error", (err) => resolve({ host, code: err.code }));
    });
  const alias = await one("127.0.0.2");
  const peers = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  return { alias, connected: (await Promise.all(peers.map(one))).filter((p) => p.code === "CONNECTED") };
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
  win.hide();
  win.on("ready-to-show", () => win.hide());

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

  const invokeRoutes = routes
    .filter((r) => r.invoke)
    .map((r) => ({ name: r.name, channel: r.channel }));
  const probe = await win.webContents.executeJavaScript(
    pageProbe(invokeRoutes),
  );

  // 扩展所走的那条通路（真实 WS → main.js 的 addRecord → store.recordVisit）。
  // 探针自己 round-trip 过所有路由，先清零再数这次访问。
  resetIpcCounts();
  const wsVisit = await reportVisitOverWs();
  // 等渲染器把这次广播画完（新作品自己出现在列表里），再读计数：
  // 计数为零不能是因为还没画，也不能靠一个拍脑袋的 sleep。
  let visitProbe = null;
  const visitDeadline = Date.now() + 5000;
  while (Date.now() < visitDeadline) {
    visitProbe = await win.webContents.executeJavaScript(`({
      worksText: (document.getElementById('worksContainer') || {}).textContent || '',
      statTotal: (document.getElementById('statTotal') || {}).textContent || '',
    })`);
    if (visitProbe.worksText.includes(SEED_WS_TITLE)) break;
    await sleep(50);
  }
  const visitIpcCalls = readIpcCounts();
  const loopback = await probeBindWidth();

  // 站点页通路：界面上的「打开来源」→ 应用内站点页 → 采集 → 落库。
  const site = await startSiteServer();
  const siteVisit = await openSitePageAndWait(win, site.url);
  // 站点页里的视频：清单经媒体代理改写，广告段不再被拉。
  const siteMedia = await probeSiteMedia(win, site.url);
  const adRequested = site.requested.includes("/media/ad-0.ts");
  // 站点页开的是另一个窗口：冒烟测试里把它收起来，别抢用户的桌面。
  for (const w of BrowserWindow.getAllWindows()) if (w !== win) w.hide();
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
  const beforeSaveRecords = workId
    ? await win.webContents.executeJavaScript("window.electronAPI.getRecords()")
    : [];
  const beforeSaveWorks = workId
    ? await win.webContents.executeJavaScript(
        "window.electronAPI.getWorksPage(1, 50, {site:'all', sort:'score'})",
      )
    : { works: [] };
  const beforeSaveWork = beforeSaveWorks.works.find((work) => work.id === workId);
  const localCopyUi = await saveSiteWorkLocalCopy(win, workId);
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
  const reusedSave = savedDetail && savedDetail.localCopy
    ? await win.webContents.executeJavaScript(
        `window.electronAPI.saveLocalCopy(${JSON.stringify(workId)})`,
      )
    : null;
  const afterReuseFiles = snapshotFiles(savedDirectory);
  const reuseFilesUnchanged =
    Object.keys(savedFiles).length === Object.keys(afterReuseFiles).length &&
    Object.entries(savedFiles).every(([name, body]) =>
      afterReuseFiles[name] && afterReuseFiles[name].equals(body));
  site.server.close();

  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
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
    wsVisit.count === 1,
    "上报同一条访问两次后，库里出现了 " + wsVisit.count + " 条（应当只有 1 条）",
  );
  expect(
    !!wsVisit.workId,
    "WS 上报的那条访问没有归到作品（workId 为空）——一次调用要把作品归属一起做完",
  );
  // issue #53：一次上报一条 record 广播，且信封带客户端读的具名 record 与健康度。
  expect(
    wsVisit.recordBroadcasts === 1,
    "一次上报产生了 " + wsVisit.recordBroadcasts + " 条 record 广播（应当只有 1 条）",
  );
  expect(wsVisit.recordHasField, "record 广播没有带 record 字段");
  expect(wsVisit.recordHasHealth, "record 广播没有带健康度（应当随这一条广播一起）");
  // AC：一条新访问不再触发全量重拉（stats / works:page / health / unattributed /
  // 打开中的详情）。广播已带够数据，这次访问不该产生任何渲染器→主进程的 invoke。
  expect(
    visitIpcCalls.length === 0,
    "一条访问触发了 IPC 重拉: " + JSON.stringify(visitIpcCalls),
  );
  expect(
    visitProbe.worksText.includes(SEED_WS_TITLE),
    "新访问的作品没有就地出现在作品列表里：" + visitProbe.worksText,
  );
  expect(
    visitProbe.statTotal !== "",
    "一条访问后统计没有更新：" + visitProbe.statTotal,
  );
  expect(
    loopback.alias.code === "ECONNREFUSED",
    "127.0.0.2:" + WS_PORT + " 未被拒（" + JSON.stringify(loopback.alias) + "）：探针在此平台无效，或服务端绑得比回环宽",
  );
  expect(
    loopback.connected.length === 0,
    "局域网地址也能连上 WS 服务端：" + JSON.stringify(loopback.connected),
  );
  expect(
    consoleErrors.length === 0,
    "renderer console errors: " + consoleErrors.join(" | "),
  );

  // 站点页：打开一个真页面 → 库里多一条访问 → 归到作品 → 界面上看得见。
  expect(
    siteVisit.count === 1,
    "站点页开出来之后，库里出现了 " + siteVisit.count + " 条访问（应当只有 1 条）",
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
    localCopyUi.saved,
    "点击存到本机后没有显示已存本机：" + JSON.stringify(localCopyUi),
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
    reusedSave && reusedSave.reused === true,
    "第二次保存没有复用已有副本：" + JSON.stringify(reusedSave),
  );
  expect(
    reuseFilesUnchanged,
    "第二次保存改变了递归文件名或文件字节",
  );
  expect(
    site.requested.length === requestCountBeforeReuse,
    "第二次保存增加了上游请求：" +
      `${requestCountBeforeReuse} → ${site.requested.length}`,
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
