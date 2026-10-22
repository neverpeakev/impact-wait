import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GoodwaitAd, GoodwaitCurrent, GoodwaitEarner, GoodwaitExternal, GoodwaitImpact, GoodwaitStats } from '../types'

// Goodwait for Claude Code.
// While a turn runs, one labeled sponsored line sits above the prompt. It
// disappears a few seconds after the reply lands. Half of the ad revenue from
// your counted views is yours (cash, donate, or draw entries); every counted
// wait adds to the public counter at https://impact-wait.vercel.app.
//
// Beyond the line: the status line carries the counter and estimated
// earnings, /goodwait opens a pane with earnings and the leaderboard, pressing
// the ad opens it in the browser through the server's click redirect (so
// clicks count), and a toast marks the 10th, 50th and 100th wait of a session.
//
// Earnings: when a network's dashboard figure has been recorded in the API
// (the earnings table), lifetime shows that actual, plus an estimate for the
// paid waits counted since that report. With no actual recorded, everything is
// an estimate: counted paid waits x the eCPM in settings (default: the user's share at
// the ad network's early publisher rate, see DEFAULT_ECPM).
//
// Earning: on first run the mod signs this install up as an earner and keeps
// the earner token in the plugin store. Paid views the API credits to that
// token earn the person a share of the ad revenue, settled monthly from what
// the network actually paid. /earn shows the balance; /earn paypal <email>
// sets where payouts go.
//
// Long turns: while Claude keeps working, a fresh ad replaces the shown one
// every 15 seconds (the rotate setting), at most 16 times a turn, and only while
// the person is around: within 2 minutes (the presence setting) of their last
// prompt, keystroke in the prompt box or press in the mod's band or pane.
// Nobody around, nothing rotates: one ad stays up and no new view is counted.
//
// Velocity (on by default with Goodwait's own ad unit; clear the velocityAdUnit
// setting to turn it off): the mod asks
// Velocity for the ad straight from this machine, so the request comes from the
// person's own connection, as Velocity's browser SDK does. A view fires
// Velocity's impression URL from here too, then is reported to the Goodwait API
// once (by Velocity's request id) so it counts and credits. No fill, an error
// or a slow answer falls back to the Goodwait API's own ads.
//
// What leaves the machine: the first 500 characters of the prompt, the site
// key and a random per-session id, sent to the Goodwait API to pick one
// matching line. Nothing else. The site key defaults to "claude-code" (the
// manifest default; the code falls back to "sandbox" only when the option is
// missing entirely). With site "sandbox" the API serves a house ad and counts
// nothing.

const DEFAULT_ENDPOINT = 'https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait'
const HOME = 'https://impact-wait.vercel.app'
const SITE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
const QUERY_CHARS = 500
// Your share per 1,000 paid views, for estimates only: half of Velocity's early publisher rate
// (about $4.67 per 1,000 on its first reported day). Settled money always replaces it.
const DEFAULT_ECPM = 2.25
const IMPRESSION_MS = 1000
const LINGER_MS = 4000
const MIN_ROTATE_SECONDS = 15 // Velocity's minimum refresh interval
const MAX_ROTATIONS = 16
const STATS_REFRESH_MS = 5 * 60 * 1000
const HIDDEN_KEY = 'goodwait.hidden'
const PANE = 'goodwait'
const MILESTONES = [10, 50, 100, 250, 500, 1000]
const EARNER_KEY = 'goodwait.earner'
const TOKEN_RE = /^gw_[0-9a-f]{64}$/
const EARN_REF = 'claude-code-mod'
const VELOCITY_GW = 'https://gw.vlcapi.net'
const VELOCITY_KEY = 'b9fb08c9ea6c' // Never Peak's Velocity publisher key (a public client id)
const VELOCITY_TIMEOUT_MS = 2500
// Goodwait's own native ad unit in Velocity, under the impact-wait.vercel.app site.
const VELOCITY_DEFAULT_UNIT = 'e7b24fe95681'
// A failed Velocity init is retried, at most this often.
const VELOCITY_INIT_RETRY_MS = 60_000
const MOD_VERSION = 'goodwait-claude-code/0.9.0'
// The band shows the ad's body line only when there is room for it.
const WIDE_COLUMNS = 110

const current = atom({ plugin: 'goodwait', key: 'current' } as const, null)
const isHidden = atom({ plugin: 'goodwait', key: 'isHidden' } as const, false)
const sessionWaits = atom({ plugin: 'goodwait', key: 'sessionWaits' } as const, 0)
const sessionPaid = atom({ plugin: 'goodwait', key: 'sessionPaid' } as const, 0)
const stats = atom({ plugin: 'goodwait', key: 'stats' } as const, null)
const earner = atom({ plugin: 'goodwait', key: 'earner' } as const, null)

type Config = { site: string; endpoint: string; ecpm: number; rotateSeconds: number; presenceSeconds: number; velocityAdUnit: string; velocitySiteUrl: string; invite: string }

