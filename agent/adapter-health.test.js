// Unit tests for adapter health counters (pure logic).
const assert = require("assert");
const { createAdapterHealth, SUSPECT_DROPPED } = require("./adapter-health");

function check(cond, msg) {
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
}

console.log("Running adapter-health tests...\n");

const h = createAdapterHealth();
check(h.snapshot().length === 0, "初始快照为空");

h.note("a.com", true);
h.note("a.com", false);
h.note("b.com", false);
h.note("b.com", false);

let snap = h.snapshot();
const a = snap.find((s) => s.domain === "a.com");
const b = snap.find((s) => s.domain === "b.com");
check(a.matched === 1 && a.dropped === 1, "命中与丢弃分别计数");
check(b.matched === 0 && b.dropped === 2, "从未命中的站点只累积丢弃");
check(a.suspect === false && b.suspect === false, "未达阈值的站点不标为失效");
check(snap[0].domain === "b.com", "按丢弃数降序排列");

// 达到阈值：从未命中的站点被标出来
const suspect = createAdapterHealth();
for (let i = 0; i < SUSPECT_DROPPED; i++) suspect.note("dead.com", false);
check(suspect.snapshot()[0].suspect === true, "连续丢弃且从未命中 → suspect");

// 一旦命中过，就不再是「从未命中」
suspect.note("dead.com", true);
check(suspect.snapshot()[0].suspect === false, "命中过一次后不再标为失效");

// 刚好差一条不算
const almost = createAdapterHealth();
for (let i = 0; i < SUSPECT_DROPPED - 1; i++) almost.note("maybe.com", false);
check(almost.snapshot()[0].suspect === false, "差一条不标为失效");

// 未知域名不能丢事件
const unknown = createAdapterHealth();
unknown.note(undefined, false);
check(unknown.snapshot()[0].domain === "(unknown)", "缺失域名归入占位 key");

console.log("\n✅ All adapter-health tests passed!");
