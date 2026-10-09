# Acuminata

**Acuminata** is a privacy-first, AI Agent-driven engine for tracking and analyzing browser history. By deeply integrating an Electron desktop application with a Chrome extension, it transforms traditional "browsing logs" into "digital memory assets" that can be reasoned with, learned from, and automatically managed by intelligent agents.

## Core Features

### 1. Intelligent Targeted Tracking & "Camouflage" Logic

* **Targeted Monitoring (Watchlist)**: Unlike general history trackers, Acuminata only records data from sites you explicitly care about.
* **Camouflage Grouping**: Group multiple domains (e.g., mirrors) into a single logical site. The system always uses the most recently visited domain for navigation, eliminating the hassle of dead links.
* **Regex-Level Filtering**: Configure precise regex rules for each site's URL or Title to block homepage clutter or capture specific patterns (such as code identifiers or specific numbering formats).

### 2. Deep AI Agent Interaction

* **Visualized Chain of Thought**: Every step of the Agent's reasoning—thinking, planning, and tool calling—is broadcasted in real-time to a sleek, hacker-style black console.
* **Command Bar Interaction**: Control your data with natural language. Type "Clear my junk records from yesterday" or "Summarize my recent research on React," and the Agent will orchestrate the necessary tools to execute the task.
* **Safety Guardrails**: All "Write" operations (deleting records, updating configs) are intercepted and placed in a pending queue for your approval (Accept/Reject).
* **Self-Evolution (Reflection)**: By analyzing your rejections, the Agent automatically updates your user profile, identifies "anti-patterns," and becomes increasingly aligned with your preferences over time.

### 3. Minimalist "Pure Black" Design System

* **Pure Black Visuals**: Utilizes a `#000000` background with ultra-thin `#27272a` borders for a stealthy, immersive aesthetic inspired by high-end pro tools.
* **Geek-Centric Typography**: Uses *Inter* for the interface and *JetBrains Mono* for data displays to ensure high-density information remains legible and professional.
* **Zero Shadows**: Adheres to a strict "no-shadow" principle, using light, borders, and color levels to define spatial hierarchy.

---

## Technical Architecture

The system follows a C/S (Client/Server) architecture where the Electron app serves as the absolute **Source of Truth**.

* **Electron App**: Runs a WebSocket server (`127.0.0.1:8766`, loopback only) and manages a local SQLite (`sql.js`) database.
* **Chrome Extension**: Built on the **Plasmo** framework, supporting both `Real-time WS Sync` and `Local Fallback` modes for independent operation.
* **AI Engine**: Supports integration with OpenAI, Anthropic (Claude), and locally deployed Ollama models.

---

## Getting Started

### Desktop Client

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Build (Production)
# npm run build

```

### Browser Extension

```bash
cd extend/

# Install dependencies
npm install

# Start development (supports HMR)
npm run dev

# Build production version
npm run build

```

Once built, load the unpacked extension from `extend/build/chrome-mv3-prod/` in the Chrome extensions management page.

---

## Data Model (SQLite)

Core data is stored locally in `tracker.db`:

* `records`: 每一次访问（URL、标题、停留时长、时间戳）。一次访问是一条，不合并。
* `works`: 作品本身——所有内容融合的唯一落点。**每日 +1 计分在这里**，所以同一部作品在两个站上看，分数累加到一处。
* `work_keys`: 一部作品可以挂多个身份键（内容编号 / 封面图哈希 / 归一化标题 / 简介指纹），任一路命中即归并。
* `watchlist`: 登记过的站点，以及该站适配器的规则（含命名捕获组）。
* `agent_memories`: 学到的用户偏好、反模式、画像更新日志。

---

## AI Agent Toolbox

The Agent leverages a suite of specialized tools to respond to user commands:

* `search_records`: Multi-dimensional search across browsing history.
* `get_statistics`: Retrieve distribution and habits data.
* `update_regex_rule`: Dynamically optimize site-specific interception rules.
* `delete_records`: Batch clean low-quality or irrelevant content.
* `get_agent_profile`: Access the acquired user preference profile.

---

## License

Distributed under the open-source license. Developed by **RoyHe**.