// Module state. A hot reload starts it over, which is fine: it only tracks
// the turn in flight and the timers that belong to it.
let activeTurn: string | null = null
let sessionId = ''
let clearTimer: Timer | null = null
let impressionTimer: Timer | null = null
let statsTimer: Timer | null = null
// This install's earner token, loaded from the plugin store at session start.
let earnerToken = ''
// Rotation on long turns. idleTicks counts rotation intervals since the
// person last did something; any sign of them sets it back to 0.
let rotateTimer: Timer | null = null
let rotations = 0
let idleTicks = 0
let turnText = ''
// Velocity, per session: whether init succeeded, and the ad unit depth it expects.
let velocityReady: Promise<boolean> | null = null
let velocityInitFailedAt: number | null = null
let velocityDepth = 1
let earnerId = ''

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

// Estimated publisher earnings for `paidWaits` counted paid impressions.
function earned(paidWaits: number, ecpm: number): number {
  return (paidWaits / 1000) * ecpm
}

// Lifetime earnings for the site: the networks' actuals when recorded, plus an
// estimate for paid waits counted after the newest report; else all estimate.
function lifetime(st: GoodwaitStats | null, ecpm: number): { usd: number; isActual: boolean; asOf: string | null; estSince: number } {
  const paid = st?.site ? st.site.paid_waits : 0
  const rows = st?.earnings ?? []
  if (rows.length === 0) return { usd: earned(paid, ecpm), isActual: false, asOf: null, estSince: 0 }
  const actual = rows.reduce((sum, r) => sum + (Number(r.earned_usd) || 0), 0)
  const reported = rows.reduce((sum, r) => sum + (r.paid_waits ?? 0), 0)
  const hasCounts = rows.some(r => r.paid_waits !== null && r.paid_waits !== undefined)
  const estSince = hasCounts ? earned(Math.max(0, paid - reported), ecpm) : 0
  const asOf = rows.map(r => String(r.as_of)).sort().at(-1) ?? null
  return { usd: actual + estSince, isActual: true, asOf, estSince }
}

function shortDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Background work that nobody awaits. A write after the module was unloaded
// (a timer firing during a reload) rejects; that is not an error worth a log.
function fire(p: Promise<unknown>) {
  p.catch(() => {})
}

async function postJson($: EngineInterface, url: string, body: unknown) {
  return $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------- stats

async function fetchStats($: EngineInterface, cfg: Config): Promise<GoodwaitStats | null> {
  let res
  try {
    res = await $.http.fetch(`${cfg.endpoint}/stats?site=${encodeURIComponent(cfg.site)}`)
  } catch {
    return null
  }
  if (!res.ok) return null
  let st: Omit<GoodwaitStats, 'fetchedAt'>
  try {
    st = JSON.parse(res.text)
  } catch {
    return null
  }
  if (!st || !st.total || !st.impact) return null
  const full: GoodwaitStats = { ...st, leaderboard: st.leaderboard ?? [], earnings: st.earnings ?? [], fetchedAt: await $.clock.now() }
  await update($, stats, () => full)
  return full
}

// The status line: the public counter, always visible while the mod is on.
async function paintStatus($: EngineInterface, cfg: Config) {
  if (await read($, isHidden)) {
    $.ui.status(undefined)
    return
  }
  // An earner sees their own balance, never the site's total.
  const me = await read($, earner)
  if (me) {
    const est = me.est_pending_usd !== null && me.est_pending_usd > 0 ? ` · est. ${money(me.est_pending_usd)} pending` : ''
    $.ui.status(`${num(me.credited_today)} paid views today · ${money(me.owed_usd)} owed${est}`)
    return
  }
  const st = await read($, stats)
  if (!st) {
    $.ui.status('counting waits')
    return
  }
  const life = lifetime(st, cfg.ecpm)
  $.ui.status(`${num(st.total.sponsored_waits)} waits · ${life.isActual ? '' : 'est. '}${money(life.usd)} earned`)
}

async function refreshStats($: EngineInterface, cfg: Config) {
  await fetchStats($, cfg)
  await paintStatus($, cfg)
}

// --------------------------------------------------------------- earner

// Signs this install up once, then reuses the stored token for good.
async function ensureEarner($: EngineInterface, cfg: Config) {
  const saved = (await $.store.get(EARNER_KEY)) as { id?: string; token?: string } | undefined
  if (saved && typeof saved.token === 'string' && TOKEN_RE.test(saved.token)) {
    earnerToken = saved.token
    earnerId = typeof saved.id === 'string' ? saved.id : ''
  } else {
    let res
    try {
      res = await postJson($, `${cfg.endpoint}/earner`, { ref: EARN_REF, ...(cfg.invite ? { invite: cfg.invite } : {}) })
    } catch {
      return
    }
    if (res.status !== 201) return
    let j: { earner_id?: string; token?: string; share_pct?: number }
    try {
      j = JSON.parse(res.text)
    } catch {
      return
    }
    if (!j.token || !TOKEN_RE.test(j.token)) return
    earnerToken = j.token
    earnerId = typeof j.earner_id === 'string' ? j.earner_id : ''
    await $.store.set(EARNER_KEY, { id: j.earner_id, token: j.token })
    $.ui.toast(`You now earn ${j.share_pct ?? 50}% of the ad revenue from your waits. /earn to see it.`, { timeoutMs: 8000 })
  }
  await fetchEarner($, cfg)
}

async function fetchEarner($: EngineInterface, cfg: Config): Promise<GoodwaitEarner | null> {
  if (!earnerToken) return null
  let res
  try {
    res = await $.http.fetch(`${cfg.endpoint}/earner/me`, { headers: { authorization: `Bearer ${earnerToken}` } })
  } catch {
    return null
  }
  if (!res.ok) return null
  let j: Omit<GoodwaitEarner, 'fetchedAt'>
  try {
    j = JSON.parse(res.text)
  } catch {
    return null
  }
  if (!j || typeof j.earner_id !== 'string' || !j.program) return null
  const full: GoodwaitEarner = { ...j, fetchedAt: await $.clock.now() }
  await update($, earner, () => full)
  await paintStatus($, cfg)
  return full
}

function earnerLine(e: GoodwaitEarner): string {
  const est = e.est_pending_usd !== null && e.est_pending_usd > 0 ? ` (est. ${money(e.est_pending_usd)})` : ''
  return `You: ${num(e.credited_today)} paid views today · ${num(e.pending_waits)} pending${est} · ${money(e.owed_usd)} owed`
}

async function setPayout($: EngineInterface, cfg: Config, email: string): Promise<string> {
  if (!earnerToken) return 'Earning is not set up on this install yet. Try again in a minute.'
  let res
  try {
    res = await $.http.fetch(`${cfg.endpoint}/earner/payout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${earnerToken}` },
      body: JSON.stringify({ email }),
    })
  } catch {
    return 'Could not reach the server. Try again in a minute.'
  }
  if (res.status === 400) return 'That does not look like an email address. Use: /earn paypal you@example.com'
  if (!res.ok) return 'Could not save it. Try again in a minute.'
  fire(fetchEarner($, cfg))
  let masked = email
  try {
    masked = JSON.parse(res.text).payout_email || email
  } catch {
    // keep what they typed
  }
  return `Payouts go to PayPal ${masked}.`
}

