/**
 * End-to-end: 一条访问走一条通道（issue #14）。
 * Run with: node agent/visit.e2e.test.js
 *
 * 一条来访的访问，从「这一页算不算作品」到「它属于哪部作品」，由
 * RecordStore.recordVisit 一次判完：
 *
 *   闸门 → 作品身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库
 *
 * 这个测试跑的是**临时库文件**而不是内存库，因为整条链路的前提是
 * 「判定只做一次、结论落库」（docs/adr/0002）：重开库再报一次同样的访问，
 * 库里不能多出第二条访问、也不能重新计一次分。内存库测不到这一层。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { RecordStore } = require("./record-store");
const { AIQIYI, TVMAO, WATCHLIST } = require("./annotated-pair.fixture");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-visit-"));
const dbPath = path.join(tmpDir, "tracker.db");

const DAY1 = new Date(2026, 2, 1, 10).getTime();
const DAY2 = new Date(2026, 2, 2, 10).getTime();

// 歧义站：一个页面能同时给出编号与封面两路身份键（ADR-0002 里最贵的那条路）
const AMB_RULE = {
  domain: "amb.example",
  label: "歧义站",
  color: "#fff",
  regexFilter: "/w/(?<code>[A-Z0-9-]+)/(?<cover>[0-9a-f]{32})",
  regexTarget: "url",
};

async function openStore() {
  const store = new RecordStore(dbPath, () => {});
  await store.init();
  return store;
}

function countRecords(store) {
  return store._dbAll("SELECT id FROM records").length;
}

function countWorks(store) {
  return store._dbAll("SELECT id FROM works").length;
}

/** 访问 / 作品 / 身份键的完整快照，用来断言「一个字节都没变」。 */
function snapshot(store) {
  return JSON.stringify({
    records: store._dbAll("SELECT * FROM records"),
    works: store._dbAll("SELECT * FROM works"),
    keys: store._dbAll("SELECT workId, kind, value FROM work_keys"),
  });
}

