// Settings domain: the `settings` key/value table plus the things stored in it —
// enabled flag, locale, AI config and window bounds.
// Testable with only the `settings` table: `SettingsStore.schema(db)`.

const path = require("path");
const fs = require("fs");

function pick(db, key) {
  const row = db.get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : null;
}

function put(db, key, value) {
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, String(value)]);
}

class SettingsStore {
  constructor(db, emit) {
    this.db = db;
    this.emit = emit || (() => {});
  }

  static schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    // 退役的 agent.profile 行：档案现在从 agent_memories 现算，不再落一条设置。
    db.tryExec("DELETE FROM settings WHERE key = 'agent.profile'");
  }

  // ── Enabled ────────────────────────────────────────────────────────────────

  getEnabled() {
    const row = this.db.get("SELECT value FROM settings WHERE key = ?", ["enabled"]);
    return row ? row.value === "true" : true;
  }

  setEnabled(val) {
    put(this.db, "enabled", val);
    this.emit("enabledUpdated", val);
  }

  // ── Locale ────────────────────────────────────────────────────────────────

  getLocale() {
    const code = pick(this.db, "locale") || "zh-CN";
    let data = {};
    try {
      data = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "..", "locales", code + ".json"), "utf8"),
      );
    } catch (e) {
      try {
        data = JSON.parse(
          fs.readFileSync(path.join(__dirname, "..", "..", "locales", "zh-CN.json"), "utf8"),
        );
      } catch (e2) {}
    }
    return { code, data };
  }

  setLocale(code) {
    put(this.db, "locale", code);
  }

  // ── AI Config ─────────────────────────────────────────────────────────────

  getAIConfig() {
    return {
      provider: pick(this.db, "ai.provider") || "ollama",
      endpoint: pick(this.db, "ai.endpoint") || "http://127.0.0.1:11434",
      apiKey: pick(this.db, "ai.apiKey") || "",
      model: pick(this.db, "ai.model") || "qwen2.5:7b",
    };
  }

  setAIConfig(config) {
    for (const key of ["provider", "endpoint", "apiKey", "model"]) {
      if (config[key] !== undefined) put(this.db, `ai.${key}`, config[key]);
    }
  }

  // ── Window Bounds ──────────────────────────────────────────────────────────

  getWindowBounds() {
    const at = (key) => pick(this.db, `window.${key}`);
    const [x, y, width, height] = [at("x"), at("y"), at("width"), at("height")];
    if (!x || !y || !width || !height) return null;
    return {
      x: parseInt(x, 10),
      y: parseInt(y, 10),
      width: parseInt(width, 10),
      height: parseInt(height, 10),
    };
  }

  saveWindowBounds(bounds) {
    for (const key of ["x", "y", "width", "height"]) put(this.db, `window.${key}`, bounds[key]);
  }
}

module.exports = { SettingsStore };