async function postEarner($: EngineInterface, cfg: Config, path: string, body: unknown) {
  return await $.http.fetch(`${cfg.endpoint}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${earnerToken}` },
    body: JSON.stringify(body),
  })
}

async function donate($: EngineInterface, cfg: Config, amountArg: string): Promise<string> {
  if (!earnerToken) return 'Earning is not set up on this install yet. Try again in a minute.'
  const amount = amountArg ? Number(amountArg.replace(/^\$/, '')) : null
  if (amountArg && (!Number.isFinite(amount) || (amount as number) <= 0)) return 'Use /earn donate to give your whole balance, or /earn donate 2.50 for part of it.'
  let res
  try {
    res = await postEarner($, cfg, '/earner/donate', amount === null ? {} : { amount })
  } catch {
    return 'Could not reach the server. Try again in a minute.'
  }
  let j: { donated_usd?: number; balance_usd?: number; cause?: string; error?: string } = {}
  try {
    j = JSON.parse(res.text)
  } catch {
    // fall through to the generic message
  }
  if (res.status === 409) return 'Nothing to donate yet. Your balance fills as ad revenue is settled each month.'
  if (!res.ok || typeof j.donated_usd !== 'number') return 'Could not donate right now. Try again in a minute.'
  fire(fetchEarner($, cfg))
  return `${money(j.donated_usd)} is going to ${j.cause ?? 'charity: water'}. Donations go out monthly and are published on the public ledger.`
}

async function setExit($: EngineInterface, cfg: Config, exit: 'cash' | 'donate'): Promise<string> {
  if (!earnerToken) return 'Earning is not set up on this install yet. Try again in a minute.'
  let res
  try {
    res = await postEarner($, cfg, '/earner/exit', { exit })
  } catch {
    return 'Could not reach the server. Try again in a minute.'
  }
  if (!res.ok) return 'Could not save it. Try again in a minute.'
  fire(fetchEarner($, cfg))
  return exit === 'donate'
    ? 'From now on your earnings go straight to charity: water. Switch back any time with /earn exit cash.'
    : 'From now on your earnings stay in your balance for PayPal. Switch any time with /earn exit donate.'
}

function referLine(me: GoodwaitEarner): string {
  if (!me.referral_code) return 'Invites open soon.'
  const pct = me.program.referral_pct ?? 10
  const got = me.referrals ? ` ${num(me.referrals)} joined so far, ${money(me.referral_earned_usd ?? 0)} earned from them.` : ''
  return `Your invite code: ${me.referral_code}. A friend sets it in /config (Invite code) before their first run. You get ${pct}% of what they earn, for life, paid from our half, never theirs.${got}`
}

// ------------------------------------------------------------------ ads

