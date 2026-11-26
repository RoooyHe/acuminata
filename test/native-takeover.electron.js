const fs = require("fs");
const http = require("http");
const path = require("path");
const { app } = require("electron");
const { createSitePage } = require("../site-page");
const { registerMediaScheme, parseProxyUrl } = require("../media-proxy");

const FIXTURES = path.join(__dirname, "fixtures", "media");
const TIMEOUT_MS = 60000;
const LATE_PLAYBACK_DELAY_MS = 11000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

registerMediaScheme();

async function main() {
  await app.whenReady();
  app.on("window-all-closed", () => {});

  const seg0 = fs.readFileSync(path.join(FIXTURES, "segment-0.ts"));
  const seg1 = fs.readFileSync(path.join(FIXTURES, "segment-1.ts"));
  const requests = [];
  let origin = "";

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/player.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html><head></head>
        <body style="margin: 20px">
          <video id="site-player" muted style="width: 480px; height: 270px">
            <source id="site-source" type="application/vnd.apple.mpegurl">
          </video>
          <script>
            const sitePlayer = document.getElementById("site-player");
            window.beforeNativeTakeover = null;
            function recordOriginalPlayback() {
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
              } else {
                setTimeout(recordOriginalPlayback, 10);
              }
            }
            setTimeout(() => {
              document.getElementById("site-source").src = "/watch";
              sitePlayer.load();
              sitePlayer.play();
              recordOriginalPlayback();
            }, ${LATE_PLAYBACK_DELAY_MS});
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

  const sitePage = createSitePage({
    getAdapters: () => [],
    getWatchlist: () => [],
    onVisit: () => null,
  });
  sitePage.open(`${origin}/player.html`);
  const win = sitePage.window;

  const loadDeadline = Date.now() + 20000;
  while (
    (!requests.includes("/playing") || win.webContents.isLoading()) &&
    Date.now() < loadDeadline
  ) {
    await sleep(50);
  }

  const after = await win.webContents.executeJavaScript(`(async () => {
    const original = document.getElementById("site-player");
    const read = () => {
      const native = Array.from(document.querySelectorAll("video")).find((v) => v !== original);
      const originalRect = original.getBoundingClientRect();
      const nativeRect = native && native.getBoundingClientRect();
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
        native: native ? {
          paused: native.paused,
          ended: native.ended,
          time: native.currentTime,
          src: native.src,
          controls: native.controls,
          muted: native.muted,
          error: native.error && native.error.message,
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

  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const sameRect = (a, b) =>
    !!a && !!b && ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 1);

  expect(before && !before.paused && before.time > 0, "original was not playing before takeover");
  expect(before && !before.error, "original playback failed: " + (before && before.error));
  expect(
    before && before.currentSrc === `${origin}/watch` && before.sourceAttribute === null,
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

  if (after.second.native) {
    const proxied = parseProxyUrl(new URL(after.second.native.src));
    expect(
      proxied && proxied.scope === "app" && proxied.upstream === `${origin}/watch`,
      "native player did not use the original currentSrc through app scope",
    );
  } else {
    failures.push("native player is missing after playback");
  }

  server.close();

  if (failures.length) {
    console.error("NATIVE TAKEOVER TEST FAILED");
    for (const failure of failures) console.error("  ✗ " + failure);
    console.error("before: " + JSON.stringify(before));
    console.error("after: " + JSON.stringify(after));
    console.error("requests: " + JSON.stringify(requests));
    return 1;
  }

  console.log(
    `NATIVE TAKEOVER TEST PASSED: original /watch paused and unloaded; ` +
      `native app player advanced ${(after.second.native.time - after.first.native.time).toFixed(2)}s ` +
      `in 0.40s at ${before.rect.width}x${before.rect.height}`,
  );
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