async function runTests() {
  console.log("\n── 一条访问走一条通道 end-to-end（临时库）──\n");

  const store = await openStore();
  store.updateWatchlist(WATCHLIST);
  store.addWatchlist(AMB_RULE);

  // ── ① 一次调用，从闸门到落库 ──
  console.log("① 一次调用：闸门 → 身份键 → 归属 → 落库");
  const a = store.recordVisit({ ...AIQIYI, id: "r-a-1", timestamp: DAY1 });
  assert(a.action === "insert", "上报一次就落库（调用方不需要提供查重回调）");
  assert(countRecords(store) === 1, "库里一条访问");
  assert(countWorks(store) === 1, "库里一部作品");
  assert(a.record.workId === a.work.id, "访问挂到了作品上");
  assert(a.work.score === 1, "作品分数为 1");
  assert(
    a.keys.some((k) => k.kind === "cover_hash") && a.keys.some((k) => k.kind === "synopsis"),
    "封面哈希与简介指纹都成了身份键",
  );

  // ── ② 同一次访问重报：只有一条访问、一部作品、一次计分 ──
  console.log("\n② 同一次访问重报");
  const beforeRepeat = snapshot(store);
  const repeat = store.recordVisit({
    ...AIQIYI,
    id: "r-a-1",
    timestamp: DAY1 + 5000,
  });
  assert(repeat.action === "ignore", "同一标签页 60s 内重报判为同一次访问");
  assert(countRecords(store) === 1, "没有多出第二条访问");
  assert(countWorks(store) === 1, "没有多出第二部作品");
  assert(snapshot(store) === beforeRepeat, "访问、作品与身份键一个字节都没变（也没有重复计分）");

  // ── ③ 闸门：列表页不进库，但带出原因 ──
  console.log("\n③ 闸门：列表页");
  const listPage = store.recordVisit({
    ...AIQIYI,
    id: "r-a-list",
    url: "https://www.aiqiyi.ai/latest/",
    title: "最新更新",
    timestamp: DAY1 + 60000,
  });
  assert(listPage.action === "drop" && listPage.reason === "no-rule-match", "列表页被闸门丢弃");
  assert(countRecords(store) === 1, "被丢弃的页面没有产生访问");

  // ── ④ 拿不到身份键：访问照常存在，只是未归属 ──
  console.log("\n④ 降级：拿不到身份键");
  const orphan = store.recordVisit({
    id: "r-t-orphan",
    url: "https://www.tvmao.com/kanju/unknown-page",
    title: "",
    description: "",
    ogImage: "",
    domain: "tvmao.com",
    matchedRule: "tvmao.com",
    tabId: 5,
    timestamp: DAY1 + 3600e3,
  });
  assert(orphan.action === "insert", "认不出的页面照常落库");
  assert(orphan.work === null && orphan.record.workId === null, "归不到作品");
  assert(store.getUnattributedCount() === 1, "它在未归属列表里可见");

  // ── ⑤ 跨站第 2 天：归成一条、分数累加 ──
  console.log("\n⑤ 跨站第 2 天");
  const b = store.recordVisit({ ...TVMAO, id: "r-b-1", timestamp: DAY2 });
  assert(b.action === "insert", "元数据站的作品页落库");
  assert(b.work.id === a.work.id, "两个站的同一部作品归成一条");
  assert(b.work.score === 2, "跨站跨天累加：分数为 2");
  assert(countRecords(store) === 3, "三次访问在库（A 站、A 站认不出的那条、B 站）");

  // ── ⑥ 身份键指向多部作品：报告歧义，不静默合并 ──
  console.log("\n⑥ 歧义：不静默合并");
  const hexA = "a".repeat(32);
  const hexB = "b".repeat(32);
  const x = store.recordVisit({
    id: "r-x",
    url: `https://amb.example/w/AAA-1/${hexA}`,
    title: "甲",
    domain: "amb.example",
    matchedRule: "amb.example",
    tabId: 6,
    timestamp: DAY2,
  });
  const y = store.recordVisit({
    id: "r-y",
    url: `https://amb.example/w/BBB-2/${hexB}`,
    title: "乙",
    domain: "amb.example",
    matchedRule: "amb.example",
    tabId: 6,
    timestamp: DAY2,
  });
  const worksBefore = countWorks(store);
  const ambiguous = store.recordVisit({
    id: "r-ab",
    url: `https://amb.example/w/AAA-1/${hexB}`,
    title: "丙",
    domain: "amb.example",
    matchedRule: "amb.example",
    tabId: 6,
    timestamp: DAY2,
  });
  assert(x.work.id !== y.work.id, "先建出两部不同的作品");
  assert(ambiguous.ambiguous === true, "两路键指向不同作品时报告歧义（交给用户裁决）");
  assert(ambiguous.work !== null, "仍然返回一条作品，不抛错");
  assert(countWorks(store) === worksBefore, "没有把两部作品静默合并成一部");
  assert(
    !store.getWorkKeys(x.work.id).some((k) => k.value === hexB),
    "被占用的键没有静默改指到另一部作品",
  );
  assert(
    store.getRecordById("r-ab") !== null,
    "歧义的那次访问照常落库（记录不因判定不确定而丢）",
  );
  // 歧义不止于返回值：上游的「歧义作品可见」（PR #32）在 recordWorkVisit 里落库，
  // 实时上报走的就是那一步，所以这条链路自动进了 works:health 的「身份键有冲突」。
  assert(
    store.getAmbiguousWorks().some((a) => a.value === hexB),
    "歧义作为事实落库，界面才看得见",
  );

  // ── ⑦ 重开库：判定只做一次，结论落库 ──
  console.log("\n⑦ 重开库后再报一次同样的访问");
  const recordsBefore = countRecords(store);
  const worksCountBefore = countWorks(store);
  fs.writeFileSync(dbPath, Buffer.from(store.export()));

  const reopened = await openStore();
  assert(countRecords(reopened) === recordsBefore, "重开库后历史一条不少");
  const again = reopened.recordVisit({ ...AIQIYI, id: "r-a-1", timestamp: DAY1 });
  assert(again.action === "ignore", "重报落地的那条访问仍判为同一次");
  assert(countRecords(reopened) === recordsBefore, "库里没有多出第二条访问");
  assert(countWorks(reopened) === worksCountBefore, "也没有多出作品");
  const fused = reopened.getWork(a.work.id);
  assert(fused.score === 2, "作品分数不变，没有重复计分");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner error:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
