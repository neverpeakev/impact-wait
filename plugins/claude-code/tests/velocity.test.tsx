import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Velocity is called straight from this machine; its impression URL is fired
// from here, then the view is reported to the Goodwait API once.

const TOKEN = 'gw_' + 'cd'.repeat(32)
const EARNER = '11111111-2222-4333-8444-555555555555'
const UNIT = 'vlc-unit-01'
const GW = 'https://gw.vlcapi.net'
const IMP = 'https://events.vlcapi.net/imp?r=abc'
const CLICK = 'https://events.vlcapi.net/click?r=abc'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} } } as const
const HOUSE_AD = {
  id: '44444444-4444-4444-8444-444444444444',
  ad: { provider: 'house', sponsored: true, label: 'Sponsored', brand: 'Wispr Flow', headline: 'Talk instead of type', body: '', cta: 'Try free', clickUrl: 'https://x.supabase.co/functions/v1/goodwait/click?id=4', favicon: '' },
  impact: { cause_name: null, cause_url: null, unit_label: null, pledge_pct: null, donated_usd: 0, units_funded: null, donated_updated_at: null, sponsored_waits: 9 },
}
const STATS = { total: { sponsored_waits: 9, paid_waits: 0, clicks: 0, sites: 1 }, site: null, leaderboard: [], impact: HOUSE_AD.impact, earnings: [] }

type World = {
  fetched: { url: string; method: string; body?: string }[]
  runs: string[][]
  load: 'fill' | 'empty' | 'slow' | 'error'
  init: boolean
  impressionFails: boolean
}
const world = (): World => ({ fetched: [], runs: [], load: 'fill', init: true, impressionFails: false })

function bottom(on: On, w: World) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('http.fetch', ($, e) => {
    w.fetched.push({ url: e.url, method: e.init?.method ?? 'GET', body: e.init?.body })
    const res = (status: number, body: unknown = {}) => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) } })
    if (e.url === `${GW}/init`) return w.init ? res(200, { status: 'success' }) : res(401)
    if (e.url === `${GW}/v2/load`) {
      if (w.load === 'slow') return new Promise(() => {}) // never answers
      if (w.load === 'empty') return res(204)
      if (w.load === 'error') return res(500)
      return res(200, { requestId: 'vlc-req-0001', ads: [{ network: 'vlc', adPayload: { id: 'vad-1', title: 'Ship faster with Neon', description: 'Serverless Postgres.', callToAction: 'Try Neon', advertiserName: 'Neon', sponsoredLabel: 'Sponsored', clickUrl: CLICK, impressionUrl: IMP } }] })
    }
    if (e.url === IMP) {
      if (w.impressionFails) throw new Error('offline')
      return res(200)
    }
    if (e.url.endsWith('/earner') && e.init?.method === 'POST') return res(201, { earner_id: EARNER, token: TOKEN, share_pct: 50 })
    if (e.url.endsWith('/earner/me')) return res(200, { earner_id: EARNER, status: 'active', credited_total: 1, credited_today: 1, pending_waits: 1, owed_usd: 0, paid_usd: 0, payout_email: null, est_pending_usd: null, program: { share_pct: 50, min_payout_usd: 10, daily_cap: 200, min_gap_seconds: 15, est_ecpm_usd: null } })
    if (e.url.endsWith('/impression/external')) return res(200, { ok: true, counted: true, credited: true })
    if (e.url.endsWith('/ad')) return res(200, HOUSE_AD)
    if (e.url.endsWith('/event')) return res(200, { ok: true, counted: true, credited: false })
    if (e.url.includes('/stats')) return res(200, STATS)
    return res(404)
  })
}

async function tick(clock: ReturnType<typeof mock.clock>, ms: number) {
  await clock.advance(ms)
  await clock.settle()
}
async function startTurn($: Engine, clock: ReturnType<typeof mock.clock>, text = 'set up a postgres database for my app') {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await tick(clock, 0)
  await $.turn.start({ text, turnId: 't1' })
  await tick(clock, 0)
}
const calls = (w: World, url: string) => w.fetched.filter(f => f.url === url || f.url.endsWith(url))

