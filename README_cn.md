# Acuminata

**Acuminata** 是一款隐私优先、由 AI Agent 驱动的浏览器历史追踪与分析引擎。它通过 Electron 桌面端与 Chrome 插件的深度联动，将传统的“浏览记录”转化为可供智能体推演、学习并自动管理的“数字记忆资产”。

## 核心特性

### 1. 智能定向追踪与“伪装组”逻辑

* **定向监控 (Watchlist)**：不同于全量记录，只针对您关心的站点进行追踪。
* **伪装归类 (Camouflage Grouping)**：支持将多个域名（如镜像站）归类为一个逻辑站点，一律使用最新访问的域名跳转，彻底解决死链烦恼。
* **正则级过滤**：为每个站点配置针对 URL 或标题的正则规则，精准拦截首页垃圾信息或特定的编号（如番号格式匹配）。

### 2. 深度 AI Agent 交互

* **可视化思维链**：Agent 的每一步推演（思考、计划、调用工具）都会实时广播到极客感十足的黑色终端中。
* **命令驱动交互 (Command Bar)**：支持自然语言指令。输入“帮我清理昨天的无效记录”或“总结我最近关于 React 的研究”，Agent 即可自动调用工具执行任务。
* **安全护栏 (Guardrails)**：所有写入类操作（删除、修改配置）都会进入待审批队列，由您决定“吸收”或“排斥”。
* **自我进化系统 (Reflection)**：通过分析您对推荐内容的拒绝行为，Agent 会自动更新用户画像，识别反模式，变得越来越懂你。

### 3. 极简极黑设计体系 (Inspired by Runway)

* **Pure Black 视觉**：采用 `#000000` 纯黑背景，搭配极细边框（`#27272a`），追求视觉上的隐形与沉浸感。
* **极客字体排版**：全局使用 Inter，数据展示区强制使用 JetBrains Mono，营造高度一致的专业质感。
* **Zero Shadows**：坚持零阴影原则，通过光影与色块层级构建空间感。

---

## 技术架构

系统采用 C/S 架构，Electron 应用作为唯一的真实数据源（Source of Truth）。

* **Electron App**：运行 WebSocket 服务器（`127.0.0.1:8766`，只绑回环），内置 SQLite (sql.js) 数据库。
* **Chrome Extension**：基于 Plasmo 框架开发，支持 `WS 实时同步` 和 `本地离线缓存` 双模式。
* **AI Engine**：支持集成 OpenAI、Anthropic (Claude) 以及本地部署的 Ollama。

---

## 快速开始

### 桌面客户端 (Desktop)

```bash
# 安装依赖
npm install

# 启动开发版
npm run dev

# 构建打包 (待完善)
# npm run build

```

### 浏览器插件 (Extension)

```bash
cd extend/

# 安装依赖
npm install

# 开发模式 (支持 HMR)
npm run dev

# 构建正式版
npm run build

```

构建成功后，在 Chrome 扩展管理页面选择“加载已解压的扩展程序”，路径为 `extend/build/chrome-mv3-prod/`。

---

## 数据模型 (SQLite)

核心数据存储于本地 `tracker.db` 文件中：

* `records`：存储详细的浏览路径、得分、置顶状态及时间戳。
* `watchlist`：存储监控站点、伪装组标签、颜色标识及正则规则。
* `agent_memories`：存储 Agent 学习到的偏好、反模式与画像更新日志。

---

## AI Agent 工具箱 (Tools)

Agent 可以自由组合以下能力来响应您的指令：

* `search_records`：多维搜索浏览历史。
* `get_statistics`：获取浏览习惯分布。
* `update_regex_rule`：动态优化站点拦截规则。
* `delete_records`：批量清理低质量内容。
* `get_agent_profile`：读取已习得的用户偏好。

---

## 许可证

基于开源协议分发。开发者：RoyHe。
