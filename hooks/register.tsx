import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { AutoCompact, Cache, Category, History, HistoryBar, Hold, Limit, PaceOf, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-quota', key: 'snapshot' } as const, null)
const isOn = atom({ plugin: 'usage-quota', key: 'isOn' } as const, true)
const isCollapsed = atom({ plugin: 'usage-quota', key: 'isCollapsed' } as const, false)
const autoCompact = atom({ plugin: 'usage-quota', key: 'autoCompact' } as const, { isOn: false, at: null } as AutoCompact)
const fieldTick = atom({ plugin: 'usage-quota', key: 'fieldTick' } as const, 0)
// the % field's text while typing is cleaned (digits only, 3 at most); null: the set %
const fieldText = atom({ plugin: 'usage-quota', key: 'fieldText' } as const, null as string | null)
const theme = atom({ plugin: 'usage-quota', key: 'theme' } as const, 'dark' as 'dark' | 'light')
const autoAsk = atom({ plugin: 'usage-quota', key: 'autoAsk' } as const, null as { at: number; percent: number } | null)
// what holds auto compact back, and in which chat: kept in state so a reload (an
// update, /reload-plugins) keeps it, where a module variable would start over
const hold = atom({ plugin: 'usage-quota', key: 'hold' } as const, { chat: '', waits: false, stuck: false } as Hold)
const cache = atom({ plugin: 'usage-quota', key: 'cache' } as const, null as Cache | null)
const historyBy = atom({ plugin: 'usage-quota', key: 'historyBy' } as const, 'days' as 'days' | 'weeks')
const isHistory = atom({ plugin: 'usage-quota', key: 'isHistory' } as const, false)

// two palettes, the desktop's dark and light themes; the band draws in the one the
// app shows (Theme), set at the start of every draw so all colours below follow it
type Palette = {
  muted: string; green: string; greenText: string; amber: string; red: string; free: string; buffer: string; track: string
  palette: string[]; named: Record<string, string>; switchOff: string; switchOn: string; switchLit: string; compactLit: string
  warm: string; cold: string; pillInk: string
}
const DARK: Palette = {
  muted: '#8b90a0', green: '#4ade80', greenText: '#4ade80', amber: '#fbbf24', red: '#f87171',
  free: '#2d3140', buffer: '#4b5163', track: '#2d3140',
  palette: ['#a78bfa', '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#22d3ee', '#c084fc'],
  named: {
    Tools: '#a78bfa', Other: '#8b90a0', 'System prompt': '#a78bfa', 'System tools': '#60a5fa', 'MCP tools': '#f472b6',
    'Custom agents': '#34d399', 'Memory files': '#fbbf24', Skills: '#fb923c', Messages: '#22d3ee',
  },
  switchOff: '#4b5163', switchOn: '#4ade80', switchLit: '#8b919c', compactLit: '#5a606e',
  warm: '#e57b74', cold: '#7fb4d1', pillInk: '#1b1d24',
}
// light: the same hues, deep enough to read on the pale band; the tracks pale
const LIGHT: Palette = {
  muted: '#5b6070', green: '#22b856', greenText: '#16a34a', amber: '#ea8a0c', red: '#ef4444',
  free: '#ffffff', buffer: '#b9bec9', track: '#ffffff',
  palette: ['#8b5cf6', '#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#f97316', '#0ea5e9', '#a855f7'],
  named: {
    Tools: '#8b5cf6', Other: '#5b6070', 'System prompt': '#8b5cf6', 'System tools': '#3b82f6', 'MCP tools': '#ec4899',
    'Custom agents': '#10b981', 'Memory files': '#f59e0b', Skills: '#f97316', Messages: '#0ea5e9',
  },
  switchOff: '#b4b9c4', switchOn: '#22c55e', switchLit: '#c3c7cf', compactLit: '#d6d9df',
  warm: '#d4544b', cold: '#3d86b8', pillInk: '#ffffff',
}
let MUTED = DARK.muted
let GREEN = DARK.green
let GREEN_TEXT = DARK.greenText
let AMBER = DARK.amber
let RED = DARK.red
let FREE = DARK.free
let BUFFER = DARK.buffer
let TRACK = DARK.track
let PALETTE = DARK.palette
let NAMED = DARK.named
let SWITCH_OFF = DARK.switchOff
let SWITCH_ON = DARK.switchOn
// the light behind the switch under the pointer: drawn beneath the pill, never over it
let SWITCH_LIT = DARK.switchLit
// Compact's hover: clearly lighter than its resting chrome, its label still reads
let COMPACT_LIT = DARK.compactLit
// the cache's pill: a warm red while the cache holds, a cold blue once it lapsed
let WARM = DARK.warm
let COLD = DARK.cold
let PILL_INK = DARK.pillInk
function usePalette(p: Palette): void {
  ;({ muted: MUTED, green: GREEN, greenText: GREEN_TEXT, amber: AMBER, red: RED, free: FREE, buffer: BUFFER, track: TRACK } = p)
  ;({ palette: PALETTE, named: NAMED, switchOff: SWITCH_OFF, switchOn: SWITCH_ON, switchLit: SWITCH_LIT, compactLit: COMPACT_LIT } = p)
  ;({ warm: WARM, cold: COLD, pillInk: PILL_INK } = p)
}
const CELLS = 16
const HOUR = 3_600_000
const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5 Hour', ms: 5 * HOUR },
  seven_day: { label: 'Weekly', ms: 7 * 24 * HOUR },
}

// 5 hour on the left, Weekly on the right
const order = (kind: string) => (kind === 'five_hour' ? 0 : 1)

type Forecast = {
  kind: string
  label: string
  percent: number
  resetsAt: number
  /** 'idle': no window running (unused, or reset): 0% until the next message starts one */
  status: 'hit' | 'ok' | 'out' | 'idle'
  projected: number
  runOutAt: number
  color: string
}

// The pace a window is forecast at: your usual one (the median of how far your past
// windows got) blended with this window's own, which takes over as the window runs: it
// counts for half a quarter of the way in. Early jumps barely move it. `skip`: the %
// the first reply of a reopened chat took re-reading its old context, a one-off left
// out of the pace (still in the % used).
const TYPICAL_DEFAULT = 50
const TRUST = 0.25
const FINALS_KEPT = 8
// one window's reset time as two readings give it: a few minutes apart at most
const SAME_WINDOW_MS = 10 * 60_000

function forecast(limit: Limit, now: number, pace?: PaceOf): Forecast | null {
  const win = WINDOWS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!win) return null
  const p = limit.percentUsed
  // no reset time, or one already passed: the window is not running, so it is at 0
  if (!Number.isFinite(resetsAt) || resetsAt <= now) {
    return { kind: limit.kind, label: win.label, percent: 0, resetsAt: NaN, status: 'idle', projected: 0, runOutAt: Infinity, color: GREEN }
  }
  const remaining = Math.max(0, resetsAt - now)
  const elapsed = Math.max(1, win.ms - remaining)
  const base = { kind: limit.kind, label: win.label, percent: p, resetsAt }
  if (p >= 100) return { ...base, status: 'hit', projected: p, runOutAt: now, color: RED }
  const typical = pace?.typical ?? TYPICAL_DEFAULT
  const own = Math.max(0, p - (pace?.skip ?? 0)) / elapsed
  const weight = elapsed / (elapsed + win.ms * TRUST)
  const rate = weight * own + (1 - weight) * (typical / win.ms)
  const projected = p + rate * remaining
  if (projected < 100 || rate <= 0) {
    return { ...base, status: 'ok', projected, runOutAt: Infinity, color: worse(GREEN, usedColor(p)) }
  }
  return {
    ...base,
    status: 'out',
    projected,
    runOutAt: now + (100 - p) / rate,
    color: worse(projected > 130 ? RED : AMBER, usedColor(p)),
  }
}

// A limit's colour by what is used, as the band shows it (rounded): amber from 75%,
// red from 90%. The bar and its % take the worse of this and the forecast's.
const LIMIT_AMBER_AT = 75
const LIMIT_RED_AT = 90
function usedColor(p: number): string {
  const shown = Math.round(p)
  return shown >= LIMIT_RED_AT ? RED : shown >= LIMIT_AMBER_AT ? AMBER : GREEN
}
function worse(a: string, b: string): string {
  const rank = (c: string) => (c === RED ? 2 : c === AMBER ? 1 : 0)
  return rank(b) > rank(a) ? b : a
}

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  const min = m % 60
  if (d > 0) return hours > 0 ? `${d}d ${hours}h` : `${d}d`
  if (hours > 0) return min > 0 ? `${hours}h ${min}m` : `${hours}h`
  return `${min}m`
}

const time = (t: number) =>
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long' })
const isSameDay = (a: number, b: number) =>
  new Date(a).toLocaleDateString('en-US') === new Date(b).toLocaleDateString('en-US')

// "the 8:40 PM reset" today, "Wednesday's reset" otherwise
// the reset by its time when it is under a day away (an after-midnight one included),
// else by its weekday: a time that far off would only lengthen the headline
function resetName(t: number, now: number): string {
  return t - now < 24 * 3_600_000 ? `the ${time(t)} reset` : `${weekday(t)}'s reset`
}

function headline(list: Forecast[], now: number): { text: string; color: string } | null {
  const hit = list.find(f => f.status === 'hit')
  if (hit) {
    const at = isSameDay(hit.resetsAt, now) ? time(hit.resetsAt) : `${weekday(hit.resetsAt)} ${time(hit.resetsAt)}`
    return { text: `Limit reached. Usage resumes at ${at}.`, color: RED }
  }
  const out = list.filter(f => f.status === 'out').sort((a, b) => a.runOutAt - b.runOutAt)[0]
  if (out) {
    return { text: `At this pace you'll run out before ${resetName(out.resetsAt, now)}.`, color: out.color }
  }
  const lead = list.find(f => f.kind === 'seven_day' && f.status !== 'idle') ?? list.find(f => f.status !== 'idle')
  if (!lead) return null
  return {
    text: `On track. You should reach ${resetName(lead.resetsAt, now)} with room to spare.`,
    color: GREEN,
  }
}

