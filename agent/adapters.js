/**
 * 适配器文件的加载：一个 JSON 文件 = 一个适配器 = 一个平台（docs/adapters/template.md）。
 *
 * 内置适配器和用户写的适配器都从这里进来，读的是同一个目录、同一段代码——
 * `adapters/maccms.json` 是仓库里的一个普通文件，不是一条特权的内置管道（ADR-0006）。
 *
 * 读进来只当**数据**：`JSON.parse`，不 `require`、不 `eval`。导入他人的适配器
 * 因此不等于执行他人的代码（ADR-0003）。单文件坏了只跳过它，不让整批适配器消失——
 * 「哪个适配器失效了」由适配器健康度报告，不在这里。
 *
 * 优先级就是文件名序：`detect` 取第一个签名命中的适配器。同签名的两个适配器
 * 是用户自己的选择，改文件名即可调先后（内置的 `maccms.json` 不在排序上享有特权）。
 */

const fs = require("fs");
const path = require("path");

/** 默认目录：仓库根下的 adapters/。 */
const ADAPTER_DIR = path.join(__dirname, "..", "adapters");

/**
 * @param {string} [dir]
 * @returns {Array<Object>} 适配器（带来源文件名 `file`）
 */
function loadAdapters(dir = ADAPTER_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return []; // 没有这个目录就是没有适配器
  }
  const out = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const adapter = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (adapter && typeof adapter === "object" && !Array.isArray(adapter)) {
        out.push({ ...adapter, file });
      }
    } catch (e) {
      // 坏 JSON：跳过这一个（健康度报告归 #28）
    }
  }
  return out;
}

module.exports = { loadAdapters, ADAPTER_DIR };
