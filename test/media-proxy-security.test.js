const assert = require("assert");
const http = require("http");
const {
  createMediaProxy,
  fetchUpstream,
  parseProxyUrl,
  proxyUrl,
  SCOPE_APP,
  SCOPE_SITE,
} = require("../media-proxy");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function fakeSession(cookieJar = {}) {
  return {
    cookies: {
      async get({ url }) {
        const values = cookieJar[new URL(url).origin] || {};
        return Object.entries(values).map(([name, value]) => ({ name, value }));
      },
    },
    webRequest: { onBeforeRequest() {} },
    protocol: { handle() {} },
  };
}

const MEDIA_KEY = "test-media-key";

function mediaProxy(referer, cookieJar) {
  return createMediaProxy({
    session: fakeSession(cookieJar),
    getMediaKey: (webContentsId) => webContentsId === 1 ? MEDIA_KEY : "",
    getReferer: (mediaKey) => mediaKey === MEDIA_KEY ? referer : null,
  });
}

function mediaRequest(upstream, kind = "file", headers, mediaKey = MEDIA_KEY) {
  return new Request(proxyUrl(upstream, kind, SCOPE_APP, mediaKey), { headers });
}

function playlistSegment(body) {
  const uri = body
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith("#"));
  return parseProxyUrl(new URL(uri)).upstream;
}

test("unknown media keys are rejected before DNS, including preflight", async () => {
  let hits = 0;
  const server = await listen((req, res) => {
    hits += 1;
    res.end("must not be fetched");
  });
  try {
    const proxy = mediaProxy(`${origin(server)}/player.html`);
    for (const method of ["GET", "OPTIONS"]) {
      const request = new Request(
        proxyUrl(`${origin(server)}/movie.mp4`, "file", SCOPE_APP, "revoked-key"),
        { method },
      );
      const response = await proxy.handle(request);
      assert.strictEqual(response.status, 410);
    }
    assert.strictEqual(hits, 0);
  } finally {
    await close(server);
  }
});

test("redirectMedia routes by requester contents and cancels unknown requesters", async () => {
  const keys = new Map([[11, "key-a"], [22, "key-b"]]);
  const proxy = createMediaProxy({
    session: fakeSession(),
    getMediaKey: (webContentsId) => keys.get(webContentsId) || "",
    getReferer: (mediaKey) => mediaKey ? "https://example.com/player" : null,
  });
  for (const [webContentsId, mediaKey] of keys) {
    const result = await new Promise((resolve) => proxy.redirectMedia({
      url: "https://cdn.example/media/index.m3u8",
      webContentsId,
    }, resolve));
    const parsed = parseProxyUrl(new URL(result.redirectURL));
    assert.strictEqual(parsed.scope, SCOPE_SITE);
    assert.strictEqual(parsed.mediaKey, mediaKey);
  }
  const cancelled = await new Promise((resolve) => proxy.redirectMedia({
    url: "https://cdn.example/media/index.m3u8",
    webContentsId: 999,
  }, resolve));
  assert.strictEqual(cancelled.cancel, true);
});

test("a public site Referer cannot fetch a literal loopback target", async () => {
  let hits = 0;
  const server = await listen((req, res) => {
    hits += 1;
    res.end("private response");
  });
  try {
    const proxy = mediaProxy("https://93.184.215.14/player.html");
    let blocked = false;
    try {
      await proxy.handle(mediaRequest(`${origin(server)}/secret.mp4`));
    } catch (error) {
      blocked = true;
    }
    assert.strictEqual(hits, 0, "the loopback upstream received a request");
    assert.ok(blocked, "the proxy returned the loopback response");
  } finally {
    await close(server);
  }
});

test("a public site Referer cannot fetch a hostname that resolves to loopback", async () => {
  let hits = 0;
  const server = await listen((req, res) => {
    hits += 1;
    res.end("private response");
  });
  try {
    const proxy = mediaProxy("https://93.184.215.14/player.html");
    let blocked = false;
    try {
      await proxy.handle(
        mediaRequest(`http://localhost:${server.address().port}/secret.mp4`),
      );
    } catch (error) {
      blocked = true;
    }
    assert.strictEqual(hits, 0, "the DNS-resolved loopback upstream received a request");
    assert.ok(blocked, "the proxy returned the DNS-resolved loopback response");
  } finally {
    await close(server);
  }
});

test("NAT64 private targets are blocked before header lookup", async () => {
  for (const address of ["64:ff9b::7f00:1", "64:ff9b:1::7f00:1"]) {
    await assert.rejects(
      fetchUpstream(`http://[${address}]/secret.mp4`, {
        getHeaders: async () => {
          throw new Error("getHeaders sentinel");
        },
      }),
      /Blocked private media proxy target:/,
    );
  }
});

