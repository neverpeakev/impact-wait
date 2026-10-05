import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GoodwaitAd, GoodwaitCurrent, GoodwaitImpact, GoodwaitStats } from '../types'

// Goodwait for Claude Code.
// While a turn runs, one labeled sponsored line sits above the prompt. It
// disappears a few seconds after the reply lands. Half of the net ad revenue
// goes to Khan Academy; every counted wait adds to the public counter at
// https://goodwait.vercel.app.
//
// Beyond the line: the status line carries the counter and estimated
// earnings, /goodwait opens a pane with earnings and the leaderboard, pressing
// the ad opens it in the browser through the server's click redirect (so
// clicks count), and a toast marks the 10th, 50th and 100th wait of a session.
//
// Earnings: when a network's dashboard figure has been recorded in the API
// (the earnings table), lifetime shows that actual, plus an estimate for the
// paid waits counted since that report. With no actual recorded, everything is
// an estimate: counted paid waits x the eCPM in settings (default: Idlen's
// published $35 network-average CPM for this format x the 70% publisher share).
//
// What leaves the machine: the first 500 characters of the prompt, the site
// key and a random per-session id, sent to the Goodwait API to pick one
// matching line. Nothing else. The site key defaults to "claude-code" (the
// manifest default; the code falls back to "sandbox" only when the option is
// missing entirely). With site "sandbox" the API serves a house ad and counts
// nothing.

const DEFAULT_ENDPOINT = 'https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait'
const HOME = 'https://goodwait.vercel.app'
const SITE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
const QUERY_CHARS = 500
const IMPRESSION_MS = 1000
const LINGER_MS = 4000
const STATS_REFRESH_MS = 5 * 60 * 1000
const HIDDEN_KEY = 'goodwait.hidden'
const PANE = 'goodwait'
const MILESTONES = [10, 50, 100, 250, 500, 1000]
// The band shows the ad's body line only when there is room for it.
const WIDE_COLUMNS = 110

const current = atom({ plugin: 'goodwait', key: 'current' } as const, null)
const isHidden = atom({ plugin: 'goodwait', key: 'isHidden' } as const, false)
const sessionWaits = atom({ plugin: 'goodwait', key: 'sessionWaits' } as const, 0)
const sessionPaid = atom({ plugin: 'goodwait', key: 'sessionPaid' } as const, 0)
const stats = atom({ plugin: 'goodwait', key: 'stats' } as const, null)

type Config = { site: string; endpoint: string; ecpm: number }

// Module state. A hot reload starts it over, which is fine: it only tracks
// the turn in flight and the timers that belong to it.
let activeTurn: string | null = null
let sessionId = ''
let clearTimer: Timer | null = null
let impressionTimer: Timer | null = null
let statsTimer: Timer | null = null

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

// ------------------------------------------------------------------ ads

async function reportImpression($: EngineInterface, cfg: Config, id: string) {
  const shown = await read($, current)
  if (!shown || shown.id !== id || (await read($, isHidden))) return
  let counted = false
  try {
    const r = await postJson($, `${cfg.endpoint}/event`, { id, type: 'impression' })
    try {
      counted = r.ok && JSON.parse(r.text).counted === true
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
}

async function fetchAd($: EngineInterface, cfg: Config, turnId: string, text: string) {
  if (await read($, isHidden)) return
  const query = text.replace(/\s+/g, ' ').trim().slice(0, QUERY_CHARS)
  if (!query) return
  let res
  try {
    res = await postJson($, `${cfg.endpoint}/ad`, { site: cfg.site, query, sessionId })
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
    ecpm: Number.isFinite(Number(options.ecpm)) && Number(options.ecpm) >= 0 ? Number(options.ecpm) : 24.5,
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
    activeTurn = e.turnId
    clearTimer?.cancel()
    clearTimer = null
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
    clearTimer?.cancel()
    clearTimer = $.clock.after(LINGER_MS, () => {
      fire(clearIfTurn($, e.turnId))
    })
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
          {lifeLabel} · est. {money(earned(paidNow, cfg.ecpm))} this session · {num(impact.sponsored_waits)} waits so far{mode}
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

    return (
      <Box flexDirection="column">
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
          Estimates use {money(cfg.ecpm)} eCPM (Idlen's published $35 network average for this format x your 70% share); change it in /config. Idlen pays monthly once you pass $50; its dashboard is the exact balance.
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
