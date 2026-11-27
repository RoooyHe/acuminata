---
status: accepted
---

# 媒体资源经应用内代理改写，站点播放器被原生播放器接管

这是 ADR-0011 的后续决定。站点页由 Acuminata 承载之后，「去掉花活与广告」「用原生播放器接管」「把原流存到本地」三件事可以在一处落地，不必再与扩展通信。决定：**媒体资源一律经应用内的协议层代理改写**，站点自己的播放器被原生播放器接管。

## Consequences

- **接管 = 站点播放器停止播放 + 原生播放器播放同一份媒体资源**。站点播放器不删（页面仍是站点的页面），只是不再拉流；原生播放器盖在它原来的位置上。
- **代理取上游不能走 Chromium 的网络栈**（`net.fetch` 会再次进入 `webRequest`，把我们自己的代理连同站点播放器一起掐掉，实测 `ERR_BLOCKED_BY_CLIENT`）。取上游走 Node 的 https，并显式带上网点页的 `Referer` 与该站点的 Cookie。
- **manifest 必须整份取**（剥掉 `Range`），**分片必须保留 `Range`**（否则整个分片一次性下载，实测单个分片 59MB）。
- **manifest 里的 URI 改写成绝对 URL**：原生 HLS 解析器按 manifest 自身 URL 解析相对路径，改成相对路径会指错地方。
- **代理补 CORS 头**：跨源取分片需要 `Access-Control-Allow-Origin`。
- **Electron 42（Chromium 148）原生支持 HLS**，不引入 hls.js 这类播放器库。
- **广告是怎么插进来的，规则要按真实站点定**。`EXT-X-MEDIA`（带 URI 的广告轨/字幕轨）是已验证可去的一类；插播广告段（`EXT-X-CUE-OUT`/`CUE-IN`、`EXT-X-DISCONTINUITY` 配对、独立的广告 m3u8）在真实站点上的形状要抓下来再定规则，不能凭猜。
- **流内广告与页面花活是两回事**：流内在代理里改；页面花活（假播放按钮、浮层广告、强制分享弹窗）按平台写规则，落在适配器里（ADR-0003/0006）。原生播放器的隐藏与挂载规则使用适配器的 `playback.hide` 与 `playback.mount`，格式见 `docs/adapters/template.md`。
