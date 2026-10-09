import { useEffect, useState } from "react"
import logoIcon from "url:~assets/icon.png"
import type { WatchlistEntry, HistoryRecord } from "../shared/types"
import { escapeHtml, formatTime, dateGroupLabel, getDomainColor, matchesSearch } from "../shared/utils"

const s: Record<string, React.CSSProperties> = {
  layout: {
    maxWidth: 960,
    margin: "0 auto",
    padding: "40px 24px 80px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 48,
    paddingBottom: 24,
    borderBottom: "1px solid var(--border)",
  },
  logoWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logoTitle: {
    fontSize: 18,
    fontWeight: 600,
  },
  logoSub: {
    fontSize: 13,
    color: "var(--muted-fg)",
    fontWeight: 500,
  },
  toggleWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 13,
    color: "var(--muted-fg)",
    fontWeight: 500,
  },
  toggleSlider: {
    position: "relative",
    width: 36,
    height: 20,
  },
  sliderOn: {
    position: "absolute",
    inset: 0,
    background: "var(--primary)",
    borderRadius: 20,
    cursor: "pointer",
  },
  sliderOff: {
    position: "absolute",
    inset: 0,
    background: "var(--border)",
    borderRadius: 20,
    cursor: "pointer",
  },
  sliderDot: {
    position: "absolute",
    width: 14,
    height: 14,
    left: 3,
    top: 3,
    background: "var(--primary-fg)",
    borderRadius: "50%",
    transition: "transform 0.25s",
  },
  title: {
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: "-0.05em",
    marginBottom: 24,
  },
  gridMetrics: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
    marginBottom: 32,
  },
  card: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: 20,
    background: "#050505",
  },
  metricTitle: {
    fontSize: 13,
    color: "var(--muted-fg)",
    fontWeight: 500,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  metricValue: {
    fontSize: 28,
    fontWeight: 600,
    marginTop: 8,
    fontFamily: "var(--font-mono)",
  },
  section: {
    marginBottom: 40,
  },
  sectionHeader: {
    fontSize: 16,
    fontWeight: 600,
    borderBottom: "1px solid var(--border)",
    paddingBottom: 8,
    marginBottom: 16,
  },
  setGrp: {
    display: "flex",
    flexDirection: "column",
    gap: 32,
    maxWidth: 800,
  },
  formRow: {
    display: "flex",
    gap: 12,
  },
  input: {
    background: "#000000",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "8px 12px",
    color: "#ffffff",
    outline: "none",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    flex: 1,
  },
  inputFocus: {
    borderColor: "var(--muted-fg)",
  },
  colorInput: {
    width: 44,
    height: 38,
    border: "none",
    background: "none",
    cursor: "pointer",
    padding: 0,
  },
  btn: {
    padding: "8px 16px",
    borderRadius: "var(--radius)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid var(--border)",
    transition: "background 0.2s, color 0.2s",
    background: "var(--primary)",
    color: "var(--primary-fg)",
    fontFamily: "var(--font-sans)",
  },
  btnGhost: {
    padding: "8px 16px",
    borderRadius: "var(--radius)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid var(--border)",
    transition: "background 0.2s, color 0.2s",
    background: "transparent",
    color: "var(--muted-fg)",
    fontFamily: "var(--font-sans)",
  },
  btnDanger: {
    padding: "8px 16px",
    borderRadius: "var(--radius)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid rgba(239,68,68,0.2)",
    transition: "background 0.2s, color 0.2s",
    background: "transparent",
    color: "var(--danger)",
    fontFamily: "var(--font-sans)",
  },
  watchList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  watchItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "#0a0a0a",
  },
  watchItemLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  watchDomain: {
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    fontSize: 14,
  },
  watchLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    padding: "1px 8px",
    borderRadius: 4,
    background: "var(--muted)",
    border: "1px solid var(--border)",
    color: "var(--muted-fg)",
  },
  watchRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  watchCount: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--muted-fg)",
  },
  btnSm: {
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 6,
    cursor: "pointer",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--muted-fg)",
    fontFamily: "var(--font-sans)",
  },
  toolbar: {
    display: "flex",
    gap: 12,
    marginBottom: 16,
    alignItems: "center",
  },
  searchInput: {
    flex: 1,
    background: "#000000",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "8px 14px",
    color: "#ffffff",
    outline: "none",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    maxWidth: 360,
  },
  filterBar: {
    display: "flex",
    gap: 8,
    overflowX: "auto",
    paddingBottom: 4,
    marginBottom: 16,
  },
  filterChip: {
    padding: "4px 12px",
    borderRadius: 99,
    border: "1px solid var(--border)",
    fontSize: 11,
    cursor: "pointer",
    color: "var(--muted-fg)",
    background: "#050505",
    whiteSpace: "nowrap",
    fontWeight: 500,
    fontFamily: "var(--font-mono)",
  },
  filterChipActive: {
    padding: "4px 12px",
    borderRadius: 99,
    border: "1px solid var(--primary)",
    fontSize: 11,
    cursor: "pointer",
    color: "var(--primary-fg)",
    background: "var(--primary)",
    whiteSpace: "nowrap",
    fontWeight: 500,
    fontFamily: "var(--font-mono)",
  },
  dataList: {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "#050505",
  },
  dateHeader: {
    padding: "12px 20px",
    background: "#0a0a0a",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--muted-fg)",
    fontFamily: "var(--font-mono)",
    borderBottom: "1px solid var(--border)",
  },
  dataItem: {
    display: "flex",
    alignItems: "center",
    padding: "14px 20px",
    borderBottom: "1px solid var(--border)",
    cursor: "pointer",
    gap: 14,
    transition: "background 0.1s",
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
  },
  itemTitle: {
    fontWeight: 500,
    fontSize: 14,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginBottom: 2,
  },
  itemMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 11,
    color: "var(--muted-fg)",
  },
  itemUrl: {
    fontFamily: "var(--font-mono)",
    opacity: 0.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 300,
  },
  badge: {
    padding: "1px 8px",
    borderRadius: 4,
    background: "var(--muted)",
    border: "1px solid var(--border)",
    fontSize: 10,
    fontFamily: "var(--font-mono)",
    color: "var(--muted-fg)",
  },
  itemActions: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexShrink: 0,
  },
  btnPin: {
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    fontSize: 11,
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
    color: "var(--muted-fg)",
    background: "transparent",
    transition: "0.2s",
  },
  btnPinOn: {
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid var(--warning)",
    fontSize: 11,
    fontWeight: 600,
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
    color: "var(--warning)",
    background: "rgba(245,158,11,0.1)",
    transition: "0.2s",
  },
  emptyState: {
    textAlign: "center",
    padding: 40,
    color: "var(--muted-fg)",
    fontSize: 13,
  },
  modeSection: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "#050505",
  },
  modeLeft: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  modeTitle: { fontSize: 14, fontWeight: 600 },
  modeDesc: { fontSize: 11, color: "var(--muted-fg)", fontWeight: 400 },
  modeToggle: {
    display: "flex",
    background: "#000000",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    overflow: "hidden",
  },
  modeOption: {
    padding: "6px 16px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    color: "var(--muted-fg)",
    background: "transparent",
    border: "none",
    outline: "none",
    whiteSpace: "nowrap" as const,
  },
  modeOptionActive: {
    padding: "6px 16px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    color: "var(--primary-fg)",
    background: "var(--primary)",
    border: "none",
    outline: "none",
    whiteSpace: "nowrap" as const,
  },
  btnRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    right: 24,
    padding: "12px 20px",
    background: "var(--muted)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    fontSize: 13,
    zIndex: 999,
  },
}

