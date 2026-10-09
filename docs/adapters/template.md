# 适配器模板

一个适配器 = 一个 JSON 文件 = 一个平台（含它的镜像）。放在 `adapters/` 下。
范例就是内置的那个：`adapters/maccms.json`。

> 加载目录、以及在程序启动时接上，是 `agent/adapters.js` 的 `loadAdapters()`；`RecordStore` 启动时读一次，写入路径与推给扩展的那一份是同一份（见下面「实现状态」）。

适配器由**用户**编写，Acuminata 只定义这个格式——除了内置的平台适配器：MacCMS 也是 `adapters/maccms.json` 里的一个普通文件，与用户写的**同一种格式、同一条管道**，没有特权路径（`docs/adr/0006-adapters-by-platform.md`）。

## 为什么是 JSON 而不是脚本

产物必须是**文本，且能被人肉眼检验**（见 `docs/adr/0003-user-authored-adapters.md`）。JSON + 正则满足这一点，还能安全地被分享。任意的 JS 解析器更强大，但它无法被检验，且导入他人适配器就等于执行他人的代码。

如果将来真的出现这个格式表达不了的站点，再加一个可选的 `parse.js` 逃生口。**先不加。**

## 形状

```json
{
  "name": "某平台",
  "detect": { "pageGlobal": "maccms" },

  "collect": [
    { "field": "codeFromDom", "selector": "span.video-code", "attr": "text" },
    { "field": "duration",    "selector": "meta[itemprop='duration']", "attr": "content" },
    { "field": "tags",        "selector": "a.tag", "attr": "text", "many": true }
  ],

  "parse": {
    "code": {
      "from": ["codeFromDom", "url", "title"],
      "regex": "(?:^|[/\\s\\-])(?<code>[A-Za-z]{2,6}-?\\d{2,5})(?=[/\\s\\-]|$)"
    },
    "edition": {
      "from": ["title"],
      "regex": "(?<edition>中文字幕|无码|4K|高清|HD)"
    },
    "episode": {
      "from": ["title"],
      "regex": "第\\s*(?<episode>\\d+)\\s*集"
    }
  }
}
```

## 字段说明

| 键 | 必需 | 作用 |
|---|---|---|
| `detect` | ✅ | **页面签名**，如 `{"pageGlobal":"maccms"}`。适配器按平台组织，不按域名 |
| `domains` | | 可选的快速匹配域名。**尚未被读取**——检测只看签名（ADR-0006） |
| `name` | | 适配器名（平台名） |
| `collect` | | **可选。** 从页面 DOM 抽取具名字段。没有它，就只能用内置的五个字段 |
| `parse` | | 从具名字段里用正则取出身份字段 |
| `list` | | **可选。** 声明列表页（最新更新 / 分类 / 演员 / 系列），它们产出候选 |

### 平台级适配器只能依赖主题无关的东西

一个适配器要盖住成百上千个站，而**每个站的路由、主题、class 名、分页形状、懒加载属性都不一样**。实测两个 MacCMS 站：

| | `mgtvtv.com` | `aiqiyi.ai` |
|---|---|---|
| 平台签名 | `var maccms=` | `var maccms=` **同** |
| 主题 | `/template/mxpro/`（Tailwind + Element Plus） | `/template/a_0012/`（Bootstrap + ewave） |
| 作品页路由 | `/tv/{id}/` | `/voddetail/{id}.html` |
| 列表页路由 | `/show/{type}-{page}/` | `/vodshow/{type}-----------{page}.html` |
| 条目选择器 | `a.video-item` | `.pic` / `.img-wrapper` / `.ranking-item` |
| 封面怎么取 | `img@src` | **`img@data-original`**（`src` 是占位 gif） |
| 封面路径形状 | `/upload/vod/{date}-{n}/{hash}.webp` | **一样** |

所以：

**1. 选择器和属性都写有序备选列表。** 与 `parse.*.from` 是同一个概念——有序备选，第一个命中的胜出。

