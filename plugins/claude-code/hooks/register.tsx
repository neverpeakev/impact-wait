import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { GoodwaitAd, GoodwaitCurrent, GoodwaitImpact } from '../types'

// Goodwait for Claude Code.
// While a turn runs, one labeled sponsored line sits above the prompt. It
// disappears a few seconds after the reply lands. Half of the net ad revenue
// goes to Khan Academy; every counted wait adds to the public counter at
// https://goodwait.vercel.app.
//
// What leaves the machine: the first 500 characters of the prompt, the site
// key and a random per-session id, sent to the Goodwait API to pick one
// matching line. Nothing else. The site key defaults to "claude-code" (the
// manifest default; the code falls back to "sandbox" only when the option is
// missing entirely). With site "sandbox" the API serves a house ad and counts
// nothing.

const DEFAULT_ENDPOINT = 'https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait'
const SITE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
const QUERY_CHARS = 500
const IMPRESSION_MS = 1000
const LINGER_MS = 4000
const HIDDEN_KEY = 'goodwait.hidden'

const current = atom({ plugin: 'goodwait', key: 'current' } as const, null)
const isHidden = atom({ plugin: 'goodwait', key: 'isHidden' } as const, false)

type Config = { site: string; endpoint: string }

// Module state. A hot reload starts it over, which is fine: it only tracks
// the turn in flight and the timers that belong to it.
let activeTurn: string | null = null
let sessionId = ''
let clearTimer: Timer | null = null
let impressionTimer: Timer | null = null

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function postJson($: EngineInterface, url: string, body: unknown) {
  return $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function reportImpression($: EngineInterface, cfg: Config, id: string) {
  const shown = await read($, current)
  if (!shown || shown.id !== id || (await read($, isHidden))) return
  try {
    await postJson($, `${cfg.endpoint}/event`, { id, type: 'impression' })
  } catch {
    return
  }
  await update($, current, c => (c && c.id === id ? { ...c, impressed: true } : c))
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
    void reportImpression($, cfg, next.id)
  })
}

async function clearIfTurn($: EngineInterface, turnId: string) {
  await update($, current, c => (c && c.turnId === turnId ? null : c))
}

async function setHidden($: EngineInterface, hidden: boolean) {
  await update($, isHidden, () => hidden)
  await $.store.set(HIDDEN_KEY, hidden)
}

async function statsText($: EngineInterface, cfg: Config): Promise<string> {
  let res
  try {
    res = await $.http.fetch(`${cfg.endpoint}/stats?site=${encodeURIComponent(cfg.site)}`)
  } catch {
    return 'Goodwait: could not reach the API.'
  }
  if (!res.ok) return `Goodwait: the API answered ${res.status}.`
  let st: {
    total?: { sponsored_waits: number; clicks: number; sites: number }
    impact?: GoodwaitImpact
    site?: { sponsored_waits: number } | null
  }
  try {
    st = JSON.parse(res.text)
  } catch {
    return 'Goodwait: the API answered something that is not JSON.'
  }
  const hidden = await read($, isHidden)
  const test = cfg.site === 'sandbox' ? ' (test mode, nothing counted)' : ''
  return [
    `Goodwait is ${hidden ? 'off' : 'on'} · site: ${cfg.site}${test}`,
    st.total ? `${st.total.sponsored_waits.toLocaleString('en-US')} sponsored waits across ${st.total.sites} sites` : '',
    st.site ? `${st.site.sponsored_waits.toLocaleString('en-US')} from this site` : '',
    st.impact
      ? `${st.impact.pledge_pct ?? '?'}% of net ad revenue goes to ${st.impact.cause_name} · ${money(st.impact.donated_usd)} donated so far`
      : '',
    'Counter: https://goodwait.vercel.app',
  ]
    .filter(Boolean)
    .join('\n')
}

export const register: Register = (on, options) => {
  const rawSite = String(options.site ?? 'sandbox').trim().toLowerCase()
  const cfg: Config = {
    site: SITE_RE.test(rawSite) ? rawSite : 'sandbox',
    endpoint: String(options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ''),
  }

  on('session.start', async ($, e, next) => {
    sessionId = crypto.randomUUID()
    const hidden = (await $.store.get(HIDDEN_KEY)) === true
    await update($, isHidden, () => hidden)
    await $.command.register({
      name: 'goodwait',
      description: 'Goodwait: show the counter, or turn the sponsored line on or off.',
      argumentHint: '[on|off]',
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
        void fetchAd($, cfg, e.turnId, e.text)
      })
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId) return next(e) // a subagent's turn, not the person's
    if (activeTurn === e.turnId) activeTurn = null
    clearTimer?.cancel()
    clearTimer = $.clock.after(LINGER_MS, () => {
      void clearIfTurn($, e.turnId)
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, current)
    if (!shown || (await read($, isHidden))) return next(e)

    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const { ad, impact } = shown
    const pledge = impact.pledge_pct === null ? 'Part' : `${impact.pledge_pct}%`
    const cause = impact.cause_name || 'a good cause'
    const waits = impact.sponsored_waits.toLocaleString('en-US')
    const funded = impact.donated_usd > 0 ? ` · ${money(impact.donated_usd)} donated` : ''
    const mode = shown.sandbox ? ' · test mode, nothing counted' : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>{ad.label || 'Sponsored'} · </Text>
          <Text bold>{ad.brand}</Text>
          <Text>: {ad.headline} </Text>
          <Link href={ad.clickUrl} label={ad.cta || 'Learn more'} />
          <Text> </Text>
          <Button
            key="hide"
            label="hide"
            plain
            dimColor
            onPress={async () => {
              await setHidden($, true)
              $.ui.toast('Goodwait hidden. /goodwait on brings it back.')
            }}
          />
        </Box>
        <Text dimColor wrap="truncate-end">
          {pledge} of net ad revenue goes to {cause}
          {funded} · {waits} waits so far{mode}
        </Text>
      </Box>
    )
  })

  on('command.run', { command: 'goodwait' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await setHidden($, true)
      return { text: 'Goodwait is off. /goodwait on turns it back on.' }
    }
    if (arg === 'on') {
      await setHidden($, false)
      return { text: `Goodwait is on (site: ${cfg.site}). The sponsored line shows while Claude works.` }
    }
    return { text: await statsText($, cfg) }
  })
}
