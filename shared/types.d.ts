export interface WatchlistEntry {
  domain: string
  label: string
  color: string
  regexFilter?: string
  regexTarget?: string
}

export interface HistoryRecord {
  id: string
  url: string
  title: string
  domain: string | null
  matchedRule: string
  tabId: number
  timestamp: number
  pinned?: number
  score?: number | null
  favIconUrl?: string
  description?: string
  ogImage?: string
  dwellTime?: number
  edition?: string
  createdAt?: number
  updatedAt?: number
}