```jsonc
"item": ["a.video-item", ".ranking-item a", ".pic > a"],
"collect": [
  { "field": "cover", "selector": ["img"], "attr": ["data-original", "data-src", "src"] }
]
```

**2. 优先锚在 URL/属性模式上，不锚在 class 上。** `img[src*='/upload/vod/']` 跨主题有效；`img.el-image__inner` 换个主题就废。

**3. 需要时可按标签文本定位。** MacCMS 自己的字段标签（`主演：`、`导演：`、`年份：`）是跨主题共享的，而它们包着的 class 不是：

```jsonc
{ "field": "actor", "selector": { "label": "主演" }, "attr": "a@text", "many": true }
```

**4. 可用的主题无关来源（两个站均实测存在）：**

- 全局变量 `var maccms={...}`
- `meta[name=keywords]`、`meta[name=description]`（均为逐片内容，非栏目泛文）
- URL 路由族（有限且已知）
- 封面图的**路径形状**

参考站上实测**不存在** `og:image`。不要假设 `og:*` 一定在。

### `collect` —— 只有第 2 种站才需要

| 键 | 说明 |
|---|---|
| `field` | 抽出来的字段叫什么。这个名字会进入 `parse.*.from` 的命名空间 |
| `selector` | CSS 选择器 |
| `attr` | `text`、`html`，或任意 HTML 属性名（`content`、`href`、`src` …） |
| `many` | `true` 时返回数组（标签、演员这类多值字段） |

`collect` 里的**每个字段都必须被持久化**——见下面的「重跑」。

### `parse` —— 两种站写法完全相同

| 键 | 说明 |
|---|---|
| `from` | **有序**字段名列表。内置字段：`url` `title` `description` `ogImage` `favIconUrl`；其余由 `collect` 声明 |
| `regex` | 必须包含一个**命名捕获组**，组名与字段名一致 |

「字段」是一个字符串，与「来源 (Source)」不是一回事——别混用。

按 `from` 的顺序逐个尝试，**第一个命中的胜出**。全部未命中 → 该字段为 `null`。

`code` 是身份字段的**名字**，不是身份的类型。它的值可以由任何字段推导出来：

- 番号站：从标题里抠出 `ABC-123`
- 没有番号的剧集站：从封面图 URL 里抠出内容哈希 `c0a55b31c915cab3d80e9863f54f2ee0`

适配器不同，管道完全一样。

## 列表页（`list`）——候选的来源

站点并不提供推荐，但提供**列表页**：最新更新、分类、演员、系列。用户就是在那里发现自己想看的东西。适配器声明这些页，程序从这里产出候选。

```jsonc
"list": [
  {
    "name": "最新更新",
    "url":  "https://example.com/latest",
    "item": "div.thumb",
    "collect": [
      { "field": "url",   "selector": "a",   "attr": "href" },
      { "field": "title", "selector": "img", "attr": "alt" },
      { "field": "cover", "selector": "img", "attr": "src" }
    ]
  }
]
```

| 键 | 说明 |
|---|---|
| `url` | 列表页地址。数组里可以放多个列表页 |
| `pageUrl` | 可选。分页模板，`{page}` 会被替换。参考站是 `https://www.mgtvtv.com/show/2-{page}/`，共 468 页 |
| `item` | 每个条目的选择器 |
| `collect` | 在**单个条目**内抽字段。规则与页面级 `collect` 完全相同 |

`selector` 写空串 `""` 表示**条目元素自己**（常用于取条目链接的 `href`）。

**条目抽完之后，顶层的 `parse` 原样再跑一遍。** 所以 `parse.code.from: ["title", "url"]` 对作品页和列表条目是同一段代码——一个适配器，三处复用（解析访问、抽取候选、采集字段）。

条目里声明的 `url` / `title` 会覆盖内置的同名字段。这是故意的：条目自己的地址和标题才是要解析的东西。

**列表页有三个角色，适配器必须能区分：**