async function reportImpression($: EngineInterface, cfg: Config, id: string) {
  const shown = await read($, current)
  if (!shown || shown.id !== id || (await read($, isHidden))) return
  let counted = false
  let credited = false
  if (shown.external) {
    ;({ counted, credited } = await reportExternal($, cfg, shown.external))
  } else try {
    const r = await postJson($, `${cfg.endpoint}/event`, { id, type: 'impression' })
    try {
      const j = JSON.parse(r.text)
      counted = r.ok && j.counted === true
      credited = r.ok && j.credited === true
    } catch {
      counted = false
    }
  } catch {
    return
  }
  await update($, current, c => (c && c.id === id ? { ...c, impressed: true } : c))
  const n = (await read($, sessionWaits)) + 1
  await update($, sessionWaits, () => n)
  // A paid wait: the server counted it and a network (not the house) filled it.
  let paid = await read($, sessionPaid)
  if (counted && shown.ad.provider !== 'house') {
    paid += 1
    await update($, sessionPaid, () => paid)
  }
  if (MILESTONES.includes(n)) {
    $.ui.toast(`Your waits this session: ${n} · est. ${money(earned(paid, cfg.ecpm))} earned`, { timeoutMs: 6000 })
  }
  // The public number moved; show it.
  fire(refreshStats($, cfg))
  if (credited) fire(fetchEarner($, cfg))
  scheduleRotation($, cfg, shown.turnId)
}

// ------------------------------------------------------------- velocity

function velocityMetadata(cfg: Config) {
  let timezone = 'UTC'
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // keep UTC
  }
  let domainName = ''
  try {
    domainName = new URL(cfg.velocitySiteUrl).hostname
  } catch {
    // no domain
  }
  return {
    platform: 'web',
    sdkVersion: MOD_VERSION,
    timestamp: Date.now(),
    timezone,
    webMetadata: { ...(domainName ? { domainName } : {}), fullUrl: cfg.velocitySiteUrl },
  }
}

// Resolves to null after ms, so a slow network never holds the line.
function within<T>($: EngineInterface, p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const t = $.clock.after(ms, () => resolve(null))
    p.then(
      v => {
        t.cancel()
        resolve(v)
      },
      () => {
        t.cancel()
        resolve(null)
      },
    )
  })
}

async function velocityInit($: EngineInterface, cfg: Config): Promise<boolean> {
  try {
    const r = await postJson($, `${VELOCITY_GW}/init`, {
      publisherKey: VELOCITY_KEY,
      consent: null,
      metadata: velocityMetadata(cfg),
      ...(earnerId ? { publisherUserId: earnerId } : {}),
    })
    return r.ok
  } catch {
    return false
  }
}

const httpsOnly = (u: unknown): string => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '')