test("a local site Referer still permits local media", async () => {
  const server = await listen((req, res) => res.end("local media"));
  try {
    const proxy = mediaProxy(`${origin(server)}/player.html`);
    const response = await proxy.handle(mediaRequest(`${origin(server)}/movie.mp4`));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(await response.text(), "local media");
  } finally {
    await close(server);
  }
});

test("a cross-origin redirect gets only the destination session cookie", async () => {
  const requests = { source: [], destination: [] };
  const destination = await listen((req, res) => {
    requests.destination.push(req.headers);
    res.writeHead(206, { "Content-Range": "bytes 1-3/6" });
    res.end("est");
  });
  const source = await listen((req, res) => {
    requests.source.push(req.headers);
    res.writeHead(302, { Location: `${origin(destination)}/media/movie.mp4` });
    res.end();
  });
  try {
    const sourceOrigin = origin(source);
    const destinationOrigin = origin(destination);
    const proxy = mediaProxy(`${sourceOrigin}/player.html`, {
      [sourceOrigin]: { source: "source-cookie" },
      [destinationOrigin]: { destination: "destination-cookie" },
    });
    const response = await proxy.handle(
      mediaRequest(`${sourceOrigin}/start.mp4`, "file", { Range: "bytes=1-3" }),
    );
    assert.strictEqual(await response.text(), "est");
    assert.strictEqual(requests.source[0].cookie, "source=source-cookie");
    assert.strictEqual(
      requests.destination[0].cookie,
      "destination=destination-cookie",
      "the redirect reused the source cookie instead of looking up the destination cookie",
    );
    assert.strictEqual(requests.destination[0].range, "bytes=1-3");
  } finally {
    await close(source);
    await close(destination);
  }
});

test("static redirect headers drop credentials and retain Range", async () => {
  let redirectedHeaders;
  const destination = await listen((req, res) => {
    redirectedHeaders = req.headers;
    res.end("destination");
  });
  const source = await listen((req, res) => {
    res.writeHead(302, { Location: `${origin(destination)}/final.mp4` });
    res.end();
  });
  try {
    const sourceOrigin = origin(source);
    const response = await fetchUpstream(`${sourceOrigin}/start.mp4`, {
      allowPrivate: true,
      headers: {
        Cookie: "source=cookie",
        Referer: `${sourceOrigin}/player.html`,
        Origin: sourceOrigin,
        "X-Test": "preserved",
      },
      range: "bytes=0-2",
    });
    assert.strictEqual(redirectedHeaders.cookie, undefined);
    assert.strictEqual(redirectedHeaders.referer, undefined);
    assert.strictEqual(redirectedHeaders.origin, undefined);
    assert.strictEqual(redirectedHeaders["x-test"], "preserved");
    assert.strictEqual(redirectedHeaders.range, "bytes=0-2");
    assert.strictEqual(response.finalUrl, `${origin(destination)}/final.mp4`);
  } finally {
    await close(source);
    await close(destination);
  }
});

test("a redirected playlist resolves segments against the final response URL", async () => {
  const requests = { source: 0, destination: 0 };
  const destination = await listen((req, res) => {
    requests.destination += 1;
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end("#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n");
  });
  const source = await listen((req, res) => {
    requests.source += 1;
    res.writeHead(302, { Location: `${origin(destination)}/nested/final.m3u8` });
    res.end();
  });
  try {
    const proxy = mediaProxy(`${origin(source)}/player.html`);
    const response = await proxy.handle(
      mediaRequest(`${origin(source)}/original/index.m3u8`, "playlist"),
    );
    assert.strictEqual(
      playlistSegment(await response.text()),
      `${origin(destination)}/nested/segment.ts`,
    );
    assert.deepStrictEqual(requests, { source: 1, destination: 1 });
  } finally {
    await close(source);
    await close(destination);
  }
});

test("manifest fallback reuses the redirected response and its final URL", async () => {
  const requests = { source: 0, destination: 0 };
  const destination = await listen((req, res) => {
    requests.destination += 1;
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    res.end("#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n");
  });
  const source = await listen((req, res) => {
    requests.source += 1;
    res.writeHead(302, { Location: `${origin(destination)}/nested/final` });
    res.end();
  });
  try {
    const proxy = mediaProxy(`${origin(source)}/player.html`);
    const response = await proxy.handle(
      mediaRequest(`${origin(source)}/original/segment`, "segment"),
    );
    assert.strictEqual(
      playlistSegment(await response.text()),
      `${origin(destination)}/nested/segment.ts`,
    );
    assert.deepStrictEqual(requests, { source: 1, destination: 1 });
  } finally {
    await close(source);
    await close(destination);
  }
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} media proxy security tests passed`);
  if (failures) process.exitCode = 1;
})();
