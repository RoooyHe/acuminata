// Unit tests for adapter health counters (pure logic).
// Issue #28: 健康度按**适配器**记，未见命中的适配器被标为疑似失效（docs/adr/0003、0006）。
const assert = require("assert");
const { createAdapterHealth, SUSPECT_DROPPED } = require("./adapter-health");

function check(cond, msg) {
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
}

console.log("Running adapter-health tests...\n");

// 已加载的适配器在快照里先各占一行：从未命中也能被看见
const h = createAdapterHealth([
  { file: "maccms.json", name: "MacCMS" },
  { file: "user-site.json", name: "用户站" },
]);
check(h.snapshot().length === 2, "已加载的适配器先各占一行");
check(
  h.snapshot().find((s) => s.key === "maccms.json").label === "MacCMS",
  "快照带适配器名，供界面显示",
);
check(
  h.snapshot().find((s) => s.key === "maccms.json").kind === "adapter",
  "预置的适配器行标为 adapter",
);

// 命中与丢弃分别计数
h.note("maccms.json", true);
h.note("maccms.json", false);
const m = h.snapshot().find((s) => s.key === "maccms.json");
check(m.matched === 1 && m.dropped === 1, "命中与丢弃分别计数");
check(m.suspect === false, "命中过一次的适配器不标为失效");

// 未见命中且持续丢弃的适配器 → 疑似失效
for (let i = 0; i < SUSPECT_DROPPED; i++) h.note("user-site.json", false);
const u = h.snapshot().find((s) => s.key === "user-site.json");
check(u.suspect === true, "从未命中且连续丢弃 → 适配器疑似失效");
check(u.matched === 0 && u.dropped === SUSPECT_DROPPED, "疑似失效的适配器计数正确");

// 从未被用到的适配器（0/0）不误报
const fresh = createAdapterHealth([{ file: "new.json", name: "新适配器" }]);
check(fresh.snapshot()[0].suspect === false, "刚装上、还没见过的适配器不标为失效");

// 一次命中就把「从未命中」翻掉
const revived = createAdapterHealth([{ file: "dead.json", name: "失效站" }]);
for (let i = 0; i < SUSPECT_DROPPED; i++) revived.note("dead.json", false);
revived.note("dead.json", true);
check(revived.snapshot()[0].suspect === false, "命中过一次后不再标为失效");

// 刚好差一条不算
const almost = createAdapterHealth([{ file: "maybe.json", name: "也许" }]);
for (let i = 0; i < SUSPECT_DROPPED - 1; i++) almost.note("maybe.json", false);
check(almost.snapshot()[0].suspect === false, "差一条不标为失效");

// ── noteVisit：一条 recordVisit 结果怎么记 ──
// 认下的适配器按「解析是否产出字段」记；没认下的页沿用站点粒度（用户自己写的正则闸门）。
const v = createAdapterHealth([{ file: "a.json", name: "A" }]);
v.noteVisit({ adapter: { file: "a.json" }, parsed: { code: null } }, "a.com");
check(
  v.snapshot().find((s) => s.key === "a.json").dropped === 1,
  "认下适配器但解析没产出 → 记一次丢弃（站点改版打失效的那一路）",
);
v.noteVisit({ adapter: { file: "a.json" }, parsed: { code: "ABC-123" } }, "a.com");
check(
  v.snapshot().find((s) => s.key === "a.json").matched === 1,
  "解析产出身份字段 → 记一次命中",
);
v.noteVisit({ adapter: { file: "a.json" }, parsed: { edition: "中文字幕" } }, "a.com");
check(
  v.snapshot().find((s) => s.key === "a.json").dropped === 2,
  "只产出 edition（非身份字段）不算命中——身份没认出来就是没认出来",
);

// 连续丢弃：命中过一次、然后站点改版打失效 → 仍会标为疑似失效
const lost = createAdapterHealth([{ file: "maccms.json", name: "MacCMS" }]);
// 先正常命中一次（域名被记住）
lost.noteVisit({ adapter: { file: "maccms.json" }, parsed: { code: "X-1" } }, "site.example");
// 站点改版：签名没了，detect 落空，走不到适配器
for (let i = 0; i < SUSPECT_DROPPED; i++) lost.noteVisit({ action: "insert" }, "site.example");
const lostRow = lost.snapshot().find((s) => s.key === "maccms.json");
check(
  lostRow.dropped === SUSPECT_DROPPED,
  "签名被改掉后，失败归到以前认下这个域名的适配器（不静默，ADR-0006）",
);
check(lostRow.suspect === true, "连续丢弃达到阈值 → 曾经工作过的适配器也会被标为疑似失效");
// 闸门丢弃（用户自己写的正则）不算适配器的账，仍按站点记
lost.noteVisit({ action: "drop" }, "site.example");
check(
  lost.snapshot().find((s) => s.key === "site.example").dropped === 1,
  "闸门丢弃不归到适配器，按站点记",
);

const g = createAdapterHealth();
g.noteVisit({ action: "drop" }, "dead.com");
g.noteVisit({ action: "insert" }, "live.com");
const dead = g.snapshot().find((s) => s.key === "dead.com");
const live = g.snapshot().find((s) => s.key === "live.com");
check(dead.dropped === 1, "没有适配器的站点：闸门丢弃照旧记到站点上");
check(live.matched === 1, "没有适配器的站点：收下照旧记一次命中");
check(dead.kind === "site", "站点粒度的行标为 site");

// 未知域名不能丢事件
const unknown = createAdapterHealth();
unknown.noteVisit({ action: "drop" }, undefined);
check(unknown.snapshot()[0].key === "(unknown)", "缺失域名归入占位 key");

// 排序：丢弃多的在前
const sorted = createAdapterHealth();
sorted.note("a.com", true);
sorted.note("a.com", false);
sorted.note("b.com", false);
sorted.note("b.com", false);
check(sorted.snapshot()[0].key === "b.com", "按丢弃数降序排列");

console.log("\n✅ All adapter-health tests passed!");