// One native ad from Velocity for this prompt, or null (no fill, error, slow).
async function velocityAd($: EngineInterface, cfg: Config, query: string): Promise<{ ad: GoodwaitAd; external: GoodwaitExternal } | null> {
  if (!cfg.velocityAdUnit) return null
  if (!velocityReady) {
    // After a failed init, wait a minute before asking Velocity again.
    if (velocityInitFailedAt !== null && (await $.clock.now()) - velocityInitFailedAt < VELOCITY_INIT_RETRY_MS) return null
    const attempt = velocityInit($, cfg)
    velocityReady = attempt
    attempt.then(async ok => {
      if (!ok && velocityReady === attempt) {
        velocityReady = null
        velocityInitFailedAt = await $.clock.now()
      }
    })
  }
  const ready = await within($, velocityReady, VELOCITY_TIMEOUT_MS)
  if (!ready) return null
  const res = await within(
    $,
    postJson($, `${VELOCITY_GW}/v2/load`, {
      publisherKey: VELOCITY_KEY,
      sessionId,
      prompt: query,
      additionalContext: 'A software developer working in Claude Code, an AI coding agent in the terminal.',
      adUnitId: cfg.velocityAdUnit,
      adUnitDepth: velocityDepth,
      adType: 'native_ad',
      adSize: 'S',
      biddingTokens: {},
      consent: null,
      metadata: velocityMetadata(cfg),
      ...(earnerId ? { publisherUserId: earnerId } : {}),
    }),
    VELOCITY_TIMEOUT_MS,
  )
  if (!res || !res.ok || res.status === 204) return null
  let j: { requestId?: string; ads?: { adPayload?: Record<string, unknown> }[] }
  try {
    j = JSON.parse(res.text)
  } catch {
    return null
  }
  const p = j.ads?.[0]?.adPayload
  const impressionUrl = httpsOnly(p?.impressionUrl)
  const clickUrl = httpsOnly(p?.clickUrl)
  const requestId = typeof j.requestId === 'string' ? j.requestId : ''
  if (!p || !impressionUrl || !clickUrl || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const headline = str(p.title) || str(p.advertiserName)
  if (!headline) return null
  return {
    ad: {
      provider: 'velocity',
      label: str(p.sponsoredLabel) || 'Sponsored',
      brand: str(p.advertiserName),
      headline,
      body: str(p.description),
      cta: str(p.callToAction) || 'Learn more',
      clickUrl,
    },
    external: { network: 'velocity', requestId, adId: str(p.id) || null, impressionUrl },
  }
}

// Fires Velocity's impression from this machine, then reports the view once.
async function reportExternal($: EngineInterface, cfg: Config, ext: GoodwaitExternal): Promise<{ counted: boolean; credited: boolean }> {
  try {
    await $.http.fetch(ext.impressionUrl)
  } catch {
    return { counted: false, credited: false } // Velocity did not get the view: claim nothing
  }
  velocityDepth += 1
  try {
    const r = await postJson($, `${cfg.endpoint}/impression/external`, {
      network: ext.network,
      site: cfg.site,
      request_id: ext.requestId,
      ad_id: ext.adId,
      ...(earnerToken ? { earner: earnerToken } : {}),
    })
    const j = JSON.parse(r.text)
    return { counted: r.ok && j.counted === true, credited: r.ok && j.credited === true }
  } catch {
    return { counted: true, credited: false } // Velocity counted it; our counter missed it
  }
}

async function fetchAd($: EngineInterface, cfg: Config, turnId: string, text: string) {
  if (await read($, isHidden)) return
  const query = text.replace(/\s+/g, ' ').trim().slice(0, QUERY_CHARS)
  if (!query) return

  const v = await velocityAd($, cfg, query)
  if (v) {
    if (activeTurn !== turnId) return
    const prev = await read($, current)
    const next: GoodwaitCurrent = {
      id: `velocity:${v.external.requestId}`,
      turnId,
      ad: v.ad,
      impact: prev?.impact ?? { cause_name: null, cause_url: null, pledge_pct: null, donated_usd: 0, sponsored_waits: (await read($, stats))?.total.sponsored_waits ?? 0 },
      sandbox: false,
      impressed: false,
      external: v.external,
    }
    await update($, current, () => next)
    impressionTimer?.cancel()
    impressionTimer = $.clock.after(IMPRESSION_MS, () => {
      fire(reportImpression($, cfg, next.id))
    })
    return
  }

  let res
  try {
    res = await postJson($, `${cfg.endpoint}/ad`, { site: cfg.site, query, sessionId, ...(earnerToken ? { earner: earnerToken } : {}) })
  } catch {
    return // offline or refused: show nothing, never block the turn
  }
  if (!res.ok) return
  let data: { id?: string; ad?: GoodwaitAd; impact?: GoodwaitImpact; sandbox?: boolean }
  try {
    data = JSON.parse(res.text)
  } catch {
    return
  }
  if (!data.id || !data.ad || !data.impact) return
  if (activeTurn !== turnId) return // the reply already landed; too late to show
  const next: GoodwaitCurrent = {
    id: data.id,
    turnId,
    ad: data.ad,
    impact: data.impact,
    sandbox: data.sandbox === true,
    impressed: false,
  }
  await update($, current, () => next)

  // A view counts only after the line has been on screen for a full second.
  impressionTimer?.cancel()
  impressionTimer = $.clock.after(IMPRESSION_MS, () => {
    fire(reportImpression($, cfg, next.id))
  })
}

// After a view counts, line up the next ad for a long turn.
function scheduleRotation($: EngineInterface, cfg: Config, turnId: string) {
  if (cfg.rotateSeconds <= 0 || rotateTimer || activeTurn !== turnId || rotations >= MAX_ROTATIONS) return
  rotateTimer = $.clock.after(cfg.rotateSeconds * 1000, () => {
    rotateTimer = null
    if (activeTurn !== turnId || rotations >= MAX_ROTATIONS) return
    idleTicks += 1
    // Nobody around: keep the ad up, count nothing new. A sign of the person resumes it.
    if (idleTicks * cfg.rotateSeconds > cfg.presenceSeconds) return
    rotations += 1
    fire(fetchAd($, cfg, turnId, turnText))
  })
}

// The person did something: they are watching. Resume rotation if it had stopped.
function sawPerson($: EngineInterface, cfg: Config) {
  idleTicks = 0
  if (activeTurn && !rotateTimer) {
    const turnId = activeTurn
    $.clock.after(0, () => {
      fire(
        read($, current).then(c => {
          if (c && c.turnId === turnId && c.impressed) scheduleRotation($, cfg, turnId)
        }),
      )
    })
  }
}

async function clearIfTurn($: EngineInterface, turnId: string) {
  await update($, current, c => (c && c.turnId === turnId ? null : c))
}

async function setHidden($: EngineInterface, cfg: Config, hidden: boolean) {
  await update($, isHidden, () => hidden)
  await $.store.set(HIDDEN_KEY, hidden)
  await paintStatus($, cfg)
}

// Opens a URL in the person's browser through the host. The ad's URL is the
// server's /click redirect, so a press is counted the same way a web click is.
async function openInBrowser($: EngineInterface, url: string) {
  if (!/^https:\/\//i.test(url)) return
  for (const argv of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 8000 })
      if (r.exitCode === 0) return
    } catch {
      // try the next opener
    }
  }
  $.ui.toast(`Open this link: ${url}`, { timeoutMs: 8000 })
}

// --------------------------------------------------------------- register

