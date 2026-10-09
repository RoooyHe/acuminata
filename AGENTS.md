# Acuminata

Electron desktop app + Chrome extension for tracking browsing history with AI agent analysis.

## Project layout

| Directory | What | Tech |
|---|---|---|
| `/` (root) | Electron desktop app | Node.js, sql.js, ws |
| `extend/` | Chrome extension (Manifest V3) | Plasmo, React 18, TypeScript |
| `ui/` | Desktop renderer (no framework) | vanilla HTML/JS |
| `shared/` | Dual-mode view models (`require` in node, global via `<script>` in the renderer) | vanilla JS |
| `agent/` | AI agent modules | Node.js (imported by main.js) |
| `agent/store/` | Domain stores behind `RecordStore` (each owns its schema) | Node.js, sql.js |
| `locales/` | i18n JSON | zh-CN only currently |

Two separate `package.json` files — **root** (Electron) and **extend/** (Plasmo extension).

## Commands

```
# Desktop
npm start          # launch Electron
npm run dev        # launch with DevTools open
npm test           # run agent/*.test.js + test/*.test.js (no Electron needed)
npm run test:smoke # Electron smoke test: hidden window, real preload + renderer, temp DB

# Extension (cd extend/)
npm run build      # production build → build/chrome-mv3-prod/
npm run dev        # dev with HMR
npx tsc --noEmit  # type-check only
```

Load the Chrome extension from `extend/build/chrome-mv3-prod/`.

## Architecture

**Electron app is the source of truth.** It runs a WebSocket server on `127.0.0.1:8766` (loopback only — same-network hosts must not reach browsing history) and stores data in SQLite (via `sql.js`). DB path: `app.getPath("userData")/tracker.db`, overridable with `ACUMINATA_DB_PATH` (used by `npm run test:smoke` to avoid the real DB). The DB auto-saves with 1s debounce, flushed on quit.

```
Browser → extension (background.ts) → WS → Electron (main.js) → SQLite
                                                ↓
                                        broadcast to renderer (ui/)
```

**Chrome extension** has two modes, persisted in `chrome.storage.local.mode`:

- `"ws"`: connects to `ws://127.0.0.1:8766`, sends/receives records bidirectionally
- `"local"`: stores in `chrome.storage.local` only, max 500 records (oldest evicted), no WS

Extension files:
- `background.ts` — service worker, tab tracking, WS client, mode switching
- `popup.tsx` — stats overview only (total, today, sites, top domain); no record list
- `options.tsx` — settings + full 500-record list with search, domain filter chips, pin toggle, date groups

When mode changes (SET_MODE message), `background.ts` connects or disconnects WS immediately.

The extension does not parse pages itself: the desktop pushes the **adapters** in the `init` message, and the extension injects `shared/page-collect.js`'s `collectPage` to report the **page signature** (`pageSignature`) plus the fields each adapter's `collect` rules found (`pageFields`). The desktop alone decides which adapter claims the page (`detectBySignature`), so a MacCMS site gets a content-code identity key even when the user wrote no regex. `agent/adapter.test.js` and `agent/maccms-signature.e2e.test.js` run that same injected function against the real page fixtures.

## Data model (SQLite)

Tables: `records`, `works`, `work_keys`, `watchlist`, `settings`, `candidates`, `recommendations`.

`candidates` is the pool of entries scraped from adapter-declared list pages (`list`), and `recommendations` is the ranked, reasoned output — two tables because the pool is raw and unranked (ADR-0005). `agent/store/candidates.js` owns it; `agent/adapter.js`'s `listFetchTargets` / `isListPageUrl` decide which list pages are fetched and which URLs are list pages (dropped, not recorded as a visit). Scraping happens in a hidden `BrowserWindow` in `main.js` (`candidates:fetch`, user-clicked), running `shared/page-collect.js`'s `collectListEntries` — the same self-contained collect rules the extension uses for visits.

`records` is a **visit event**; `works` is the content itself, fused across sites. `work_keys` holds one or more identity keys per work (content code / cover hash / normalized title / synopsis fingerprint) — any single match merges. Daily +1 scoring lives on `works`, so the same work watched on two sites accumulates into one score.

Key columns in `records`: `id`, `url`, `title`, `domain`, `site` (adapters' declared mirror group's canonical domain, so mirrors are one source), `matchedRule`, `tabId`, `timestamp`, `pinned`, `score`, `workId`, `createdAt`, `updatedAt`. `pageSignature` (JSON) and `pageFields` (JSON) persist what the extension saw on the page — they are the pure input to `parse`, so re-running parsing needs no re-fetch.

Deduplication: same URL + same tabId within 60s is ignored. `chrome://` and `chrome-extension://` URLs are never tracked.

The **visit write path** is one call, `RecordStore.recordVisit(incoming)` — 列表页丢弃 → 闸门 → 身份键 → 同组同路径去重 → 当日计分 → 作品归属 → 落库, so the call order is testable. `RecordStore` (`agent/record-store.js`) is the composition root and stable facade: it owns the SQLite handle and lifecycle, and forwards to the domain stores in `agent/store/` — `settings`, `sites`, `works`, `visits`, `candidates`, `agent`, `recommendations` — each of which declares its own schema via `X.schema(db)`. Settings, sites and agent-memory are testable with that schema alone; works reads `records` and visits reads sites + works, so those take their collaborators as dependencies. `main.js` calls `recordVisit` once per reported visit and only adds the adapter-health broadcast when the visit produced no record broadcast (drop / ignore); the visit's own broadcast (record + affected work row + stats + health) comes from `Visits._emitVisit`, and the renderer patches only the affected rows from it instead of re-pulling stats / works page / health / detail. Every server→client domain broadcast goes through `toClientMessage` (`agent/broadcast.js`) so each event carries the named field its client reads (`watchlist` / `record` / `enabled` / `health`). Callers never pass a dedup callback. The agent's `add_record` tool goes through the same call via `getAgentWriteStore().recordVisit` — there is no second implementation of the attribution channel. Removing visits (single, batch, or all) sweeps works left with none, so no orphan work score survives; moving a visit off its work on a re-visit sweeps it too. Within it: same-path URLs across different domains in the same watchlist group are treated as duplicates, and daily re-visits auto-pin records with score increment (max 1/day). Identity keys and the pure rules live in `agent/identity.js` / `agent/cluster.js`. `WorkStore.reparseWorks()` (IPC `works:reparse`, UI "重新解析历史") clears the derived work rows (`workId` / `works` / `work_keys` / `work_ambiguities`) and re-attributes **every** stored visit through the same `identityKeysFor` path — so fixing an adapter improves all history, not just new visits. `backfillWorks` is the incremental subset (unattributed only, per #6).

## IPC channels (renderer ↔ main)

`preload.js` holds the route table: each entry maps a public API `name` (e.g. `getRecordsPage`, `getStatistics`, `toggleRecordPin`, `addToWatchlist`/`removeFromWatchlist`, `triggerAgentAnalysis`, `agentApproveActions`/`agentDismissActions`, `backfillWorks`/`reparseWorks`) to an `域:动作` IPC `channel` registered by `agent/ipc-dispatcher.js`. `test/ipc-contract.test.js` asserts the two lists match in both directions.

## Design system

`DESIGN.md` is authoritative. All UI must follow:

- **Colors** (CSS vars): `--background:#000`, `--foreground:#fff`, `--muted:#1a1a1a`, `--muted-fg:#767d88`, `--border:#27272a`
- **Zero shadows** — no `box-shadow` anywhere
- **No gradients** in the interface
- **Typography**: single sans-serif (Inter/system-ui), JetBrains Mono for data values only; tight line-heights (1.0–1.4), negative letter-spacing on headings
- **Radius**: 4px (buttons), 8px (cards/containers), no pill shapes
- **Buttons**: transparent background, thin border, Cool Slate text; no filled backgrounds

Both `ui/index.html` and `extend/options.tsx` use matching CSS variable blocks. Keep them in sync.

## Key gotchas

- Two `package.json` — `npm install` in root **and** `extend/` separately
- Chrome extension CSP blocks external fonts; uses `system-ui` / `JetBrains Mono` fallback stack
- Extension uses Plasmo v0.90.5 — entrypoints autodetected by filename convention (`background.ts`, `popup.tsx`, `options.tsx`)
- `sql.js` returns all rows as objects (not arrays); migrated from WASM file buffer, not native SQLite
- The Electron app is single-instance locked (`requestSingleInstanceLock`)
- Extension `options.tsx` was refactored to match `ui/` CSS patterns — if changing one, check the other

## Agent skills

### Issue tracker

Issues live in the repo's GitHub Issues, accessed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to the default label strings — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. Read `CONTEXT.md` at the repo root, plus ADRs in `docs/adr/`. See `docs/agents/domain.md`.
