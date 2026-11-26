// 两个函数都靠 executeJavaScript 整段注入，不能引用模块作用域里的名字。

function detectNativePlayer() {
  const videos = Array.from(document.querySelectorAll("video"));
  const index = videos.findIndex(
    (video) =>
      !video.hasAttribute("data-acuminata-native-player") &&
      !!video.currentSrc &&
      ["http:", "https:"].includes(new URL(video.currentSrc).protocol) &&
      !video.paused &&
      !video.ended &&
      video.currentTime > 0,
  );
  return index < 0 ? null : { index, src: videos[index].currentSrc };
}

/**
 * @param {{index:number, src:string, nativeSrc:string}} takeover
 */
function takeoverNativePlayer({ index, src, nativeSrc }) {
  const original = document.querySelectorAll("video")[index];
  if (!original || original.currentSrc !== src || !original.parentElement) return false;

  const rect = original.getBoundingClientRect();
  const muted = original.muted;
  const parent = original.parentElement;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

  // visibility 保留原元素的布局盒；移除 src 后 load 才会真正停止拉流。
  original.style.visibility = "hidden";
  original.pause();
  original.removeAttribute("src");
  for (const source of original.querySelectorAll("source")) source.removeAttribute("src");
  original.load();

  const native = document.createElement("video");
  native.setAttribute("data-acuminata-native-player", "");
  native.controls = true;
  native.autoplay = true;
  native.muted = muted;
  native.playsInline = true;
  native.src = nativeSrc;
  native.style.position = "absolute";
  native.style.left = `${original.offsetLeft}px`;
  native.style.top = `${original.offsetTop}px`;
  native.style.width = `${rect.width}px`;
  native.style.height = `${rect.height}px`;
  native.style.zIndex = "1";
  parent.insertBefore(native, original.nextSibling);
  const playing = native.play();
  if (playing) playing.catch(() => {});
  return true;
}

module.exports = { detectNativePlayer, takeoverNativePlayer };
