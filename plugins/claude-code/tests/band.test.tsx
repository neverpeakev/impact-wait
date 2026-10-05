import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const AD_ID = '11111111-1111-4111-8111-111111111111'

const AD_RESPONSE = {
  id: AD_ID,
  ad: {
    provider: 'idlen',
    sponsored: true,
    label: 'Sponsored',
    brand: 'Fuel Path Pro',
    headline: 'Plan every road trip in one tap.',
    body: 'Free courses in math, science and more.',
    cta: 'Learn more',
    clickUrl: `https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait/click?id=${AD_ID}`,
    favicon: '',
  },
  impact: {
    cause_name: 'Khan Academy',
    cause_url: 'https://www.khanacademy.org',
    unit_label: null,
    pledge_pct: 50,
    donated_usd: 0,
    units_funded: null,
    donated_updated_at: null,
    sponsored_waits: 1234,
  },
  sandbox: false,
}

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

type Seen = {
  fetched: { url: string; body?: string }[]
  status: (string | undefined)[]
  toasts: string[]
  runs: string[][]
  opened: string[]
}

const seen = (): Seen => ({ fetched: [], status: [], toasts: [], runs: [], opened: [] })

const STATS = {
  total: { sponsored_waits: 1234, paid_waits: 900, clicks: 12, sites: 3 },
  site: { site_key: 'claude-code', name: null, sponsored_waits: 40, paid_waits: 40, clicks: 2 },
  leaderboard: [
    { site_key: 'riverside-library', name: 'Riverside Library', sponsored_waits: 800 },
    { site_key: 'claude-code', name: null, sponsored_waits: 40 },
  ],
  impact: AD_RESPONSE.impact,
}

const PANE = {
  component: 'Pane',
  requestId: 'goodwait',
  props: {
    title: 'Goodwait',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// The engine beneath the plugin: what each `$` call the mod makes lands on.
function bottom(on: On, s: Seen) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    s.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    s.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    s.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    s.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('http.fetch', ($, e) => {
    s.fetched.push({ url: e.url, body: e.init?.body })
    const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    if (e.url.endsWith('/ad')) return ok(JSON.stringify(AD_RESPONSE))
    if (e.url.endsWith('/event')) return ok('{"ok":true,"counted":true}')
    if (e.url.includes('/stats')) return ok(JSON.stringify(STATS))
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
}

test('nothing is drawn before a turn', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  bottom(on, seen())
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface, ...BAND })
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the line shows during a turn, counts after one second, clears after the linger', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  const fetched = s.fetched
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'How do I write a bash loop? ' + 'x'.repeat(900), turnId: 't1' })
  await clock.advance(0)
  await clock.settle()

  // The ad request carried the site, a capped query and a session id.
  const adCall = fetched.find(f => f.url.endsWith('/ad'))
  expect(adCall).toBeDefined()
  const sent = JSON.parse(adCall!.body ?? '{}')
  expect(sent.site).toBe('claude-code') // the manifest default
  expect(sent.query.length).toBeLessThanOrEqual(500)
  expect(typeof sent.sessionId).toBe('string')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface, ...BAND })
    expect(await ui.find({ type: 'Link' })).toBeUndefined() // no raw redirect URL on the band
    expect((await ui.find({ key: 'open' }))?.props.label).toBe('Learn more')
    expect(await ui.find({ type: 'Text', text: /Fuel Path Pro/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /est. earned \$0\.00 this session · \$0\.98 lifetime · 1,234 waits so far/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Khan Academy/ })).toBeUndefined() // no cause line on the band
    expect(await ui.find({ key: 'hide' })).toBeDefined()
    await ui.unmount()
  }

  // No impression before the line has been up for a second.
  expect(fetched.some(f => f.url.endsWith('/event'))).toBe(false)
  await clock.advance(1000)
  await clock.settle()
  const ev = fetched.find(f => f.url.endsWith('/event'))
  expect(ev).toBeDefined()
  expect(JSON.parse(ev!.body ?? '{}')).toEqual({ id: AD_ID, type: 'impression' })

  // The reply lands; the line lingers, then goes.
  await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't1', reason: 'answer' })
  {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(4000)
  await clock.settle()
  {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an ad that arrives after the reply is never shown', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  const fetched = s.fetched
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'quick one', turnId: 't2' })
  // The turn ends before the timer that fetches the ad has fired.
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(0)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'open' })).toBeUndefined()
  await ui.unmount()
  await clock.advance(1000)
  await clock.settle()
  expect(fetched.some(f => f.url.endsWith('/event'))).toBe(false)
})

