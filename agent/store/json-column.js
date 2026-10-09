// `records.pageSignature` / `records.pageFields` 这类 JSON 列的编解码。
// 写入路径（visits.js）与重跑 / 回填（works.js）都要读写它们，所以实现只此一份。

/** 值 → JSON 文本。已经是合法 JSON 文本就原样保留；编不出来时退回 fallback。 */
function toJson(value, fallback) {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch (e) {
      /* 不是 JSON，继续往下编 */
    }
  }
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return fallback;
  }
}

/** JSON 文本 → 值。已经是对象 / 数组就原样返回；解析不了时退回 fallback。 */
function fromJson(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  try {
    const value = JSON.parse(raw);
    return value === undefined || value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

module.exports = { toJson, fromJson };
