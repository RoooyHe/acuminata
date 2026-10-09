import type { WatchlistEntry, HistoryRecord } from "../shared/types"
import { createAIProviders } from "../agent/providers"
import { buildAnalysisPrompt } from "../agent/prompts"
import { analyzePrompt } from "../agent/analysis-pipeline"
import { TabTracker } from "./tab-tracker"
import { WsTransport } from "./ws-transport"

const WS_URL = "ws://127.0.0.1:8766"

type Mode = "ws" | "local"

let watchlist: WatchlistEntry[] = []
let enabled = true
let records: HistoryRecord[] = []
let mode: Mode = "ws"

let aiProvider = "ollama"
let aiEndpoint = "http://127.0.0.1:11434"
let aiApiKey = ""
let aiModel = "qwen2.5:7b"

function getAIConfig() {
  return {
    provider: aiProvider,
    endpoint: aiEndpoint,
    apiKey: aiApiKey,
    model: aiModel,
  }
}

// Browser transport for agent/providers.js
async function browserHttpRequest(urlStr: string, options: { method?: string; headers?: Record<string, string>; body?: string }, timeout = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(urlStr, {
      method: options.method || "POST",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    return { status: res.status, data: text }
  } finally {
    clearTimeout(timer)
  }
}

const aiProviders = createAIProviders(getAIConfig, browserHttpRequest)

// ── Pure helpers ──────────────────────────────────────────────────────────────

function extractDomain(url: string): string | null {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, "")
  } catch (e) {
    return null
  }
}