function OptionsIndex() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState("ws")
  const [inputDomain, setInputDomain] = useState("")
  const [inputLabel, setInputLabel] = useState("")
  const [inputColor, setInputColor] = useState("#5b8dee")
  const [searchQuery, setSearchQuery] = useState("")
  const [activeFilter, setActiveFilter] = useState("all")
  const [toast, setToast] = useState<{
    msg: string
    type: "success" | "error"
  } | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const data = await chrome.storage.local.get([
      "watchlist",
      "records",
      "enabled",
      "mode",
    ])
    setWatchlist((data.watchlist as WatchlistEntry[]) || [])
    setRecords((data.records as HistoryRecord[]) || [])
    setEnabled(data.enabled !== false)
    setMode((data.mode as string) || "ws")
  }

  function showToast(msg: string, type: "success" | "error") {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
  }

  const counts: Record<string, number> = {}
  for (const r of records) {
    counts[r.matchedRule] = (counts[r.matchedRule] || 0) + 1
  }

  const domains = [...new Set(records.map((r) => r.matchedRule))]

  let filtered = records
  if (searchQuery) {
    filtered = filtered.filter((r) => matchesSearch(r, searchQuery))
  }
  if (activeFilter === "pinned") {
    filtered = filtered.filter((r) => r.pinned)
  } else if (activeFilter !== "all") {
    filtered = filtered.filter((r) => r.matchedRule === activeFilter)
  }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayCount = records.filter(
    (r) => r.timestamp >= todayStart.getTime(),
  ).length

  const topDomain = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]

  async function addEntry() {
    const domain = inputDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
    const label = inputLabel.trim()
    const color = inputColor

    if (!domain) {
      showToast("请输入域名", "error")
      return
    }

    if (watchlist.find((e) => e.domain === domain)) {
      showToast("该域名已存在", "error")
      return
    }

    const next = [...watchlist, { domain, label, color }]
    setWatchlist(next)
    await chrome.storage.local.set({ watchlist: next })
    chrome.runtime.sendMessage({ type: "SYNC_WATCHLIST", watchlist: next })
    setInputDomain("")
    setInputLabel("")
    showToast(`已添加 ${domain}`, "success")
  }

  async function removeEntry(idx: number) {
    const entry = watchlist[idx]
    if (!confirm(`确认移除 ${entry.domain}？相关记录不会删除。`)) return
    const next = [...watchlist]
    next.splice(idx, 1)
    setWatchlist(next)
    await chrome.storage.local.set({ watchlist: next })
    chrome.runtime.sendMessage({ type: "SYNC_WATCHLIST", watchlist: next })
    showToast("已移除", "success")
  }

  async function toggleEnabled(val: boolean) {
    setEnabled(val)
    await chrome.storage.local.set({ enabled: val })
    chrome.runtime.sendMessage({ type: "SYNC_ENABLED", enabled: val })
    showToast(val ? "追踪已开启" : "追踪已暂停", "success")
  }

  async function togglePin(id: string) {
    setRecords((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, pinned: r.pinned ? 0 : 1, score: !r.pinned && r.score == null ? 50 : r.score }
          : r,
      ),
    )
    chrome.runtime.sendMessage({ type: "TOGGLE_RECORD_PIN", id })
  }

  async function exportData() {
    const data = await chrome.storage.local.get(["records", "watchlist"])
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `acuminata-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast("导出成功", "success")
  }

  async function clearData() {
    if (!confirm("确认清空所有浏览记录？此操作不可撤销。")) return
    await chrome.storage.local.set({ records: [] })
    setRecords([])
    showToast("已清空所有记录", "success")
  }

  async function setModeAndPersist(newMode: string) {
    setMode(newMode)
    await chrome.storage.local.set({ mode: newMode })
    chrome.runtime.sendMessage({ type: "SET_MODE", mode: newMode })
    showToast(
      newMode === "ws" ? "已切换至 WebSocket 模式" : "已切换至本地模式",
      "success",
    )
  }

  function renderRecordsList() {
    let currentGroup = ""
    const rows: React.ReactNode[] = []

    filtered.forEach((r) => {
      const dateLabel = dateGroupLabel(r.timestamp)
      if (dateLabel !== currentGroup) {
        currentGroup = dateLabel
        rows.push(
          <div key={`h-${dateLabel}`} style={s.dateHeader}>
            {dateLabel}
          </div>,
        )
      }
      const color = getDomainColor(r.matchedRule, watchlist)
      const isPinned = !!r.pinned

      rows.push(
        <div
          key={r.id}
          style={s.dataItem}
          className="data-item"
          data-url={encodeURIComponent(r.url)}
          onClick={(e) => {
            const target = e.target as HTMLElement
            if (target.closest("[data-action]")) return
            chrome.tabs.create({ url: r.url })
          }}>
          {r.favIconUrl ? (
            <img
              src={r.favIconUrl}
              style={{ width: 16, height: 16, borderRadius: 4, flexShrink: 0, marginTop: 2 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
            />
          ) : null}
          <div style={s.itemBody}>
            <div style={s.itemTitle}>
              {escapeHtml(r.title || r.url)}
            </div>
            <div style={s.itemMeta}>
              <span style={{ ...s.badge, borderColor: color, color }}>
                {escapeHtml(r.matchedRule)}
              </span>
              <span>{formatTime(r.timestamp)}</span>
              {r.description ? (
                <span style={{ ...s.itemUrl, maxWidth: 240, color: "var(--muted-fg)", opacity: 0.7 }}>
                  {escapeHtml(r.description.slice(0, 60))}
                </span>
              ) : (
                <span style={s.itemUrl}>
                  {escapeHtml(r.url)}
                </span>
              )}
            </div>
          </div>
          <div style={s.itemActions}>
            <button
              style={isPinned ? s.btnPinOn : s.btnPin}
              data-action="pin"
              onClick={(e) => {
                e.stopPropagation()
                togglePin(r.id)
              }}>
              {isPinned
                ? `Pinned${r.score ? ` ${r.score}` : ""}`
                : "Pin"}
            </button>
          </div>
        </div>,
      )
    })

    return rows
  }

  return (
    <div
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
        fontFamily: "var(--font-sans)",
        fontSize: 14,
        minHeight: "100vh",
      }}>
      <style>{`
        :root {
          --background: #000000;
          --foreground: #ffffff;
          --muted: #1a1a1a;
          --muted-fg: #767d88;
          --border: #27272a;
          --primary: #ffffff;
          --primary-fg: #000000;
          --danger: #ef4444;
          --warning: #f59e0b;
          --radius: 8px;
          --font-sans: system-ui, -apple-system, 'Segoe UI', sans-serif;
          --font-mono: 'JetBrains Mono', 'Consolas', 'Cascadia Code', monospace;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .data-item:hover { background: var(--muted) !important; }
        .search-input:focus { border-color: var(--muted-fg) !important; }
      `}</style>
      <div style={s.layout}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.logoWrap}>
            <img src={logoIcon} style={{ width: 36, height: 36 }} />
            <div>
              <div style={s.logoTitle}>Acuminata</div>
              <div style={s.logoSub}>浏览记录追踪器 · 设置</div>
            </div>
          </div>
          <div style={s.toggleWrap}>
            <span>{enabled ? "追踪中" : "已暂停"}</span>
            <label style={s.toggleSlider}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => toggleEnabled(e.target.checked)}
                style={{
                  opacity: 0,
                  width: 0,
                  height: 0,
                  position: "absolute",
                }}
              />
              <span style={enabled ? s.sliderOn : s.sliderOff} />
              <span
                style={
                  enabled
                    ? { ...s.sliderDot, transform: "translateX(16px)" }
                    : s.sliderDot
                }
              />
            </label>
          </div>
        </div>

        {/* Metrics */}
        <div style={s.gridMetrics}>
          <div style={s.card}>
            <div style={s.metricTitle}>总记录数</div>
            <div style={s.metricValue}>{records.length}</div>
          </div>
          <div style={s.card}>
            <div style={s.metricTitle}>今日捕获</div>
            <div style={s.metricValue}>{todayCount}</div>
          </div>
          <div style={s.card}>
            <div style={s.metricTitle}>监控站点</div>
            <div style={s.metricValue}>{watchlist.length}</div>
          </div>
          <div style={s.card}>
            <div style={s.metricTitle}>最常访问</div>
            <div style={{ ...s.metricValue, fontSize: 16 }}>
              {topDomain ? topDomain[0] : "-"}
            </div>
          </div>
        </div>

        {/* Settings */}
        <div style={s.title}>设置</div>
        <div style={s.setGrp}>
          {/* Global Toggle */}
          <div style={s.card}>
            <div style={s.sectionHeader}>全局开关</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "var(--muted-fg)", fontSize: 13 }}>
                {enabled ? "追踪开启中" : "追踪已暂停"}
              </span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => toggleEnabled(e.target.checked)}
                style={{ width: 20, height: 20, accentColor: "var(--primary)" }}
              />
            </div>
          </div>

          {/* Watchlist */}
          <div style={s.card}>
            <div style={s.sectionHeader}>添加监控组</div>
            <div style={{ ...s.formRow, marginBottom: 12 }}>
              <input
                type="text"
                className="search-input"
                style={s.input}
                placeholder="域名 (e.g. bilibili.com)"
                value={inputDomain}
                onChange={(e) => setInputDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addEntry()
                }}
              />
              <input
                type="text"
                className="search-input"
                style={s.input}
                placeholder="备注 (e.g. B站)"
                value={inputLabel}
                onChange={(e) => setInputLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addEntry()
                }}
              />
              <input
                type="color"
                value={inputColor}
                onChange={(e) => setInputColor(e.target.value)}
                style={s.colorInput}
              />
              <button style={s.btn} onClick={addEntry}>
                添加站点
              </button>
            </div>
            <div style={s.sectionHeader}>已监控列表</div>
            <div style={s.watchList}>
              {watchlist.length === 0 ? (
                <div style={s.emptyState}>暂无监控站点</div>
              ) : (
                watchlist.map((entry, idx) => (
                  <div key={idx} style={s.watchItem}>
                    <div style={s.watchItemLeft}>
                      <div
                        style={{
                          ...s.colorDot,
                          background: entry.color || "var(--muted-fg)",
                        }}
                      />
                      <span style={s.watchDomain}>
                        {escapeHtml(entry.domain)}
                      </span>
                      <span style={s.watchLabel}>
                        {escapeHtml(entry.label || "未命名")}
                      </span>
                    </div>
                    <div style={s.watchRight}>
                      <span style={s.watchCount}>
                        {counts[entry.domain] || 0} 条
                      </span>
                      <button
                        style={s.btnSm}
                        onClick={() => removeEntry(idx)}>
                        移除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Mode */}
          <div style={s.card}>
            <div style={s.sectionHeader}>运行模式</div>
            <div style={s.modeSection}>
              <div style={s.modeLeft}>
                <div style={s.modeTitle}>
                  {mode === "ws" ? "WebSocket 模式" : "本地模式"}
                </div>
                <div style={s.modeDesc}>
                  {mode === "ws"
                    ? "连接本地 WS 服务端，数据双向同步"
                    : "仅在本地存储浏览记录，不连接外部服务"}
                </div>
              </div>
              <div style={s.modeToggle}>
                <button
                  style={mode === "ws" ? s.modeOptionActive : s.modeOption}
                  onClick={() => setModeAndPersist("ws")}>
                  WS
                </button>
                <button
                  style={mode === "local" ? s.modeOptionActive : s.modeOption}
                  onClick={() => setModeAndPersist("local")}>
                  本地
                </button>
              </div>
            </div>
          </div>

          {/* Data Management */}
          <div style={s.card}>
            <div style={s.sectionHeader}>数据管理</div>
            <div style={s.btnRow}>
              <button style={s.btnGhost} onClick={exportData}>
                导出 JSON 数据
              </button>
              <button style={s.btnDanger} onClick={clearData}>
                清空所有历史记录
              </button>
            </div>
          </div>
        </div>

        {/* Records */}
        <div style={{ marginTop: 40 }}>
          <div style={s.title}>监控的历史 · {records.length}</div>

          <div style={s.toolbar}>
            <input
              type="text"
              className="search-input"
              style={s.searchInput}
              placeholder="搜索标题、URL..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div style={s.filterBar}>
            <div
              style={activeFilter === "all" ? s.filterChipActive : s.filterChip}
              onClick={() => setActiveFilter("all")}>
              全部
            </div>
            <div
              style={activeFilter === "pinned" ? s.filterChipActive : s.filterChip}
              onClick={() => setActiveFilter("pinned")}>
              ★ 已收藏
            </div>
            {domains.map((d) => {
              const color = getDomainColor(d, watchlist)
              return (
                <div
                  key={d}
                  style={
                    activeFilter === d
                      ? s.filterChipActive
                      : { ...s.filterChip, borderColor: color }
                  }
                  onClick={() => setActiveFilter(d)}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: color,
                      marginRight: 4,
                    }}
                  />
                  {d}{" "}
                  <span style={{ opacity: 0.5 }}>
                    {counts[d] || 0}
                  </span>
                </div>
              )
            })}
          </div>
          <div style={s.dataList}>
            {filtered.length === 0 ? (
              <div style={s.emptyState}>
                {searchQuery ? "未发现匹配记录" : "历史空空如也"}
              </div>
            ) : (
              renderRecordsList()
            )}
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            ...s.toast,
            color: toast.type === "success" ? "var(--foreground)" : "var(--danger)",
          }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}

export default OptionsIndex