// The prompt cache: every reply leaves the chat's context cached for a while, and the
// next reply within that time reads it back for a tenth of the price; past it the next
// reply writes the whole context again, a jump in the limits. Claude Code caches for an
// hour on a Claude login, 5 minutes on an API key. Amber for the last sixth of it
const CACHE_TTL_LOGIN = HOUR
const CACHE_TTL_KEY = 5 * 60_000
let cacheTtl = CACHE_TTL_LOGIN
/** `short`: the minutes left, or how long it sat idle; `rewrites`: what the next reply writes again */
type CacheLook = { label: 'WARM' | 'COLD'; short: string; color: string; rewrites?: number }
function cacheLook(c: Cache, now: number): CacheLook {
  const left = c.at + c.ttl - now
  if (left <= 0) {
    // cold: how long the chat has sat idle, and what the next reply writes again
    const idle = duration(now - c.at)
    return { label: 'COLD', short: `${idle} idle`, color: COLD, ...(c.tokens > 0 ? { rewrites: c.tokens } : {}) }
  }
  const min = Math.ceil(left / 60_000)
  return { label: 'WARM', short: `${min}m left`, color: left <= Math.max(60_000, c.ttl / 6) ? AMBER : WARM }
}

// the pill's cells: its word and a cell of room each side
const PILL_CELLS = 6
const PILL_H = 16
function pillSvg(label: string, color: string): string {
  const w = PILL_CELLS * 8
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PILL_H}" viewBox="0 0 ${w} ${PILL_H}">` +
    `<rect width="${w}" height="${PILL_H}" rx="${PILL_H / 2}" fill="${color}"/>` +
    `<text x="${w / 2}" y="${PILL_H / 2}" dominant-baseline="central" text-anchor="middle" fill="${PILL_INK}" ` +
    `font-family="-apple-system, system-ui, sans-serif" font-size="9.5" font-weight="700" letter-spacing="0.6">${label}</text></svg>`
  )
}

async function saveCache($: EngineInterface, next: Cache | null): Promise<void> {
  await update($, cache, () => next)
  await storeSet($, `cache:${await chatId($)}`, next)
}

function tokens(n: number): string {
  // 1M, not 1.0M; 1.5M keeps its decimal
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n)}`
}

// Context by what it holds, as shown (rounded): amber from 50% (a long context costs
// more on every reply: compacting pays), red from 80%
const CONTEXT_AMBER_AT = 50
const CONTEXT_RED_AT = 80
function fillColor(percent: number): string {
  const shown = Math.round(percent)
  if (shown >= CONTEXT_RED_AT) return RED
  if (shown >= CONTEXT_AMBER_AT) return AMBER
  return GREEN
}

// text in green, which on the light band needs a deeper green than the bars to read
function ink(color: string): string {
  return color === GREEN ? GREEN_TEXT : color
}

function colorOf(category: Category, index: number): string {
  if (category.kind === 'free') return FREE
  if (category.kind === 'buffer') return BUFFER
  return NAMED[category.name] ?? PALETTE[index % PALETTE.length]!
}

type Segment = { color: string; share: number }

const BAR_PX = 7.5

// an iOS-style switch: a pill, the knob right and green when on, left and grey when off
// three cells wide, so the click area laid over it covers all of it
const SWITCH_W = 30
const SWITCH_H = 20
const SWITCH_PAD = 3
// the cells the switch's box takes: the press under it is clipped to this, so the
// app's own button tint can't spill onto the text beside it
const SWITCH_CELLS = 4
// the box behind the switch measures a pixel off the drawing (19px tall, 31 wide):
// the pill is drawn half a pixel down and right so it sits in the light's centre
const SWITCH_NUDGE = 0.5
// fully see-through: the unlit border, and the press's own hover tint, which drew a
// square frame round the light (the word "transparent" draws white or nothing)
const CLEAR = '#00000000'
// a space a wrap never breaks at
const NB = '\u00a0'

function switchSvg(isOn: boolean): string {
  // the pill sits inset by PAD: the light under the pointer shows around it
  const w = SWITCH_W - 2 * SWITCH_PAD
  const tall = SWITCH_H - 2 * SWITCH_PAD
  const p = SWITCH_PAD
  const knob = p + (isOn ? w - tall / 2 : tall / 2)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SWITCH_W}" height="${SWITCH_H}" viewBox="${-SWITCH_NUDGE} ${-SWITCH_NUDGE} ${SWITCH_W} ${SWITCH_H}">` +
    `<rect x="${p}" y="${p}" width="${w}" height="${tall}" rx="${tall / 2}" fill="${isOn ? SWITCH_ON : SWITCH_OFF}"/>` +
    `<circle cx="${knob}" cy="${p + tall / 2}" r="${tall / 2 - 2}" fill="#ffffff"/></svg>`
  )
}

// a thin rounded bar for surfaces that draw Svg: segments laid out over 0..1000,
// with an optional grey tick, the bar's own height, at `marker` percent (the forecast at reset)
function barSvg(segments: Segment[], width: number, marker?: number): string {
  const height = BAR_PX
  const y = 0
  const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
  let x = 0
  const rects = segments
    .map(s => {
      const w = (s.share / total) * 1000
      const rect = `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${BAR_PX}" fill="${s.color}"/>`
      x += w
      return rect
    })
    .join('')
  // a plain upright block 3px wide whatever the drawn width: no rounded corners
  // (stretched sideways, those drew it as a "D"), inside the bar's rounded ends so
  // nothing pokes out past them. Placed on a whole pixel and left smooth-edged: snapped
  // edges on a scaled screen drew it 3 device pixels wide on one bar and 4 on another
  const TICK_PX = 3
  const tickW = (TICK_PX / width) * 1000
  const tickAt = marker === undefined ? 0 : Math.min(width - TICK_PX, Math.max(0, Math.round((marker / 100) * width - TICK_PX / 2)))
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${((tickAt / width) * 1000).toFixed(3)}" y="${y}" width="${tickW.toFixed(3)}" height="${BAR_PX}" fill="${MUTED}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 ${height}" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect y="${y}" width="1000" height="${BAR_PX}" rx="${BAR_PX / 2}" ry="${BAR_PX / 2}"/></clipPath>` +
    `<g clip-path="url(#r)">${rects}${tick}</g></svg>`
  )
}

// the forecast tick's percent, or none when there is nothing ahead to mark
function markerOf(f: Forecast): number | undefined {
  if (f.status === 'hit' || f.status === 'idle') return undefined
  const at = Math.min(100, f.projected)
  return at - f.percent >= 1 ? at : undefined
}

// the terminal's bar: one colour per cell, runs of a colour merged into one Box
function cellRuns(f: Forecast, cells: number): { color: string; width: number }[] {
  const filled = Math.max(0, Math.min(cells, Math.round((f.percent / 100) * cells)))
  const marker = markerOf(f)
  const tick = marker === undefined ? -1 : Math.max(filled, Math.min(cells - 1, Math.round((marker / 100) * cells) - 1))
  const runs: { color: string; width: number }[] = []
  for (let i = 0; i < cells; i++) {
    const color = i < filled ? f.color : i === tick ? MUTED : TRACK
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.width += 1
    else runs.push({ color, width: 1 })
  }
  return runs
}

// The usage service rate-limits per login, and the app's own Usage panel asks it on
// the same allowance, so ask it seldom: when a chat opens, then every 2 minutes with the
// exact context count, one ask for the whole app (when it was last asked, the answer and
// any back-off sit in the shared store). Between asks the figures every reply from
// Claude carries keep the band current.
const PLAN_EVERY_MS = 2 * 60_000
// timers drift: a 2-minute tick a moment early still counts as due
const PLAN_SLACK_MS = 10_000
// after a failed ask wait 2, then 5, then 15 minutes, or what the service says
const PLAN_BACKOFF_MS = [120_000, 300_000, 900_000]
const LOCAL_EVERY_MS = 3_000

type Backoff = { until: number; failures: number; error: string }
/** 'no': the 3s tick, never asks; 'due': asks if 2 minutes have passed app-wide; 'now': asks unless backed off */
type Ask = 'no' | 'due' | 'now'

class AskError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

// The plan's limits, as the app's "Plan usage limits" panel reads them: the account's
// usage endpoint, through the session's own credential (the plugin never sees it).
async function fetchPlan($: EngineInterface): Promise<Limit[] | null> {
  const auth = await $.session.authorize()
  // no Claude login (an API key, a gateway): there is no plan to ask about
  if (!auth || auth.kind !== 'bearer') return null
  const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
  })
  if (!res.ok) {
    const header = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
    const seconds = Number(Array.isArray(header) ? header[0] : header)
    const retry = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
    throw new AskError(res.status === 429 ? 'refused (429)' : `failed (${res.status})`, retry)
  }
  const body = JSON.parse(res.text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null>
  const limits: Limit[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const w = body[kind]
    if (!w || typeof w.utilization !== 'number') continue
    limits.push({ kind, percentUsed: Math.round(w.utilization * 10) / 10, resetsAt: w.resets_at ?? undefined })
  }
  if (limits.length === 0) throw new AskError('answer had no limits')
  return limits
}

type Saved = { at: number; limits: Limit[] }

// why an ask failed, in a few words: the service's own answer as it is, a request that
// never got there (no network, a lookup that failed) as "no network"
function shortError(message: string): string {
  if (/^(refused|failed) \(/.test(message) || message === 'answer had no limits') return message
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|network|timed? ?out/i.test(message)) return 'failed (no network)'
  return 'failed'
}

// this chat's own reading from its replies, and when it last changed
let live: Saved | undefined

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

