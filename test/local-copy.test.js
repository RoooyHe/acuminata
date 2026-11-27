const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveMediaCopy } = require("../local-copy");
const { manifestReferences } = require("../media-manifest");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-local-copy-"));
const sourceUrl = "https://cdn.example/root";
const childUrl = "https://cdn.example/20260928/aiXU3jsO/782kb/hls/index.m3u8";
const segmentUrl = "https://cdn.example/20260928/aiXU3jsO/782kb/hls/segment-0.ts";
const adUrl = "https://cdn.example/20260928/aiXU3jsO/782kb/hls/ad.ts";
const keyUrl = "https://cdn.example/20260928/aiXU3jsO/782kb/hls/key.key";
const mapUrl = "https://cdn.example/20260928/aiXU3jsO/782kb/hls/init.mp4";
const master = fs.readFileSync(
  path.join(__dirname, "fixtures", "media", "real-master-playlist.m3u8"),
);
const realMedia = fs.readFileSync(
  path.join(__dirname, "fixtures", "media", "real-media-playlist.m3u8"),
);
const child = Buffer.from([
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="key.key"',
  '#EXT-X-MAP:URI="init.mp4"',
  "#EXTINF:1,",
  "segment-0.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-KEY:METHOD=NONE",
  "#EXTINF:3,",
  "ad.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:1,",
  "segment-0.ts",
  "#EXT-X-STREAM-INF:BANDWIDTH=1",
  sourceUrl,
  "#EXT-X-ENDLIST",
  "",
].join("\r\n"));
const bodies = new Map([
  [sourceUrl, master],
  [childUrl, child],
  [segmentUrl, Buffer.from([0, 255, 1, 2, 3, 128])],
  [adUrl, Buffer.from("raw-ad-segment")],
  [keyUrl, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])],
  [mapUrl, Buffer.from("raw-init-map")],
]);

function response(url) {
  const body = bodies.get(url);
  if (!body) return { status: 404, headers: {}, body: Buffer.alloc(0), finalUrl: url };
  const manifest = url === sourceUrl || url === childUrl;
  return {
    status: 200,
    headers: manifest && url === childUrl
      ? { "content-type": "application/vnd.apple.mpegurl; charset=utf-8" }
      : { "content-type": "application/octet-stream" },
    body,
    finalUrl: url,
  };
}

function archivedName(url, extension) {
  return crypto.createHash("sha256").update(url).digest("hex") + extension;
}

async function run() {
  const realRefs = manifestReferences(
    realMedia.toString("utf8"),
    "https://play.modujx17.com/20260928/aiXU3jsO/782kb/hls/index.m3u8",
  );
  assert.ok(realRefs.some((ref) =>
    ref.url === "https://play.modujx17.com/20261119/scO5af3x/10137kb/hls/vD6Yoytg.ts" &&
    ref.kind === "segment"
  ), "the real fixture's known ad-run URI is retained");

  const refs = manifestReferences(child.toString("utf8"), childUrl);
  assert.deepStrictEqual(refs, [
    { url: keyUrl, kind: "file" },
    { url: mapUrl, kind: "file" },
    { url: segmentUrl, kind: "segment" },
    { url: adUrl, kind: "segment" },
    { url: segmentUrl, kind: "segment" },
    { url: sourceUrl, kind: "playlist" },
  ], "references retain document order, ads, files and playlist cycles");

  const directory = path.join(tmpRoot, "work-1");
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return response(url);
  };
  const first = await saveMediaCopy({ sourceUrl, directory, fetch });
  assert.deepStrictEqual(first, { directory, sourceUrl, reused: false, fileCount: 6 });
  assert.deepStrictEqual(fs.readFileSync(path.join(directory, "index.m3u8")), master);
  assert.deepStrictEqual(
    fs.readFileSync(path.join(directory, "manifests", archivedName(childUrl, ".m3u8"))),
    child,
    "nested manifest bytes retain CRLF and the ad run",
  );
  for (const [url, folder, extension] of [
    [segmentUrl, "segments", ".ts"],
    [adUrl, "segments", ".ts"],
    [keyUrl, "files", ".key"],
    [mapUrl, "files", ".mp4"],
  ]) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(directory, folder, archivedName(url, extension))),
      bodies.get(url),
      `${url} was not archived byte for byte`,
    );
  }
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(directory, "source.json"), "utf8")),
    { sourceUrl },
  );
  assert.strictEqual(requests.filter((url) => url === sourceUrl).length, 1, "cycle refetched root");
  assert.strictEqual(requests.filter((url) => url === segmentUrl).length, 1, "duplicate segment refetched");
  assert.ok(requests.includes(adUrl), "ad segment was filtered out");

  const requestCount = requests.length;
  const second = await saveMediaCopy({
    sourceUrl: "https://changed.example/new-root",
    directory,
    fetch: async () => { throw new Error("an existing copy must not fetch"); },
  });
  assert.deepStrictEqual(second, { directory, sourceUrl, reused: true });
  assert.strictEqual(requests.length, requestCount);

  const repairDirectory = path.join(tmpRoot, "repair");
  fs.mkdirSync(repairDirectory, { recursive: true });
  fs.writeFileSync(path.join(repairDirectory, "keep.txt"), "preserve me");
  const repaired = await saveMediaCopy({ sourceUrl, directory: repairDirectory, fetch });
  assert.strictEqual(repaired.reused, false);
  assert.strictEqual(
    fs.readFileSync(path.join(repairDirectory, "keep.txt"), "utf8"),
    "preserve me",
    "repair deleted pre-existing files",
  );
  assert.deepStrictEqual(fs.readFileSync(path.join(repairDirectory, "index.m3u8")), master);
  assert.strictEqual(fs.existsSync(`${repairDirectory}.tmp`), false);

  const failedDirectory = path.join(tmpRoot, "failed");
  fs.mkdirSync(`${failedDirectory}.tmp`, { recursive: true });
  fs.writeFileSync(path.join(`${failedDirectory}.tmp`, "stale"), "stale");
  let fetchedAfterStaleCleanup = false;
  await assert.rejects(
    saveMediaCopy({
      sourceUrl,
      directory: failedDirectory,
      fetch: async (url) => {
        assert.strictEqual(fs.existsSync(path.join(`${failedDirectory}.tmp`, "stale")), false);
        fetchedAfterStaleCleanup = true;
        if (url === childUrl) return { status: 503, headers: {}, body: Buffer.from("no"), finalUrl: url };
        return response(url);
      },
    }),
    /503/,
  );
  assert.ok(fetchedAfterStaleCleanup);
  assert.strictEqual(fs.existsSync(failedDirectory), false);
  assert.strictEqual(fs.existsSync(`${failedDirectory}.tmp`), false, "failed fetch left temp files");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("local-copy: raw recursive archival, dedupe, reuse and cleanup passed");
}

run().catch((error) => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
