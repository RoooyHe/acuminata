// 一条分析管道：构建好的提示词 → 调模型 → 抠 JSON → 解析（失败降级成截断文本）。
// 这是全仓库唯一一份「模型回复 → JSON」的抽取与降级实现，分析与反思都从这里走（issue #17）。
// 「什么字段离开了本机」只需核对提示词构建处（agent/prompts.js）。

/** 从模型回复里抠出 JSON 对象；抠不到或解析失败返回 null。 */
function readModelJson(providers, raw) {
  const jsonStr = providers.extractJson(raw);
  if (!jsonStr) return null;
  try {
    const data = JSON.parse(jsonStr);
    return data && typeof data === "object" ? data : null;
  } catch (e) {
    return null;
  }
}

/** 唯一一处把提示词交给模型的地方。 */
function askModel(providers, prompt) {
  return providers.callText(prompt);
}

/** 兴趣归纳的降级规则：模型没给 JSON 时，summary 退化成截断文本。 */
function analysisFromReply(providers, raw) {
  const data = readModelJson(providers, raw) || {};
  return {
    summary: data.summary || (raw ? String(raw).slice(0, 200) : ""),
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
  };
}

/** 反思：提示词 → 反思对象（没有 JSON 时返回 null，由调用方决定不落库）。 */
async function reflectPrompt(providers, prompt) {
  return readModelJson(providers, await askModel(providers, prompt));
}

module.exports = {
  analysisFromReply,
  reflectPrompt,
};
