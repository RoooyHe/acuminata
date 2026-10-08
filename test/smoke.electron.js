// Electron smoke test — boots the REAL app (main.js) with the REAL preload and
// the REAL renderer page, against a throwaway database, and asserts:
//   1. window.electronAPI exists and every route is callable
//   2. every invoke channel round-trips (a handler is actually registered)
//   3. the renderer rendered real data read over IPC
// Run with: npm run test:smoke

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { loadPreloadRoutes } = require("./preload-routes");

const SEED_TITLE = "SMOKE 预置记录 α";
const TIMEOUT_MS = 60000;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acuminata-smoke-"));
const dbPath = path.join(tmpDir, "tracker.db");
// Only explicit setting wins; this keeps main.js away from the user's real DB.
process.env.ACUMINATA_DB_PATH = dbPath;

const routes = loadPreloadRoutes().routes;

async function seedDatabase() {
  const { RecordStore } = require("../agent/record-store");
  const store = new RecordStore(dbPath);
  await store.init();
  store.insertRecord({
    id: "smoke-1",
    url: "https://bilibili.com/video/smoke",
    title: SEED_TITLE,
    domain: "bilibili.com",
    matchedRule: "bilibili.com",
    tabId: 1,
    timestamp: Date.now(),
  });
  fs.writeFileSync(dbPath, Buffer.from(store.export()));
}

function waitForWindow() {
  return new Promise((resolve, reject) => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) return resolve(existing);
    const timer = setTimeout(
      () => reject(new Error("no BrowserWindow was created")),
      TIMEOUT_MS,
    );
    app.once("browser-window-created", (_, win) => {
      clearTimeout(timer);
      resolve(win);
    });
  });
}

function waitForLoad(win) {
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once("did-finish-load", resolve);
  });
}

// Runs inside the renderer: the only place where window.electronAPI is real.
function pageProbe(invokeRoutes) {
  return `(async () => {
    const routes = ${JSON.stringify(invokeRoutes)};
    const api = window.electronAPI;
    const out = {
      hasAPI: !!api && typeof api === "object",
      hasSharedUtils: !!window.sharedUtils && typeof window.sharedUtils.formatTime === "function",
      missingRoutes: [],
      unregistered: [],
      watchlistText: "",
      recordsText: "",
    };
    if (!out.hasAPI) return out;

    for (const r of routes) {
      if (typeof api[r.name] !== "function") out.missingRoutes.push(r.name);
    }

    // Wait for the renderer's async init() to finish painting data.
    const deadline = Date.now() + 10000;
    const rendered = () => {
      const el = document.getElementById("recordsContainer");
      return el && el.textContent.includes(${JSON.stringify(SEED_TITLE)});
    };
    while (!rendered() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const wl = document.getElementById("watchlist");
    const rc = document.getElementById("recordsContainer");
    out.watchlistText = wl ? wl.textContent : "";
    out.recordsText = rc ? rc.textContent : "";

    // Round-trip every route. A missing handler rejects with distinctive text;
    // channels that need arguments may reject with a handler-level error, which
    // still proves the invoke reached a handler, so only the former is a failure.
    for (const r of routes) {
      if (typeof api[r.name] !== "function") continue;
      try {
        await api[r.name]();
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/No handler registered/i.test(msg)) {
          out.unregistered.push(r.channel + " (" + msg + ")");
        }
      }
    }
    return out;
  })()`;
}

async function main() {
  await seedDatabase();
  require("../main.js");

  await app.whenReady();
  const win = await waitForWindow();
  win.hide();
  win.on("ready-to-show", () => win.hide());

  // Acceptance: the renderer console must be free of errors (e.g. failed IPC).
  // Electron 42 passes the details object first; the positional level/message are
  // deprecated fallbacks.
  const consoleErrors = [];
  win.webContents.on("console-message", (...args) => {
    const details = args[0];
    const level = details && typeof details === "object" ? details.level : args[1];
    const message = details && typeof details === "object" ? details.message : args[2];
    if (level === "error" || level === 3) consoleErrors.push(String(message));
  });

  await waitForLoad(win);

  const invokeRoutes = routes
    .filter((r) => r.invoke)
    .map((r) => ({ name: r.name, channel: r.channel }));
  const probe = await win.webContents.executeJavaScript(
    pageProbe(invokeRoutes),
  );

  const failures = [];
  const expect = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  expect(probe.hasAPI, "window.electronAPI is not an object");
  expect(
    probe.hasSharedUtils,
    "window.sharedUtils was not provided by the shared utils <script>",
  );
  expect(
    probe.missingRoutes.length === 0,
    "routes missing from electronAPI: " + probe.missingRoutes.join(", "),
  );
  expect(
    probe.unregistered.length === 0,
    "channels with no registered handler: " + probe.unregistered.join(", "),
  );
  expect(
    probe.watchlistText.includes("bilibili.com"),
    "renderer did not render the seeded watchlist entry",
  );
  expect(
    probe.recordsText.includes(SEED_TITLE),
    "renderer did not render the seeded record",
  );
  expect(
    consoleErrors.length === 0,
    "renderer console errors: " + consoleErrors.join(" | "),
  );

  if (failures.length) {
    console.error("SMOKE FAILED");
    for (const f of failures) console.error("  ✗ " + f);
    console.error("probe: " + JSON.stringify(probe));
    return 1;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(
    `SMOKE PASSED: ${invokeRoutes.length} channels round-tripped, renderer painted seeded data`,
  );
  return 0;
}

const watchdog = setTimeout(() => {
  console.error("SMOKE FAILED: timed out after " + TIMEOUT_MS + "ms");
  app.exit(1);
}, TIMEOUT_MS);

main()
  .then((code) => {
    clearTimeout(watchdog);
    app.exit(code);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error("SMOKE FAILED: " + (err && err.stack ? err.stack : err));
    app.exit(1);
  });