test('hide persists across sessions and /goodwait on brings it back', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  const fetched = s.fetched
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hello there', turnId: 't3' })
  await clock.advance(0)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'open' })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'open' })).toBeUndefined()
  await ui.unmount()

  // Hidden survives a restart: the store remembers it.
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'still hidden?', turnId: 't4' })
  await clock.advance(0)
  await clock.settle()
  const adCalls = fetched.filter(f => f.url.endsWith('/ad')).length
  expect(adCalls).toBe(1) // no second ad request while hidden
  {
    const ui2 = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
    expect(await ui2.find({ key: 'open' })).toBeUndefined()
    await ui2.unmount()
  }

  const on_ = await $.command.run({ command: 'goodwait', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(on_.text).toMatch(/is on/)
  const stats = await $.command.run({ command: 'goodwait', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(stats.text).toMatch(/opened/)
})

test('status line carries the public counter from session start, and clears when hidden', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
  expect(s.fetched.some(f => f.url.includes('/stats?site=claude-code'))).toBe(true)
  expect(s.status.at(-1)).toBe('1,234 waits · est. $0.98 earned')

  await $.command.run({ command: 'goodwait', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(s.status.at(-1)).toBeUndefined()
  await $.command.run({ command: 'goodwait', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(s.status.at(-1)).toBe('1,234 waits · est. $0.98 earned')
})

test('the band shows the body line only when wide, and "open" goes through the click redirect on the host', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'how do I center a div', turnId: 't5' })
  await clock.advance(0)
  await clock.settle()

  // Wide (120 columns): the ad's body line shows beside the headline.
  const wide = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await wide.find({ type: 'Text', text: /Free courses in math/ })).toBeDefined()
  expect(await wide.find({ key: 'open' })).toBeDefined()
  expect(await wide.find({ key: 'counter' })).toBeDefined()
  expect(await wide.find({ key: 'hide' })).toBeDefined()
  await wide.press({ key: 'open' })
  expect(s.runs[0]).toEqual(['open', AD_RESPONSE.ad.clickUrl])
  await wide.press({ key: 'counter' })
  expect(s.opened).toContain('goodwait')
  await wide.unmount()

  // Narrow (80 columns): headline and link only, no body.
  const narrow = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND.props, bodyColumns: 80 } })
  expect(await narrow.find({ key: 'open' })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /Free courses in math/ })).toBeUndefined()
  await narrow.unmount()
})

test('a toast marks the 10th wait of the session', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= 10; i++) {
    const turnId = `m${i}`
    await $.turn.start({ text: `question number ${i}`, turnId })
    await clock.advance(0)
    await clock.settle()
    await clock.advance(1000) // the impression
    await clock.settle()
    await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
    await clock.advance(4000) // the linger
    await clock.settle()
  }
  const events = s.fetched.filter(f => f.url.endsWith('/event')).length
  expect(events).toBe(10)
  expect(s.toasts.some(t => t === 'Your waits this session: 10 · est. $0.25 earned')).toBe(true)
  expect(s.toasts.some(t => t.startsWith('Your waits this session: 9'))).toBe(false)
})

test('/goodwait opens the pane, which shows totals, the leaderboard and this session', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const s = seen()
  bottom(on, s)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
  const run = await $.command.run({ command: 'goodwait', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(run.text).toMatch(/opened/)
  expect(s.opened).toContain('goodwait')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^\$0\.98$/ })).toBeDefined() // 40 paid waits x $24.50 eCPM
    expect(await ui.find({ type: 'Text', text: /est. lifetime earnings/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /est. this session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1,234$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Riverside Library/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$24\.50 eCPM/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pledged to Khan Academy: about \$0\.49/ })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(s.status.at(-1)).toBeUndefined() // turned off from the pane
    await ui.press({ key: 'toggle' })
    expect(s.status.at(-1)).toMatch(/^1,234 waits/)
    await ui.press({ key: 'site' })
    expect(s.runs.at(-1)).toEqual(['open', 'https://goodwait.vercel.app/?ref=claude-code'])
    await ui.unmount()
  }
})
