export interface WatchlistEntry {
  domain: string
  label: string
  color: string
  regexFilter?: string
  regexTarget?: string
}

/** 一条 collect 规则：选择器与属性都是有序备选，第一个命中的胜出。 */
export interface AdapterCollectRule {
  field: string
  selector: string | string[]
  attr: string | string[]
  many?: boolean
}

/** 一个适配器 = 一个 JSON 文件 = 一个平台（docs/adapters/template.md）。 */
export interface Adapter {
  name?: string
  /** 来源文件名；`loadAdapters()` 给每个适配器标上，回传的采集字段就按它分组。 */
  file?: string
  detect?: { pageGlobal?: string }
  collect?: AdapterCollectRule[]
  parse?: Record<string, { from: string[]; regex: string }>
}

/** 采集字段按适配器文件名分组（同一个页面可能对上不止一种格式）。 */
export type PageFields = Record<string, Record<string, string | string[] | null>>

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
  /** 页面自己报出的平台身份（内联脚本里的 `var maccms=`）；检测只看它。 */
  pageSignature?: string[]
  /** 适配器在这个页面上 collect 抽到的字段，按适配器文件名分组。 */
  pageFields?: PageFields
}
