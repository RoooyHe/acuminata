/**
 * 清单改写：真实清单进，改写后的清单出。
 * Run with: node test/media-manifest.test.js
 *
 * 夹具是从真实站点抓下来的清单（test/fixtures/media/）：
 * 广告是插在内容中间的一段分片，靠 `#EXT-X-DISCONTINUITY` +
 * `#EXT-X-KEY:METHOD=NONE` 夹住。这个文件里有三处这样的插入块。
 *
 * 这里只测改写本身（纯函数）：去广告、地址改绝对。
 * 代理那一层（取上游、Range、CORS）由 test/media-proxy.electron.js 测。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { rewriteManifest } = require("../media-manifest");
const { proxyUrl, parseProxyUrl, SCHEME, SCOPE_APP } = require("../media-proxy");

const MEDIA_KEY = "manifest-test-key";
const manifestProxyUrl = (upstream, kind) => proxyUrl(upstream, kind, SCOPE_APP, MEDIA_KEY);

const FIXTURES = path.join(__dirname, "fixtures", "media");
const PROXY = `${SCHEME}://${SCOPE_APP}/media`;

function countTag(text, tag) {
  return text.split(/\r?\n/).filter((l) => l.trim().startsWith(tag)).length;
}

function run() {
  console.log("Running media-manifest tests...\n");

  const media = fs.readFileSync(
    path.join(FIXTURES, "real-media-playlist.m3u8"),
    "utf8",
  );
  const master = fs.readFileSync(
    path.join(FIXTURES, "real-master-playlist.m3u8"),
    "utf8",
  );

  // 夹具本身：广告块是三处，每处六片。
  assert.strictEqual(countTag(media, "#EXTINF"), 1366, "夹具里的分片数不对");
  assert.strictEqual(countTag(media, "#EXT-X-DISCONTINUITY"), 5, "夹具里的不连续点不对");
  assert.strictEqual(countTag(media, "#EXT-X-KEY"), 3, "夹具里的密钥标记不对");
  assert.ok(
    media.includes("/20261119/scO5af3x/10137kb/hls/"),
    "夹具里没有广告分片的地址",
  );
  console.log("  ✓ 夹具是真实清单：三处广告块，每处六片");

  // 改写：去广告、地址改绝对。
  const rewritten = rewriteManifest(media, {
    baseUrl: "https://play.modujx17.com/20260928/aiXU3jsO/782kb/hls/index.m3u8",
    proxyUrl: manifestProxyUrl,
  });

  assert.strictEqual(countTag(rewritten, "#EXTINF"), 1348, "广告分片没去掉");
  assert.ok(
    !rewritten.includes("/20261119/scO5af3x/10137kb/hls/"),
    "广告分片的地址还在清单里",
  );
  assert.ok(
    !rewritten.includes("#EXT-X-KEY:METHOD=NONE"),
    "广告块的密钥标记还在清单里",
  );
  console.log("  ✓ 三处广告块（18 片）都去掉了");

  // 剩下的每个地址都是绝对地址，且指向代理。
  const uris = rewritten
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"));
  assert.strictEqual(uris.length, 1348, "剩下的分片数不对");
  for (const uri of uris) {
    assert.ok(uri.startsWith(PROXY), "分片地址不是绝对地址：" + uri);
  }
  console.log("  ✓ 剩下的 1348 个分片地址都是绝对地址（指向代理）");

  const firstSegment = parseProxyUrl(new URL(uris[0]));
  assert.strictEqual(firstSegment.mediaKey, MEDIA_KEY);
  assert.strictEqual(
    firstSegment.upstream,
    "https://bf.modujx17.com/20260928/aiXU3jsO/782kb/hls/m9J9Ig8H.ts",
    "代理地址里没装上游地址",
  );
  console.log("  ✓ 代理地址里装的是上游的绝对地址");

  // 主清单：变体地址也是绝对地址。
  const rewrittenMaster = rewriteManifest(master, {
    baseUrl: "https://play.modujx17.com/20260928/aiXU3jsO/index.m3u8",
    proxyUrl: manifestProxyUrl,
  });
  const variant = rewrittenMaster
    .split(/\r?\n/)
    .find((l) => l && !l.startsWith("#"));
  assert.ok(variant.startsWith(`${PROXY}/playlist/`), "变体地址不是绝对地址");
  const parsedVariant = parseProxyUrl(new URL(variant));
  assert.strictEqual(parsedVariant.mediaKey, MEDIA_KEY);
  assert.strictEqual(
    parsedVariant.upstream,
    "https://play.modujx17.com/20260928/aiXU3jsO/782kb/hls/index.m3u8",
    "代理地址里没装上游的变体地址",
  );
  console.log("  ✓ 主清单里的变体地址也改成了绝对地址");

  // 纯函数：同样的输入给同样的输出，入参不动。
  const again = rewriteManifest(media, {
    baseUrl: "https://play.modujx17.com/20260928/aiXU3jsO/782kb/hls/index.m3u8",
    proxyUrl: manifestProxyUrl,
  });
  assert.strictEqual(again, rewritten, "改写不是纯函数");
  assert.ok(media.includes("/20261119/scO5af3x/10137kb/hls/"), "入参被改了");
  console.log("  ✓ 纯函数：同样的输入同样的输出，入参不动");

  // 没有广告的清单：原样保留（只改地址）。
  const clean = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:4",
    "#EXTINF:2,",
    "a.ts",
    "#EXTINF:2,",
    "b.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const rewrittenClean = rewriteManifest(clean, {
    baseUrl: "https://cdn.example/hls/index.m3u8",
    proxyUrl: manifestProxyUrl,
  });
  assert.strictEqual(countTag(rewrittenClean, "#EXTINF"), 2, "正常清单的分片被吃了");
  assert.ok(rewrittenClean.includes("#EXT-X-ENDLIST"), "正常清单的结尾被吃了");
  console.log("  ✓ 没有广告块的清单：分片与结尾都在");

  // 主清单里没人引用的广告轨：去掉；被引用的音轨：留着（去掉就没声音了）。
  const masterPlaylist = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",URI="audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ad",NAME="广告",URI="ad.m3u8"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="session.key"',
    '#EXT-X-STREAM-INF:BANDWIDTH=782000,AUDIO="audio"',
    "v.m3u8",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  const rewrittenMasterPlaylist = rewriteManifest(masterPlaylist, {
    baseUrl: "https://cdn.example/hls/index.m3u8",
    proxyUrl: manifestProxyUrl,
  });
  assert.ok(!rewrittenMasterPlaylist.includes('GROUP-ID="ad"'), "主清单里的广告轨没去掉");
  assert.ok(rewrittenMasterPlaylist.includes('GROUP-ID="audio"'), "主清单里被引用的音轨被删了");
  assert.ok(
    rewrittenMasterPlaylist.includes(
      `URI="${proxyUrl("https://cdn.example/hls/session.key", "file", SCOPE_APP, MEDIA_KEY)}"`,
    ),
    "主清单里的会话密钥没有按文件地址改写",
  );
  console.log("  ✓ 主清单里没人引用的广告轨被去掉，被引用的音轨留着");

  console.log("\n✅ All media-manifest tests passed!");
}

run();
