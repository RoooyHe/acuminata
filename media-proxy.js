"use strict";

/**
 * 媒体代理：站点页里的媒体资源经这里改写（docs/adr/0012）。
 *
 * 站点页自己带着一套花哨播放器，它拉的媒体资源里有插播广告。
 * 代理把媒体请求接过来，改写完再交回去：
 *
 * 1. 清单整份取回。Chromium 拉清单时会带 `Range`（实测 `bytes=0-`），
 *    转发上游时把 `Range` 剥掉，拿到的是整份清单——半份清单改写不了。
 * 2. 清单改写：去掉流内广告，地址改成绝对地址（media-manifest.js）。
 * 3. 分片透传：`Range` 原样转发，上游的 `206` 与 `Content-Range` 原样回去。
 *
 * 拦截方式是 `webRequest.onBeforeRequest` 把媒体请求重定向到应用自己的 scheme
 * （`acuminata://`）：站点页的其余流量（页面、脚本、图片、XHR）根本不经过我们，
 * 重定向、Cookie、POST 这些行为一点不变——站点页是站点页，代理只管媒体。
 *
 * 上游取回走 Node 的 https，不走 Chromium 的网络栈：`net.fetch` 会再次进入
 * `webRequest`，于是「掐死站点播放器」的规则会连自己的代理一起掐掉
 * （docs/adr/0013，实测 ERR_BLOCKED_BY_CLIENT）。走 Node 的网络栈就没有这个问题，
 * 但要自己带上站点页的 Referer 与该站点的 Cookie。
 */

const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const { rewriteManifest } = require("./media-manifest");

/** 应用自己的 scheme：媒体请求被重定向到这里，与站点页的请求在 URL 空间上分得开。 */
const SCHEME = "acuminata";

/**
 * 代理地址里的作用域（host）：
 * - `site`：站点页自己的播放器发起的（经 webRequest 重定向进来）
 * - `app`：Acuminata 自己的播放器发起的
 *
 * 两者在 URL 空间上分得开，于是「掐死站点播放器」的规则只碰 site 一侧，
 * 不误伤我们自己的播放（ADR-0012）。
 */
const SCOPE_SITE = "site";
const SCOPE_APP = "app";

/** 清单的 MIME（RFC 8216）。 */
const MANIFEST_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
];

/** 媒体地址的形状：清单按后缀，分片也按后缀。 */
const MANIFEST_PATH = /\.(m3u8|m3u)$/i;
const SEGMENT_PATH = /\.(ts|m4s|m4v|mp4|m4a|aac|key|webm)$/i;

let schemeRegistered = false;

/**
 * 登记代理的 scheme。必须在 app ready 之前调用（Chromium 只认提前登记的 scheme）。
 * 登记两次没意义，第二次直接跳过。
 */
function registerMediaScheme() {
  if (schemeRegistered) return;
  // electron 只在这里用：模块本身在 node 里也能引（纯函数那一半不依赖它）。
  const { app, protocol } = require("electron");
  if (app.isReady()) {
    throw new Error(
      "媒体代理的 scheme 登记晚了：registerMediaScheme() 必须在 app ready 之前调用",
    );
  }
  schemeRegistered = true;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
}

/**
 * 这个地址是媒体资源吗。
 * @param {string} pathname
 * @returns {"playlist"|"segment"|null}
 */
function mediaKind(pathname) {
  if (MANIFEST_PATH.test(pathname)) return "playlist";
  if (SEGMENT_PATH.test(pathname)) return "segment";
  return null;
}

/**
 * 代理地址：把上游地址装进路径里，代理收到请求就知道该回哪儿。
 * @param {string} upstream 上游的绝对地址
 * @param {"playlist"|"segment"|"file"} kind
 * @param {"site"|"app"} [scope] 谁发起的
 * @returns {string}
 */
function proxyUrl(upstream, kind, scope = SCOPE_APP) {
  const encoded = Buffer.from(upstream, "utf8").toString("base64url");
  return `${SCHEME}://${scope}/media/${kind}/${encoded}`;
}

/**
 * 从代理地址里取回上游地址与作用域。
 *
 * 代理地址是 `acuminata://<scope>/media/<kind>/<上游地址的 base64url>`：
 * scope 是 host（scheme 是 standard 的，host 有意义），kind 与上游地址在路径里。
 *
 * @param {URL} url
 * @returns {{scope: string, kind: string, upstream: string}|null}
 */
function parseProxyUrl(url) {
  const m = url.pathname.match(/^\/media\/(playlist|segment|file)\/([^/]+)$/);
  if (!m) return null;
  return {
    scope: url.hostname || SCOPE_APP,
    kind: m[1],
    upstream: Buffer.from(m[2], "base64url").toString("utf8"),
  };
}

