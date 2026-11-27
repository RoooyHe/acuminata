const assert = require("assert");
const { normalizeAddress } = require("../site-page");

assert.strictEqual(
  normalizeAddress("  example.com/v/42  "),
  "https://example.com/v/42",
);
assert.strictEqual(
  normalizeAddress("localhost:8080/v/42?from=address"),
  "https://localhost:8080/v/42?from=address",
);
assert.strictEqual(
  normalizeAddress("http://127.0.0.1:8080/v/42?x=1#player"),
  "http://127.0.0.1:8080/v/42?x=1#player",
);
assert.strictEqual(
  normalizeAddress("https://example.com"),
  "https://example.com/",
);

for (const address of [
  "",
  "   ",
  "https://",
  "two words",
  "file:///tmp/private.html",
  "javascript:alert(1)",
  "mailto:user@example.com",
]) {
  assert.throws(() => normalizeAddress(address), undefined, address);
}

console.log("site-page-address: HTTP(S), bare hosts, and rejected inputs behave as specified");
