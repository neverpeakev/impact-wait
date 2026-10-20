import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Long turns: a fresh ad every 15s, only while the person is around (2 min
// since their last sign), at most 16 rotations a turn.

let n = 0
const adResponse = () => {
  n += 1
  const id = `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`
  return {
    id,
    ad: { provider: 'idlen', sponsored: true, label: 'Sponsored', brand: `Brand ${n}`, headline: `Headline ${n}`, body: '', cta: 'Go', clickUrl: `https://x.supabase.co/functions/v1/goodwait/click?id=${id}`, favicon: '' },
    impact: { cause_name: null, cause_url: null, unit_label: null, pledge_pct: null, donated_usd: 0, units_funded: null, donated_updated_at: null, sponsored_waits: n },
    sandbox: false,
  }
}
const STATS = {
  total: { sponsored_waits: 1, paid_waits: 1, clicks: 0, sites: 1 },
  site: { site_key: 'claude-code', name: null, sponsored_waits: 1, paid_waits: 1, clicks: 0 },
  leaderboard: [],
  impact: { cause_name: null, cause_url: null, unit_label: null, pledge_pct: null, donated_usd: 0, units_funded: null, donated_updated_at: null, sponsored_waits: 1 },
  earnings: [],
}
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} } } as const

function bottom(on: On, fetched: { url: string; body?: string }[]) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.edit', ($, e) => ({ text: e.text, cursor: e.cursor }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('http.fetch', ($, e) => {
    fetched.push({ url: e.url, body: e.init?.body })
    const ok = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (e.url.endsWith('/ad')) return ok(adResponse())
    if (e.url.endsWith('/event')) return ok({ ok: true, counted: true, credited: false })
    if (e.url.includes('/stats')) return ok(STATS)
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
}

const ads = (f: { url: string }[]) => f.filter(x => x.url.endsWith('/ad')).length
const events = (f: { url: string }[]) => f.filter(x => x.url.endsWith('/event')).length

async function tick(clock: ReturnType<typeof mock.clock>, ms: number) {
  await clock.advance(ms)
  await clock.settle()
}

async function startTurn($: Engine, clock: ReturnType<typeof mock.clock>, turnId: string) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await tick(clock, 0)
  await $.turn.start({ text: 'refactor the payment module', turnId })
  await tick(clock, 0) // first ad
  await tick(clock, 1000) // first view counts
}

// prompt.edit is raised by the editor, not a call on the test's $ type; the kit still raises it.
async function typeKey($: Engine) {
  const prompt = $.prompt as unknown as { edit(e: unknown): Promise<unknown> }
  await prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'a' })
}

test('a long turn rotates every 15s while the person is around, then holds one ad and counts nothing new', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await startTurn($, clock, 'r1')
  expect([ads(fetched), events(fetched)]).toEqual([1, 1])

  // Eight rotations fit in the 2-minute presence window (15, 30, ... 120s idle).
  for (let i = 0; i < 8; i++) {
    await tick(clock, 15_000)
    await tick(clock, 1000)
  }
  expect([ads(fetched), events(fetched)]).toEqual([9, 9])
  // Same prompt each time.
  const queries = fetched.filter(f => f.url.endsWith('/ad')).map(f => JSON.parse(f.body ?? '{}').query)
  expect(new Set(queries).size).toBe(1)

  // Nobody around: no more ads, no more views, however long the turn runs.
  await tick(clock, 10 * 60_000)
  expect([ads(fetched), events(fetched)]).toEqual([9, 9])
  const band = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /^Brand 9$/ })).toBeDefined() // the last ad stays up
  await band.unmount()

  // A keystroke in the prompt box: they are back, rotation resumes.
  await typeKey($)
  await tick(clock, 0)
  await tick(clock, 15_000)
  await tick(clock, 1000)
  expect([ads(fetched), events(fetched)]).toEqual([10, 10])
})

test('at most 16 rotations a turn even with the person active throughout', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await startTurn($, clock, 'r2')
  for (let i = 0; i < 24; i++) {
    await typeKey($)
    await tick(clock, 15_000)
    await tick(clock, 1000)
  }
  expect(ads(fetched)).toBe(17) // the first ad + 16 rotations
})

test('rotation stops when the turn ends, and nothing rotates on a short turn', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await startTurn($, clock, 'r3')
  await tick(clock, 10_000)
  await $.turn.complete({ answer: 'done', durationMs: 11_000, isAborted: false, turnId: 'r3', reason: 'answer' })
  await tick(clock, 5 * 60_000)
  expect(ads(fetched)).toBe(1)
})

test('rotateSeconds 0 turns rotation off', { options: { rotateSeconds: 0 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await startTurn($, clock, 'r4')
  await typeKey($)
  await tick(clock, 5 * 60_000)
  expect(ads(fetched)).toBe(1)
})

test('rotateSeconds below 15 is held to 15', { options: { rotateSeconds: 5 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: { url: string; body?: string }[] = []
  bottom(on, fetched)
  await startTurn($, clock, 'r5')
  await tick(clock, 14_000)
  expect(ads(fetched)).toBe(1)
  await tick(clock, 1000)
  expect(ads(fetched)).toBe(2)
})
