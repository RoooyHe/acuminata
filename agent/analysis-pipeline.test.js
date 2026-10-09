/**
 * 一条分析管道（agent/analysis-pipeline.js）测试。
 * 三种模型回复形状：合法 JSON、带围栏的 JSON、纯文本。
 * Run with: node agent/analysis-pipeline.test.js
 */

const assert = require("assert");
const { createAIProviders } = require("./providers");
const { analyzePrompt, reflectPrompt } = require("./analysis-pipeline");

function providersReturning(raw) {
  return createAIProviders(
    () => ({ provider: "ollama", endpoint: "http://localhost:11434", model: "m" }),
    async () => ({ status: 200, data: JSON.stringify({ response: raw }) }),
  );
}

async function runTests() {
  console.log("\n── agent/analysis-pipeline.js tests ──\n");

  // 1. 合法 JSON
  {
    const analysis = await analyzePrompt(
      providersReturning('{"summary":"喜欢悬疑","keywords":["悬疑","推理"]}'),
      "prompt",
    );
    assert.strictEqual(analysis.summary, "喜欢悬疑", "解析出 summary");
    assert.deepStrictEqual(analysis.keywords, ["悬疑", "推理"], "解析出 keywords");
    console.log("  ✓ 合法 JSON：直接解析");
  }

  // 2. 带围栏的 JSON
  {
    const analysis = await analyzePrompt(
      providersReturning('```json\n{"summary":"围栏里的","keywords":["a"]}\n```'),
      "prompt",
    );
    assert.strictEqual(analysis.summary, "围栏里的", "围栏也能剥开");
    assert.deepStrictEqual(analysis.keywords, ["a"], "围栏里 keywords 也在");
    console.log("  ✓ 带围栏的 JSON：剥围栏后解析");
  }

  // 3. 纯文本：降级成截断文本
  {
    const raw = "  " + "啰".repeat(300);
    const analysis = await analyzePrompt(providersReturning(raw), "prompt");
    assert.strictEqual(analysis.summary, raw.slice(0, 200), "纯文本降级为截断文本");
    assert.deepStrictEqual(analysis.keywords, [], "降级后 keywords 为空");
    console.log("  ✓ 纯文本：降级为截断文本");
  }

  // 4. 反思共用同一条管道：有 JSON 给对象，纯文本给 null（不落库）
  {
    const parsed = await reflectPrompt(
      providersReturning('{"insight":"删掉的都太吵"}'),
      "prompt",
    );
    assert.strictEqual(parsed.insight, "删掉的都太吵", "反思拿到 JSON 对象");

    const none = await reflectPrompt(providersReturning("一堆没有 JSON 的话"), "prompt");
    assert.strictEqual(none, null, "纯文本反思返回 null");
    console.log("  ✓ 反思复用同一条管道：JSON 给对象，纯文本给 null");
  }

  console.log("\n✅ All analysis-pipeline tests passed!");
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
