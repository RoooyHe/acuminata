// @ts-check
/// <reference path="../shared/types.d.ts" />

(() => {
  const form = document.getElementById("browserAddressForm");
  const address = document.getElementById("browserAddress");
  const workspace = document.getElementById("agentWorkspace");
  const empty = document.getElementById("browserEmpty");
  const settings = document.getElementById("browserSettings");
  const error = document.getElementById("browserError");
  const back = document.getElementById("browserBack");
  const forward = document.getElementById("browserForward");
  const reload = document.getElementById("browserReload");
  const tabs = document.getElementById("browserTabs");
  const newTab = document.getElementById("browserNewTab");
  const historyButton = document.getElementById("browserHistory");

  /** @type {import("../shared/types").BrowserState} */
  let state = {
    mode: "browser",
    activeTabId: 0,
    tabs: [{
      id: 0,
      title: "新标签页",
      url: "",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      error: "",
    }],
  };

  function showError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function activeTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId);
  }

  function renderTabs() {
    const fragment = document.createDocumentFragment();
    for (const tab of state.tabs) {
      const item = document.createElement("div");
      item.className = `browser-tab${tab.id === state.activeTabId ? " active" : ""}`;

      const select = document.createElement("button");
      select.type = "button";
      select.className = "browser-tab-button";
      select.dataset.tabId = String(tab.id);
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === state.activeTabId));
      select.title = tab.title;
      select.textContent = tab.title;

      const close = document.createElement("button");
      close.type = "button";
      close.className = "browser-tab-close";
      close.dataset.closeTabId = String(tab.id);
      close.setAttribute("aria-label", `关闭 ${tab.title}`);
      close.textContent = "×";

      item.append(select, close);
      fragment.append(item);
    }
    tabs.replaceChildren(fragment);
  }

  /** @param {import("../shared/types").BrowserState} next */
  function render(next) {
    state = next;
    const active = activeTab();
    const inSettings = state.mode === "settings";
    renderTabs();
    workspace.hidden = !inSettings;
    empty.hidden = inSettings || !active || !!active.url;
    settings.setAttribute("aria-pressed", String(inSettings));
    settings.textContent = inSettings ? "关闭设置" : "设置";
    back.disabled = !active || !active.canGoBack;
    forward.disabled = !active || !active.canGoForward;
    reload.disabled = !active || !active.url;
    if (document.activeElement !== address) address.value = active ? active.url : "";
    showError(active ? active.error : "");
  }

  /** @param {Promise<import("../shared/types").BrowserState>} call */
  async function run(call, focusAddress = false) {
    try {
      render(await call);
      if (focusAddress) {
        address.focus();
        address.select();
      }
    } catch (e) {
      showError((e && e.message) || String(e));
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(window.electronAPI.navigateBrowser(address.value));
  });
  back.onclick = () => run(window.electronAPI.browserAction("back"));
  forward.onclick = () => run(window.electronAPI.browserAction("forward"));
  reload.onclick = () => run(window.electronAPI.browserAction("reload"));
  newTab.onclick = () => run(window.electronAPI.newBrowserTab(), true);
  settings.onclick = () => run(
    window.electronAPI.setBrowserMode(state.mode === "settings" ? "browser" : "settings"),
  );
  async function openHistory() {
    await run(window.electronAPI.setBrowserMode("settings"));
    if (state.mode === "settings") {
      document.querySelector('.nav-item[data-target="history"]').click();
    }
  }
  historyButton.onclick = openHistory;
  tabs.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close-tab-id]");
    if (close) {
      event.stopPropagation();
      run(window.electronAPI.closeBrowserTab(Number(close.dataset.closeTabId)));
      return;
    }
    const tab = event.target.closest("[data-tab-id]");
    if (tab) run(window.electronAPI.activateBrowserTab(Number(tab.dataset.tabId)));
  });
  address.addEventListener("input", () => showError(""));

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      address.focus();
      address.select();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "h") {
      event.preventDefault();
      openHistory();
    } else if (event.key === "Escape" && document.activeElement === address) {
      const active = activeTab();
      address.value = active ? active.url : "";
      showError(active ? active.error : "");
    }
  });

  window.electronAPI.onBrowserState(render);
  window.electronAPI.getBrowserState().then(render).catch((e) => {
    showError((e && e.message) || String(e));
  }).finally(() => address.focus());
})();
