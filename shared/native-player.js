// 两个函数都靠 executeJavaScript 整段注入，不能引用模块作用域里的名字。

function detectNativePlayer(allowPaused = false) {
  const videos = Array.from(document.querySelectorAll("video"));
  const eligible = (video) =>
    !video.hasAttribute("data-acuminata-native-player") &&
    !!video.currentSrc &&
    ["http:", "https:"].includes(new URL(video.currentSrc).protocol);
  const playing = videos.findIndex(
    (video) =>
      eligible(video) && !video.paused && !video.ended && video.currentTime > 0,
  );
  const loaded = allowPaused
    ? videos.findIndex((video) => eligible(video) && video.readyState >= 1)
    : -1;
  const index = playing >= 0 ? playing : loaded;
  return index < 0 ? null : { index, src: videos[index].currentSrc };
}

/**
 * @param {{index:number, src:string, nativeSrc:string,
 *          playback?:{hide?:string|string[], mount?:string|string[]}}} takeover
 */
function takeoverNativePlayer({ index, src, nativeSrc, playback }) {
  const original = document.querySelectorAll("video")[index];
  if (!original || original.currentSrc !== src || !original.parentElement) {
    return { ok: false, warning: "" };
  }

  let warning = "";
  let hideSelectors = [];
  let mountSelectors = [];
  if (playback !== undefined) {
    try {
      if (!playback || typeof playback !== "object" || Array.isArray(playback)) {
        throw new Error("playback 必须是对象");
      }
      const readSelectors = (value, name) => {
        if (value === undefined) return [];
        const selectors = Array.isArray(value) ? value : [value];
        if (selectors.some((selector) => typeof selector !== "string")) {
          throw new Error(`playback.${name} 必须是选择器字符串或字符串数组`);
        }
        for (const selector of selectors) document.querySelectorAll(selector);
        return selectors;
      };
      hideSelectors = readSelectors(playback.hide, "hide");
      mountSelectors = readSelectors(playback.mount, "mount");
    } catch (error) {
      warning = `播放规则无效，已使用通用接管: ${error.message}`;
      hideSelectors = [];
      mountSelectors = [];
    }
  }

  const rect = original.getBoundingClientRect();
  const muted = original.muted;
  const originalParent = original.parentElement;
  let parent = originalParent;
  let customMount = false;
  if (!warning) {
    for (const selector of mountSelectors) {
      const match = document.querySelector(selector);
      if (match) {
        parent = match;
        customMount = true;
        break;
      }
    }
  }
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  // visibility 保留原元素的布局盒；移除 src 后 load 才会真正停止拉流。
  original.style.visibility = "hidden";
  original.pause();
  original.removeAttribute("src");
  for (const source of original.querySelectorAll("source")) source.removeAttribute("src");
  original.load();
  for (const selector of hideSelectors) {
    for (const element of document.querySelectorAll(selector)) element.style.visibility = "hidden";
  }

  const native = document.createElement("video");
  native.setAttribute("data-acuminata-native-player", "");
  native.controls = true;
  native.autoplay = true;
  native.muted = muted;
  native.playsInline = true;
  native.src = nativeSrc;
  native.style.position = "absolute";
  if (customMount) {
    const mountRect = parent.getBoundingClientRect();
    native.style.left = `${rect.left - mountRect.left - parent.clientLeft + parent.scrollLeft}px`;
    native.style.top = `${rect.top - mountRect.top - parent.clientTop + parent.scrollTop}px`;
  } else {
    native.style.left = `${original.offsetLeft}px`;
    native.style.top = `${original.offsetTop}px`;
  }
  native.style.width = `${rect.width}px`;
  native.style.height = `${rect.height}px`;
  native.style.zIndex = "1";
  // hide 可以命中挂载点的祖先；显式 visible 防止原生结果被一起藏掉。
  if (playback !== undefined && !warning) native.style.visibility = "visible";
  if (customMount) parent.appendChild(native);
  else originalParent.insertBefore(native, original.nextSibling);
  const playing = native.play();
  if (playing) playing.catch(() => {});
  return { ok: true, warning };
}

module.exports = { detectNativePlayer, takeoverNativePlayer };
