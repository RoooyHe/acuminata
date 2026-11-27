const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { createBrowser } = require("../site-page");
const { loadAdapters } = require("../agent/adapters");
const { registerMediaScheme, parseProxyUrl } = require("../media-proxy");

const FIXTURES = path.join(__dirname, "fixtures", "media");
const TIMEOUT_MS = 180000;
const LATE_PLAYBACK_DELAY_MS = 11000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

registerMediaScheme();
// CI and unattended runs can be backgrounded; Chromium must not suspend the fixture's only video.
app.commandLine.appendSwitch("disable-background-media-suspend");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

async function checkScenario(sitePage, requests, scenario) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(`${scenario.name}: ${message}`);
  };
  const playingBefore = requests.filter((url) => url.startsWith("/playing")).length;
  sitePage.open(`${scenario.origin}${scenario.path}`);
  const contents = sitePage.webContents;
  sitePage.view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });

  const loadDeadline = Date.now() + 20000;
  while (
    (requests.filter((url) => url.startsWith("/playing")).length === playingBefore ||
      contents.isLoading()) &&
    Date.now() < loadDeadline
  ) {
    await sleep(50);
  }

  const after = await contents.executeJavaScript(`(async () => {
    const original = document.getElementById("site-player");
    const read = () => {
      const native = document.querySelector("video[data-acuminata-native-player]");
      const originalRect = original.getBoundingClientRect();
      const nativeRect = native && native.getBoundingClientRect();
      const thirdParty = document.getElementById("third-party");
      const thirdPartyToo = document.getElementById("third-party-too");
      return {
        originalConnected: original.isConnected,
        originalPaused: original.paused,
        originalTime: original.currentTime,
        originalCurrentSrc: original.currentSrc,
        originalReadyState: original.readyState,
        originalNetworkState: original.networkState,
        originalVisibility: getComputedStyle(original).visibility,
        originalRect: {
          x: originalRect.x, y: originalRect.y,
          width: originalRect.width, height: originalRect.height,
        },
        thirdPartyVisibility: thirdParty ? getComputedStyle(thirdParty).visibility : null,
        thirdPartyTooVisibility: thirdPartyToo ? getComputedStyle(thirdPartyToo).visibility : null,
        native: native ? {
          paused: native.paused,
          ended: native.ended,
          time: native.currentTime,
          src: native.src,
          controls: native.controls,
          muted: native.muted,
          error: native.error && native.error.message,
          parentId: native.parentElement.id,
          visibility: getComputedStyle(native).visibility,
          rect: {
            x: nativeRect.x, y: nativeRect.y,
            width: nativeRect.width, height: nativeRect.height,
          },
        } : null,
      };
    };
    const deadline = Date.now() + 20000;
    let first = read();
    while (Date.now() < deadline) {
      first = read();
      if (
        first.originalPaused && first.originalNetworkState === HTMLMediaElement.NETWORK_NO_SOURCE &&
        first.native && !first.native.paused && first.native.time > 0
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { before: window.beforeNativeTakeover, first, second: read() };
  })()`);
  const before = after.before;

  const sameRect = (a, b) =>
    !!a && !!b && ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 1);

  expect(before && !before.paused && before.time > 0, "original was not playing before takeover");
  expect(before && !before.error, "original playback failed: " + (before && before.error));
  expect(
    before && before.currentSrc === `${scenario.origin}/watch` && before.sourceAttribute === null,
    "resource did not come from currentSrc on an extensionless <source>: " + JSON.stringify(before),
  );
  expect(after.first.originalConnected, "original was removed from layout");
  expect(
    after.first.originalPaused &&
      after.first.originalReadyState === 0 &&
      after.first.originalNetworkState === 3,
    "original was not paused and unloaded",
  );
  expect(after.first.originalVisibility === "hidden", "original remains visible");
  expect(sameRect(before && before.rect, after.first.originalRect), "original layout box changed");
  expect(after.first.native && !after.first.native.error, "native playback failed");
  expect(after.first.native && !after.first.native.paused && !after.first.native.ended, "native player is not playing");
  expect(after.first.native && after.first.native.controls, "native controls are unavailable");
  expect(after.first.native && after.first.native.visibility === "visible", "native player is hidden");
  expect(
    after.first.native && before && after.first.native.muted === before.muted,
    "native muted state differs from the original",
  );
  expect(sameRect(before && before.rect, after.first.native && after.first.native.rect), "native geometry differs");
  expect(
    after.second.originalTime === after.first.originalTime,
    "original time advanced after takeover",
  );
  expect(
    after.second.native && after.second.native.time > after.first.native.time,
    "native time did not advance",
  );

  if (scenario.name === "adapter hide+mount") {
    expect(after.first.native && after.first.native.parentId === "native-mount", "native player did not use the first matching mount fallback");
    expect(after.first.thirdPartyVisibility === "hidden" && after.first.thirdPartyTooVisibility === "hidden", "adapter hide rule did not hide every matching element");
  } else {
    expect(after.first.native && after.first.native.parentId === "original-parent", "generic fallback did not use the original video parent");
    expect(after.first.thirdPartyVisibility !== "hidden", "generic fallback applied custom hiding");
  }

  if (scenario.name === "malformed playback") {
    expect(
      scenario.warnings.length === 1 &&
        scenario.warnings[0].file === "broken.json" &&
        typeof scenario.warnings[0].message === "string" &&
        scenario.warnings[0].message.length > 0,
      "invalid selector did not emit one adapter warning: " + JSON.stringify(scenario.warnings),
    );
  } else {
    expect(scenario.warnings.length === 0, "valid playback emitted a warning");
  }

  if (after.second.native) {
    const proxied = parseProxyUrl(new URL(after.second.native.src));
    expect(
      proxied && proxied.scope === "app" && proxied.mediaKey &&
        proxied.upstream === `${scenario.origin}/watch`,
      "native player did not use the original currentSrc through app scope",
    );
  } else {
    failures.push(`${scenario.name}: native player is missing after playback`);
  }

  if (failures.length) {
    console.error("before: " + JSON.stringify(before));
    console.error("after: " + JSON.stringify(after));
  }
  return { failures, after, before };
}