/** Node 的 BlockList 会让 IPv4 规则同时覆盖 IPv4-mapped IPv6。 */
const BLOCKED_ADDRESSES = new net.BlockList();
for (const [network, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
]) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, family);
}

function isBlockedAddress(address, family) {
  return BLOCKED_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function resolveUpstream(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported media proxy protocol: ${url.protocol}`);
  }
  const hostname = url.hostname.startsWith("[")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`No address for media proxy host: ${hostname}`);
  return addresses;
}

async function isPrivateReferer(urlStr) {
  try {
    const addresses = await resolveUpstream(new URL(urlStr));
    return addresses.every(({ address, family }) => isBlockedAddress(address, family));
  } catch (e) {
    return false;
  }
}

function stripRedirectCredentials(headers) {
  for (const key of Object.keys(headers)) {
    if (["cookie", "referer", "origin"].includes(key.toLowerCase())) delete headers[key];
  }
}

/**
 * 上游取回。用 Node 的网络栈（见文件头的说明）。
 * 每一跳都重新校验并解析地址，请求固定使用这次校验选中的 DNS 结果。
 * @param {string} urlStr
 * @param {{method?: string, headers?: Object, getHeaders?: (url: string) => Promise<Object>, range?: string, allowPrivate?: boolean}} [opts]
 * @returns {Promise<{status: number, headers: Object, body: Buffer, finalUrl: string}>}
 */
async function fetchUpstream(urlStr, opts = {}) {
  const {
    method = "GET",
    headers = {},
    getHeaders,
    range,
    allowPrivate = false,
  } = opts;
  const staticHeaders = { ...headers };
  let url = new URL(urlStr);

  while (true) {
    const addresses = await resolveUpstream(url);
    if (
      !allowPrivate &&
      addresses.some(({ address, family }) => isBlockedAddress(address, family))
    ) {
      throw new Error(`Blocked private media proxy target: ${url.hostname}`);
    }
    const selected = addresses[0];
    const pinnedLookup = (_hostname, options, cb) => {
      if (options.all) cb(null, [selected]);
      else cb(null, selected.address, selected.family);
    };
    const requestHeaders = getHeaders ? await getHeaders(url.href) : { ...staticHeaders };
    if (range) requestHeaders.range = range;
    const mod = url.protocol === "https:" ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = mod.request(url, { method, headers: requestHeaders, lookup: pinnedLookup }, resolve);
      req.on("error", reject);
      req.end();
    });

    const redirect = [301, 302, 303, 307, 308].includes(res.statusCode);
    if (redirect && res.headers.location) {
      res.resume();
      const nextUrl = new URL(res.headers.location, url);
      if (!getHeaders && nextUrl.origin !== url.origin) {
        stripRedirectCredentials(staticHeaders);
      }
      url = nextUrl;
      continue;
    }

    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    return { status: res.statusCode, headers: res.headers, body, finalUrl: url.href };
  }
}

/**
 * 上游这份是不是清单。
 * @param {Object} headers 上游响应头
 * @returns {boolean}
 */
function isManifestResponse(headers) {
  const type = String(headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  return MANIFEST_TYPES.includes(type);
}

/**
 * 发给渲染进程的响应头：上游的头 + 跨源播放要有的 CORS 头。
 * @param {Object} headers
 * @param {string} origin 渲染进程的来源（站点页的来源）
 * @returns {Object}
 */
function responseHeaders(headers, origin) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // 会话的网络栈解了 gzip，这里不能再声明编码。
    if (lower === "content-encoding" || lower === "content-length") continue;
    if (lower === "access-control-allow-origin") continue;
    if (lower === "access-control-allow-credentials") continue;
    out[key] = value;
  }
  // 有来源就照抄来源（带凭据的请求只认具体来源，不认 `*`）；没有来源就用 `*`。
  out["Access-Control-Allow-Origin"] = origin || "*";
  if (origin) out["Access-Control-Allow-Credentials"] = "true";
  out["Access-Control-Expose-Headers"] = "Content-Length,Content-Range,Accept-Ranges";
  return out;
}

/**
 * 建一个媒体代理，挂到站点页所在的会话上。
 *
 * @param {{session: Object, getReferer?: () => string}} opts
 *   session：站点页所在的会话
 *   getReferer：站点页的地址（上游要看到它，否则按盗链拒）
 * @returns {{handle: Function, proxyUrl: Function, redirectMedia: Function}}
 */
function createMediaProxy({ session, getReferer }) {
  const referer = () => (getReferer ? getReferer() : "");

  /**
   * 发给上游的头：站点页的 Referer 与该站点的 Cookie。
   * @param {string} upstreamUrl
   * @returns {Promise<Object>}
   */
  async function upstreamHeaders(upstreamUrl, pageUrl) {
    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Acuminata",
      "accept-encoding": "identity",
    };
    const ref = pageUrl || referer();
    if (ref) headers.referer = ref;
    try {
      const cookies = await session.cookies.get({ url: upstreamUrl });
      if (cookies.length) {
        headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    } catch (e) {
      /* 取不到 Cookie 就不要了 */
    }
    return headers;
  }

  function rewritePlaylistResponse(res, requestOrigin, scope) {
    const rewritten = rewriteManifest(res.body.toString("utf8"), {
      baseUrl: res.finalUrl,
      proxyUrl: (absoluteUrl, kind) => proxyUrl(absoluteUrl, kind, scope),
    });
    return new Response(rewritten, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        ...responseHeaders({}, requestOrigin),
      },
    });
  }

  /**
   * 取一份清单并改写。改写出来的地址带上同一个作用域：
   * 站点页的清单指向 site 一侧，我们自己的清单指向 app 一侧。
   * @param {string} upstreamUrl
   * @param {string} requestOrigin
   * @param {string} scope
   * @returns {Promise<Response>}
   */
  async function servePlaylist(upstreamUrl, requestOrigin, scope) {
    // 清单整份取：上游不接受 Range 时（206）改写不了，这里只发不带 Range 的请求。
    const res = await fetchUpstream(upstreamUrl, {
      getHeaders: upstreamHeaders,
      allowPrivate: await isPrivateReferer(referer()),
    });
    return rewritePlaylistResponse(res, requestOrigin, scope);
  }

  /**
   * 透传一个媒体文件：Range 照发，上游的 206 与 Content-Range 照回。
   * @param {string} upstreamUrl
   * @param {string} range 渲染进程给的 Range
   * @param {string} requestOrigin
   * @param {boolean} [allowManifestFallback] 上游说是清单时按清单改写
   * @returns {Promise<Response>}
   */
  async function serveMedia(upstreamUrl, range, requestOrigin, allowManifestFallback, scope) {
    const res = await fetchUpstream(upstreamUrl, {
      getHeaders: upstreamHeaders,
      range,
      allowPrivate: await isPrivateReferer(referer()),
    });
    if (allowManifestFallback && isManifestResponse(res.headers)) {
      // 上游说是清单（地址后缀不像），照样按清单改写。
      return rewritePlaylistResponse(res, requestOrigin, scope);
    }
    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders(res.headers, requestOrigin),
    });
  }

  async function fetchMedia(url, pageUrl) {
    return fetchUpstream(url, {
      getHeaders: (upstreamUrl) => upstreamHeaders(upstreamUrl, pageUrl),
      allowPrivate: await isPrivateReferer(pageUrl || referer()),
    });
  }

  /**
   * scheme 的处理器：媒体请求到这里，按地址里的 kind 决定改写还是透传。
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async function handle(request) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get("origin") || "";
    const parsed = parseProxyUrl(url);
    if (!parsed) return new Response("not found", { status: 404 });
    if (request.method === "OPTIONS") {
      // 跨源播放要过的预检：放行方法与头，别的交给真正的请求。
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": requestOrigin || "*",
          "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
          "Access-Control-Allow-Headers": "Range,Content-Type",
          "Access-Control-Max-Age": "86400",
          ...(requestOrigin ? { "Access-Control-Allow-Credentials": "true" } : {}),
        },
      });
    }
    if (parsed.kind === "playlist") {
      return servePlaylist(parsed.upstream, requestOrigin, parsed.scope);
    }
    // 分片（可能地址后缀不像的清单）与文件（密钥、初始化段）都按字节透传。
    return serveMedia(
      parsed.upstream,
      request.headers.get("range"),
      requestOrigin,
      parsed.kind === "segment",
      parsed.scope,
    );
  }

  /**
   * 把站点的媒体请求重定向到代理。站点的其余请求原样放行。
   * @param {Object} details webRequest 的请求详情
   * @param {Function} cb
   */
  function redirectMedia(details, cb) {
    let url;
    try {
      url = new URL(details.url);
    } catch (e) {
      cb({});
      return;
    }
    const kind = mediaKind(url.pathname);
    if (!kind) {
      cb({});
      return;
    }
    cb({ redirectURL: proxyUrl(url.href, kind, SCOPE_SITE) });
  }

  session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, redirectMedia);
  session.protocol.handle(SCHEME, handle);

  return { handle, proxyUrl, redirectMedia, fetchMedia };
}

module.exports = {
  createMediaProxy,
  registerMediaScheme,
  proxyUrl,
  parseProxyUrl,
  mediaKind,
  fetchUpstream,
  isManifestResponse,
  SCHEME,
  SCOPE_SITE,
  SCOPE_APP,
};
