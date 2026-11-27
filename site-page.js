// 站点页：Acuminata 自己承载的站点页面（ADR-0011）。
//
// 一个窗口，复用；每次导航后抽字段、按同一条写入路径落库（ADR-0002：判定只做一次）。
// 站点页跑在自己的持久化 partition 里：登录态因此跨重启存活，
// 媒体资源的协议层改写（ADR-0012）也挂在这个 session 上，不碰应用自己的界面 session。
//
//
// 算不算一次访问、归到哪部作品，都不在这里判——那是 store.recordVisit 的事。

const { BrowserWindow, session } = require("electron");
const { collectPage, detectBySignature } = require("./shared/page-collect");
const { detectNativePlayer, takeoverNativePlayer } = require("./shared/native-player");
const { extractDomain, matchSite } = require("./shared/site-match");
const { createMediaProxy, proxyUrl, SCOPE_APP } = require("./media-proxy");

// 持久化 partition：登录态跨重启存活（cookie 落盘）。
const PARTITION = "persist:acuminata";

/**
 * @param {Object} deps
 * @param {() => Array<Object>} deps.getAdapters 桌面端这一份适配器（与扩展时期推给扩展的是同一份）
 * @param {() => Array<Object>} deps.getWatchlist 登记站点
 * @param {(incoming:Object) => Object} deps.onVisit 一条访问的来料；交给写入路径
 * @param {(file:string, message:string) => void} [deps.onAdapterWarning] 播放规则失效告警
 */
function createSitePage({ getAdapters, getWatchlist, onVisit, onAdapterWarning = () => {} }) {
  const siteSession = session.fromPartition(PARTITION);
  let win = null;
  let takeoverGeneration = 0;

  // 媒体资源经代理改写：站点页拉到的清单没有流内广告（ADR-0012）。
  // 代理只管媒体：站点的其余流量不经过它，页面的行为一点不变。
  createMediaProxy({
    session: siteSession,
    getReferer: () => (win && !win.isDestroyed() ? win.webContents.getURL() : ""),
  });

  /** 站点页窗口：没有就开一个，有就复用。 */
  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: 1100,
      height: 760,
      title: "Acuminata",
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.on("closed", () => {
      takeoverGeneration++;
      win = null;
    });
    // 整页换页与页内换页（history.pushState）都算一次新页面：两种都得采。
    win.webContents.on("did-finish-load", () => {
      capture().catch((e) => console.error("[SitePage] capture failed:", e));
      takeover().catch((e) => console.error("[SitePage] native takeover failed:", e));
    });
    win.webContents.on("did-navigate-in-page", () => {
      capture().catch((e) => console.error("[SitePage] capture failed:", e));
      takeover().catch((e) => console.error("[SitePage] native takeover failed:", e));
    });
    return win;
  }

  async function takeover() {
    const generation = ++takeoverGeneration;
    const detectExpr = `(${detectNativePlayer.toString()})()`;
    let adapter = null;
    try {
      const adapters = getAdapters() || [];
      const expr = `(${collectPage.toString()})([])`;
      const page = await win.webContents.executeJavaScript(expr, true);
      adapter = detectBySignature(page.pageSignature, adapters);
    } catch (e) {
      adapter = null;
    }
    while (generation === takeoverGeneration && win && !win.isDestroyed()) {
      const media = await win.webContents.executeJavaScript(detectExpr, true);
      if (media && media.src) {
        const request = {
          ...media,
          nativeSrc: proxyUrl(media.src, "segment", SCOPE_APP),
          playback: adapter && adapter.playback,
        };
        const expr = `(${takeoverNativePlayer.toString()})(${JSON.stringify(request)})`;
        const result = await win.webContents.executeJavaScript(expr, true);
        if (result && result.ok) {
          if (result.warning && adapter && adapter.file) {
            onAdapterWarning(adapter.file, result.warning);
          }
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  /**
   * 抽这一页看到的字段，交给写入路径。
   * 未登记的站点不产生访问（兴趣分析只针对用户显式登记的站点，ADR-0003）。
   */
  async function capture() {
    if (!win || win.isDestroyed()) return null;
    const url = win.webContents.getURL();
    const site = matchSite(url, getWatchlist());
    if (!site) return null;

    const title = win.webContents.getTitle();
    let page = null;
    try {
      // 采集函数是自足的（shared/page-collect.js）：整段注入页面即可，
      // 与扩展时期 chrome.scripting.executeScript 跑的是同一个函数。
      const expr = `(${collectPage.toString()})(${JSON.stringify(getAdapters() || [])})`;
      page = await win.webContents.executeJavaScript(expr, true);
    } catch (e) {
      page = null; // 抽不到字段不该丢掉这次访问：降级而不是丢弃（ADR-0003）
    }

    return onVisit({
      url,
      title,
      domain: extractDomain(url) || site.domain,
      matchedRule: site.domain,
      // 站点页的访问统一用 0：扩展时期的 tabId 是 Chrome 的标签页号，
      // 两者会撞号，撞号会让「同一路径 60 秒内重报」误判成同一次访问。
      tabId: 0,
      timestamp: Date.now(),
      favIconUrl: "",
      description: (page && page.description) || "",
      ogImage: (page && page.ogImage) || "",
      pageSignature: (page && page.pageSignature) || [],
      pageFields: (page && page.pageFields) || {},
    });
  }

  /**
   * 打开一个地址。地址没给就不动（界面会空调用这个动作）。
   * @param {string} url
   */
  function open(url) {
    if (!url) return false;
    const w = ensureWindow();
    w.focus();
    w.loadURL(url);
    return true;
  }

  return {
    open,
    /** 站点页自己的 session：媒体资源的协议层改写挂在这里（ADR-0012）。 */
    get session() {
      return siteSession;
    },
    /** 当前窗口；没有就 null。 */
    get window() {
      return win && !win.isDestroyed() ? win : null;
    },
  };
}

module.exports = { createSitePage, PARTITION };
