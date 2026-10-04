import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const AD_ID = '11111111-1111-4111-8111-111111111111'

const AD_RESPONSE = {
  id: AD_ID,
  ad: {
    provider: 'house',
    sponsored: true,
    label: 'Sponsored',
    brand: 'Khan Academy',
    headline: 'Free, world-class education for anyone, anywhere.',
    body: '',
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
  sandbox: true,
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

// The engine beneath the plugin: what each `$` call the mod makes lands on.
function bottom(on: On, fetched: { url: string; body?: string }[]) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('http.fetch', ($, e) => {
    fetched.push({ url: e.url, body: e.init?.body })
    const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    if (e.url.endsWith('/ad')) return ok(JSON.stringify(AD_RESPONSE))
    if (e.url.endsWith('/event')) return ok('{"ok":true,"counted":false,"sandbox":true}')
    if (e.url.includes('/stats')) {
      return ok(JSON.stringify({ total: { sponsored_waits: 1234, paid_waits: 0, clicks: 0, sites: 3 }, site: null, leaderboard: [], impact: AD_RESPONSE.impact }))
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
}

test('nothing is drawn before a turn', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  bottom(on, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface, ...BAND })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the line shows during a turn, counts after one second, clears after the linger', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
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
    const link = await ui.find({ type: 'Link' })
    expect(link?.props.href).toBe(AD_RESPONSE.ad.clickUrl)
    expect(await ui.find({ type: 'Text', text: /Khan Academy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50% of net ad revenue goes to Khan Academy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /test mode, nothing counted/ })).toBeDefined()
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
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(4000)
  await clock.settle()
  {
    const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  }
})

test('an ad that arrives after the reply is never shown', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'quick one', turnId: 't2' })
  // The turn ends before the timer that fetches the ad has fired.
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(0)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()
  await clock.advance(1000)
  await clock.settle()
  expect(fetched.some(f => f.url.endsWith('/event'))).toBe(false)
})

test('hide persists across sessions and /goodwait on brings it back', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hello there', turnId: 't3' })
  await clock.advance(0)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
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
    expect(await ui2.find({ type: 'Link' })).toBeUndefined()
    await ui2.unmount()
  }

  const on_ = await $.command.run({ command: 'goodwait', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(on_.text).toMatch(/is on/)
  const stats = await $.command.run({ command: 'goodwait', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(stats.text).toMatch(/1,234 sponsored waits/)
  expect(stats.text).toMatch(/Khan Academy/)
})
