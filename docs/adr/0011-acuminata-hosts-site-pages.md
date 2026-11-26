---
status: accepted
---

# Acuminata 自己承载站点页，扩展与本地 WS 全部删除

ADR-0001 把「扩展作为捕获层」当成前提，于是 Electron 只做聚合与推荐。现在这个前提被推翻：用户要的下一个能力是**在播放层接管**——去掉站点播放器与流内广告、用浏览器原生播放器播、把原流下载到本地。这三件事 Chrome 扩展做不到（MV3 的 `declarativeNetRequest` 不能改响应体，`chrome.webRequest` 已无阻塞式改写），而 Electron 能做到。决定：**Acuminata 自己加载这些站点页**，扩展与扩展↔桌面端的本地 WebSocket 一并删除。

## Consequences

- **捕获层与数据层同处一个进程**。扩展存在的那套「扩展用 `chrome.scripting.executeScript` 抽字段 → 经 WS 发回桌面 → 桌面判定」的三段式没有了；站点页在应用内加载，字段在应用内抽，判定仍只有一处（桌面端的写入路径，ADR-0002）。
- **`shared/page-collect.js` 的注入方式变了**：从 `chrome.scripting.executeScript` 改成应用内注入，函数本身与夹具测试不变（它本来就是自足的双模函数）。
- **用户在这些站点上改用 Acuminata 看**。Chrome 里的观看不再被记录。这是本决定最贵的一笔账，换来的是播放层可控。
- **Electron 没有 Widevine**。DRM 站点打不开，这一条与 ADR-0001 当时的判断一致，不因架构变更而改变。
- 依赖 ADR-0003（用户编写适配器）与 ADR-0006（按平台组织）：站点页的「花活」按平台写规则，而不是维护域名清单。
