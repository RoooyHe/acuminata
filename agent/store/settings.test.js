// Settings domain only needs the `settings` table — no RecordStore.
const assert = require("assert");
const { openDatabase } = require("./db");
const { SettingsStore } = require("./settings");

async function run() {
  const db = await openDatabase(":memory:");
  SettingsStore.schema(db); // 只带自己的 schema
  const events = [];
  const settings = new SettingsStore(db, (type, payload) => events.push({ type, payload }));

  assert.strictEqual(settings.getEnabled(), true, "默认开启");
  settings.setEnabled(false);
  assert.strictEqual(settings.getEnabled(), false, "关闭后读回 false");
  assert.deepStrictEqual(events, [{ type: "enabledUpdated", payload: false }], "改开关广播一次");

  assert.strictEqual(settings.getLocale().code, "zh-CN", "默认语言 zh-CN");
  settings.setLocale("en-US");
  assert.strictEqual(settings.getLocale().code, "en-US", "语言可改（文件缺失也回退代码）");

  assert.deepStrictEqual(
    settings.getAIConfig(),
    {
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      apiKey: "",
      model: "qwen2.5:7b",
    },
    "AI 配置有默认值",
  );
  settings.setAIConfig({ model: "llama3", apiKey: "k" });
  assert.strictEqual(settings.getAIConfig().model, "llama3", "只改给的字段");
  assert.strictEqual(
    settings.getAIConfig().endpoint,
    "http://127.0.0.1:11434",
    "没给的字段保持默认",
  );

  assert.strictEqual(settings.getWindowBounds(), null, "没存过窗口位置返回 null");
  settings.saveWindowBounds({ x: 1, y: 2, width: 800, height: 600 });
  assert.deepStrictEqual(
    settings.getWindowBounds(),
    { x: 1, y: 2, width: 800, height: 600 },
    "窗口位置读写",
  );

  console.log("settings store tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
