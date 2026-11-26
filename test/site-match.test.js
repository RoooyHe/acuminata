/**
 * 站点匹配：一个地址属于哪个登记站点。
 * Run with: node test/site-match.test.js
 *
 * 这条规则扩展与桌面端的站点页都要用（ADR-0011），因此它只有一份实现
 * （shared/site-match.js）。这里测的是它的边界：
 *   - 域名相同、www. 前缀、子域
 *   - 没登记的站点不归任何站点（因此不产生访问，ADR-0003）
 */

const assert = require("assert");
const { extractDomain, matchSite } = require("../shared/site-match");

const WATCHLIST = [
  { domain: "aiqiyi.ai", label: "爱奇艺镜像", color: "#fff" },
  { domain: "www.mgtvtv.com", label: "MGT", color: "#fff" },
];

function run() {
  console.log("Running site-match tests...\n");

  assert.strictEqual(extractDomain("https://www.aiqiyi.ai/v/1"), "aiqiyi.ai");
  assert.strictEqual(extractDomain("https://aiqiyi.ai/v/1"), "aiqiyi.ai");
  assert.strictEqual(extractDomain("not a url"), null);
  console.log("  ✓ extractDomain 去掉 www. 前缀，解析不了就是 null");

  assert.strictEqual(matchSite("https://aiqiyi.ai/v/1", WATCHLIST).domain, "aiqiyi.ai");
  console.log("  ✓ 域名相同即命中登记站点");

  assert.strictEqual(
    matchSite("https://www.aiqiyi.ai/v/1", WATCHLIST).domain,
    "aiqiyi.ai",
    "www. 前缀不该挡住命中",
  );
  console.log("  ✓ www. 前缀不影响命中");

  assert.strictEqual(
    matchSite("https://vod.aiqiyi.ai/v/1", WATCHLIST).domain,
    "aiqiyi.ai",
    "子域属于登记站点",
  );
  console.log("  ✓ 子域命中登记站点");

  assert.strictEqual(
    matchSite("https://www.mgtvtv.com/show/1", WATCHLIST).domain,
    "www.mgtvtv.com",
    "登记域名带 www. 时，命中的是登记域名本身",
  );
  console.log("  ✓ 登记域名带 www. 时命中登记域名");

  assert.strictEqual(matchSite("https://example.com/v/1", WATCHLIST), null);
  assert.strictEqual(matchSite("https://not-aiqiyi.ai.evil.com/v/1", WATCHLIST), null);
  console.log("  ✓ 未登记的站点不归任何站点");

  assert.strictEqual(matchSite("https://aiqiyi.ai/v/1", []), null);
  console.log("  ✓ 没有登记站点时什么都不命中");

  console.log("\n✅ All site-match tests passed!");
}

run();
