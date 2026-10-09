// Contract assertion for issue #23/#25: the store's public interface is its real
// interface. The composition root (main.js) and the IPC layer
// (agent/ipc-dispatcher.js) may only call named RecordStore methods — never
// private SQL helpers, event emission, or the domain stores behind the facade.
// This test is what keeps the SQL escape hatch from being reopened.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CALLERS = ["main.js", "agent/ipc-dispatcher.js"];
const PRIVATE = /\bstore\.(?:db|broadcast)\b|\._(?:dbAll|dbGet|dbGetScalar|dbRun|emit|migrate|seedDefaults|markDirty|onDirty|watchers|sweepOrphanWorks|findVisitByPath|siteRules)\b|\bstore\._(?:settings|sites|works|visits|agent|recommendations)\b/;

for (const file of CALLERS) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const hit = text.match(PRIVATE);
  assert.ok(
    !hit,
    `${file} reaches into a RecordStore private member: ${hit && hit[0]}`,
  );
}

console.log(
  `store-encapsulation: ${CALLERS.join(", ")} use only the store's named interface`,
);