export const register: Register = (on, options) => {
  const rawSite = String(options.site ?? 'sandbox').trim().toLowerCase()
  const cfg: Config = {
    site: SITE_RE.test(rawSite) ? rawSite : 'sandbox',
    endpoint: String(options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    ecpm: Number.isFinite(Number(options.ecpm)) && Number(options.ecpm) >= 0 ? Number(options.ecpm) : DEFAULT_ECPM,
    // 0 turns rotation off; anything else is held to at least 15 seconds.
    rotateSeconds: (() => {
      const n = Number(options.rotateSeconds ?? MIN_ROTATE_SECONDS)
      if (!Number.isFinite(n) || n <= 0) return n === 0 ? 0 : MIN_ROTATE_SECONDS
      return Math.max(MIN_ROTATE_SECONDS, n)
    })(),
    presenceSeconds: Number.isFinite(Number(options.presenceSeconds)) && Number(options.presenceSeconds) > 0 ? Number(options.presenceSeconds) : 120,
    // Unset = Goodwait's own unit; set to empty (or anything that is not an id) = Velocity off.
    velocityAdUnit: options.velocityAdUnit === undefined || options.velocityAdUnit === null
      ? VELOCITY_DEFAULT_UNIT
      : /^[A-Za-z0-9_-]{4,64}$/.test(String(options.velocityAdUnit).trim()) ? String(options.velocityAdUnit).trim() : '',
    velocitySiteUrl: /^https:\/\/[^\s]+$/i.test(String(options.velocitySiteUrl ?? '')) ? String(options.velocitySiteUrl) : 'https://impact-wait.vercel.app',
    // A friend's invite code, used once at sign-up.
    invite: /^[a-z2-9]{8}$/.test(String(options.invite ?? '').trim().toLowerCase()) ? String(options.invite).trim().toLowerCase() : '',
  }

  on('session.start', async ($, e, next) => {
    sessionId = crypto.randomUUID()
    const hidden = (await $.store.get(HIDDEN_KEY)) === true
    await update($, isHidden, () => hidden)
    await update($, sessionWaits, () => 0)
    await update($, sessionPaid, () => 0)
    await $.command.register({
      name: 'goodwait',
      description: 'Goodwait: open the counter pane, or turn the sponsored line on or off.',
      argumentHint: '[on|off]',
    })
    await $.command.register({
      name: 'earn',
      description: 'Your share of the ad revenue: balance, PayPal, donate, invites.',
      argumentHint: '[paypal you@example.com | donate [amount] | exit cash|donate | refer]',
    })
    earnerToken = ''
    earnerId = ''
    velocityReady = null
    velocityInitFailedAt = null
    velocityDepth = 1
    $.clock.after(0, () => {
      fire(ensureEarner($, cfg))
    })
    // Counter in the status line, refreshed every few minutes. Off the dispatch.
    statsTimer?.cancel()
    $.clock.after(0, () => {
      fire(refreshStats($, cfg))
    })
    statsTimer = $.clock.every(STATS_REFRESH_MS, () => {
      fire(refreshStats($, cfg))
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    // A subagent's turn runs inside the person's; it must not take over the band.
    if (e.agentId) return next(e)
    activeTurn = e.turnId
    clearTimer?.cancel()
    clearTimer = null
    rotateTimer?.cancel()
    rotateTimer = null
    rotations = 0
    idleTicks = 0
    turnText = e.text || ''
    if (e.text) {
      // Work that outlives this dispatch goes on a timer, never inside the hook.
      $.clock.after(0, () => {
        fire(fetchAd($, cfg, e.turnId, e.text))
      })
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId) return next(e) // a subagent's turn, not the person's
    if (activeTurn === e.turnId) activeTurn = null
    rotateTimer?.cancel()
    rotateTimer = null
    clearTimer?.cancel()
    clearTimer = $.clock.after(LINGER_MS, () => {
      fire(clearIfTurn($, e.turnId))
    })
    return next(e)
  })

  // ---- signs the person is at the keyboard (for rotation on long turns)
  on('prompt.edit', ($, e, next) => {
    sawPerson($, cfg)
    return next(e)
  })
  on('prompt.submit', ($, e, next) => {
    sawPerson($, cfg)
    return next(e)
  })
  on('ui.press', ($, e, next) => {
    sawPerson($, cfg)
    return next(e)
  })
  on('ui.scroll', ($, e, next) => {
    sawPerson($, cfg)
    return next(e)
  })

  // ---- the band above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, current)
    if (!shown || (await read($, isHidden))) return next(e)

    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const { ad, impact } = shown
    const wide = e.props.bodyColumns >= WIDE_COLUMNS
    const st = await read($, stats)
    const paidNow = await read($, sessionPaid)
    const life = lifetime(st, cfg.ecpm)
    const lifeLabel = life.isActual ? `${money(life.usd)} lifetime (actual as of ${shortDate(life.asOf)})` : `est. ${money(life.usd)} lifetime`
    const me = await read($, earner)
    const mode = shown.sandbox ? ' · test mode, nothing counted' : ''
    const body = wide && ad.body && ad.body !== ad.headline ? ad.body : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>{ad.label || 'Sponsored'} · </Text>
          <Text bold>{ad.brand}</Text>
          <Text>: {ad.headline}</Text>
          {body ? <Text dimColor> {body}</Text> : null}
          <Text>  </Text>
          <Button
            key="open"
            label={ad.cta || 'Learn more'}
            hotkey="1"
            plain
            onPress={() => openInBrowser($, ad.clickUrl)}
          />
          <Text> </Text>
          <Button
            key="counter"
            label="counter"
            hotkey="2"
            plain
            dimColor
            onPress={() => $.ui.open({ id: PANE, title: 'Goodwait' })}
          />
          <Text> </Text>
          <Button
            key="hide"
            label="hide"
            hotkey="h"
            plain
            dimColor
            onPress={async () => {
              await setHidden($, cfg, true)
              $.ui.toast('Goodwait hidden. /goodwait on brings it back.')
            }}
          />
        </Box>
        <Text dimColor wrap="truncate-end">
          {me ? earnerLine(me) : `${lifeLabel} · est. ${money(earned(paidNow, cfg.ecpm))} this session`} · {num(impact.sponsored_waits)} waits so far{mode}
        </Text>
      </Box>
    )
  })

  // ---- the counter pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const st = await read($, stats)
    const mine = await read($, sessionWaits)
    const hidden = await read($, isHidden)
    const width = Math.max(30, e.props.bodyColumns - 2)

    if (!st) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Loading the counter...</Text>
          <Button key="refresh" label="Refresh" onPress={() => refreshStats($, cfg)} />
        </Box>
      )
    }

    const paidNow = await read($, sessionPaid)
    const lifetimePaid = st.site ? st.site.paid_waits : 0
    const life = lifetime(st, cfg.ecpm)
    const lifetimeEarned = life.usd
    const pledgePct = st.impact.pledge_pct ?? 50
    const cause = st.impact.cause_name || 'the cause'
    const leaders = st.leaderboard.slice(0, 10)
    const nameWidth = Math.min(28, Math.max(10, ...leaders.map(l => (l.name || l.site_key).length)))
    const col = Math.floor(width / 3)

    const me = await read($, earner)

    return (
      <Box flexDirection="column">
        {me ? (
          <Box flexDirection="column">
            <Text bold>You earn {me.program.share_pct}% of the ad revenue from your waits</Text>
            <Text> </Text>
            <Box flexDirection="row">
              <Box flexDirection="column" width={col}>
                <Text bold>{money(me.owed_usd)}</Text>
                <Text dimColor>owed to you</Text>
              </Box>
              <Box flexDirection="column" width={col}>
                <Text bold>{num(me.pending_waits)}</Text>
                <Text dimColor>paid views waiting to settle{me.est_pending_usd !== null ? ` (est. ${money(me.est_pending_usd)})` : ''}</Text>
              </Box>
              <Box flexDirection="column" width={col}>
                <Text bold>{money(me.paid_usd)}</Text>
                <Text dimColor>paid out so far</Text>
              </Box>
            </Box>
            <Text dimColor>
              {num(me.credited_today)} of {num(me.program.daily_cap)} paid views today · {num(me.credited_total)} lifetime
            </Text>
            <Text dimColor wrap="wrap">
              Views settle monthly from what the ad network actually paid. Payouts go out once you are owed {money(me.program.min_payout_usd)}.
            </Text>
            <Text>{me.payout_email ? `Payouts go to PayPal ${me.payout_email}.` : 'Set your PayPal to get paid: /earn paypal you@example.com'}</Text>
            <Text> </Text>
          </Box>
        ) : null}
        <Text bold>Goodwait · your earnings</Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column" width={col}>
            <Text bold>{money(lifetimeEarned)}</Text>
            <Text dimColor>{life.isActual ? `lifetime earnings (actual as of ${shortDate(life.asOf)})` : 'est. lifetime earnings'}</Text>
          </Box>
          <Box flexDirection="column" width={col}>
            <Text bold>{money(earned(paidNow, cfg.ecpm))}</Text>
            <Text dimColor>est. this session</Text>
          </Box>
          <Box flexDirection="column" width={col}>
            <Text bold>{num(lifetimePaid)}</Text>
            <Text dimColor>paid waits lifetime ({num(mine)} this session)</Text>
          </Box>
        </Box>
        <Text> </Text>
        {st.earnings.map(r => (
          <Text dimColor key={`earn-${r.network}`}>
            {r.network}: {money(Number(r.earned_usd))} actual{r.paid_waits !== null ? ` on ${num(r.paid_waits)} paid waits` : ''} ({r.source}, {shortDate(String(r.as_of))})
          </Text>
        ))}
        {life.isActual && life.estSince > 0 ? <Text dimColor>+ est. {money(life.estSince)} for paid waits counted since that report</Text> : null}
        <Text dimColor wrap="wrap">
          Estimates use {money(cfg.ecpm)} per 1,000 paid views, your share at the ad network's early rate; change it in /config. Real money is settled monthly from what the network actually paid and replaces the estimate.
        </Text>
        <Text dimColor>
          {pledgePct}% of net is pledged to {cause}: about {money(lifetimeEarned * (pledgePct / 100))} so far.
        </Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Box flexDirection="column" width={col}>
            <Text bold>{num(st.total.sponsored_waits)}</Text>
            <Text dimColor>waits across all sites</Text>
          </Box>
          <Box flexDirection="column" width={col}>
            <Text bold>{st.site ? num(st.site.sponsored_waits) : '0'}</Text>
            <Text dimColor>waits from {cfg.site}</Text>
          </Box>
          <Box flexDirection="column" width={col}>
            <Text bold>{st.site ? num(st.site.clicks) : '0'}</Text>
            <Text dimColor>clicks from {cfg.site}</Text>
          </Box>
        </Box>
        <Text> </Text>
        <Text bold>Leaderboard</Text>
        {leaders.length === 0 ? <Text dimColor>No counted waits yet. Yours will be the first.</Text> : null}
        {leaders.map((l, i) => (
          <Box flexDirection="row" key={`row-${l.site_key}`}>
            <Text dimColor>{String(i + 1).padStart(2, ' ')}. </Text>
            <Text bold={l.site_key === cfg.site}>{(l.name || l.site_key).slice(0, nameWidth).padEnd(nameWidth, ' ')}</Text>
            <Text> {num(l.sponsored_waits)}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text dimColor>
          Site key: {cfg.site}
          {cfg.site === 'sandbox' ? ' (test mode, nothing counted)' : ''}
        </Text>
        <Text> </Text>
        <Box flexDirection="row">
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refreshStats($, cfg)} />
          <Text> </Text>
          <Button
            key="toggle"
            label={hidden ? 'Turn on' : 'Turn off'}
            hotkey="t"
            onPress={() => setHidden($, cfg, !hidden)}
          />
          <Text> </Text>
          <Button key="site" label="Open counter page" hotkey="o" onPress={() => openInBrowser($, `${HOME}/?ref=${encodeURIComponent(cfg.site)}`)} />
          <Text> </Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        <Text> </Text>
        <Link href={HOME} label={HOME} />
      </Box>
    )
  })

  on('command.run', { command: 'earn' }, async ($, e) => {
    const args = e.args.trim()
    const m = args.match(/^paypal\s+(\S+)$/i)
    if (m?.[1]) return { text: await setPayout($, cfg, m[1].toLowerCase()) }
    const d = args.match(/^donate(?:\s+(\S+))?$/i)
    if (d) return { text: await donate($, cfg, d[1] ?? '') }
    const x = args.match(/^exit\s+(cash|donate)$/i)
    if (x?.[1]) return { text: await setExit($, cfg, x[1].toLowerCase() as 'cash' | 'donate') }
    if (/^(refer|invite)$/i.test(args)) {
      const me = (await fetchEarner($, cfg)) ?? (await read($, earner))
      return { text: me ? referLine(me) : 'Earning is not set up on this install yet. Try again in a minute.' }
    }
    if (args) return { text: 'Use /earn for your balance, /earn paypal you@example.com, /earn donate [amount], /earn exit cash|donate, or /earn refer.' }
    const me = (await fetchEarner($, cfg)) ?? (await read($, earner))
    fire(refreshStats($, cfg))
    await $.ui.open({ id: PANE, title: 'Goodwait' })
    if (!me) return { text: 'Earning is not set up on this install yet. Try again in a minute.' }
    const payout = me.auto_exit === 'donate' ? 'earnings go to charity: water' : me.payout_email ? `PayPal ${me.payout_email}` : 'no PayPal set (/earn paypal you@example.com)'
    const given = me.donated_usd ? ` · ${money(me.donated_usd)} donated` : ''
    const draw = me.draw ? ` · ${num(me.draw.entries)} entries in the ${me.draw.name}` : ''
    const invite = me.referral_code ? ` · invite code ${me.referral_code}` : ''
    return { text: `${earnerLine(me)} · ${money(me.paid_usd)} paid out${given} · ${payout}${draw}${invite}` }
  })

  on('command.run', { command: 'goodwait' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await setHidden($, cfg, true)
      return { text: 'Goodwait is off. /goodwait on turns it back on.' }
    }
    if (arg === 'on') {
      await setHidden($, cfg, false)
      return { text: `Goodwait is on (site: ${cfg.site}). The sponsored line shows while Claude works.` }
    }
    fire(refreshStats($, cfg))
    const opened = await $.ui.open({ id: PANE, title: 'Goodwait' })
    if (opened.isPlaced) return { text: 'Goodwait counter opened.' }
    const st = (await read($, stats)) ?? (await fetchStats($, cfg))
    const line = st
      ? `${num(st.total.sponsored_waits)} waits · est. ${money(earned(st.site ? st.site.paid_waits : 0, cfg.ecpm))} earned lifetime · ${HOME}`
      : `Counter: ${HOME}`
    return { text: `Goodwait · site ${cfg.site} · ${line}` }
  })
}