// v0.1.5 renamed the plugin from claude-code-usage-quota, a name kept for Anthropic's
// own plugins. Its store is a file under the old name, so what it held (each chat's
// auto compact, the learned pace) is copied over once, never over a newer value
const OLD_STORE = 'claude-code-usage-quota_claude-code-usage-quota-mod-'
async function migrateStore($: EngineInterface): Promise<void> {
  if (await storeGet($, 'migrated')) return
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
    if (config) {
      const dir = `${config}/plugins/store`
      const old = (await $.fs.list(dir))
        .filter(f => f.kind === 'file' && f.name.startsWith(OLD_STORE) && f.name.endsWith('.json'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      if (old) {
        const saved = JSON.parse(String(await $.fs.read(`${dir}/${old.name}`))) as Record<string, unknown>
        for (const [key, value] of Object.entries(saved)) {
          if ((await storeGet($, key)) === undefined) await storeSet($, key, value)
        }
      }
    }
  } catch (error) {
    $.ui.log(`usage-quota: the old settings could not be copied: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
  await storeSet($, 'migrated', true)
}

async function storeSet($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // this chat still has it
  }
}

// Two sources, and the newest wins: the usage service (asked seldom, shared by every
// chat through the store) and the figures each reply from Claude carries (this chat's,
// stamped when they last changed). A window that has reset since is dropped.
async function limitsOf(
  $: EngineInterface,
  rateLimits: SessionRateLimit[],
  now: number,
  ask: Ask,
): Promise<{ limits: Limit[]; at?: number; error?: string }> {
  if (rateLimits.length > 0) {
    const limits = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    if (!live || JSON.stringify(live.limits) !== JSON.stringify(limits)) live = { at: now, limits }
  }
  let saved = (await storeGet($, 'limits')) as Saved | undefined
  let backoff = (await storeGet($, 'planBackoff')) as Backoff | undefined
  const askedAt = ((await storeGet($, 'planAskedAt')) as number | undefined) ?? 0
  const isFree = now >= (backoff?.until ?? 0)
  const isDue = ask === 'now' || (ask === 'due' && now - askedAt >= PLAN_EVERY_MS - PLAN_SLACK_MS)
  if (isDue && isFree) {
    // claim the ask first, so the other chats see it taken and skip theirs
    await storeSet($, 'planAskedAt', now)
    try {
      const plan = await fetchPlan($)
      if (plan) {
        saved = { at: now, limits: plan }
        await storeSet($, 'limits', saved)
        await storeSet($, 'planLimits', saved)
      }
      if (backoff) await storeSet($, 'planBackoff', { until: 0, failures: 0, error: '' })
      backoff = undefined
    } catch (error) {
      const failures = (backoff?.failures ?? 0) + 1
      const wait =
        error instanceof AskError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : PLAN_BACKOFF_MS[Math.min(failures - 1, PLAN_BACKOFF_MS.length - 1)]!
      backoff = { until: now + wait, failures, error: error instanceof Error ? error.message : String(error) }
      await storeSet($, 'planBackoff', backoff)
    }
  }
  const pick = [saved, live]
    .filter((r): r is Saved => r !== undefined)
    .sort((x, y) => y.at - x.at)[0]
  // newer reply figures go to the store too, so other chats get them
  if (pick && pick === live && (!saved || live.at > saved.at)) await storeSet($, 'limits', live)
  // The reply figures run behind the usage service, which the app's panel reads: whole
  // percents, and seen at 18 for an hour while the service said 19.0. Use only climbs
  // within a window, so a newer reply figure below the service's last answer is stale:
  // the higher of the two is kept. Above it, the reply's is news.
  const plan = (await storeGet($, 'planLimits')) as Saved | undefined
  const finer = (l: Limit): Limit => {
    const p = plan?.limits.find(x => x.kind === l.kind)
    return p && sameWindow(p.resetsAt, l.resetsAt) && p.percentUsed > l.percentUsed ? { ...l, percentUsed: p.percentUsed } : l
  }
  // a window that has reset since stays, at 0: the forecast reads it as not running
  const limits = (pick?.limits ?? []).map(l =>
    l.resetsAt !== undefined && Date.parse(l.resetsAt) <= now ? { kind: l.kind, percentUsed: 0 } : finer(l),
  )
  return { limits, at: pick?.at, error: backoff?.error ? shortError(backoff.error) : undefined }
}

// What the forecast learns, shared by every chat through the store: how far each past
// window got (its peak, the last few kept), and the running one's peak and skipped %.
type PaceWindow = { resetsAt: number; peak: number; skip: number }
type PaceStore = { finals: Record<string, number[]>; windows: Record<string, PaceWindow> }

// A chat reopened with a long history re-reads it all on its first reply: one big jump
// in usage. Its first turn notes the limits it started from; the first new reading
// that moved is that jump, and is left out of the pace. Only for a chat that opened
// with this much already in it (a new chat's first reply is real work).
const RESUME_MIN_TOKENS = 20_000
let isOpening = true
let openMessages = 0
let spikeFrom: { at: number; limits: Limit[] } | undefined

function median(list: number[] | undefined): number | undefined {
  if (!list || list.length === 0) return undefined
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const sameWindow = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_MS

// the jump the reopened chat's first reply made, once a reading after it has moved
function takeSpike(): Record<string, number> | undefined {
  if (!spikeFrom || !live || live.at <= spikeFrom.at) return undefined
  const jump: Record<string, number> = {}
  for (const l of live.limits) {
    const before = spikeFrom.limits.find(b => b.kind === l.kind)
    if (before && sameWindow(before.resetsAt, l.resetsAt) && l.percentUsed > before.percentUsed) {
      jump[l.kind] = l.percentUsed - before.percentUsed
    }
  }
  if (Object.keys(jump).length === 0) return undefined
  spikeFrom = undefined
  return jump
}

async function trackPace($: EngineInterface, limits: Limit[], now: number): Promise<Record<string, PaceOf>> {
  const spike = takeSpike()
  const saved = ((await storeGet($, 'pace')) as PaceStore | undefined) ?? { finals: {}, windows: {} }
  let isChanged = false
  const pace: Record<string, PaceOf> = {}
  for (const l of limits) {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!WINDOWS[l.kind] || !Number.isFinite(resetsAt) || resetsAt <= now) continue
    let w = saved.windows[l.kind]
    if (!w || Math.abs(w.resetsAt - resetsAt) > SAME_WINDOW_MS) {
      // a new window: the last one's peak is how far it got
      if (w && w.peak > 0) saved.finals[l.kind] = [...(saved.finals[l.kind] ?? []), w.peak].slice(-FINALS_KEPT)
      w = { resetsAt, peak: l.percentUsed, skip: 0 }
      saved.windows[l.kind] = w
      isChanged = true
    } else if (l.percentUsed > w.peak) {
      w.peak = l.percentUsed
      isChanged = true
    }
    const jump = spike?.[l.kind]
    if (jump) {
      w.skip = Math.min(w.peak, w.skip + jump)
      isChanged = true
    }
    pace[l.kind] = { typical: median(saved.finals[l.kind]) ?? TYPICAL_DEFAULT, skip: w.skip }
  }
  if (isChanged) await storeSet($, 'pace', saved)
  return pace
}

// The history: what the weekly limit went to, kept for every chat. Each rise of the
// weekly % is added to the day it happened in (one shared last reading, so two chats
// seeing the same rise count it once); each weekly window keeps the peak it reached.
// The first reading ever only sets the start: the week before it is no one day's.
const DAYS_KEPT = 28
const DAYS_SHOWN = 14
const WEEKS_KEPT = 8
type HistoryStore = {
  last?: { resetsAt: string; percent: number }
  days: Record<string, number>
  weeks: { resetsAt: number; peak: number }[]
}
const dayKey = (t: number) => new Date(t).toLocaleDateString('en-CA')

async function trackHistory($: EngineInterface, limits: Limit[], now: number): Promise<History> {
  const saved = ((await storeGet($, 'history')) as HistoryStore | undefined) ?? { days: {}, weeks: [] }
  let isChanged = false
  const week = limits.find(l => l.kind === 'seven_day')
  const resetsAt = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
  if (week?.resetsAt && Number.isFinite(resetsAt) && resetsAt > now) {
    const last = saved.last
    const isSame = last !== undefined && sameWindow(last.resetsAt, week.resetsAt)
    // a new window starts from 0: all of its % is new
    const rise = !last ? 0 : isSame ? week.percentUsed - last.percent : week.percentUsed
    if (rise > 0) {
      const today = dayKey(now)
      saved.days[today] = Math.round(((saved.days[today] ?? 0) + rise) * 10) / 10
    }
    // a reading a little under the last (the figures round) is no fall to count again
    if (!isSame || week.percentUsed > last!.percent) {
      saved.last = { resetsAt: week.resetsAt, percent: week.percentUsed }
      isChanged = true
    }
    const w = saved.weeks.find(x => Math.abs(x.resetsAt - resetsAt) <= SAME_WINDOW_MS)
    if (!w) {
      saved.weeks = [...saved.weeks, { resetsAt, peak: week.percentUsed }].slice(-WEEKS_KEPT)
      isChanged = true
    } else if (week.percentUsed > w.peak) {
      w.peak = week.percentUsed
      isChanged = true
    }
    const oldest = dayKey(now - DAYS_KEPT * 24 * HOUR)
    for (const key of Object.keys(saved.days)) {
      if (key < oldest) {
        delete saved.days[key]
        isChanged = true
      }
    }
    if (isChanged) await storeSet($, 'history', saved)
    // the days before the band, once, from the chats' records (on a timer: the work
    // outlives this refresh)
    if (saved.last && saved.last.percent >= 1 && !isBackfilling && (await storeGet($, 'historyBackfill')) !== BACKFILL_VERSION) {
      $.clock.after(0, () => void backfillHistory($))
    }
  }
  // the last 14 days, today last, a day with nothing at 0
  const days: HistoryBar[] = []
  for (let i = DAYS_SHOWN - 1; i >= 0; i--) {
    const key = dayKey(now - i * 24 * HOUR)
    days.push({ key, percent: saved.days[key] ?? 0 })
  }
  const weeks = saved.weeks.map(w => ({ key: new Date(w.resetsAt).toISOString(), percent: w.peak }))
  return { days, weeks }
}

// the history's bars, three rows tall: one column per slot of 1000 units, stretched to
// the box as the other bars are (a drawing that kept its proportions grew taller than its
// box and spilled out of the band); the last (today, this week) in the lead colour, an
// empty one a sliver of track so every day still reads
const CHART_PX = 44
function chartSvg(bars: HistoryBar[], color: string, lead: string): string {
  const max = Math.max(1, ...bars.map(b => b.percent))
  const slot = 1000 / Math.max(1, bars.length)
  const w = slot * 0.6
  const rects = bars
    .map((b, i) => {
      const h = b.percent > 0 ? Math.max(3, (b.percent / max) * CHART_PX) : 1.5
      const x = i * slot + (slot - w) / 2
      const fill = b.percent > 0 ? (i === bars.length - 1 ? lead : color) : TRACK
      return `<rect x="${x.toFixed(1)}" y="${(CHART_PX - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${CHART_PX}" viewBox="0 0 1000 ${CHART_PX}" preserveAspectRatio="none">${rects}</svg>`
}
// the terminal's bars: three block characters a column (level 0 the lowest), filled
// from the bottom, as tall as its share of the highest
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
function blockOf(percent: number, max: number, level: 0 | 1 | 2): string {
  if (percent <= 0) return level === 0 ? '▁' : ' '
  const eighths = Math.max(1, Math.ceil((percent / Math.max(1, max)) * 24)) - level * 8
  return eighths <= 0 ? ' ' : BLOCKS[Math.min(8, eighths) - 1]!
}

// The days before the band was installed, read back once from the chats' own records
// (the transcripts under ~/.claude/projects carry every reply's tokens and time). Tokens
// are weighed as the plan prices them (output 5x input, cache writes 1.25x, or 2x for an
// hour, cache reads 0.1x; Opus 5x Haiku, others 3x), then turned into the weekly % by
// this week's own ratio: the % used now over what this week's replies weighed. An
// estimate: replies on other devices are not here, and land in this week's ratio.
const BACKFILL_MS = WEEKS_KEPT * 7 * 24 * HOUR
// v1 could not open a transcript over 4 MiB, and scaled from the small ones alone: v2
// reads them all once more, and its estimate replaces v1's
const BACKFILL_VERSION = 2
let isBackfilling = false
const modelWeight = (model: string | undefined) => (model?.includes('opus') ? 5 : model?.includes('haiku') ? 1 : 3)
type Usage = {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null
}
function weigh(u: Usage, model: string | undefined): number {
  const writes = u.cache_creation
    ? (u.cache_creation.ephemeral_1h_input_tokens ?? 0) * 2 + (u.cache_creation.ephemeral_5m_input_tokens ?? 0) * 1.25
    : (u.cache_creation_input_tokens ?? 0) * 1.25
  return ((u.input_tokens ?? 0) + writes + (u.cache_read_input_tokens ?? 0) * 0.1 + (u.output_tokens ?? 0) * 5) * modelWeight(model)
}

// A transcript can run to tens of MB, past the 4 MiB one read may take: awk on the host
// pulls each reply's figures out (a line of them a reply, a few hundred kB in all), and
// a host without awk, or a test, falls back to reading the file whole when it fits
const AWK = String.raw`
function v(k, re,  s) { if (!match($0, "\"" k "\":" re)) return ""; s = substr($0, RSTART + length(k) + 3, RLENGTH - length(k) - 3); gsub(/"/, "", s); return s }
/"type":"assistant"/ && /"usage"/ {
  print v("timestamp", "\"[^\"]*\"") "\t" v("id", "\"msg_[^\"]*\"") "\t" v("model", "\"[^\"]*\"") "\t" v("input_tokens", "[0-9]+") "\t" v("output_tokens", "[0-9]+") "\t" v("cache_read_input_tokens", "[0-9]+") "\t" v("cache_creation_input_tokens", "[0-9]+") "\t" v("ephemeral_1h_input_tokens", "[0-9]+") "\t" v("ephemeral_5m_input_tokens", "[0-9]+")
}`
type Reply = { at: number; id: string; model?: string; usage: Usage }
async function repliesIn($: EngineInterface, file: string): Promise<Reply[]> {
  const replies: Reply[] = []
  try {
    const { exitCode, stdout } = await $.process.run(['awk', AWK, file], { timeoutMs: 60_000 })
    if (exitCode === 0) {
      for (const line of stdout.split('\n')) {
        const [ts, id, model, input, output, read, write, w1h, w5m] = line.split('\t')
        const at = ts ? Date.parse(ts) : NaN
        if (!id || !Number.isFinite(at)) continue
        const n = (x: string | undefined) => (x ? Number(x) : 0)
        const split = w1h || w5m ? { ephemeral_1h_input_tokens: n(w1h), ephemeral_5m_input_tokens: n(w5m) } : null
        replies.push({ at, id, model: model || undefined, usage: { input_tokens: n(input), output_tokens: n(output), cache_read_input_tokens: n(read), cache_creation_input_tokens: n(write), cache_creation: split } })
      }
      return replies
    }
  } catch {
    // no awk here: read it whole below
  }
  let text: string
  try {
    text = String(await $.fs.read(file))
  } catch {
    return replies
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let row: { timestamp?: string; message?: { id?: string; model?: string; usage?: Usage } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const m = row.message
    const at = row.timestamp ? Date.parse(row.timestamp) : NaN
    if (m?.usage && m.id && Number.isFinite(at)) replies.push({ at, id: m.id, model: m.model, usage: m.usage })
  }
  return replies
}

async function transcripts($: EngineInterface, dir: string, since: number, depth = 0): Promise<string[]> {
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const found: string[] = []
  for (const e of entries) {
    if (e.kind === 'file' && e.name.endsWith('.jsonl') && e.mtimeMs >= since) found.push(`${dir}/${e.name}`)
    // a project's folders: its chats', which hold their subagents' transcripts
    else if (e.kind === 'dir' && depth < 3) found.push(...(await transcripts($, `${dir}/${e.name}`, since, depth + 1)))
  }
  return found
}

async function backfillHistory($: EngineInterface): Promise<void> {
  if (isBackfilling || ((await storeGet($, 'historyBackfill')) as number | undefined) === BACKFILL_VERSION) return
  isBackfilling = true
  try {
    const now = await $.clock.now()
    const saved = (await storeGet($, 'history')) as HistoryStore | undefined
    const week = saved?.last
    const resetsAt = week ? Date.parse(week.resetsAt) : NaN
    // this week's % sets the scale: too little of it says nothing yet
    if (!saved || !week || !Number.isFinite(resetsAt) || week.percent < 1) return
    // read back once, whatever it finds: no records is no history to add
    // a redo of v1's read-back: its days and past weeks are replaced, not kept
    const isRedo = (await storeGet($, 'historyBackfilled')) === true
    await storeSet($, 'historyBackfill', BACKFILL_VERSION)
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
    if (!config) return
    const since = now - BACKFILL_MS
    const byDay: Record<string, number> = {}
    const replies: { at: number; weight: number }[] = []
    const seen = new Set<string>()
    for (const file of await transcripts($, `${config}/projects`, since)) {
      for (const r of await repliesIn($, file)) {
        // a reply is written once per block, each with the same usage: counted once
        if (seen.has(r.id) || r.at < since) continue
        seen.add(r.id)
        const weight = weigh(r.usage, r.model)
        replies.push({ at: r.at, weight })
        byDay[dayKey(r.at)] = (byDay[dayKey(r.at)] ?? 0) + weight
      }
    }
    const weekMs = WINDOWS.seven_day!.ms
    const thisWeek = replies.filter(r => r.at >= resetsAt - weekMs).reduce((sum, r) => sum + r.weight, 0)
    if (thisWeek <= 0) return
    const ratio = week.percent / thisWeek
    const round = (p: number) => Math.min(100, Math.round(p * ratio * 10) / 10)
    // merged into the history as it is now: a refresh may have counted a rise meanwhile;
    // a day already counted live keeps the larger, the estimate covering all of it
    Object.assign(saved, ((await storeGet($, 'history')) as HistoryStore | undefined) ?? {})
    const oldest = dayKey(now - DAYS_KEPT * 24 * HOUR)
    for (const [key, weight] of Object.entries(byDay)) {
      if (key >= oldest) saved.days[key] = isRedo ? round(weight) : Math.max(saved.days[key] ?? 0, round(weight))
    }
    // the weeks before this one, each its own 7 days back from this week's start
    const past: { resetsAt: number; peak: number }[] = []
    for (let k = WEEKS_KEPT - 1; k >= 1; k--) {
      const end = resetsAt - k * weekMs
      if (!isRedo && saved.weeks.some(w => Math.abs(w.resetsAt - end) <= SAME_WINDOW_MS)) continue
      const weight = replies.filter(r => r.at >= end - weekMs && r.at < end).reduce((sum, r) => sum + r.weight, 0)
      if (weight > 0) past.push({ resetsAt: end, peak: round(weight) })
    }
    const kept = isRedo ? saved.weeks.filter(w => Math.abs(w.resetsAt - resetsAt) <= SAME_WINDOW_MS) : saved.weeks
    saved.weeks = [...past, ...kept].sort((a, b) => a.resetsAt - b.resetsAt).slice(-WEEKS_KEPT)
    await storeSet($, 'history', saved)
    await refresh($)
  } catch (error) {
    $.ui.log(`usage-quota: the history could not be read back: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isBackfilling = false
  }
}

const shortDate = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
// a day key read as that local day (Date.parse would read it as UTC midnight)
const dayOf = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime()
}

// The window is shown as three groups: Messages, Tools (System + MCP tools) and Other
// (the system prompt, skills, memory files, agents, MCP server instructions).
const TOOL_NAMES = new Set(['System tools', 'MCP tools'])
type Group = 'Messages' | 'Tools' | 'Other'
const groupOf = (name: string): Group => (name === 'Messages' ? 'Messages' : TOOL_NAMES.has(name) ? 'Tools' : 'Other')

// The free local breakdown ('summary') estimates each category from its text, which
// reads tools ~1.3-1.6x heavy. The exact count ('full', what /context and the app's
// Context window panel show) costs no tokens but sends one token-count request per tool
// and memory file (~320 here). So run it every 2 minutes, keep the exact/estimate ratio
// of Tools and Other (in the store, for every session), and scale the live 3s estimate
// by it; Messages is then the API's real input total less those two.
const CALIBRATE_EVERY_MS = 2 * 60_000
let calib: Partial<Record<Group, number>> = {}
let isCalibrating = false
// Right after /compact there is no API reply yet, so the window's real total is unknown
// and the local estimate is all there is. The exact count fills that gap until the next reply.
let exactCount: { at: number; sums: Record<Group, number> } | undefined
let noReplySince: number | undefined

function sumGroups(categories: readonly { name: string; tokens: number; kind: string }[]): Record<Group, number> {
  const sums: Record<Group, number> = { Messages: 0, Tools: 0, Other: 0 }
  for (const c of categories) if (c.kind === 'used') sums[groupOf(c.name)] += c.tokens
  return sums
}

async function calibrate($: EngineInterface): Promise<void> {
  if (isCalibrating) return
  isCalibrating = true
  try {
    const exact = await $.session.usage({ breakdown: 'full' })
    const rough = await $.session.usage({ breakdown: 'summary' })
    const real = sumGroups(exact.context.breakdown?.categories ?? [])
    const guess = sumGroups(rough.context.breakdown?.categories ?? [])
    const next = { ...calib }
    for (const g of ['Tools', 'Other'] as const) if (guess[g] > 0 && real[g] > 0) next[g] = real[g] / guess[g]
    calib = next
    exactCount = { at: await $.clock.now(), sums: real }
    await $.store.set('calib', next)
    lastSnapshot = ''
  } catch (error) {
    $.ui.log(`usage-quota: exact count failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isCalibrating = false
  }
  // the usage service is asked alongside, on the same 2 minutes
  await refresh($, 'due')
}

// Auto compact fires whenever the chat is idle (no turn running) and the context
// is at or past the %: at the end of a turn, on opening a chat, on any refresh between
// turns. Held back only by: `waits` (the band is asking, or the person chose
// "after my next compact", which is also what an unanswered ask means: cleared only by
// a real compaction, never by the % flickering below), `stuck` (a compaction already ran and
// the context is still past the %: it would only repeat; dropping below clears it).
// The % is compared as the band shows it, rounded.
// a reply has been seen since the chat opened or was last compacted
let hadReply = false
async function setHold($: EngineInterface, patch: Partial<Hold>): Promise<void> {
  await update($, hold, held => ({ ...held, ...patch }))
}
let isBusy = false
let isCompacting = false
let lastPercent = 0

function compactNow($: EngineInterface): void {
  if (isCompacting) return
  isCompacting = true
  // compacting takes longer than a press or a hook may run, so a timer starts it
  $.clock.after(0, async () => {
    try {
      await $.command.run({ command: 'compact' })
    } finally {
      isCompacting = false
    }
  })
}

// Auto compact compacts through the session itself, not by typing /compact: a
// command run from the end of a turn is refused while the turn winds down, which
// is why it toasted and then did nothing. The compaction also rejects while a turn
// runs, so it is tried again a few times, a couple of seconds apart.
const AUTO_TRIES = 6
let canCompactDirectly = true
const AUTO_RETRY_MS = 2_000

function autoCompactNow($: EngineInterface, attempt = 1): void {
  if (attempt === 1) {
    if (isCompacting) return
    isCompacting = true
  }
  $.clock.after(attempt === 1 ? 1_000 : AUTO_RETRY_MS, async () => {
    try {
      // the desktop app (an SDK session) has no direct compaction: there /compact runs
      // as a turn of its own, so it is typed, as the Compact button does
      const result = canCompactDirectly
        ? await $.session.compact()
        : (await $.command.run({ command: 'compact' }), undefined)
      // held as stuck while the figures are read again, so no tick fires a second one
      await setHold($, { stuck: true })
      isCompacting = false
      if (result && 'skip' in result && result.skip) $.ui.toast(`Auto compact was skipped: ${result.skip}`)
      lastSnapshot = ''
      const usage = await $.session.usage({ breakdown: 'summary' })
      const percent = usage.context.percent ?? 0
      // still past the % after compacting: say so once, and do not loop on it
      const auto = await read($, autoCompact)
      if (auto.at !== null && Math.round(percent) >= auto.at) {
        $.ui.toast(`Context is still at ${Math.round(percent)}% after compacting, past your ${auto.at}%: auto compact waits until it drops below`)
      } else await setHold($, { stuck: false })
      await refresh($)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // any refusal of the direct way: type /compact from then on, as the button does
      if (canCompactDirectly) {
        canCompactDirectly = false
        return autoCompactNow($, attempt + 1)
      }
      if (attempt < AUTO_TRIES) return autoCompactNow($, attempt + 1)
      isCompacting = false
      $.ui.toast(`Auto compact could not start: ${reason}`)
      $.ui.log(`usage-quota: auto compact failed: ${reason}`, { to: 'debug' })
    }
  })
}

// called with the context % whenever it is read
async function watchAuto($: EngineInterface, percent: number): Promise<void> {
  lastPercent = percent
  const auto = await read($, autoCompact)
  if (!auto.isOn || auto.at === null) return
  const held = await read($, hold)
  if (Math.round(percent) < auto.at) {
    if (held.stuck) await setHold($, { stuck: false })
    return
  }
  if (held.waits || held.stuck || isBusy || isCompacting) return
  $.ui.toast(`Context at ${Math.round(percent)}%: auto compacting (set at ${auto.at}%)`)
  autoCompactNow($)
}

async function saveAuto($: EngineInterface, next: AutoCompact): Promise<void> {
  await update($, autoCompact, () => next)
  await storeSet($, `autoCompact:${autoChat ?? (await chatId($))}`, next)
}

// auto compact is set per chat: a chat that never had it opens with it off (at the
// default %); a chat reopened, or the app restarted, gets back its own. Read again
// whenever the chat's id changes (a /clear goes on under a new one, unannounced)
let autoChat: string | undefined
async function chatId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return 'chat'
  }
}
async function loadAuto($: EngineInterface): Promise<void> {
  const id = await chatId($)
  if (id === autoChat) return
  autoChat = id
  // the cache this chat's last reply left, an app restart or a reopened chat included
  const savedCache = (await storeGet($, `cache:${id}`)) as Cache | null | undefined
  await update($, cache, () => savedCache ?? null)
  const saved = (await storeGet($, `autoCompact:${id}`)) as AutoCompact | undefined
  await update($, autoCompact, () => (saved ? { ...saved, at: saved.at ?? AT_DEFAULT } : { isOn: false, at: AT_DEFAULT }))
  // the same chat after a reload keeps its ask and what holds it back
  if ((await read($, hold)).chat === id) return
  await update($, hold, () => ({ chat: id, waits: false, stuck: false }))
  await update($, autoAsk, () => null)
}

// the % field sets on Enter, or when the focus leaves it with an unset draft (a
// click elsewhere in the band, or the next prompt sent); 15 to 99, outside is pulled
// in. After a set the field is drawn afresh (fieldTick), which also drops its focus
const AT_MIN = 15
// the % whenever there is none: a blank field, a first switch-on
const AT_DEFAULT = 30
const AT_MAX = 99
let draftAt: string | null = null

// no event says a click landed outside the band, so a draft also sets itself once
// typing has rested a while, as if the person had clicked away
const AT_REST_MS = 2_000
let restTimer: { cancel(): void } | null = null

// the field takes digits only, 3 at most: anything else typed or pasted is dropped
// as it arrives, by drawing the field's text again cleaned
const AT_DIGITS = 3
// a mark of no width, so a cleaned text equal to the one drawn still redraws (an
// unchanged value would leave the typing as it is) without a new field losing focus
const NO_WIDTH = '\u200b'

function cleanAt(value: string): string {
  return value.replace(/\D/g, '').slice(0, AT_DIGITS)
}

// what the field shows comes from state, not a module variable: a press or a typing
// runs apart from the draw, so a value the draw kept would not be seen here
async function redrawField($: EngineInterface, value: string): Promise<void> {
  const at = (await read($, autoCompact)).at ?? AT_DEFAULT
  await update($, fieldText, drawn => (value === (drawn ?? `${at}`) ? value + NO_WIDTH : value))
}

function typedAt($: EngineInterface, raw: string): void {
  const value = cleanAt(raw)
  if (value !== raw) void redrawField($, value)
  draftAt = value
  restTimer?.cancel()
  restTimer = $.clock.after(AT_REST_MS, () => {
    restTimer = null
    void commitDraft($)
  })
}

async function commitDraft($: EngineInterface): Promise<void> {
  if (draftAt === null) return
  await commitAt($, draftAt)
}

async function commitAt($: EngineInterface, value: string): Promise<void> {
  draftAt = null
  restTimer?.cancel()
  restTimer = null
  const text = cleanAt(value)
  // only digits reach here: blank is the default, out of range is pulled in, every time
  const typed = text === '' ? AT_DEFAULT : Number(text)
  const at = Math.min(AT_MAX, Math.max(AT_MIN, typed))
  if (typed !== at) $.ui.toast(`Auto compact: ${typed < at ? 'the least' : 'the most'} is ${at}% – set to ${at}%`)
  await setThreshold($, at)
  // a new field every time (its key changes), so it shows the set value whatever was typed
  await update($, fieldText, () => null)
  await update($, fieldTick, n => n + 1)
}

// a new threshold: armed when the context is below it, else the band asks, in its
// own buttons (never the chat's question dialog, which runs through the chat)
async function setThreshold($: EngineInterface, at: number): Promise<void> {
  await saveAuto($, { isOn: true, at })
  await askIfPast($, at)
}

// turning it on, or a new %, while the context is already past it: ask first
async function askIfPast($: EngineInterface, at: number | null): Promise<void> {
  const isPast = at !== null && Math.round(lastPercent) >= at
  await setHold($, { waits: isPast, stuck: false })
  await update($, autoAsk, () => (isPast ? { at: at!, percent: Math.round(lastPercent) } : null))
  if (!isPast && at !== null) $.ui.toast(`Auto compact at ${at}% context`)
}

type AskChoice = 'now' | 'next'

async function answerAsk($: EngineInterface, choice: AskChoice): Promise<void> {
  await update($, autoAsk, () => null)
  // 'next': goes on waiting until a compaction is seen (the reply total goes blank)
  if (choice === 'now') {
    await setHold($, { waits: false })
    autoCompactNow($)
  }
}

let isRefreshing = false
// an ask that arrived while a 3s tick was running: done right after it, not dropped
let pendingAsk: Ask = 'no'
let lastSnapshot = ''
let hadError = false

// collapsed or not is one setting for every chat, kept in the shared store: each chat
// reads it twice a second (one small read, nothing else) and follows
const COLLAPSE_EVERY_MS = 500
// this chat's own press, until the store has it
async function syncCollapsed($: EngineInterface): Promise<void> {
  const saved = ((await storeGet($, 'collapsed')) as boolean | undefined) === true
  if (saved !== (await read($, isCollapsed))) await update($, isCollapsed, () => saved)
}

// The desktop app's theme is not told to plugins: it is read from the app's own
// settings (userThemeMode), and for "system" from the OS. Looked at every 2s so a
// switch shows at once, each look a single file-time check (the file is read only
// once it changed); the OS, for "system" alone, is asked at most every 15s
const THEME_EVERY_MS = 2_000
const SYSTEM_EVERY_MS = 15_000
let didLogTheme = false
let systemTheme: { at: number; value: 'dark' | 'light' } | undefined
async function desktopConfig($: EngineInterface): Promise<string | undefined> {
  const appData = await $.env.get('APPDATA')
  if (appData) return `${appData}/Claude/config.json`
  const home = await $.env.get('HOME')
  return home ? `${home}/Library/Application Support/Claude/config.json` : undefined
}
async function osTheme($: EngineInterface): Promise<'dark' | 'light'> {
  const now = await $.clock.now()
  if (systemTheme && now - systemTheme.at < SYSTEM_EVERY_MS) return systemTheme.value
  let value: 'dark' | 'light' = 'dark'
  try {
    if (await $.env.get('APPDATA')) {
      const { stdout } = await $.process.run(['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { timeoutMs: 5_000 })
      if (/AppsUseLightTheme\s+REG_DWORD\s+0x1\b/.test(stdout)) value = 'light'
    } else {
      const { stdout } = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 })
      if (!/dark/i.test(stdout)) value = 'light'
    }
  } catch {
    // unknown: dark, as the band was built
  }
  systemTheme = { at: now, value }
  return value
}
// the settings file is read again only when it has changed since the last look: a
// look is otherwise one file-time check, no read, no parse
let themeFile: { mtimeMs: number; mode: string | undefined } | undefined
async function syncTheme($: EngineInterface): Promise<void> {
  let mode: string | undefined
  try {
    const path = await desktopConfig($)
    if (!path) return
    const { mtimeMs } = await $.fs.stat(path)
    if (themeFile?.mtimeMs === mtimeMs) mode = themeFile.mode
    else {
      mode = (JSON.parse(await $.fs.read(path)) as { userThemeMode?: string }).userThemeMode
      themeFile = { mtimeMs, mode }
    }
  } catch (error) {
    if (!didLogTheme) $.ui.log(`usage-quota: the app's theme could not be read: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    didLogTheme = true
    return
  }
  const next = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : await osTheme($)
  if (next !== (await read($, theme))) await update($, theme, () => next)
}

async function refresh($: EngineInterface, ask: Ask = 'no'): Promise<void> {
  await loadAuto($)
  if (isRefreshing) {
    if (ask === 'now' || (ask === 'due' && pendingAsk === 'no')) pendingAsk = ask
    return
  }
  isRefreshing = true
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage({ breakdown: 'summary' })
    const { context } = usage
    const breakdown = context.breakdown
    const all = (breakdown?.categories ?? []).filter(c => c.kind !== 'deferred' && c.tokens > 0)
    const rough = sumGroups(all)
    if (context.tokens === undefined) {
      // no reply since the chat opened or was compacted: get the exact count once
      if (noReplySince === undefined) {
        noReplySince = now
        $.clock.after(0, () => void calibrate($))
      }
    } else noReplySince = undefined
    // what the chat opened with, before its first turn here (a reopened chat may
    // already carry its last reply's total, so not only while that is blank)
    if (isOpening) openMessages = Math.max(rough.Messages, context.tokens ?? 0)
    // the reply total going blank after a reply: the chat was compacted (or cleared)
    if (context.tokens !== undefined) hadReply = true
    else if (hadReply) {
      hadReply = false
      // an ask left unanswered meant "after my next compact": done with now
      if ((await read($, hold)).waits) {
        await update($, autoAsk, () => null)
        await setHold($, { waits: false })
      }
    }
    const useExact = context.tokens === undefined && exactCount !== undefined && noReplySince !== undefined && exactCount.at >= noReplySince
    let tools = Math.round(rough.Tools * (calib.Tools ?? 1))
    let other = Math.round(rough.Other * (calib.Other ?? 1))
    // Messages is what the window holds beyond everything else, as /context counts it:
    // the API's real input total less the other groups, not the local estimate
    let messages = context.tokens !== undefined && context.tokens - tools - other > 0
      ? context.tokens - tools - other
      : rough.Messages
    if (useExact) ({ Messages: messages, Tools: tools, Other: other } = exactCount!.sums)
    const used = context.tokens ?? (useExact ? messages + tools + other : breakdown?.totalTokens ?? 0)
    const categories: Category[] = [
      { name: 'Messages', tokens: messages, kind: 'used' },
      { name: 'Tools', tokens: tools, kind: 'used' },
      { name: 'Other', tokens: other, kind: 'used' },
      ...all
        .filter(c => c.kind === 'buffer' || c.kind === 'free')
        .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind as Category['kind'] })),
    ].filter(c => c.tokens > 0)
    const { limits, at: limitsAt, error: limitsError } = await limitsOf($, usage.rateLimits, now, ask)
    const pace = await trackPace($, limits, now)
    const history = await trackHistory($, limits, now)
    const next: Snapshot = {
      window: context.window,
      tokens: used,
      percent: useExact ? Math.round((used / context.window) * 100) : context.percent ?? breakdown?.percentage ?? Math.round((used / context.window) * 100),
      total: categories.reduce((sum, c) => sum + c.tokens, 0) || context.window,
      categories,
      limits,
      ...(limitsAt !== undefined ? { limitsAt } : {}),
      ...(limitsError ? { limitsError } : {}),
      ...(Object.keys(pace).length > 0 ? { pace } : {}),
      ...(history.weeks.length > 0 ? { history } : {}),
      // the minute, so countdowns and ages redraw even when nothing else moves
      minute: Math.floor(now / 60_000),
    }
    await watchAuto($, next.percent)
    // redraw only when something moved, not on every tick
    const json = JSON.stringify(next)
    if (json !== lastSnapshot) {
      lastSnapshot = json
      await update($, snapshot, () => next)
    }
    if (hadError) $.ui.status(undefined)
    hadError = false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.status(`usage-quota: ${message.replace(/^usage-quota: /, '')}`)
    hadError = true
  } finally {
    isRefreshing = false
  }
  if (pendingAsk !== 'no') {
    const queued = pendingAsk
    pendingAsk = 'no'
    await refresh($, queued)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quota', description: 'Toggle the Claude Code Usage Quota band above the prompt' })
    const result = await next(e)
    await migrateStore($)
    try {
      calib = ((await $.store.get('calib')) as typeof calib | undefined) ?? {}
    } catch {
      calib = {}
    }
    await loadAuto($)
    await syncCollapsed($)
    const by = await storeGet($, 'historyBy')
    if (by === 'days' || by === 'weeks') await update($, historyBy, () => by)
    try {
      const auth = await $.session.authorize()
      cacheTtl = auth?.kind === 'bearer' ? CACHE_TTL_LOGIN : CACHE_TTL_KEY
    } catch {
      cacheTtl = CACHE_TTL_LOGIN
    }
    // a chat just opened: its limits now, unless another chat asked a moment ago
    await refresh($, 'due')
    // the exact count on a timer, never from the hook itself: work a hook starts and
    // leaves running ends with its dispatch, which is why it never ran before
    $.clock.after(2_000, () => void calibrate($))
    $.clock.every(CALIBRATE_EVERY_MS, () => void calibrate($))
    // keep it live, mid-turn included: what Claude Code already holds (the context and
    // the limits each reply carries), every 3s; timers stop when the module reloads
    $.clock.every(LOCAL_EVERY_MS, () => void refresh($))
    $.clock.every(COLLAPSE_EVERY_MS, () => void syncCollapsed($))
    // whatever surface the session started on (a desktop chat may say none)
    await syncTheme($)
    $.clock.every(THEME_EVERY_MS, () => void syncTheme($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // the focus leaving the % field sets what was typed in it
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.element?.startsWith('autoAt')) await commitDraft($)
    return next(e)
  }).catch(($, e, next) => next(e)) // a draft that fails to set never holds the focus back

  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
    await commitDraft($)
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    void commitDraft($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    if (isOpening) {
      isOpening = false
      const snap = await read($, snapshot)
      if (snap && snap.limits.length > 0 && openMessages >= RESUME_MIN_TOKENS) {
        spikeFrom = { at: await $.clock.now(), limits: snap.limits }
      }
    }
    await commitDraft($)
    return next(e)
  })

  // each reply of the main thread caches the context afresh: the clock starts over
  // (turn.step streams: the hook passes the chunks through and reads the result)
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const held = result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens
      await saveCache($, { at: await $.clock.now(), tokens: held, ttl: cacheTtl })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // the first reply is done: whatever it used, the jump is behind it
    spikeFrom = undefined
    // the turn is over: auto compact may fire now, never mid-reply
    isBusy = false
    const snap = await read($, snapshot)
    if (snap) await watchAuto($, snap.percent)
    return result
  })

  on('command.run', { command: 'quota' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($, 'now')
    return { text: now ? 'Claude Code Usage Quota on.' : 'Claude Code Usage Quota off.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text, Button, Input } = table
    const Svg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    usePalette(e.surface === 'desktop' && (await read($, theme)) === 'light' ? LIGHT : DARK)
    const width = Math.max(20, e.props.bodyColumns)
    const now = await $.clock.now()
    // both windows always, once there is any reading: one the reading lacks is not running
    const known = snap.limits.length === 0 ? [] : Object.keys(WINDOWS).map(kind => snap.limits.find(l => l.kind === kind) ?? { kind, percentUsed: 0 })
    const list = known.map(l => forecast(l, now, snap.pace?.[l.kind])).filter((f): f is Forecast => f !== null)
    const head = headline(list, now)
    // free as /context has it: the window less what is used and the autocompact buffer
    const buffer = snap.categories.find(c => c.kind === 'buffer')?.tokens ?? 0
    const free = Math.max(0, snap.window - snap.tokens - buffer)
    // highest first, as /context lists them: used categories, then the buffer, then free space
    const rank = (c: Category) => (c.kind === 'used' ? 0 : c.kind === 'buffer' ? 1 : 2)
    const shown = snap.categories
      .map((c, i) => ({ ...c, color: colorOf(c, i) }))
      .sort((a, b) => rank(a) - rank(b) || b.tokens - a.tokens)

    const limits = [...list].sort((a, b) => order(a.kind) - order(b.kind))
    // say so when the figures are old: the service refused and no reply has come since
    const age = snap.limitsAt === undefined ? 0 : now - snap.limitsAt
    const stale =
      snap.limitsError && age >= 2 * 60_000 && limits.length > 0
        ? `usage check ${snap.limitsError} – figures from ${duration(age)} ago`
        : snap.limitsError && limits.length === 0
          ? `usage check ${snap.limitsError}`
          : undefined
    const cached = await read($, cache)
    const cacheState = cached ? cacheLook(cached, now) : undefined
    // the cache's state as a pill: a rounded Svg on the desktop, a coloured run on the terminal
    const cachePill = (look: CacheLook) => (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {Svg ? (
          <Box width={PILL_CELLS} height={1} alignItems="center" flexShrink={0}>
            <Svg alt={`Cache ${look.label.toLowerCase()}`} source={pillSvg(look.label, look.color)} height={PILL_H} />
          </Box>
        ) : (
          <Box backgroundColor={look.color} flexShrink={0}>
            <Text bold color={PILL_INK}>{` ${look.label} `}</Text>
          </Box>
        )}
        <Text bold color={look.color}>{look.short}</Text>
      </Box>
    )
    const collapsed = await read($, isCollapsed)
    const showHistory = !collapsed && snap.history !== undefined && (await read($, isHistory))
    const auto = await read($, autoCompact)
    const ask = await read($, autoAsk)
    const tick = await read($, fieldTick)
    const drawnAt = (await read($, fieldText)) ?? `${auto.at ?? AT_DEFAULT}`
    const submitAt = (value: string) => commitAt($, value)
    const toggleAuto = () => {
      const flipped = { isOn: !auto.isOn, at: auto.at ?? AT_DEFAULT }
      void saveAuto($, flipped).then(() =>
        flipped.isOn ? askIfPast($, flipped.at) : update($, autoAsk, () => null),
      )
    }
    // Laid out to the width the chat gives the band, down to the desktop's narrowest
    // chat: what fits side by side stays side by side; past that it stacks, and text
    // wraps rather than cuts off.
    // The header: the headline beside the controls when both fit, else the controls
    // on a row of their own beneath it
    // (the desktop's letters are narrower than its cells: about 0.8 of one)
    const CONTROLS = 50
    // the terminal draws its own hide control ([-]) over the band's top-right
    // corner: the first row keeps clear of it
    const HOST_HIDE = Svg ? 0 : 4
    const pillCells = collapsed && cacheState ? PILL_CELLS + cacheState.short.length + 3 : 0
    const isHeadBeside = width >= (head?.text.length ?? 0) * (Svg ? 0.8 : 1) + CONTROLS + pillCells + HOST_HIDE
    // the windows and the context side by side, or one above the other
    const isSplit = width >= 84
    const column = isSplit ? Math.floor((width - 4) / 2) : width
    // the limit bars fill their column: less the label (8) and the % (2 + 4)
    const cells = Math.max(6, column - 14)
    // collapsed: the three bars in one row, or each on a row of its own
    const isOneRow = width >= 72
    // the context's two figures on one line, or the free count on the next
    const isContextLine = column >= 38
    // the question and its two answers on one line when they fit, else the answers
    // beneath: measured from the words themselves (the desktop draws text narrower than
    // a cell each, as the headline's check allows), each button's chrome and the gaps
    const ASK_LABELS = ['Now', 'After my next compact']
    const askWords = (ask ? `Context is already at ${ask.percent}%, past ${ask.at}%. Auto compact:`.length : 0) + ASK_LABELS.join('').length
    const isAskLine = width >= askWords * (Svg ? 0.8 : 1) + ASK_LABELS.length * (Svg ? 3 : 4) + 3

    // collapsed, the cache's pill leads the controls: the row of bars keeps all its width
    const headPill = collapsed && cacheState ? cacheState : undefined
    const controls = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0} flexWrap="wrap">
        {headPill ? <Box marginRight={2}>{cachePill(headPill)}</Box> : null}
        {/* auto compact: the switch (the press), its name, the % field beside it,
            then a wide gap so the field reads as the switch's, not Compact's */}
        {Svg ? (
          <Box key="autoSwitch" width={SWITCH_CELLS} height={1} overflow="hidden">
            {/* three layers, each the box's full size, so all share one centre: the
                rounded light (unlit: an invisible border), the pill, the press */}
            <Box position="absolute" top={0} left={0} width={SWITCH_CELLS} height={1} borderStyle="round" borderColor={CLEAR} hover={{ backgroundColor: SWITCH_LIT, borderColor: SWITCH_LIT }} />
            <Box position="absolute" top={0} left={0} width={SWITCH_CELLS} height={1} alignItems="center" justifyContent="center">
              <Svg alt={`Auto compact ${auto.isOn ? 'on' : 'off'}`} source={switchSvg(auto.isOn)} width={SWITCH_W} height={SWITCH_H} />
            </Box>
            {/* a chromeless button over all of it takes the click */}
            <Box position="absolute" top={0} left={0}>
              <Button key="auto" label={'   '} plain hover={{ backgroundColor: CLEAR }} onPress={toggleAuto} />
            </Box>
          </Box>
        ) : (
          <Button key="auto" label={auto.isOn ? '●' : '○'} plain onPress={toggleAuto} />
        )}
        <Text color={auto.isOn ? undefined : MUTED}>Auto compact</Text>
        {auto.isOn ? (
          // the field (3 digits) sets itself once typing pauses; a plain % right after it
          <Box flexDirection="row" alignItems="center">
            {/* the field's Enter chip can't be turned off: the field is drawn wider than
                its box and the box clips the chip away */}
            <Box width={4} overflow="hidden">
              <Box width={6} flexShrink={0}>
                <Input
                  key={`autoAt${tick}`}
                  value={drawnAt}
                  submitLabel={'\u200b'}
                  onInput={value => typedAt($, value)}
                  onSubmit={value => submitAt(value)}
                />
              </Box>
            </Box>
            <Text color={MUTED}>%</Text>
          </Box>
        ) : Svg ? (
          // off: the field's room is kept, unseen, so the switch sits at the very same
          // spot and draws pixel for pixel as when on
          <Box flexDirection="row" alignItems="center">
            <Box width={4} />
            <Text color={CLEAR}>%</Text>
          </Box>
        ) : null}
        <Box key="compactBox" marginLeft={isHeadBeside ? 2 : 0} flexDirection="row" columnGap={1}>
          {/* the history in place of the limits and the context, and back */}
          {!collapsed && snap.history ? (
            <Button key="history" label={showHistory ? 'Usage' : 'History'} hover={{ backgroundColor: COMPACT_LIT }} onPress={() => void update($, isHistory, v => !v)} />
          ) : null}
          <Button key="compact" label="Compact" hover={{ backgroundColor: COMPACT_LIT }} onPress={() => compactNow($)} />
        </Box>
        <Button
          key="collapse"
          label={collapsed ? '▲' : '▼'}
          plain
          onPress={async () => {
            // from the state, not this closure's value (an older draw's); saved for
            // the other chats first, so the half-second read never undoes the press
            const now = !(await read($, isCollapsed))
            await storeSet($, 'collapsed', now)
            await update($, isCollapsed, () => now)
          }}
        />
      </Box>
    )
    const gap = Svg ? 0.5 : 1
    const headText = <Text bold color={head ? ink(head.color) : MUTED} wrap="wrap">{head?.text ?? ' '}</Text>

    // one bar: an Svg on the desktop, coloured cells on the terminal
    const bar = (alt: string, segments: { color: string; share: number }[], barCells: number, marker?: number, f?: Forecast) =>
      Svg ? (
        <Box width={barCells} height={1} alignItems="center">
          <Svg alt={alt} source={barSvg(segments, barCells * 8, marker)} height={BAR_PX} />
        </Box>
      ) : f ? (
        <Box flexDirection="row" width={barCells}>
          {cellRuns(f, barCells).map(run => (
            <Box width={run.width} backgroundColor={run.color}>
              <Text> </Text>
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="row" width={barCells} overflow="hidden">
          {segments.map(seg => {
            const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
            return (
              <Box backgroundColor={seg.color} flexGrow={Math.min(10000, Math.max(seg.share > 0 ? 1 : 0, Math.round((seg.share / total) * 1000)))} flexShrink={1}>
                <Text> </Text>
              </Box>
            )
          })}
        </Box>
      )
    const limitSegments = (f: Forecast) => [
      { color: f.color, share: Math.min(100, f.percent) },
      { color: TRACK, share: Math.max(0, 100 - f.percent) },
    ]
    // the bar in three colours: Messages, Tools, and one light grey run for Other and
    // the autocompact buffer together (drawn as one, no seam between them); then free.
    // Always in that order, so Other sits against the buffer
    const BAR_ORDER = ['Messages', 'Tools', 'Other']
    const barRank = (c: (typeof shown)[number]) => (c.kind === 'used' ? Math.max(0, BAR_ORDER.indexOf(c.name)) : c.kind === 'buffer' ? 3 : 4)
    const contextSegments = [...shown]
      .sort((a, b) => barRank(a) - barRank(b))
      .map(c => ({ color: c.name === 'Other' && c.kind === 'used' ? BUFFER : c.color, share: c.tokens }))
      .reduce<Segment[]>((runs, seg) => {
        const last = runs[runs.length - 1]
        if (last && last.color === seg.color) last.share += seg.share
        else runs.push({ ...seg })
        return runs
      }, [])

    const limitsBlock = (
      <Box flexDirection="column" width={isSplit ? '50%' : undefined}>
        {limits.length === 0 ? <Text color={MUTED} wrap="wrap">Usage limits show after the first reply.</Text> : null}
        {stale ? <Text color={AMBER} wrap="wrap">{stale}</Text> : null}
        {limits.map((f, i) => {
          // held together when the note wraps: "resets in 2d 20h" moves down whole,
          // never leaving "20h" alone on the next line
          const left = `resets in ${duration(f.resetsAt - now)}`.replace(/ /g, NB)
          const note =
            f.status === 'idle'
              ? 'starts with your next message'
              : f.status === 'out'
                ? `Limit will hit in ${duration(f.runOutAt - now)} – ${left}`
                : f.status === 'hit'
                  ? `Limit reached – ${left}`
                  : `On pace for about ${Math.round(Math.min(100, f.projected))}% by reset – ${left}`
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Box width={8} flexShrink={0}>
                  <Text bold wrap="truncate-end">{f.label}</Text>
                </Box>
                {bar(`${f.label} ${Math.round(f.percent)}% used`, limitSegments(f), cells, markerOf(f), f)}
                <Box marginLeft={2} flexShrink={0}>
                  <Text bold color={ink(f.color)}>{`${Math.round(f.percent)}%`}</Text>
                </Box>
              </Box>
              <Text color={MUTED} wrap="wrap">{note}</Text>
              {/* a whole blank line, not a margin: the desktop draws margins shorter
                  than a line, which put Weekly out of step with the right column */}
              {i < limits.length - 1 ? <Text> </Text> : null}
            </Box>
          )
        })}
      </Box>
    )

    const usedText = <Text bold color={ink(fillColor(snap.percent))}>{`${Math.round(snap.percent)}% used`}</Text>
    const freeText = <Text color={MUTED}>{`${tokens(free)} free of ${tokens(snap.window)}`}</Text>
    const contextName = (
      <Box flexDirection="row">
        <Text bold>Context</Text>
        <Box marginLeft={2}>{usedText}</Box>
      </Box>
    )
    const contextBlock = (
      <Box flexDirection="column" width={isSplit ? '50%' : undefined}>
        {bar(`Context ${Math.round(snap.percent)}% used`, contextSegments, column)}
        {isContextLine ? (
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            {contextName}
            {freeText}
          </Box>
        ) : (
          <Box flexDirection="column">
            {contextName}
            {freeText}
          </Box>
        )}
        {(['Messages', 'Tools', 'Other'] as const)
          .map(name => shown.find(c => c.name === name))
          .filter((c): c is (typeof shown)[number] => c !== undefined)
          .map(c => (
            <Box flexDirection="row" justifyContent="space-between">
              <Text color={c.color}>{c.name}</Text>
              <Text color={MUTED}>{tokens(c.tokens)}</Text>
            </Box>
          ))}
        {cacheState ? (
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            {cachePill(cacheState)}
            {cacheState.rewrites ? <Text color={MUTED} wrap="wrap">{`next reply rewrites ${tokens(cacheState.rewrites)}`}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )

    // collapsed, the limits go by a short name and the time to their reset: "5H 1h 3m",
    // "W 2d 21h"; a window not running shows its whole length: "5H 5h", "W 7d"
    const compactItems = [
      ...limits.map(f => ({
        label: f.label,
        short: f.kind === 'five_hour' ? '5H' : f.kind === 'seven_day' ? 'W' : f.label,
        // not running yet: the whole window, the countdown it will start from (5h, 7d)
        until: f.status === 'idle' || !Number.isFinite(f.resetsAt) ? duration(WINDOWS[f.kind]?.ms ?? 0) : duration(f.resetsAt - now),
        percent: f.percent,
        color: f.color, marker: markerOf(f), segments: limitSegments(f), f: f as Forecast | undefined,
      })),
      // Context with the whole window, as the limits have their time: 1M, 200k
      { label: 'Context', short: 'Context', until: tokens(snap.window), percent: snap.percent, color: fillColor(snap.percent), marker: undefined as number | undefined, segments: contextSegments, f: undefined as Forecast | undefined },
    ]
    const nameOf = (item: (typeof compactItems)[number]) => (
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        <Text bold>{item.short}</Text>
        {item.until ? <Text color={MUTED}>{item.until}</Text> : null}
      </Box>
    )
    const nameLength = (item: (typeof compactItems)[number]) => item.short.length + (item.until ? item.until.length + 1 : 0)
    const third = Math.floor((width - 2 * 3) / 3)
    // Collapsed, one row: each limit sits in a slot of fixed width, so W always starts at
    // the same place: its name, room for the longest time ("4h 59m", "6d 23h"), its bar
    // (one fixed width for both), room for "100%". A shorter time moves the bar left
    // inside the slot, never the slot. Context takes all that is left, its % held to
    // the right edge, its bar as wide as fits.
    const TIME_CELLS = 6
    const limitBar = Math.max(6, third - 'Weekly'.length - '100%'.length - 2)
    const slotOf = (item: (typeof compactItems)[number]) => item.short.length + 1 + TIME_CELLS + 1 + limitBar + 1 + '100%'.length
    // between the slots: enough that a 100% never runs into the next name
    const GAP = 2
    const slotsWidth = compactItems.filter(item => item.f).reduce((sum, item) => sum + slotOf(item) + GAP, 0)
    const contextItem = compactItems[compactItems.length - 1]!
    const contextBar = Math.max(6, width - slotsWidth - nameLength(contextItem) - 1 - 1 - `${Math.round(contextItem.percent)}%`.length)
    const collapsedBlock = isOneRow ? (
      <Box flexDirection="row" columnGap={GAP}>
        {compactItems.map(item => {
          const pct = `${Math.round(item.percent)}%`
          const isContext = item === contextItem
          return (
            <Box flexDirection="row" width={isContext ? undefined : slotOf(item)} flexGrow={isContext ? 1 : 0} flexShrink={isContext ? 1 : 0}>
              <Box marginRight={1} flexShrink={0}>
                {nameOf(item)}
              </Box>
              {isContext && Svg ? (
                // on the desktop the bar stretches to fill what the row leaves, so the
                // % lands at the right edge however wide the text draws
                <Box flexGrow={1} flexShrink={1} height={1} alignItems="center">
                  <Svg alt={`Context ${pct} used`} source={barSvg(item.segments, 4000)} height={BAR_PX} />
                </Box>
              ) : (
                bar(`${item.label} ${Math.round(item.percent)}% used`, item.segments, isContext ? contextBar : limitBar, item.marker, item.f)
              )}
              <Box marginLeft={1} flexShrink={0} flexGrow={isContext && !Svg ? 1 : 0} justifyContent={isContext ? 'flex-end' : undefined}>
                <Text bold color={ink(item.color)}>{pct}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    ) : (
      // each on a row of its own, the names in one column (as wide as the longest) and
      // the %s in another
      (() => {
        const nameCells = Math.max(8, ...compactItems.map(item => nameLength(item) + 1))
        return (
          <Box flexDirection="column">
            {compactItems.map(item => (
              <Box flexDirection="row">
                <Box width={nameCells} flexShrink={0}>
                  {nameOf(item)}
                </Box>
                {bar(`${item.label} ${Math.round(item.percent)}% used`, item.segments, Math.max(6, width - nameCells - 6), item.marker, item.f)}
                <Box marginLeft={2} flexShrink={0}>
                  <Text bold color={ink(item.color)}>{`${Math.round(item.percent)}%`}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )
      })()
    )

    const askText = ask ? <Text color={AMBER} wrap="wrap">{`Context is already at ${ask.percent}%, past ${ask.at}%. Auto compact:`}</Text> : null
    const askButtons = (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap" flexShrink={0}>
        <Button key="askNow" label="Now" onPress={() => void answerAsk($, 'now')} />
        <Button key="askNext" label="After my next compact" onPress={() => void answerAsk($, 'next')} />
      </Box>
    )

    // the history, beneath the rest when expanded: what the weekly limit went to by day
    // (the last 14) or by week (the last 8), the view a choice kept for every chat
    const by = await read($, historyBy)
    const hist = snap.history
    const historyBlock = (() => {
      if (!hist) return null
      const bars = by === 'days' ? hist.days : hist.weeks
      const last = bars[bars.length - 1]
      const share = (p: number) => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`)
      // the average from the first bar with anything in it, so days before the band
      // was installed don't pull it down; weeks: the finished ones
      const first = bars.findIndex(b => b.percent > 0)
      const counted = by === 'days' ? (first < 0 ? [] : bars.slice(first)) : bars.slice(0, -1)
      const avg = counted.length > 0 ? counted.reduce((sum, b) => sum + b.percent, 0) / counted.length : undefined
      const summary =
        by === 'days'
          ? `${share(last?.percent ?? 0)} today${avg !== undefined ? ` – ${share(avg)} a day on average` : ''}`
          : `${share(last?.percent ?? 0)} this week${avg !== undefined ? ` – ${share(avg)} a week on average` : ''}`
      const choose = (view: 'days' | 'weeks') => async () => {
        await storeSet($, 'historyBy', view)
        await update($, historyBy, () => view)
      }
      const tab = (value: 'days' | 'weeks', label: string) =>
        by === value ? <Text bold>{label}</Text> : <Button key={`history-${value}`} label={label} plain dimColor onPress={choose(value)} />
      const span = !bars[0]
        ? ''
        : by === 'days'
          ? `${shortDate(dayOf(bars[0].key))} to today`
          : `the week of ${shortDate(Date.parse(bars[0].key) - WINDOWS.seven_day!.ms)} to this week`
      const max = Math.max(1, ...bars.map(b => b.percent))
      const color = PALETTE[1]!
      const lead = PALETTE[0]!
      // under each bar its day's initial, or its week's start (10/23); the last in bold
      const labelOf = (b: HistoryBar) => {
        const t = by === 'days' ? dayOf(b.key) : Date.parse(b.key) - WINDOWS.seven_day!.ms
        return by === 'days'
          ? new Date(t).toLocaleDateString('en-US', { weekday: 'narrow' })
          : new Date(t).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
      }
      // one column a bar, its label beneath it: on the desktop the width shared out, on
      // the terminal just wide enough for a week's date
      const COL = Svg ? Math.max(by === 'days' ? 2 : 5, Math.floor(width / Math.max(1, bars.length))) : by === 'days' ? 3 : 6
      const chartWidth = bars.length * COL
      // beneath the bars, each one's % (a narrow column drops the sign), then its day
      const valueOf = (b: HistoryBar) => (b.percent <= 0 ? '' : COL >= 4 ? share(b.percent) : b.percent < 1 ? '<1' : `${Math.round(b.percent)}`)
      const row = (text: (b: HistoryBar) => string, isMuted: boolean) => (
        <Box flexDirection="row" width={chartWidth}>
          {bars.map((b, i) => (
            <Box width={COL} flexShrink={0} justifyContent={Svg ? 'center' : 'flex-start'}>
              <Text bold={i === bars.length - 1} color={i === bars.length - 1 ? lead : isMuted ? MUTED : undefined} wrap="truncate-end">{text(b)}</Text>
            </Box>
          ))}
        </Box>
      )
      const labels = (
        <Box flexDirection="column">
          {row(valueOf, false)}
          {row(labelOf, true)}
        </Box>
      )
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap">
            <Box flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
              <Text bold>History</Text>
              <Box marginLeft={1}>{tab('days', 'Days')}</Box>
              <Text color={MUTED}>/</Text>
              {tab('weeks', 'Weeks')}
            </Box>
            <Text color={MUTED} wrap="wrap">{`${summary} – highest ${share(max)}`}</Text>
          </Box>
          {Svg ? (
            <Box width={chartWidth} height={3} alignItems="flex-end">
              <Svg alt={`History: weekly limit used by ${by === 'days' ? 'day' : 'week'}, ${span}: ${bars.map(b => share(b.percent)).join(', ')}`} source={chartSvg(bars, color, lead)} height={CHART_PX} />
            </Box>
          ) : (
            ([2, 1, 0] as const).map(level => (
              <Box flexDirection="row">
                {bars.map((b, i) => (
                  <Box width={COL} flexShrink={0}>
                    <Text color={i === bars.length - 1 ? lead : b.percent > 0 ? color : TRACK}>{blockOf(b.percent, max, level)}</Text>
                  </Box>
                ))}
              </Box>
            ))
          )}
          {labels}
        </Box>
      )
    })()

    return (
      <Box flexDirection="column">
        {isHeadBeside ? (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={gap} paddingRight={HOST_HIDE}>
            <Box flexShrink={1}>{headText}</Box>
            {controls}
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={gap}>
            <Box paddingRight={HOST_HIDE}>{headText}</Box>
            <Box marginTop={gap}>{controls}</Box>
          </Box>
        )}

        {ask ? (
          isAskLine ? (
            <Box flexDirection="row" alignItems="center" columnGap={1} marginBottom={gap}>
              <Box flexShrink={1}>{askText}</Box>
              {askButtons}
            </Box>
          ) : (
            <Box flexDirection="column" marginBottom={gap}>
              {askText}
              <Box marginTop={gap}>{askButtons}</Box>
            </Box>
          )
        ) : null}

        {collapsed ? (
          collapsedBlock
        ) : showHistory ? (
          historyBlock
        ) : isSplit ? (
          <Box flexDirection="row" columnGap={4}>
            {limitsBlock}
            {contextBlock}
          </Box>
        ) : (
          <Box flexDirection="column">
            {limitsBlock}
            <Text> </Text>
            {contextBlock}
          </Box>
        )}
      </Box>
    )
  })
}
