const fs = require("fs");
const http = require("http");
const path = require("path");
const { app, session, BrowserWindow, WebContentsView } = require("electron");
const {
  createMediaProxy,
  registerMediaScheme,
  parseProxyUrl,
  SCOPE_SITE,
} = require("../media-proxy");

const FIXTURES = path.join(__dirname, "fixtures", "media");
const TIMEOUT_MS = 60000;
const PARTITION = "persist:acuminata-media-test";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

registerMediaScheme();

function manifestUris(text) {
  return text.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}

function keyUri(text) {
  const match = text.match(/^#EXT-X-KEY:.*URI="([^"]+)"/m);
  return match && match[1];
}

async function fetchResource(contents, url, headers = {}) {
  return contents.executeJavaScript(`(async () => {
    const response = await fetch(${JSON.stringify(url)}, { headers: ${JSON.stringify(headers)} });
    return {
      status: response.status,
      text: await response.text(),
      cors: response.headers.get("access-control-allow-origin"),
      contentRange: response.headers.get("content-range"),
    };
  })()`);
}

async function playNative(contents, url) {
  return contents.executeJavaScript(`(async () => {
    const video = document.createElement("video");
    video.src = ${JSON.stringify(url)};
    video.muted = true;
    document.body.appendChild(video);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (video.readyState >= 1) {
        const result = {
          duration: video.duration,
          readyState: video.readyState,
          width: video.videoWidth,
          currentSrc: video.currentSrc,
          error: video.error && video.error.message,
        };
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { duration: 0, readyState: video.readyState, error: "timeout" };
  })()`);
}

async function main() {
  await app.whenReady();
  app.on("window-all-closed", () => {});

  const seg0 = fs.readFileSync(path.join(FIXTURES, "segment-0.ts"));
  const seg1 = fs.readFileSync(path.join(FIXTURES, "segment-1.ts"));
  const upstreamRequests = [];
  let origin = "";

  const server = http.createServer((req, res) => {
    upstreamRequests.push({
      path: req.url,
      range: req.headers.range || null,
      referer: req.headers.referer || null,
    });
    const page = /^\/(a|b)\/player$/.exec(req.url);
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<title>${page[1]}</title><body></body>`);
      return;
    }
    const master = /^\/(a|b)\/media\/master\.m3u8$/.exec(req.url);
    if (master) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nnested.m3u8\n");
      return;
    }
    const nested = /^\/(a|b)\/media\/nested\.m3u8$/.exec(req.url);
    if (nested) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end([
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        '#EXT-X-KEY:METHOD=AES-128,URI="key.key"',
        "#EXTINF:1,",
        "segment-0.ts",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"));
      return;
    }
    const play = /^\/(a|b)\/media\/play\.m3u8$/.exec(req.url);
    if (play) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end([
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:1",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:1.00000,",
        "segment-0.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXT-X-KEY:METHOD=NONE",
        "#EXTINF:3.00000,",
        "ad-0.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:1.00000,",
        "segment-1.ts",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"));
      return;
    }
    if (/\/(a|b)\/media\/key\.key$/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.alloc(16, 7));
      return;
    }
    if (/\/(a|b)\/media\/segment-[01]\.ts$/.test(req.url)) {
      const body = req.url.endsWith("segment-1.ts") ? seg1 : seg0;
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

  const siteSession = session.fromPartition(PARTITION);
  const contexts = new Map();
  const mediaKeys = new Map();
  const proxy = createMediaProxy({
    session: siteSession,
    getMediaKey(webContentsId) {
      const context = contexts.get(webContentsId);
      return context && !context.contents.isDestroyed() ? context.mediaKey : "";
    },
    getReferer(mediaKey) {
      const context = mediaKeys.get(mediaKey);
      return context && !context.contents.isDestroyed() ? context.contents.getURL() : null;
    },
  });

  const host = new BrowserWindow({ show: false, width: 1000, height: 700 });
  function addTab(name, mediaKey) {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    view.setBounds({ x: 0, y: 88, width: 1000, height: 612 });
    host.contentView.addChildView(view);
    const context = { contents: view.webContents, mediaKey, view };
    contexts.set(view.webContents.id, context);
    mediaKeys.set(mediaKey, context);
    return context;
  }
  function showOnly(context) {
    for (const entry of contexts.values()) entry.view.setVisible(entry === context);
  }

  const a = addTab("a", "media-key-a");
  const b = addTab("b", "media-key-b");
  await Promise.all([
    a.contents.loadURL(`${origin}/a/player`),
    b.contents.loadURL(`${origin}/b/player`),
  ]);

  showOnly(a);
  const masterA = await fetchResource(a.contents, `${origin}/a/media/master.m3u8`);
  showOnly(b);
  const masterB = await fetchResource(b.contents, `${origin}/b/media/master.m3u8`);
  const nestedUrlA = manifestUris(masterA.text)[0];
  const nestedUrlB = manifestUris(masterB.text)[0];
  const nestedA = await fetchResource(a.contents, nestedUrlA);
  showOnly(a);
  const nestedB = await fetchResource(b.contents, nestedUrlB);
  const segmentUrlA = manifestUris(nestedA.text)[0];
  const segmentUrlB = manifestUris(nestedB.text)[0];
  const keyUrlA = keyUri(nestedA.text);
  const keyUrlB = keyUri(nestedB.text);
  showOnly(b);
  const segmentA = await fetchResource(a.contents, segmentUrlA, { Range: "bytes=0-99" });
  const keyA = await fetchResource(a.contents, keyUrlA);
  showOnly(a);
  const segmentB = await fetchResource(b.contents, segmentUrlB, { Range: "bytes=100-199" });
  const keyB = await fetchResource(b.contents, keyUrlB);

  const playbackA = await playNative(a.contents, `${origin}/a/media/play.m3u8`);
  showOnly(b);
  const playbackB = await playNative(b.contents, `${origin}/b/media/play.m3u8`);

  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const parsed = {
    a: [nestedUrlA, segmentUrlA, keyUrlA].map((url) => parseProxyUrl(new URL(url))),
    b: [nestedUrlB, segmentUrlB, keyUrlB].map((url) => parseProxyUrl(new URL(url))),
  };
  for (const [name, urls] of Object.entries(parsed)) {
    expect(
      urls.every((entry) => entry && entry.scope === SCOPE_SITE && entry.mediaKey === `media-key-${name}`),
      `${name} nested resources lost scope or media key: ${JSON.stringify(urls)}`,
    );
  }
  expect(parsed.a[0].mediaKey !== parsed.b[0].mediaKey, "the two tabs shared a media key");
  expect(
    [masterA, masterB, nestedA, nestedB].every((response) => response.status === 200 && response.cors),
    "a root or nested manifest failed or lost CORS",
  );
  expect(
    segmentA.status === 206 && segmentB.status === 206 && segmentA.contentRange && segmentB.contentRange,
    "segment Range or Content-Range was not preserved",
  );
  expect(keyA.status === 200 && keyB.status === 200, "a rewritten key request failed");
  expect(!nestedA.text.includes("ad-0.ts") && !nestedB.text.includes("ad-0.ts"), "nested ad URI survived");
  expect(
    !upstreamRequests.some((request) => /\/(?:a|b)\/media\/ad-0\.ts$/.test(request.path)),
    "native playback requested an ad segment",
  );
  const nativeSegmentRequests = upstreamRequests.filter((entry) => /\/(?:a|b)\/media\/segment-[01]\.ts$/.test(entry.path));
  expect(
    nativeSegmentRequests.length > 0 && nativeSegmentRequests.every((entry) => entry.range),
    "a segment request lost Range",
  );
  for (const playback of [playbackA, playbackB]) {
    expect(!playback.error, "native playback failed: " + JSON.stringify(playback));
    expect(playback.duration > 0 && playback.width > 0, "native playback did not decode HLS");
  }

  for (const name of ["a", "b"]) {
    const pageUrl = `${origin}/${name}/player`;
    for (const resource of ["master.m3u8", "nested.m3u8", "segment-0.ts", "key.key", "play.m3u8", "segment-1.ts"]) {
      const requests = upstreamRequests.filter((entry) => entry.path === `/${name}/media/${resource}`);
      expect(requests.length > 0, `${name} ${resource} was never requested upstream`);
      expect(
        requests.every((entry) => entry.referer === pageUrl),
        `${name} ${resource} used another tab's Referer: ${JSON.stringify(requests)}`,
      );
    }
    const roots = upstreamRequests.filter((entry) => entry.path === `/${name}/media/master.m3u8`);
    expect(roots.every((entry) => entry.range === null), `${name} root manifest forwarded Range`);
  }

  const upstreamBeforeClose = upstreamRequests.length;
  contexts.delete(a.contents.id);
  mediaKeys.delete(a.mediaKey);
  host.contentView.removeChildView(a.view);
  a.contents.close({ waitForBeforeUnload: false });
  const stale = await proxy.handle(new Request(nestedUrlA));
  expect(stale.status === 410, "closed tab media key did not return 410");
  expect(upstreamRequests.length === upstreamBeforeClose, "stale media key reached upstream");

  const surviving = await fetchResource(b.contents, segmentUrlB, { Range: "bytes=200-299" });
  const playbackBAfterClose = await playNative(b.contents, `${origin}/b/media/play.m3u8`);
  expect(surviving.status === 206, "closing A prevented B's segment request");
  expect(
    !playbackBAfterClose.error && playbackBAfterClose.duration > 0 && playbackBAfterClose.width > 0,
    "closing A prevented B's native playback",
  );
  expect(
    upstreamRequests.filter((entry) => entry.path.startsWith("/b/media/")).every((entry) => entry.referer === `${origin}/b/player`),
    "B used a stale or cross-tab Referer after A closed",
  );

  server.close();
  host.destroy();
  if (failures.length) {
    console.error("MEDIA PROXY TEST FAILED");
    for (const failure of failures) console.error("  ✗ " + failure);
    console.error("upstream requests: " + JSON.stringify(upstreamRequests, null, 1));
    return 1;
  }

  console.log(
    `MEDIA PROXY TEST PASSED: two tab contexts kept root/nested/segment/key Referers; ` +
      `native HLS decoded, Range and CORS survived, and a closed key returned 410`,
  );
  return 0;
}

const watchdog = setTimeout(() => {
  console.error("MEDIA PROXY TEST FAILED: timed out after " + TIMEOUT_MS + "ms");
  app.exit(1);
}, TIMEOUT_MS);

main()
  .then((code) => {
    clearTimeout(watchdog);
    app.exit(code);
  })
  .catch((error) => {
    clearTimeout(watchdog);
    console.error("MEDIA PROXY TEST FAILED: " + (error && error.stack ? error.stack : error));
    app.exit(1);
  });
