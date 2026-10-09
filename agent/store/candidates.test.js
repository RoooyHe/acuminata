// Candidates domain needs only the `candidates` table. The pool is the raw
// side of ADR-0005: what a declared list page yielded, before any ranking.
const assert = require("assert");
const { openDatabase } = require("./db");
const { CandidateStore } = require("./candidates");

async function run() {
  const db = await openDatabase(":memory:");
  CandidateStore.schema(db); // 只带自己的 schema
  const events = [];
  const candidates = new CandidateStore(db, {
    emit: (type, payload) => events.push({ type, payload }),
  });

  const payload = {
    adapterFile: "maccms.json",
    listName: "最新更新",
    domain: "www.mgtvtv.com",
    matchedRule: "mgtvtv.com",
    groupLabel: "芒果",
    entries: [
      { url: "https://www.mgtvtv.com/tv/1/", title: "甲", cover: "https://x/upload/vod/1/a.webp" },
      { url: "https://www.mgtvtv.com/tv/2/", title: "乙", cover: "https://x/upload/vod/1/b.webp" },
      { title: "没有地址的条目" }, // 没有地址就不是候选
    ],
  };

  const first = candidates.importCandidates(payload);
  assert.deepStrictEqual(first, { inserted: 2, updated: 0 }, "两条带地址的条目落成候选");
  const rows = candidates.getCandidates();
  assert.strictEqual(rows.length, 2, "读取全部候选");
  const raw = JSON.parse(rows.find((r) => r.url.endsWith("/tv/1/")).fields);
  assert.strictEqual(raw.cover, "https://x/upload/vod/1/a.webp", "原始字段整份存下来");
  assert.strictEqual(rows[0].domain, "www.mgtvtv.com", "候选带来源站点");
  assert.strictEqual(rows[0].matchedRule, "mgtvtv.com", "候选带分组");

  // 重抓同一个列表页：地址是自然键，只更新不新增。
  const second = candidates.importCandidates({
    ...payload,
    entries: [
      { url: "https://www.mgtvtv.com/tv/1/", title: "甲（改名）", cover: "https://x/upload/vod/1/a.webp" },
      { url: "https://www.mgtvtv.com/tv/3/", title: "丙", cover: "https://x/upload/vod/1/c.webp" },
    ],
  });
  assert.deepStrictEqual(second, { inserted: 1, updated: 1 }, "重抓只更新已有地址、新增新地址");
  assert.strictEqual(candidates.getCandidates().length, 3, "库里三条候选");
  assert.strictEqual(
    candidates.getCandidates().find((r) => r.url.endsWith("/tv/1/")).title,
    "甲（改名）",
    "重抓更新标题",
  );

  const removeId = candidates.getCandidates()[0].id;
  assert.strictEqual(candidates.removeCandidate(removeId), true, "移除返回 true");
  assert.strictEqual(candidates.getCandidates().length, 2, "移除后少一条");

  assert.strictEqual(candidates.clearCandidates(), true, "清空返回 true");
  assert.strictEqual(candidates.getCandidates().length, 0, "清空后为空");

  assert.ok(events.some((e) => e.type === "candidatesUpdated"), "改动会广播候选变化");

  console.log("candidates store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
