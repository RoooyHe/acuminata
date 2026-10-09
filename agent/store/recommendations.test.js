// Recommendations domain needs only the `recommendations` table. Accepting one
// lands a pinned visit, so visits is a collaborator — a stub proves the module
// itself needs no records table.
const assert = require("assert");
const { openDatabase } = require("./db");
const { RecommendationStore } = require("./recommendations");

async function run() {
  const db = await openDatabase(":memory:");
  RecommendationStore.schema(db); // 只带自己的 schema
  const events = [];
  const landed = [];
  const visits = {
    insertPinnedVisit: (record) => {
      landed.push(record);
      return { ...record, pinned: 1, score: 1 };
    },
  };
  const recommendations = new RecommendationStore(db, {
    emit: (type, payload) => events.push({ type, payload }),
    visits,
  });

  db.run(
    "INSERT INTO recommendations (id, url, title, domain, groupLabel, reason, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["rec-1", "https://example.com/1", "甲", "example.com", "example.com", "理由", 0, 1],
  );
  db.run(
    "INSERT INTO recommendations (id, url, title, domain, groupLabel, reason, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["rec-2", "https://example.com/2", "乙", "example.com", "example.com", "理由", 0, 2],
  );

  assert.strictEqual(recommendations.getRecommendations().length, 2, "读取全部");
  assert.strictEqual(recommendations.list(0, 10).length, 2, "按状态筛选");
  assert.strictEqual(recommendations.list(1, 10).length, 0, "未接受时为 0");

  const rejected = recommendations.rejectRecommendation("rec-1");
  assert.strictEqual(rejected.id, "rec-1", "拒绝返回那一行");
  assert.strictEqual(recommendations.list(-1, 10).length, 1, "拒绝后状态为 -1");

  const accepted = recommendations.acceptRecommendation("rec-2");
  assert.strictEqual(landed.length, 1, "接受触发一次落库");
  assert.strictEqual(landed[0].url, "https://example.com/2", "落库用的是推荐里的地址");
  assert.strictEqual(landed[0].matchedRule, "example.com", "落库用的是推荐的分组");
  assert.strictEqual(accepted.pinned, 1, "返回那条已钉住的访问");
  assert.strictEqual(recommendations.list(1, 10).length, 1, "接受后状态为 1");
  assert.strictEqual(recommendations.acceptRecommendation("nope"), null, "未知推荐返回 null");

  assert.strictEqual(recommendations.clearRecommendations(), true, "清空返回 true");
  assert.strictEqual(recommendations.getRecommendations().length, 0, "清空后为空");

  console.log("recommendations store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