async function main() {
  await app.whenReady();
  app.on("window-all-closed", () => {});

  const seg0 = fs.readFileSync(path.join(FIXTURES, "segment-0.ts"));
  const seg1 = fs.readFileSync(path.join(FIXTURES, "segment-1.ts"));
  const requests = [];
  let origin = "";

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith("/player.html") || req.url.startsWith("/adapter.html")) {
      const custom = req.url.startsWith("/adapter.html");
      const delay = custom ? 0 : LATE_PLAYBACK_DELAY_MS;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><head></head>
        <body style="margin: 20px">
          ${custom ? `<div id="native-mount" class="MacPlayer" style="margin-left: 30px">
            <div id="original-parent" style="margin-left: 15px">` : `<div id="original-parent">`}
            <video id="site-player" muted style="width: 480px; height: 270px">
              <source id="site-source" type="application/vnd.apple.mpegurl">
            </video>
          </div>
          ${custom ? `<div id="third-party" class="dplayer">third-party player</div>
            <div id="third-party-too" class="artplayer">second third-party player</div>
          </div>
          <script>var maccms = {};</script>` : ""}
          <script>
            const sitePlayer = document.getElementById("site-player");
            window.beforeNativeTakeover = null;
            function recordOriginalPlayback() {
              if (window.beforeNativeTakeover) return;
              if (!sitePlayer.paused && sitePlayer.currentTime > 0) {
                const rect = sitePlayer.getBoundingClientRect();
                window.beforeNativeTakeover = {
                  paused: sitePlayer.paused,
                  time: sitePlayer.currentTime,
                  currentSrc: sitePlayer.currentSrc,
                  sourceAttribute: sitePlayer.getAttribute("src"),
                  muted: sitePlayer.muted,
                  error: sitePlayer.error && sitePlayer.error.message,
                  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                };
                fetch("/playing");
                clearInterval(playbackObserver);
              }
            }
            const playbackObserver = setInterval(recordOriginalPlayback, 1);
            setTimeout(() => {
              document.getElementById("site-source").src = "/watch";
              sitePlayer.load();
              sitePlayer.play();
              recordOriginalPlayback();
            }, ${delay});
          </script>
        </body></html>`);
      return;
    }
    if (req.url === "/playing") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/watch") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(
        [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:1",
          "#EXT-X-MEDIA-SEQUENCE:0",
          "#EXT-X-PLAYLIST-TYPE:VOD",
          "#EXTINF:1.00000,",
          `${origin}/segment-0.ts`,
          "#EXTINF:1.00000,",
          `${origin}/segment-1.ts`,
          "#EXT-X-ENDLIST",
          "",
        ].join("\n"),
      );
      return;
    }
    if (req.url === "/segment-0.ts" || req.url === "/segment-1.ts") {
      const body = req.url === "/segment-1.ts" ? seg1 : seg0;
      const range = req.headers.range;
      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "video/mp2t",
          "Content-Range": `bytes ${start}-${end}/${body.length}`,
          "Accept-Ranges": "bytes",
          "Content-Length": slice.length,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Accept-Ranges": "bytes",
        "Content-Length": body.length,
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  let adapters = [];
  let warnings = [];
  const hostWindow = new BrowserWindow({
    show: true,
    width: 1000,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const sitePage = createBrowser({
    hostWindow,
    getAdapters: () => adapters,
    getWatchlist: () => [],
    onVisit: () => null,
    onAdapterWarning: (file, message) => warnings.push({ file, message }),
  });
  hostWindow.on("resize", () => {
    if (!sitePage.view) return;
    const { width, height } = hostWindow.getContentBounds();
    sitePage.view.setBounds({ x: 0, y: 0, width, height });
  });

  const scenarios = [
    {
      name: "generic fallback",
      path: "/player.html",
      adapters: [],
    },
    {
      name: "adapter hide+mount",
      path: "/adapter.html",
      adapters: [
        ...loadAdapters(),
        {
          file: "unrelated.json",
          detect: { pageGlobal: "unrelatedplatform" },
          collect: [{ field: "broken", selector: "[", attr: "text" }],
        },
      ],
    },
    {
      name: "malformed playback",
      path: "/adapter.html?malformed=1",
      adapters: [{
        file: "broken.json",
        detect: { pageGlobal: "maccms" },
        playback: { hide: ["["], mount: ".MacPlayer" },
      }],
    },
  ];

  const failures = [];
  for (const scenario of scenarios) {
    adapters = scenario.adapters;
    warnings = [];
    Object.assign(scenario, { origin, warnings });
    const result = await checkScenario(sitePage, requests, scenario);
    failures.push(...result.failures);
    if (!result.failures.length) {
      console.log(
        `  ✓ ${scenario.name}: native app player advanced ` +
          `${(result.after.second.native.time - result.after.first.native.time).toFixed(2)}s ` +
          `in 0.40s at ${result.before.rect.width}x${result.before.rect.height}`,
      );
    }
  }

  const pending = sitePage.openForMedia(`${origin}/player.html?pending-close=1`);
  const pendingContents = sitePage.webContents;
  sitePage.newTab();
  const survivingContents = sitePage.webContents;
  sitePage.closeTab(pendingContents.id);
  await assert.rejects(pending, /已取消/);
  const destroyedDeadline = Date.now() + 5000;
  while (!pendingContents.isDestroyed() && Date.now() < destroyedDeadline) await sleep(50);
  if (pendingContents.isDestroyed() && !survivingContents.isDestroyed()) {
    console.log("  ✓ closing a tab rejects only its pending media detection");
  } else {
    failures.push("close cancellation: wrong contents was destroyed");
  }

  server.close();

  if (failures.length) {
    console.error("NATIVE TAKEOVER TEST FAILED");
    for (const failure of failures) console.error("  ✗ " + failure);
    console.error("requests: " + JSON.stringify(requests));
    return 1;
  }

  console.log("NATIVE TAKEOVER TEST PASSED: generic, adapter hide+mount, and malformed-selector fallback");
  return 0;
}

const watchdog = setTimeout(() => {
  console.error("NATIVE TAKEOVER TEST FAILED: timed out after " + TIMEOUT_MS + "ms");
  app.exit(1);
}, TIMEOUT_MS);

main()
  .then((code) => {
    clearTimeout(watchdog);
    app.exit(code);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error("NATIVE TAKEOVER TEST FAILED: " + (error && error.stack ? error.stack : error));
    app.exit(1);
  });
