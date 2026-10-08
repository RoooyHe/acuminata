// Loads preload.js outside Electron so tests can read its route table.
// Throws if preload requires anything other than `electron` — that is exactly
// the sandbox constraint we want to keep enforced.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadPreloadRoutes() {
  const src = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    console,
    require(id) {
      if (id === "electron") {
        return {
          contextBridge: { exposeInMainWorld() {} },
          ipcRenderer: { invoke: async () => undefined, on() {} },
        };
      }
      throw new Error(`preload must only require "electron", got "${id}"`);
    },
  };
  vm.runInNewContext(src, sandbox, { filename: "preload.js" });
  return { routes: moduleObj.exports.ROUTES };
}

module.exports = { loadPreloadRoutes };
