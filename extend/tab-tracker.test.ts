// Unit tests for TabTracker — mocks chrome.tabs and chrome.scripting in-process.

// ── Minimal chrome mocks ──────────────────────────────────────────────────────

const tabListeners = {
  onUpdated: new Set<(tabId: number, changeInfo: any, tab: any) => void>(),
  onActivated: new Set<(activeInfo: any) => void>(),
  onRemoved: new Set<(tabId: number) => void>(),
}

let scriptInjectResults: unknown[] = []
let scriptInjectArgs: unknown[][] = []

const mockChrome = {
  tabs: {
    onUpdated: {
      addListener: (cb: (tabId: number, changeInfo: any, tab: any) => void) => tabListeners.onUpdated.add(cb),
      removeListener: (cb: (tabId: number, changeInfo: any, tab: any) => void) => tabListeners.onUpdated.delete(cb),
    },
    onActivated: {
      addListener: (cb: (activeInfo: any) => void) => tabListeners.onActivated.add(cb),
      removeListener: (cb: (activeInfo: any) => void) => tabListeners.onActivated.delete(cb),
    },
    onRemoved: {
      addListener: (cb: (tabId: number) => void) => tabListeners.onRemoved.add(cb),
      removeListener: (cb: (tabId: number) => void) => tabListeners.onRemoved.delete(cb),
    },
  },
  scripting: {
    executeScript: async (opts: { args?: unknown[] }) => {
      scriptInjectArgs.push(opts?.args || [])
      return scriptInjectResults
    },
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
}

;(global as any).chrome = mockChrome

// ── Helpers ──────────────────────────────────────────────────────────────────

import { TabTracker, type RecordEvent, type DwellTimeEvent } from "./tab-tracker"
import type { Adapter } from "../shared/types"

const ADAPTERS: Adapter[] = [
  { name: "MacCMS", file: "maccms.json", detect: { pageGlobal: "maccms" } },
]

function createTracker() {
  const matchesWatchlist = (url: string) => {
    if (url.includes("example.com")) return { domain: "example.com", label: "Example", color: "#fff" }
    return null
  }
  const extractDomain = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, "") } catch { return null }
  }
  return new TabTracker({ matchesWatchlist, extractDomain, getAdapters: () => ADAPTERS })
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`  ✓ ${message}`)
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("Running TabTracker tests...\n")

  // Test 1: Start registers listeners
  console.log("Test: Start registers listeners")
  const tracker = createTracker()
  tracker.start()
  assert(tabListeners.onUpdated.size === 1, "onUpdated has 1 listener")
  assert(tabListeners.onActivated.size === 1, "onActivated has 1 listener")
  assert(tabListeners.onRemoved.size === 1, "onRemoved has 1 listener")
  tracker.stop()

  // Test 2: Stop removes listeners
  console.log("\nTest: Stop removes listeners")
  assert(tabListeners.onUpdated.size === 0, "onUpdated cleared")
  assert(tabListeners.onActivated.size === 0, "onActivated cleared")
  assert(tabListeners.onRemoved.size === 0, "onRemoved cleared")

  // Test 3: handleUrl ignores non-matching URLs
  console.log("\nTest: handleUrl ignores non-matching URLs")
  tracker.start()
  let recordFired = false
  let dwellFired = false
  tracker.onRecord(() => { recordFired = true })
  tracker.onDwellTime(() => { dwellFired = true })
  await tracker.handleUrl("https://nonexistent.com/video", 1, "Title")
  assert(!recordFired, "No record event for non-matching URL")
  tracker.stop()

  // Test 4: handleUrl ignores restricted URLs
  console.log("\nTest: handleUrl ignores restricted URLs")
  recordFired = false
  tracker.start()
  tracker.onRecord(() => { recordFired = true })
  await tracker.handleUrl("chrome://settings", 1, "Settings")
  assert(!recordFired, "No record event for chrome:// URL")
  tracker.stop()

  // Test 5: handleUrl creates record event
  console.log("\nTest: handleUrl creates record event")
  recordFired = false
  let capturedRecord: RecordEvent["data"] | null = null
  tracker.start()
  tracker.onRecord((evt) => {
    recordFired = true
    capturedRecord = evt.data
  })
  await tracker.handleUrl("https://www.example.com/video/1", 1, "Test Video")
  assert(recordFired, "Record event fired")
  assert(capturedRecord !== null, "Record data captured")
  assert(capturedRecord!.url === "https://www.example.com/video/1", "Record URL correct")
  assert(capturedRecord!.matchedRule === "example.com", "Record matchedRule correct")
  assert(capturedRecord!.title === "Test Video", "Record title correct")
  assert(capturedRecord!.tabId === 1, "Record tabId correct")
  tracker.stop()

  // Test 6: Dedup within 60s
  console.log("\nTest: Dedup within 60s")
  recordFired = false
  tracker.start()
  tracker.onRecord(() => { recordFired = true })
  await tracker.handleUrl("https://www.example.com/video/2", 2, "Duplicate")
  assert(recordFired, "First visit creates record")
  recordFired = false
  await tracker.handleUrl("https://www.example.com/video/2", 2, "Duplicate")
  assert(!recordFired, "Duplicate within 60s ignored")
  tracker.stop()

  // Test 7: flushDwellTime updates record
  console.log("\nTest: flushDwellTime updates record")
  let dwellEvent: DwellTimeEvent | null = null
  tracker.start()
  tracker.onDwellTime((evt) => { dwellEvent = evt })
  // Simulate tab entry time
  ;(tracker as any).tabEntryTimes[10] = Date.now() - 2000
  ;(tracker as any).tabLastRecordId[10] = capturedRecord!.id
  tracker.flushDwellTime(10)
  assert(dwellEvent !== null, "DwellTime event fired")
  assert(dwellEvent!.data.dwellTime !== undefined, "Dwell time calculated")
  assert(dwellEvent!.data.dwellTime >= 2000, "Dwell time is ~2000ms")
  tracker.stop()

  // Test 8: Tab activation flushes previous tab
  console.log("\nTest: Tab activation flushes previous tab")
  dwellEvent = null
  // Clear any leftover state from previous tests
  ;(tracker as any).tabEntryTimes = {}
  ;(tracker as any).tabLastRecordId = {}
  tracker.start()
  tracker.onDwellTime((evt) => { dwellEvent = evt })
  // Tab 10 was active, now tab 11 activates
  ;(tracker as any).tabEntryTimes[10] = Date.now() - 5000
  ;(tracker as any).tabLastRecordId[10] = capturedRecord!.id
  tabListeners.onActivated.forEach((cb) => cb({ tabId: 11, previousTabId: 10 }))
  assert(dwellEvent !== null, "Previous tab dwell time flushed on activation")
  tracker.stop()

  // Test 9: Max records cap
  console.log("\nTest: Max records cap")
  tracker.start()
  tracker.onRecord(() => {})
  for (let i = 0; i < 600; i++) {
    await tracker.handleUrl(`https://www.example.com/video/${i}`, 100 + i, `Video ${i}`)
  }
  const allRecords = tracker.getRecords()
  assert(allRecords.length <= 500, "Records capped at 500")
  tracker.stop()

  // Test 10: Script injection updates record
  console.log("\nTest: Script injection updates record")
  scriptInjectArgs = []
  scriptInjectResults = [{
    result: {
      description: "Test description",
      ogImage: "https://example.com/og.jpg",
      pageSignature: ["maccms", "ewave_config"],
      pageFields: { "maccms.json": { cover: "https://x.com/upload/vod/20260101-1/c0a55b31c915cab3d80e9863f54f2ee0.webp" } },
    },
  }]
  recordFired = false
  let injectedRecord: RecordEvent["data"] | null = null
  tracker.start()
  tracker.onRecord((evt) => {
    recordFired = true
    injectedRecord = evt.data
  })
  await tracker.handleUrl("https://www.example.com/video/injected", 50, "Injected")
  assert(recordFired, "Record event fired after injection")
  assert(injectedRecord!.description === "Test description", "Description injected")
  assert(injectedRecord!.ogImage === "https://example.com/og.jpg", "OG image injected")
  assert(injectedRecord!.pageSignature?.includes("maccms") === true, "页面签名随访问回传")
  assert(
    typeof injectedRecord!.pageFields?.["maccms.json"].cover === "string",
    "适配器 collect 抽到的字段随访问回传",
  )
  assert(scriptInjectArgs[0][0] === ADAPTERS, "桌面端推过来的适配器被带进页面采集")
  tracker.stop()
  scriptInjectResults = []

  console.log("\n✅ All TabTracker tests passed!")
  process.exit(0)
}

runTests().catch((err) => {
  console.error("\n❌ Test failed:", err)
  process.exit(1)
})
