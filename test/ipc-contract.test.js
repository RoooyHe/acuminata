// Contract assertion: the channels preload exposes and the handlers the
// dispatcher registers must match exactly, in both directions. They are two
// handwritten lists; this test is what keeps them from drifting apart.

const assert = require("assert");
const { createIPCDispatcher } = require("../agent/ipc-dispatcher");
const { loadPreloadRoutes } = require("./preload-routes");

// Compare two channel lists; returns the two one-sided differences.
function channelDiff(exposed, registered) {
  const e = new Set(exposed);
  const r = new Set(registered);
  return {
    exposedNotRegistered: [...e].filter((c) => !r.has(c)),
    registeredNotExposed: [...r].filter((c) => !e.has(c)),
  };
}

function assertChannelsConsistent(exposed, registered) {
  const { exposedNotRegistered, registeredNotExposed } = channelDiff(
    exposed,
    registered,
  );
  if (exposedNotRegistered.length || registeredNotExposed.length) {
    throw new Error(
      "IPC channel contract violated:\n" +
        `  exposed but no handler: ${exposedNotRegistered.join(", ") || "(none)"}\n` +
        `  handler but not exposed: ${registeredNotExposed.join(", ") || "(none)"}`,
    );
  }
}

// ── Real lists ───────────────────────────────────────────────────────────────

const { routes } = loadPreloadRoutes();
const exposedInvokeChannels = routes
  .filter((r) => r.invoke)
  .map((r) => r.channel);

const registeredChannels = [];
// Fake ipcMain: records whatever the real dispatcher registers. Fake store only
// needs the one method the factory calls eagerly.
createIPCDispatcher(
  { handle: (channel) => registeredChannels.push(channel) },
  { getAgentReadStore: () => ({}) },
  {},
);

assert.deepStrictEqual(
  channelDiff(exposedInvokeChannels, registeredChannels),
  { exposedNotRegistered: [], registeredNotExposed: [] },
  "preload route table and dispatcher handlers must match",
);
assert.ok(registeredChannels.length > 0, "dispatcher registered no handlers");

// ── The assertion really fails in both directions ────────────────────────────

assert.throws(
  () => assertChannelsConsistent(["a", "b"], ["a"]),
  /exposed but no handler: b/,
  "exposed-but-not-registered must fail",
);

assert.throws(
  () => assertChannelsConsistent(["a"], ["a", "b"]),
  /handler but not exposed: b/,
  "registered-but-not-exposed must fail",
);

console.log(
  `ipc-contract: ${exposedInvokeChannels.length} channels consistent; both mismatch directions fail`,
);
