// TabTracker — owns chrome.tabs event listeners, dwell-time logic, and record creation.
// Emits plain events; the caller persists them.
// Designed so a future RecordStore abstraction can replace the persistence layer.

import type { Adapter, WatchlistEntry, HistoryRecord } from "../shared/types"
import { collectPage } from "../shared/page-collect"

type RecordEvent = { type: "record"; data: HistoryRecord }
type DwellTimeEvent = { type: "dwellTime"; data: HistoryRecord }

type RecordCallback = (evt: RecordEvent) => void
type DwellTimeCallback = (evt: DwellTimeEvent) => void

interface TabTrackerDeps {
  matchesWatchlist: (url: string) => WatchlistEntry | null
  extractDomain: (url: string) => string | null
  /** 桌面端推过来的适配器；扩展拿它们在页面上认签名、抽字段。 */
  getAdapters: () => Adapter[]
}

class TabTracker {
  private records: HistoryRecord[] = []
  private tabEntryTimes: Record<number, number> = {}
  private tabLastRecordId: Record<number, string> = {}
  private onRecordCbs: Set<RecordCallback> = new Set()
  private onDwellTimeCbs: Set<DwellTimeCallback> = new Set()
  private maxRecords = 500

  constructor(private deps: TabTrackerDeps) {}

  onRecord(cb: RecordCallback) { this.onRecordCbs.add(cb) }
  onDwellTime(cb: DwellTimeCallback) { this.onDwellTimeCbs.add(cb) }

  start() {
    chrome.tabs.onUpdated.addListener(this.onTabUpdated)
    chrome.tabs.onActivated.addListener(this.onTabActivated)
    chrome.tabs.onRemoved.addListener(this.onTabRemoved)
  }

  stop() {
    chrome.tabs.onUpdated.removeListener(this.onTabUpdated)
    chrome.tabs.onActivated.removeListener(this.onTabActivated)
    chrome.tabs.onRemoved.removeListener(this.onTabRemoved)
  }

  private onTabUpdated = (tabId: number, changeInfo: { status?: string; url?: string }, tab: { url?: string; title?: string; favIconUrl?: string }) => {
    if (changeInfo.status === "complete" && tab.url) {
      this.handleUrl(tab.url, tabId, tab.title || "", tab.favIconUrl || "")
    }
  }

  private onTabActivated = (activeInfo: { tabId: number; previousTabId?: number }) => {
    const prevTabId = Object.keys(this.tabEntryTimes).map(Number).find((t) => t !== activeInfo.tabId)
    if (prevTabId) this.flushDwellTime(prevTabId)
    this.tabEntryTimes[activeInfo.tabId] = Date.now()
  }

  private onTabRemoved = (tabId: number) => {
    this.flushDwellTime(tabId)
  }

  async handleUrl(url: string, tabId: number, title: string, favIconUrl?: string) {
    if (!url) return
    if (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("moz-extension://")
    )
      return

    const matched = this.deps.matchesWatchlist(url)
    if (!matched) return

    const now = Date.now()
    const isDuplicate = this.records.some(
      (r) => r.url === url && r.tabId === tabId && now - r.timestamp < 60000,
    )
    if (isDuplicate) return

    this.tabEntryTimes[tabId] = now

    const record: HistoryRecord = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: title || "",
      domain: this.deps.extractDomain(url) || matched.domain,
      matchedRule: matched.domain,
      tabId,
      timestamp: now,
      favIconUrl: favIconUrl || "",
    }

    // 先进内存再去页面上取数据：同一页的并发上报因此在 await 之前就被去重挡住。
    this.records.unshift(record)
    if (this.records.length > this.maxRecords) this.records.splice(this.maxRecords)
    this.tabLastRecordId[tabId] = record.id

    await this.injectPageData(tabId, record)

    // 只发一次（带页面签名与采集字段）：这一条就是桌面端算身份键的输入。
    for (const cb of this.onRecordCbs) cb({ type: "record", data: record })
  }

  /**
   * 页面上才有的那几样：简介、og:image、**页面签名**、适配器 collect 抽到的字段。
   * `collectPage` 从 shared/ 来——桌面端测试用同一个函数跑真实页面夹具。
   */
  private async injectPageData(tabId: number, record: HistoryRecord) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectPage,
        args: [this.deps.getAdapters()],
        injectImmediately: false,
      })
      const page = results?.[0]?.result as
        | { description: string; ogImage: string; pageSignature: string[]; pageFields: HistoryRecord["pageFields"] }
        | undefined
      if (!page) return
      record.description = page.description
      record.ogImage = page.ogImage
      record.pageSignature = page.pageSignature
      record.pageFields = page.pageFields
    } catch (e) {
      // ignore — can't inject on chrome:// or restricted pages
    }
  }

  flushDwellTime(tabId: number) {
    const start = this.tabEntryTimes[tabId]
    const recordId = this.tabLastRecordId[tabId]
    if (!start || !recordId) return
    const dwellTime = Date.now() - start
    if (dwellTime < 1000) return
    const idx = this.records.findIndex((r) => r.id === recordId)
    if (idx !== -1) {
      this.records[idx] = { ...this.records[idx], dwellTime }
      for (const cb of this.onDwellTimeCbs) cb({ type: "dwellTime", data: this.records[idx] })
    }
    delete this.tabEntryTimes[tabId]
    delete this.tabLastRecordId[tabId]
  }

  getRecords() {
    return this.records
  }
}

export { TabTracker }
export type { TabTrackerDeps, RecordEvent, DwellTimeEvent }