function matchesWatchlist(url: string): WatchlistEntry | null {
  const domain = extractDomain(url)
  if (!domain) return null
  for (const entry of watchlist) {
    const pattern = entry.domain
      .replace(/^www\./, "")
      .toLowerCase()
      .trim()
    if (domain === pattern || domain.endsWith("." + pattern)) {
      return entry
    }
  }
  return null
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function saveLocal() {
  try {
    await chrome.storage.local.set({ watchlist, enabled, records, mode, aiProvider, aiEndpoint, aiApiKey, aiModel })
  } catch (e) {
    // ignore
  }
}

async function loadLocal() {
  try {
    const result = await chrome.storage.local.get([
      "watchlist",
      "enabled",
      "records",
      "mode",
      "aiProvider",
      "aiEndpoint",
      "aiApiKey",
      "aiModel",
    ])
    watchlist = (result.watchlist as WatchlistEntry[]) || []
    enabled = result.enabled !== false
    records = (result.records as HistoryRecord[]) || []
    mode = (result.mode as Mode) || "ws"
    aiProvider = (result.aiProvider as string) || "ollama"
    aiEndpoint = (result.aiEndpoint as string) || "http://127.0.0.1:11434"
    aiApiKey = (result.aiApiKey as string) || ""
    aiModel = (result.aiModel as string) || "qwen2.5:7b"
  } catch (e) {
    watchlist = []
    enabled = true
    records = []
    mode = "ws"
    aiProvider = "ollama"
    aiEndpoint = "http://127.0.0.1:11434"
    aiApiKey = ""
    aiModel = "qwen2.5:7b"
  }
}

// ── WS message handling ───────────────────────────────────────────────────────

interface WsMessage {
  type: string
  watchlist?: WatchlistEntry[]
  records?: HistoryRecord[]
  enabled?: boolean
  record?: HistoryRecord
}

function handleMessage(msg: WsMessage) {
  switch (msg.type) {
    case "init":
      watchlist = msg.watchlist || []
      enabled = msg.enabled !== false
      saveLocal()
      break
    case "watchlistUpdated":
      watchlist = msg.watchlist || []
      saveLocal()
      break
    case "enabledUpdated":
      enabled = !!msg.enabled
      saveLocal()
      break
    case "recordAdded":
      if (msg.record) {
        const exists = records.some((r) => r.id === msg.record!.id)
        if (!exists) {
          records.unshift(msg.record)
          if (records.length > 500) records.splice(500)
          saveLocal()
        }
      }
      break
    case "recordsCleared":
      records = []
      saveLocal()
      break
    case "recordUpdated":
      if (msg.record) {
        const idx = records.findIndex((r) => r.id === msg.record!.id)
        if (idx !== -1) {
          records[idx] = msg.record
        } else {
          records.unshift(msg.record)
          if (records.length > 500) records.splice(500)
        }
        saveLocal()
      }
      break
    case "stats":
      break
  }
}

// ── Composition ───────────────────────────────────────────────────────────────

const tracker = new TabTracker({ matchesWatchlist, extractDomain })
const transport = new WsTransport()

// Wire tracker events -> persistence + WS
tracker.onRecord((evt) => {
  records.unshift(evt.data)
  if (records.length > 500) records.splice(500)
  saveLocal()
  if (mode === "ws") transport.send({ type: "addRecord", ...evt.data })
})

tracker.onDwellTime((evt) => {
  const idx = records.findIndex((r) => r.id === evt.data.id)
  if (idx !== -1) {
    records[idx] = evt.data
  } else {
    records.unshift(evt.data)
    if (records.length > 500) records.splice(500)
  }
  saveLocal()
  if (mode === "ws") transport.send({ type: "recordUpdated", record: evt.data })
})

// Wire WS messages -> handler
transport.onMessage((msg) => {
  handleMessage(msg as WsMessage)
})

// ── Bootstrap ────────────────────────────────────────────────────────────────

loadLocal().then(() => {
  tracker.start()
  if (mode === "ws") transport.connect(WS_URL)
})

// ── Runtime API ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if ((msg as { type: string }).type === "GET_STATS") {
    const stats: Record<string, number> = {}
    for (const r of records) {
      stats[r.matchedRule] = (stats[r.matchedRule] || 0) + 1
    }
    sendResponse({ total: records.length, stats, enabled, mode })
  } else if ((msg as { type: string }).type === "SYNC_WATCHLIST") {
    watchlist = (msg as { watchlist: WatchlistEntry[] }).watchlist
    saveLocal()
    if (mode === "ws") transport.send({ type: "updateWatchlist", watchlist })
  } else if ((msg as { type: string }).type === "SYNC_ENABLED") {
    enabled = (msg as { enabled: boolean }).enabled
    saveLocal()
    if (mode === "ws") transport.send({ type: "enabledUpdated", enabled })
  } else if ((msg as { type: string }).type === "TOGGLE_RECORD_PIN") {
    const id = (msg as { id: string }).id
    const idx = records.findIndex((r) => r.id === id)
    if (idx !== -1) {
      const rec = records[idx]
      const newPinned = rec.pinned ? 0 : 1
      const newScore = newPinned && rec.score == null ? 50 : rec.score
      records[idx] = { ...rec, pinned: newPinned, score: newScore }
      saveLocal()
      if (mode === "ws") transport.send({ type: "recordUpdated", record: records[idx] })
    }
    sendResponse({ success: true })
  } else if ((msg as { type: string }).type === "SET_MODE") {
    const newMode = (msg as { mode: Mode }).mode
    if (newMode === "ws" || newMode === "local") {
      mode = newMode
      saveLocal()
      if (mode === "ws") {
        transport.connect(WS_URL)
      } else {
        transport.disconnect()
      }
    }
    sendResponse({ success: true })
  } else if ((msg as { type: string }).type === "GET_AI_CONFIG") {
    sendResponse({ provider: aiProvider, endpoint: aiEndpoint, apiKey: aiApiKey ? "●●●●" + aiApiKey.slice(-4) : "", model: aiModel })
  } else if ((msg as { type: string }).type === "SET_AI_CONFIG") {
    const cfg = msg as { provider?: string; endpoint?: string; apiKey?: string; model?: string }
    if (cfg.provider) aiProvider = cfg.provider
    if (cfg.endpoint) aiEndpoint = cfg.endpoint
    if (cfg.apiKey && !cfg.apiKey.startsWith("●●●●")) aiApiKey = cfg.apiKey
    if (cfg.model) aiModel = cfg.model
    saveLocal()
    sendResponse({ success: true })
  } else if ((msg as { type: string }).type === "AI_ANALYZE") {
    const prompt = buildAnalysisPrompt(records, watchlist)
    analyzePrompt(aiProviders, prompt).then((result) => {
      sendResponse(result)
    }).catch((e) => {
      sendResponse({ error: String(e) })
    })
    return true
  }
  return true
})
