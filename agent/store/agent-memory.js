// Agent memory domain: conversations and their messages, learned memories, the
// pending-action queue, and the profile assembled from memories.
// Testable with only the agent_* tables: `AgentMemoryStore.schema(db)`.

const { uuid, now } = require("./ids");

class AgentMemoryStore {
  constructor(db, emit) {
    this.db = db;
    this.emit = emit || (() => {});
  }

  static schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'analysis',
      summary TEXT DEFAULT '',
      system_prompt TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      completed_at INTEGER DEFAULT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      tool_calls TEXT DEFAULT NULL,
      tool_call_id TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_am_conv ON agent_messages(conversation_id)`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT DEFAULT '',
      value TEXT DEFAULT '',
      weight REAL DEFAULT 0.5,
      source_conversation_id TEXT,
      source_reflection TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_amm_type ON agent_memories(type)`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_pending_actions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '{}',
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER DEFAULT NULL
    )`);
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  createConversation(type, systemPrompt) {
    const id = uuid();
    this.db.run(
      "INSERT INTO agent_conversations (id, type, system_prompt, created_at) VALUES (?, ?, ?, ?)",
      [id, type, systemPrompt || "", now()],
    );
    return id;
  }

  completeConversation(id, summary) {
    this.db.run("UPDATE agent_conversations SET summary = ?, completed_at = ? WHERE id = ?", [
      summary || "",
      now(),
      id,
    ]);
  }

  insertMessage(conversationId, round, role, content, toolCalls, toolCallId) {
    const id = uuid();
    this.db.run(
      "INSERT INTO agent_messages (id, conversation_id, round, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        conversationId,
        round,
        role,
        content || "",
        toolCalls ? JSON.stringify(toolCalls) : null,
        toolCallId || null,
        now(),
      ],
    );
  }

  // ── Memories ───────────────────────────────────────────────────────────────

  upsertMemory(type, key, value, weight, sourceConvId, sourceReflection) {
    const existing = this.db.get("SELECT id, weight FROM agent_memories WHERE type = ? AND key = ?", [
      type,
      key,
    ]);
    const nowTs = now();
    const stringValue = typeof value === "string" ? value : JSON.stringify(value);

    if (existing) {
      const newWeight = Math.min(1, Math.max(0, existing.weight * 0.7 + weight * 0.3));
      this.db.run(
        "UPDATE agent_memories SET value = ?, weight = ?, updated_at = ?, source_reflection = ? WHERE id = ?",
        [stringValue, newWeight, nowTs, sourceReflection || null, existing.id],
      );
    } else {
      this.db.run(
        "INSERT INTO agent_memories (id, type, key, value, weight, source_conversation_id, source_reflection, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          uuid(),
          type,
          key,
          stringValue,
          weight,
          sourceConvId || null,
          sourceReflection || null,
          nowTs,
          nowTs,
        ],
      );
    }
  }

  getMemoriesByType(type) {
    return this.db.all("SELECT * FROM agent_memories WHERE type = ? ORDER BY weight DESC", [type]);
  }

  getAllMemories() {
    return this.db.all("SELECT * FROM agent_memories ORDER BY updated_at DESC");
  }

  buildAgentProfile() {
    const memories = this.getAllMemories();
    const profile = {
      preferences: memories
        .filter((m) => m.type === "preference")
        .map((m) => ({ key: m.key, weight: m.weight, value: m.value })),
      antiPatterns: memories.filter((m) => m.type === "anti_pattern").map((m) => m.key),
      insights: memories
        .filter((m) => m.type === "insight")
        .map((m) => ({ key: m.key, value: m.value, weight: m.weight })),
      domainHealth: {},
      lastUpdated:
        memories.length > 0 ? Math.max(...memories.map((m) => m.updated_at || 0)) : null,
    };
    for (const m of memories.filter((m) => m.type === "domain_health")) {
      profile.domainHealth[m.key] = m.weight;
    }
    return profile;
  }

  // ── Pending Actions ────────────────────────────────────────────────────────

  insertPendingAction(conversationId, toolName, args) {
    const id = uuid();
    this.db.run(
      "INSERT INTO agent_pending_actions (id, conversation_id, tool_name, args, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, conversationId, toolName, JSON.stringify(args), now()],
    );
    return id;
  }

  /**
   * 一轮分析拦下的一批待审批动作入队。有变更就广播一次队列现状，
   * 队列变化的可见性由 store 负责，调用方不再自己发事件。
   */
  insertPendingActions(conversationId, actions) {
    for (const a of actions || []) {
      this.insertPendingAction(conversationId, a.tool, a.args);
    }
    if (actions && actions.length > 0) {
      this.emit("agentPendingUpdated", { actions: this.getPendingActions() });
    }
  }

  getPendingActions() {
    return this.db.all(
      "SELECT * FROM agent_pending_actions WHERE status = 'pending' ORDER BY created_at ASC",
    );
  }

  resolvePendingAction(id, status) {
    this.db.run("UPDATE agent_pending_actions SET status = ?, resolved_at = ? WHERE id = ?", [
      status,
      now(),
      id,
    ]);
  }

  /** 批量裁决待审批动作，并广播一次队列现状。 */
  resolvePendingActions(ids, status) {
    for (const id of ids || []) this.resolvePendingAction(id, status);
    this.emit("agentPendingUpdated", { actions: this.getPendingActions() });
  }
}

module.exports = { AgentMemoryStore };
