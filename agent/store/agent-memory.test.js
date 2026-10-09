// Agent-memory domain: conversations, messages, memories, pending actions and
// the profile. Only the agent_* tables are needed — no RecordStore.
const assert = require("assert");
const { openDatabase } = require("./db");
const { AgentMemoryStore } = require("./agent-memory");

async function run() {
  const db = await openDatabase(":memory:");
  AgentMemoryStore.schema(db); // 只带自己的 schema
  const events = [];
  const agent = new AgentMemoryStore(db, (type, payload) => events.push({ type, payload }));

  const convId = agent.createConversation("analysis", "system prompt");
  agent.insertMessage(convId, 0, "user", "hello", null, null);
  agent.insertMessage(convId, 1, "assistant", "hi", [{ name: "t" }], null);
  const messages = db.all("SELECT * FROM agent_messages WHERE conversation_id = ?", [convId]);
  assert.strictEqual(messages.length, 2, "两条消息落库");
  assert.strictEqual(messages[1].role, "assistant", "角色保留");
  assert.ok(messages[1].tool_calls.includes("t"), "工具调用序列化保留");
  agent.completeConversation(convId, "done");
  assert.strictEqual(
    db.get("SELECT summary FROM agent_conversations WHERE id = ?", [convId]).summary,
    "done",
    "会话结案带摘要",
  );

  agent.upsertMemory("preference", "dark_mode", "enabled", 0.8, null, null);
  assert.strictEqual(agent.getMemoriesByType("preference").length, 1, "新增一条记忆");
  agent.upsertMemory("preference", "dark_mode", "enabled", 0.2, null, null);
  const merged = agent.getMemoriesByType("preference")[0];
  assert.strictEqual(merged.weight, Math.min(1, 0.8 * 0.7 + 0.2 * 0.3), "同键按权重合并，不新增");
  agent.upsertMemory("anti_pattern", "junk", "junk", 0.4, null, null);
  agent.upsertMemory("insight", "i1", "洞察", 0.5, null, null);
  agent.upsertMemory("domain_health", "example.com", "ok", 0.9, null, null);

  const profile = agent.buildAgentProfile();
  assert.strictEqual(profile.preferences.length, 1, "画像含偏好");
  assert.deepStrictEqual(profile.antiPatterns, ["junk"], "画像含反模式");
  assert.strictEqual(profile.insights.length, 1, "画像含洞察");
  assert.strictEqual(profile.domainHealth["example.com"], 0.9, "画像含站点健康度");
  assert.ok(typeof profile.lastUpdated === "number", "画像带最后更新时间");

  // 待审批队列：入队、裁决，只有非空批次广播
  const before = events.filter((e) => e.type === "agentPendingUpdated").length;
  agent.insertPendingActions(convId, []);
  assert.strictEqual(
    events.filter((e) => e.type === "agentPendingUpdated").length,
    before,
    "空批次不广播",
  );
  agent.insertPendingActions(convId, [
    { tool: "t1", args: { a: 1 } },
    { tool: "t2", args: { b: 2 } },
  ]);
  assert.strictEqual(agent.getPendingActions().length, 2, "两条动作入队");
  assert.strictEqual(
    events.filter((e) => e.type === "agentPendingUpdated").length,
    before + 1,
    "入队广播一次队列现状",
  );
  agent.resolvePendingActions(
    agent.getPendingActions().map((a) => a.id),
    "approved",
  );
  assert.strictEqual(agent.getPendingActions().length, 0, "裁决后队列为空");
  assert.strictEqual(
    events.filter((e) => e.type === "agentPendingUpdated").length,
    before + 2,
    "裁决再广播一次",
  );

  console.log("agent memory store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
