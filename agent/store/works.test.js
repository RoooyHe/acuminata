// Works identity, fusion, scoring and ambiguity only need the works tables —
// no RecordStore, no records. The read side (getWorksPage / getWorkDetail /
// backfillWorks) joins `records`, so it is covered by the integration test in
// agent/record-store.test.js instead.
const assert = require("assert");
const { openDatabase } = require("./db");
const { WorkStore } = require("./works");

const DAY = 24 * 3600 * 1000;
const code = (v) => ({ kind: "code", value: v, confidence: "high" });
const cover = (v) => ({ kind: "cover_hash", value: v, confidence: "high" });
const synopsis = (v) => ({ kind: "synopsis", value: v, confidence: "medium" });
const titleKey = (v) => ({ kind: "title", value: v, confidence: "low" });

async function run() {
  const db = await openDatabase(":memory:");
  WorkStore.schema(db); // 只带自己的 schema
  const works = new WorkStore(db, { emit: () => {} });
  const t0 = new Date(2026, 2, 1, 10).getTime();

  const first = works.recordWorkVisit({
    keys: [code("ABC-1"), synopsis("共用的简介正文")],
    title: "某剧",
    timestamp: t0,
  });
  assert.strictEqual(first.created, true, "有强键的第一条访问建起作品");
  assert.strictEqual(first.work.score, 1, "作品分数为 1");

  const sameDay = works.recordWorkVisit({
    keys: [code("ABC-1")],
    title: "某剧",
    timestamp: t0 + 3600e3,
  });
  assert.strictEqual(sameDay.work.id, first.work.id, "同一个键还是同一部作品");
  assert.strictEqual(sameDay.work.score, 1, "同一天不重复加分");

  const nextDay = works.recordWorkVisit({
    keys: [code("ABC-1")],
    title: "某剧",
    timestamp: t0 + DAY,
  });
  assert.strictEqual(nextDay.work.score, 2, "隔天 +1");

  // 跨站桥接：封面不同、共用的简介指纹相同
  const bridge = works.recordWorkVisit({
    keys: [cover("a".repeat(32)), synopsis("共用的简介正文")],
    title: "某剧（另一个站）",
    timestamp: t0 + 2 * DAY,
  });
  assert.strictEqual(bridge.work.id, first.work.id, "靠共用简介落到同一部作品");
  assert.strictEqual(bridge.work.score, 3, "跨站跨天继续累加");
  assert.strictEqual(works.getWorkKeys(first.work.id).length, 3, "内容编号 + 简介 + 封面哈希都在");

  // 没有共享键就不合并（宁可拆，不可合）
  const a = works.recordWorkVisit({ keys: [cover("1".repeat(32))], title: "同名剧", timestamp: t0 });
  const b = works.recordWorkVisit({ keys: [cover("2".repeat(32))], title: "同名剧", timestamp: t0 + DAY });
  assert.notStrictEqual(a.work.id, b.work.id, "没有共享键值时拆成两条");
  assert.strictEqual(works.findWorksByKeys([cover("1".repeat(32))]).length, 1, "按键找到唯一候选");

  // 低可信度标题键：不建也不合
  const low = works.recordWorkVisit({ keys: [titleKey("同名剧")], title: "同名剧", timestamp: t0 });
  assert.strictEqual(low.work, null, "只有标题时归不到作品（降级）");

  // 两路键指向不同作品 → 报歧义，不静默合并
  const merged = works.recordWorkVisit({
    keys: [cover("1".repeat(32)), cover("2".repeat(32))],
    title: "两路",
    timestamp: t0 + 3 * DAY,
  });
  assert.strictEqual(merged.ambiguous, true, "同一批键命中两部作品时报告歧义");
  assert.strictEqual(works.getAmbiguousWorks().length, 1, "歧义落库");

  // 删光访问后的孤儿清理要 records 表，属于 visits × works 的集成（见 record-store.test.js）。

  console.log("works store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
