---
status: accepted
---

# 媒体资源在应用内经协议层改写，不靠页面脚本

去广告要改的是 manifest 本身（广告轨 `EXT-X-MEDIA`、广告切片、`EXT-X-DISCONTINUITY` 配对），而 manifest 是一个**响应体**。Chrome 扩展改不了响应体；Electron 的 `protocol.handle("https")` 可以。决定：媒体资源一律经应用内的协议层代理，站点页面与原生播放器拿到的是改写后的 manifest。

## Consequences

- **manifest 必须整份取**：Chromium 会带 `Range` 重新请求 manifest，代理转发时必须剥掉 `Range`，否则拿到的是半份 manifest（实测：剥掉后去广告改写才生效）。媒体分片相反，**必须保留 `Range`**，否则整个 59MB 分片一次性下载。
- **上游取回不能走 Chromium 的网络栈**。`net.fetch` 会再次进入 `webRequest`，于是「掐死站点播放器」的规则会连自己的代理一起掐掉（实测 `ERR_BLOCKED_BY_CLIENT`）。代理取上游走 Node 的 https，独立于 `webRequest`。
- **应用内代理用独立 host 标识**（如 `acuminata.local`），这样「我们发起的请求」与「站点发起的请求」在 URL 空间上可区分，站点自己的播放器才可能被单独掐掉，不误伤我们自己的播放。实现上用的是应用自己的 scheme（`acuminata://<作用域>/media/...`）：作用域 `site` 是站点页发起的，`app` 是 Acuminata 自己发起的。
- **只拦媒体请求，站点页的其余流量一点不动**。媒体请求经 `webRequest.onBeforeRequest` 重定向到应用自己的 scheme，其余请求仍走 Chromium 自己的网络栈——重定向、Cookie、POST 都还是站点页自己的行为（实测：走整站 `protocol.handle("https")` 的转发会把重定向后的 `Location` 丢掉，相对地址因此指错地方）。
- **manifest 里的 URI 改写必须是绝对 URL**。原生 HLS 解析器按 manifest 自身的 URL 解析相对路径，改成相对路径会指向错的地方（实测失败）；改成绝对 URL 后正常播放。
- **跨源播放要由代理补 CORS 头**（`Access-Control-Allow-Origin`），否则站点页与代理页之间取不到分片。
- Electron 42（Chromium 148）**原生支持 HLS**（`application/vnd.apple.mpegurl` 可播，fMP4 与 TS 分片均实测通过），不引入 hls.js 这类播放器库。
