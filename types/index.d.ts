export type Category = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type PaceOf = { typical: number; skip: number }
export type Snapshot = {
  window: number
  tokens: number
  percent: number
  total: number
  categories: Category[]
  limits: Limit[]
  /** when the limit figures were read */
  limitsAt?: number
  /** why the usage service last refused, while it is backed off */
  limitsError?: string
  /** per window kind: the usual final % and the one-off % left out of the pace */
  pace?: Record<string, PaceOf>
  /** the minute it was taken in: redraws countdowns at least once a minute */
  minute?: number
  /** what the weekly limit went to, day by day and week by week, oldest first */
  history?: History
}

/** a day (YYYY-MM-DD, local) or a week (when it reset) and the % of the weekly limit it took */
export type HistoryBar = { key: string; percent: number }
export type History = { days: HistoryBar[]; weeks: HistoryBar[] }

/** auto compact: on or off, and the context % that sets it off (kept for every chat) */
export type AutoCompact = { isOn: boolean; at: number | null }

/** what holds auto compact back in a chat: an ask (or "after my next compact"), or a compaction that left it past the % */
export type Hold = { chat: string; waits: boolean; stuck: boolean }

/** the prompt cache: when the main thread's last request was answered, what it held, and how long it lives */
export type Cache = { at: number; tokens: number; ttl: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-quota': {
      snapshot: Snapshot | null
      isOn: boolean
      isCollapsed: boolean
      autoCompact: AutoCompact
      /** the choice the band is asking for: the context was already past a new % */
      autoAsk: { at: number; percent: number } | null
      hold: Hold
      /** bumped on every % set: draws the field afresh even when the value is unchanged */
      fieldTick: number
      fieldText: string | null
      /** the desktop app's theme, as its settings (or the OS) have it */
      theme: 'dark' | 'light'
      /** the prompt cache as this chat's last reply left it; null before any reply */
      cache: Cache | null
      /** the history chart: by day or by week */
      historyBy: 'days' | 'weeks'
      /** the band shows the history in place of the limits and the context */
      isHistory: boolean
      /** the cold cache whose compact hint was put off (its last reply's time): shown again once it warms and cools anew */
      coldHintOff: number | null
    }
  }
}
