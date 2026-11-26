"use strict";

/**
 * 媒体清单改写：去掉流内广告，并把清单里的地址改成绝对地址。
 *
 * 纯函数：清单文本进、清单文本出（不碰网络、不读文件、不改入参）。
 * 代理层（media-proxy.js）拿它来改写上游取回的清单。
 *
 * 一、去广告。
 *
 * 形状来自真实站点抓下来的清单（test/fixtures/media/real-media-playlist.m3u8）：
 * 广告是一段插进来的分片，插在内容中间，靠
 *   `#EXT-X-DISCONTINUITY` + `#EXT-X-KEY:METHOD=NONE`
 * 夹住（广告没有加密，于是用 METHOD=NONE 断掉密钥状态），
 * 到下一个 `#EXT-X-DISCONTINUITY`（或清单结束）为止。
 * 这样的插入块在一份清单里出现三处。
 *
 * 只认这一种形状：真实站点的广告就长这样，没有依据的形状不猜
 * （docs/adr/0013：流内广告的规则要按真实站点定）。
 *
 * 时间轴上广告是插在内容之间的另一条轨：广告分片自己的 PTS 从 0 重新开始，
 * 而内容在广告前后是连续的（实测前后差 0.11s，就是一帧）。
 * 所以整块删掉之后内容的时间轴仍然是连续的，播放器不会卡。
 *
 * 另一种去法是删掉主清单里没人引用的 `#EXT-X-MEDIA` 轨（广告轨常常是这样插进来的）：
 * 没人引用它，删掉不影响播放。只在主清单里判：媒体清单里的轨是被主清单引用的，
 * 在那里判「没人引用」会误删。
 *
 * 二、地址改成绝对地址。
 *
 * 清单里的分片地址有相对路径，而原生 HLS 解析器按**清单自己的 URL** 解析相对路径
 * ——清单是经代理发出的，相对路径会指向错的地方（docs/adr/0012）。
 * 所以每个地址先按清单自己的地址解成绝对地址，再换成代理地址。
 *
 * 代理地址由调用方给（proxyUrl）：清单改写不知道代理长什么样，代理那边才知道。
 */

const DISCONTINUITY = "#EXT-X-DISCONTINUITY";
const KEY_NONE = "#EXT-X-KEY:METHOD=NONE";
const END_TAGS = ["#EXT-X-ENDLIST", "#EXT-X-END"];

/**
 * 一个地址按清单自己的地址解成绝对地址。解不了就原样返回（宁可留着也不丢）。
 * @param {string} uri
 * @param {string} baseUrl 清单自己的地址
 * @returns {string}
 */
function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch (e) {
    return uri;
  }
}

/**
 * 标签里的 URI="..." 指向什么：清单还是文件。
 *
 * `#EXT-X-MEDIA` 的 TYPE 说了算：音视频轨指向一份媒体清单，字幕轨指向一个字幕文件。
 * `#EXT-X-I-FRAME-STREAM-INF` 指向一份 I 帧清单。
 * `#EXT-X-KEY`（密钥）与 `#EXT-X-MAP`（初始化段）都是文件。
 *
 * @param {string} tag
 * @returns {"playlist"|"file"|null}
 */
function tagUriKind(tag) {
  if (tag.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) return "playlist";
  if (tag.startsWith("#EXT-X-MEDIA:")) {
    const type = /TYPE=([A-Z-]+)/.exec(tag);
    return type && (type[1] === "AUDIO" || type[1] === "VIDEO") ? "playlist" : "file";
  }
  if (tag.startsWith("#EXT-X-KEY:") || tag.startsWith("#EXT-X-MAP:")) return "file";
  return null;
}

/**
 * 这一行是广告插入块的开头吗。
 * @param {string[]} lines
 * @param {number} i
 * @returns {boolean}
 */
function startsAdRun(lines, i) {
  if (lines[i].trim() !== DISCONTINUITY) return false;
  const next = lines[i + 1];
  return !!next && next.trim().startsWith(KEY_NONE);
}

/**
 * 广告插入块的结尾：下一个 `#EXT-X-DISCONTINUITY`、清单结束，或文件尾。
 * @param {string[]} lines
 * @param {number} i 广告块开头（DISCONTINUITY 行）
 * @returns {number} 结尾所在行号（这一行也要去掉）
 */
function adRunEnd(lines, i) {
  for (let j = i + 2; j < lines.length; j++) {
    const line = lines[j].trim();
    if (line === DISCONTINUITY) return j;
    if (END_TAGS.includes(line)) return j - 1;
  }
  return lines.length - 1;
}

/**
 * 清单里被 `#EXT-X-STREAM-INF` 引用到的轨（GROUP-ID）。
 * @param {string[]} lines
 * @returns {Set<string>}
 */
function referencedGroups(lines) {
  const groups = new Set();
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    for (const m of line.matchAll(/(?:AUDIO|VIDEO|SUBTITLES|CLOSED-CAPTIONS)="([^"]*)"/g)) {
      groups.add(m[1]);
    }
  }
  return groups;
}

/**
 * 改写一份清单。
 *
 * @param {string} text 清单文本
 * @param {{baseUrl: string, proxyUrl: (absoluteUrl: string, kind: string) => string}} opts
 *   baseUrl：清单自己的地址（相对路径按它解析）
 *   proxyUrl：把绝对地址换成代理地址（kind：playlist/segment/file）
 * @returns {string} 改写后的清单文本
 */
function rewriteManifest(text, opts) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n/);
  // 主清单（有 STREAM-INF）才判得出「没人引用的轨」：媒体清单里的轨是被主清单引用的。
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF:"));
  const referenced = referencedGroups(lines);
  const out = [];
  let lastTag = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (startsAdRun(lines, i)) {
      const end = adRunEnd(lines, i);
      // 块里至少要有分片，否则不是广告插入块（别把正常内容吃掉）。
      const hasSegment = lines
        .slice(i + 2, end + 1)
        .some((l) => l.trim().startsWith("#EXTINF"));
      if (hasSegment) {
        i = end;
        continue;
      }
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const group = /GROUP-ID="([^"]*)"/.exec(line);
      // 主清单里没人引用、还带 URI 的轨：插进来的广告轨，删掉（不影响播放）。
      if (isMaster && group && !referenced.has(group[1]) && line.includes("URI=")) continue;
      out.push(rewriteTagUri(line, opts));
      lastTag = line.trim();
      continue;
    }

    if (line.startsWith("#")) {
      out.push(rewriteTagUri(line, opts));
      lastTag = line.trim();
      continue;
    }

    if (!line.trim()) {
      out.push(line);
      continue;
    }

    // 标签行之外的地址行：子清单（STREAM-INF 后面）或分片（EXTINF 后面）。
    const kind = lastTag.startsWith("#EXT-X-STREAM-INF:") ? "playlist" : "segment";
    out.push(opts.proxyUrl(resolveUri(line.trim(), opts.baseUrl), kind));
    lastTag = "";
  }

  return out.join(eol);
}

/**
 * 改写标签里的 URI="..." 属性。
 * @param {string} tag
 * @param {{baseUrl: string, proxyUrl: Function}} opts
 * @returns {string}
 */
function rewriteTagUri(tag, opts) {
  const kind = tagUriKind(tag);
  if (!kind) return tag;
  return tag.replace(/URI="([^"]*)"/g, (match, uri) => {
    if (!uri) return match;
    return `URI="${opts.proxyUrl(resolveUri(uri, opts.baseUrl), kind)}"`;
  });
}

module.exports = { rewriteManifest, resolveUri };
