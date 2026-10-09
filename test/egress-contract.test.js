// Contract assertion for issue #22: the extension is capture-only, and the
// desktop owns both the model provider and the prompt text.
//
// "What leaves the machine" is audited in two places, and this test pins both:
//   - agent/prompts.js        the prompt text sent to the model
//   - main.js                 the single provider instance that can send it
// The extension may talk to nothing but the local desktop WebSocket.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXTEND = path.join(ROOT, "extend");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// 1. The extension must not reach a model: no import of the desktop's agent
//    modules, and no transport that can leave the browser (fetch/XHR/beacon).
//    Pattern-based, so renaming provider methods cannot disarm the guard.
const FORBIDDEN = [
  { re: /from\s+["'][^"']*agent\//, why: "imports a desktop agent module" },
  { re: /require\(["'][^"']*agent\//, why: "requires a desktop agent module" },
  { re: /\bfetch\s*\(/, why: "calls fetch()" },
  { re: /\bXMLHttpRequest\b/, why: "uses XMLHttpRequest" },
  { re: /sendBeacon/, why: "uses navigator.sendBeacon" },
];
const extSources = walk(EXTEND).filter(
  (p) =>
    /\.(ts|tsx)$/.test(p) &&
    !/[\\/](node_modules|build|\.plasmo)[\\/]/.test(p),
);
assert.ok(extSources.length > 0, "found extension sources to scan");
for (const file of extSources) {
  const text = read(file);
  for (const { re, why } of FORBIDDEN) {
    assert.ok(
      !re.test(text),
      `${path.relative(ROOT, file)} must not ${why} (extension has no model egress)`,
    );
  }
}

// 2. The manifest lets the extension reach only the local desktop / dev server.
const manifest = JSON.parse(read(path.join(EXTEND, "package.json"))).manifest;
const csp = manifest.content_security_policy.extension_pages;
const connectSrc = csp.split(";").find((d) => d.trim().startsWith("connect-src"));
assert.ok(connectSrc, "extension CSP declares connect-src");
assert.ok(
  !/https:\/\//.test(connectSrc),
  "extension connect-src must not allow remote https hosts: " + connectSrc,
);

// 3. One provider instance for the whole repo, in main.js only.
const scanned = [path.join(ROOT, "main.js"), path.join(ROOT, "preload.js")].concat(
  walk(path.join(ROOT, "agent")).filter((p) => p.endsWith(".js") && !p.endsWith(".test.js")),
);
const providerCallers = scanned
  .filter((p) => path.basename(p) !== "providers.js")
  .filter((p) => read(p).includes("createAIProviders("))
  .map((p) => path.relative(ROOT, p).replace(/\\/g, "/"));
assert.deepStrictEqual(
  providerCallers,
  ["main.js"],
  "exactly one runtime provider instance (main.js) may exist",
);

// 4. Feature-level prompt text is built only in agent/prompts.js; callers pass
//    the resulting messages to the loop instead of writing role/content inline.
const dispatcher = read(path.join(ROOT, "agent", "ipc-dispatcher.js"));
assert.ok(
  !/"role"\s*:/.test(dispatcher),
  "agent/ipc-dispatcher.js must build model messages via agent/prompts.js, not inline",
);

console.log(
  "egress-contract: extension has no model egress; provider and prompts live only in the desktop",
);