test('off by default: no Velocity calls, the Goodwait API serves', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  bottom(on, w)
  await startTurn($, clock)
  expect(w.fetched.some(f => f.url.startsWith(GW))).toBe(false)
  expect(calls(w, '/ad').length).toBe(1)
})

test('with an ad unit: Velocity fills from this machine, its impression fires here, the view is reported once', { options: { velocityAdUnit: UNIT } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  bottom(on, w)
  await startTurn($, clock)

  expect(calls(w, `${GW}/init`).length).toBe(1)
  const load = JSON.parse(calls(w, `${GW}/v2/load`)[0]!.body ?? '{}')
  expect(load.publisherKey).toBe('b9fb08c9ea6c')
  expect(load.adUnitId).toBe(UNIT)
  expect(load.adType).toBe('native_ad')
  expect(load.adUnitDepth).toBe(1)
  expect(load.publisherUserId).toBe(EARNER) // per-user revenue in Velocity's reporting
  expect(load.prompt).toBe('set up a postgres database for my app')
  expect(load.metadata.webMetadata.domainName).toBe('impact-wait.vercel.app')
  expect(calls(w, '/ad').length).toBe(0) // no fallback needed

  const band = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /^Neon$/ })).toBeDefined()
  expect((await band.find({ key: 'open' }))?.props.label).toBe('Try Neon')
  await band.press({ key: 'open' })
  expect(w.runs.at(-1)).toEqual(['open', CLICK]) // Velocity's own click URL
  await band.unmount()

  // Nothing fires before a full second on screen.
  expect(calls(w, IMP).length).toBe(0)
  await tick(clock, 1000)
  expect(calls(w, IMP).length).toBe(1)
  const rep = calls(w, '/impression/external')
  expect(rep.length).toBe(1)
  expect(JSON.parse(rep[0]!.body ?? '{}')).toEqual({ network: 'velocity', site: 'claude-code', request_id: 'vlc-req-0001', ad_id: 'vad-1', earner: TOKEN })
  expect(w.fetched.findIndex(f => f.url === IMP)).toBeLessThan(w.fetched.findIndex(f => f.url.endsWith('/impression/external')))
  expect(calls(w, '/event').length).toBe(0)
})

test('the next Velocity ad in a session asks at the next depth; init runs once', { options: { velocityAdUnit: UNIT } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  bottom(on, w)
  await startTurn($, clock)
  await tick(clock, 1000)
  await tick(clock, 15_000) // rotation
  await tick(clock, 1000)
  const loads = calls(w, `${GW}/v2/load`).map(f => JSON.parse(f.body ?? '{}').adUnitDepth)
  expect(loads).toEqual([1, 2])
  expect(calls(w, `${GW}/init`).length).toBe(1)
})

for (const mode of ['empty', 'error'] as const) {
  test(`Velocity ${mode === 'empty' ? 'no fill (204)' : 'error (500)'} falls back to the Goodwait API`, { options: { velocityAdUnit: UNIT } }, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const w = world()
    w.load = mode
    bottom(on, w)
    await startTurn($, clock)
    expect(calls(w, '/ad').length).toBe(1)
    await tick(clock, 1000)
    expect(calls(w, '/event').length).toBe(1)
    expect(calls(w, '/impression/external').length).toBe(0)
  })
}

test('a slow Velocity never holds the line: fallback after 2.5s', { options: { velocityAdUnit: UNIT } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  w.load = 'slow'
  bottom(on, w)
  await startTurn($, clock)
  expect(calls(w, '/ad').length).toBe(0)
  await tick(clock, 2500)
  expect(calls(w, '/ad').length).toBe(1)
})

test('if Velocity init fails there is no load call, and the API serves', { options: { velocityAdUnit: UNIT } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  w.init = false
  bottom(on, w)
  await startTurn($, clock)
  expect(calls(w, `${GW}/v2/load`).length).toBe(0)
  expect(calls(w, '/ad').length).toBe(1)
})

test('if the impression cannot reach Velocity, no view is claimed', { options: { velocityAdUnit: UNIT } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  w.impressionFails = true
  bottom(on, w)
  await startTurn($, clock)
  await tick(clock, 1000)
  expect(calls(w, IMP).length).toBe(1)
  expect(calls(w, '/impression/external').length).toBe(0)
})
