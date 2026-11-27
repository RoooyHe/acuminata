const { WebContentsView, session } = require("electron");
const { randomUUID } = require("crypto");
const { collectPage, detectBySignature } = require("./shared/page-collect");
const { detectNativePlayer, takeoverNativePlayer } = require("./shared/native-player");
const { extractDomain, matchSite } = require("./shared/site-match");
const { createMediaProxy, proxyUrl, SCOPE_APP } = require("./media-proxy");

const PARTITION = "persist:acuminata";
const BROWSER_CHROME_HEIGHT = 88;

function normalizeAddress(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("请输入网址");
  let address = input.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(address)) {
    const bareHostWithPort = /^[^/:?#]+:\d+(?:[/?#]|$)/.test(address);
    if (/^[a-z][a-z\d+.-]*:/i.test(address) && !bareHostWithPort) {
      throw new Error("只支持 HTTP 或 HTTPS 地址");
    }
    address = `https://${address}`;
  }
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error("网址格式无效");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new Error("只支持 HTTP 或 HTTPS 地址");
  }
  return url.href;
}

function isWebAddress(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {Object} deps
 * @param {Electron.BrowserWindow} deps.hostWindow 唯一的可见应用窗口
 * @param {() => Array<Object>} deps.getAdapters 桌面端加载的适配器
 * @param {() => Array<Object>} deps.getWatchlist 登记站点
 * @param {(incoming:Object) => Object} deps.onVisit 一条访问的来料；交给写入路径
 * @param {(file:string, message:string) => void} [deps.onAdapterWarning] 播放规则失效告警
 * @param {() => void} [deps.onStateChange] 地址、标签、载入状态或错误变化
 * @param {() => "browser"|"settings"} [deps.getMode] 主窗口当前的显示模式
 */
function createBrowser({
  hostWindow,
  getAdapters,
  getWatchlist,
  onVisit,
  onAdapterWarning = () => {},
  onStateChange = () => {},
  getMode = () => "browser",
}) {
  const siteSession = session.fromPartition(PARTITION);
  const tabs = new Map();
  const mediaTabs = new Map();
  let activeTabId = 0;

  function isLive(tab) {
    return tabs.get(tab.id) === tab && !tab.contents.isDestroyed();
  }

  function activeTab() {
    const tab = tabs.get(activeTabId);
    return tab && !tab.contents.isDestroyed() ? tab : null;
  }

  const mediaProxy = createMediaProxy({
    session: siteSession,
    getMediaKey(webContentsId) {
      const tab = tabs.get(webContentsId);
      return tab && !tab.contents.isDestroyed() ? tab.mediaKey : "";
    },
    getReferer(mediaKey) {
      const tab = mediaTabs.get(mediaKey);
      if (!tab || !isLive(tab)) return null;
      return tab.contents.getURL();
    },
  });

  function cancelMediaDetection(tab, error) {
    const pending = tab.pendingMedia;
    if (!pending) return;
    tab.pendingMedia = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  function finishMediaDetection(tab, media) {
    const pending = tab.pendingMedia;
    if (!pending || !isLive(tab)) return;
    tab.pendingMedia = null;
    clearTimeout(pending.timer);
    pending.resolve({ src: media.src, pageUrl: tab.contents.getURL() });
  }

  function layout() {
    if (!hostWindow || hostWindow.isDestroyed()) return;
    const { width, height } = hostWindow.getContentBounds();
    for (const tab of tabs.values()) {
      tab.view.setBounds({
        x: 0,
        y: BROWSER_CHROME_HEIGHT,
        width,
        height: Math.max(0, height - BROWSER_CHROME_HEIGHT),
      });
      tab.view.setVisible(
        getMode() === "browser" && tab.id === activeTabId && !!tab.contents.getURL(),
      );
    }
  }

  function notifyStateChange() {
    layout();
    onStateChange();
  }

  function titleFor(tab) {
    const url = tab.contents.getURL();
    if (!url) return "新标签页";
    const title = tab.contents.getTitle();
    if (title) return title;
    try {
      return new URL(url).hostname || "新标签页";
    } catch {
      return "新标签页";
    }
  }

  function getState() {
    return {
      activeTabId,
      tabs: Array.from(tabs.values(), (tab) => {
        const available = !tab.contents.isDestroyed();
        return {
          id: tab.id,
          title: available ? titleFor(tab) : "新标签页",
          url: available ? tab.contents.getURL() : "",
          isLoading: available ? tab.contents.isLoading() : false,
          canGoBack: available ? tab.contents.navigationHistory.canGoBack() : false,
          canGoForward: available ? tab.contents.navigationHistory.canGoForward() : false,
          error: tab.loadError,
        };
      }),
    };
  }

  function openInTab(tab, address) {
    const url = normalizeAddress(address);
    if (!isLive(tab)) throw new Error("标签页不存在");
    cancelMediaDetection(tab, new Error("媒体检测已取消：导航已被替换"));
    tab.takeoverGeneration++;
    hostWindow.focus();
    const loading = tab.contents.loadURL(url);
    if (loading && loading.catch) loading.catch(() => {});
    layout();
    return true;
  }

  async function capture(tab) {
    const generation = ++tab.captureGeneration;
    if (tab.pendingMedia || !isLive(tab)) return null;
    const url = tab.contents.getURL();
    const site = matchSite(url, getWatchlist());
    if (!site) return null;

    const title = tab.contents.getTitle();
    let page = null;
    try {
      const expr = `(${collectPage.toString()})(${JSON.stringify(getAdapters() || [])})`;
      page = await tab.contents.executeJavaScript(expr, true);
    } catch (e) {
      page = null;
    }
    if (
      !isLive(tab) || generation !== tab.captureGeneration || tab.contents.getURL() !== url
    ) return null;

    return onVisit({
      url,
      title,
      domain: extractDomain(url) || site.domain,
      matchedRule: site.domain,
      tabId: tab.id,
      timestamp: Date.now(),
      favIconUrl: "",
      description: (page && page.description) || "",
      ogImage: (page && page.ogImage) || "",
      pageSignature: (page && page.pageSignature) || [],
      pageFields: (page && page.pageFields) || {},
    });
  }

  async function takeover(tab) {
    const generation = ++tab.takeoverGeneration;
    let adapter = null;
    try {
      const adapters = getAdapters() || [];
      const expr = `(${collectPage.toString()})([])`;
      const page = await tab.contents.executeJavaScript(expr, true);
      adapter = detectBySignature(page.pageSignature, adapters);
    } catch (e) {
      adapter = null;
    }
    while (isLive(tab) && generation === tab.takeoverGeneration) {
      const detectExpr = `(${detectNativePlayer.toString()})(${!!tab.pendingMedia})`;
      const media = await tab.contents.executeJavaScript(detectExpr, true);
      if (!isLive(tab) || generation !== tab.takeoverGeneration) return false;
      if (media && media.src) {
        const request = {
          ...media,
          nativeSrc: proxyUrl(media.src, "segment", SCOPE_APP, tab.mediaKey),
          playback: adapter && adapter.playback,
        };
        const expr = `(${takeoverNativePlayer.toString()})(${JSON.stringify(request)})`;
        const result = await tab.contents.executeJavaScript(expr, true);
        if (!isLive(tab) || generation !== tab.takeoverGeneration) return false;
        if (result && result.ok) {
          if (result.warning && adapter && adapter.file) {
            onAdapterWarning(adapter.file, result.warning);
          }
          finishMediaDetection(tab, media);
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  function startPageWork(tab) {
    capture(tab).catch((e) => console.error("[Browser] capture failed:", e));
    takeover(tab).catch((e) => console.error("[Browser] native takeover failed:", e));
  }

  function handleDestroyed(tab) {
    if (tabs.get(tab.id) !== tab) return;
    const ids = Array.from(tabs.keys());
    const index = ids.indexOf(tab.id);
    const wasActive = activeTabId === tab.id;
    const nextId = wasActive ? (ids[index + 1] || ids[index - 1] || 0) : activeTabId;
    tabs.delete(tab.id);
    mediaTabs.delete(tab.mediaKey);
    tab.captureGeneration++;
    tab.takeoverGeneration++;
    cancelMediaDetection(tab, new Error("媒体检测已取消：标签页已关闭"));
    if (wasActive) activeTabId = nextId;
    if (!tabs.size && hostWindow && !hostWindow.isDestroyed()) {
      activeTabId = createTab().id;
    }
    notifyStateChange();
  }

  function createTab() {
    if (!hostWindow || hostWindow.isDestroyed()) throw new Error("应用窗口已关闭");
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    const contents = view.webContents;
    const tab = {
      id: contents.id,
      view,
      contents,
      mediaKey: randomUUID(),
      loadError: "",
      captureGeneration: 0,
      takeoverGeneration: 0,
      pendingMedia: null,
    };
    tabs.set(tab.id, tab);
    mediaTabs.set(tab.mediaKey, tab);
    hostWindow.contentView.addChildView(view);

    contents.setWindowOpenHandler(({ url }) => {
      if (isWebAddress(url) && isLive(tab)) openInTab(tab, url);
      return { action: "deny" };
    });
    const denyNonWebNavigation = (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame && !isWebAddress(url)) event.preventDefault();
    };
    contents.on("will-navigate", denyNonWebNavigation);
    contents.on("will-redirect", denyNonWebNavigation);
    contents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame || !isLive(tab)) return;
      tab.loadError = "";
      tab.captureGeneration++;
      tab.takeoverGeneration++;
      notifyStateChange();
    });
    contents.on("did-navigate", () => {
      if (isLive(tab)) notifyStateChange();
    });
    contents.on("did-navigate-in-page", () => {
      if (!isLive(tab)) return;
      notifyStateChange();
      startPageWork(tab);
    });
    contents.on("page-title-updated", () => {
      if (isLive(tab)) notifyStateChange();
    });
    contents.on("did-start-loading", () => {
      if (isLive(tab)) notifyStateChange();
    });
    contents.on("did-stop-loading", () => {
      if (isLive(tab)) notifyStateChange();
    });
    contents.on("did-finish-load", () => {
      if (!isLive(tab)) return;
      notifyStateChange();
      startPageWork(tab);
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || !isLive(tab)) return;
      tab.takeoverGeneration++;
      cancelMediaDetection(tab, new Error(`媒体页面载入失败 ${code} ${description}`));
      if (code !== -3) tab.loadError = `${code} ${description}`;
      notifyStateChange();
    });
    contents.once("destroyed", () => handleDestroyed(tab));
    return tab;
  }

  function newTab() {
    const tab = createTab();
    activeTabId = tab.id;
    hostWindow.focus();
    if (getMode() === "browser") tab.contents.focus();
    notifyStateChange();
    return getState();
  }

  function activateTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.contents.isDestroyed()) throw new Error("标签页不存在");
    activeTabId = tabId;
    hostWindow.focus();
    if (getMode() === "browser") tab.contents.focus();
    notifyStateChange();
    return getState();
  }

  function closeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return getState();
    const ids = Array.from(tabs.keys());
    const index = ids.indexOf(tabId);
    const wasActive = activeTabId === tabId;
    const nextId = wasActive ? (ids[index + 1] || ids[index - 1] || 0) : activeTabId;

    tabs.delete(tabId);
    mediaTabs.delete(tab.mediaKey);
    tab.captureGeneration++;
    tab.takeoverGeneration++;
    cancelMediaDetection(tab, new Error("媒体检测已取消：标签页已关闭"));
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.contentView.removeChildView(tab.view);
    }
    if (!tab.contents.isDestroyed()) tab.contents.close({ waitForBeforeUnload: false });

    if (wasActive) activeTabId = nextId;
    if (!tabs.size) activeTabId = createTab().id;
    const next = activeTab();
    if (wasActive && next && getMode() === "browser") next.contents.focus();
    notifyStateChange();
    return getState();
  }

  function open(address) {
    const tab = activeTab();
    if (!tab) throw new Error("标签页不存在");
    return openInTab(tab, address);
  }

  async function openForMedia(address) {
    const url = normalizeAddress(address);
    const tab = activeTab();
    if (!tab) throw new Error("标签页不存在");
    cancelMediaDetection(tab, new Error("媒体检测已取消：导航已被替换"));
    hostWindow.focus();
    tab.takeoverGeneration++;
    const detection = new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimeout(() => {
        if (tab.pendingMedia === pending) {
          cancelMediaDetection(tab, new Error("媒体检测超时"));
        }
      }, 30000);
      tab.pendingMedia = pending;
    });
    try {
      const loading = tab.contents.loadURL(url);
      if (loading && loading.catch) {
        loading.catch((error) => cancelMediaDetection(tab, error));
      }
    } catch (error) {
      cancelMediaDetection(tab, error);
    }
    layout();
    return detection;
  }

  function action(action) {
    const tab = activeTab();
    if (!tab) return getState();
    if (action === "back" && tab.contents.navigationHistory.canGoBack()) {
      tab.contents.navigationHistory.goBack();
    } else if (action === "forward" && tab.contents.navigationHistory.canGoForward()) {
      tab.contents.navigationHistory.goForward();
    } else if (action === "reload") {
      tab.contents.reload();
    }
    return getState();
  }

  activeTabId = createTab().id;
  layout();

  return {
    open,
    openForMedia,
    getState,
    newTab,
    activateTab,
    closeTab,
    action,
    layout,
    fetchMedia: mediaProxy.fetchMedia,
    get session() {
      return siteSession;
    },
    get view() {
      const tab = activeTab();
      return tab ? tab.view : null;
    },
    get webContents() {
      const tab = activeTab();
      return tab ? tab.contents : null;
    },
  };
}

module.exports = { createBrowser, normalizeAddress, PARTITION, BROWSER_CHROME_HEIGHT };
