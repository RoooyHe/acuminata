// Contract assertion for issue #22: the desktop owns both the model provider
// and the prompt text.
//
// "What leaves the machine" is audited in two places, and this test pins both:
//   - agent/prompts.js        the prompt text sent to the model
//   - main.js                 the single provider instance that can send it

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// 1. One provider instance for the whole repo, in main.js only.
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

// 2. Feature-level prompt text is built only in agent/prompts.js; callers pass
//    the resulting messages to the loop instead of writing role/content inline.
const dispatcher = read(path.join(ROOT, "agent", "ipc-dispatcher.js"));
assert.ok(
  !/"role"\s*:/.test(dispatcher),
  "agent/ipc-dispatcher.js must build model messages via agent/prompts.js, not inline",
);

console.log(
  "egress-contract: provider and prompts live only in the desktop",
);