1. **不要记录为一次访问**——你手动翻最新更新，那不是一部作品（今天靠 `regexFilter` 丢弃，位置是错的）
2. **要被抓取**——它产出候选
3. **没有内容编号**——它本身不是作品

## 失败语义

**解析失败必须降级，不能丢弃。**

| 情况 | 行为 |
|---|---|
| `code` 抽到了 | 归入该作品 |
| `code` 为 `null` | **照常记录**，退化为「同站点 + 同路径」的旧身份（`RecordStore.recordVisit` 的同组同路径去重）。历史一条不少 |
| 适配器整体失效（连续多日零命中） | 在 UI 上报「适配器可能已失效」。**静默失效是用户编写适配器模式的头号故障** |

今天 `agent/record-store.js` 的写入路径（`recordVisit`）在闸门不匹配时 `return { action: "drop" }` —— 那对「过滤器」是对的，对「解析器」是静默丢历史。必须改。

## 重跑

适配器会因为站点改版而失效。用户修好适配器后，**历史记录必须能被重新解析**，否则每修一次只有新记录受益。

这要求 `parse` 是**已存原始字段的纯函数**：

- 内置字段（`url` / `title` / `description` / `ogImage` / `favIconUrl`）今天已经存在 `records` 里 ✅
- 扩展回传的采集结果存在 `records.pageSignature`（页面签名）与 `records.pageFields`（各适配器 collect 的字段）里 ✅

`WorkStore.reparseWorks()` 是一次**显式操作**：清空作品的派生结果
（`workId` / `works` / `work_keys` / `work_ambiguities`），再把每条已有访问交给与实时
上报同一条 `identityKeysFor → recordWorkVisit` 通道重算——没有第二套解析。
界面上是作品视图的「重新解析历史」按钮，IPC 是 `works:reparse`。

重跑是**全历史**：已归属的访问也按当前适配器重算（不只是未归属的）。
作品代理键会重生成，但分组、分数、身份键与存的原始字段都不变（幂等）。
漏掉这一条，「用户自己写适配器」这个模式的另一半价值（修一次，全历史受益）就没了。

## 归一化不属于适配器

`ABC-123` / `ABC123` / `abc-0123` 必须归到同一个作品。这个归一化**必须由程序统一实现，不能让每个适配器各写一遍**——否则同一个编号在不同适配器下得到不同结果，`works` 表会碎掉。

适配器只负责「把编号从噪声里抠出来」。抠出来之后的形状，程序说了算。

## 实现状态

这个格式由 `agent/adapter.js`（解析 + 组合）、`agent/adapters.js`（加载）、
`shared/page-collect.js`（detect / collect，要 DOM 的那一半）读，
`agent/adapter.test.js` 用真实抓下来的页面夹具验证。

| 已读 | 未读（写了但没人读，别用） |
|---|---|
| `detect.pageGlobal`、`collect`（含 `many`、选择器/属性有序备选）、`parse`（`from` / 命名捕获组） | `domains`、`{label:"主演"}` 与 `attr:"a@text"`（按标签文本定位）、`list` 列表页 |

`loadAdapters()` 能读 `adapters/` 目录（内置与用户写在同一个目录、同一段代码，没有特权路径），
`RecordStore` 启动时读一次，交给两处：

- **写入路径**（`agent/cluster.js` 的 `identityKeysFor`）：认平台 → `parse` → 作品身份键
- **扩展**（`init` 消息推过去）：拿它去页面上 `collect`

detect 与 collect 要 DOM，所以住在 `shared/page-collect.js`：扩展用
`chrome.scripting.executeScript` 把 `collectPage` 整段注入页面，桌面端测试用**同一个函数**
跑真实页面夹具。**认平台由桌面端决定**（`detectBySignature`）——扩展只回传页面签名
（`pageSignature`）与各适配器 collect 抽到的字段（`pageFields`），判定只有一处。

仍未接上：把用户适配器接上、并在健康度里报告失效是 #28。
采集字段落库（`records.pageSignature` / `records.pageFields`）与「重新解析历史」是 #27。
