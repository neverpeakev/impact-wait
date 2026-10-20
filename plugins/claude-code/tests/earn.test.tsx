import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const AD_ID = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'gw_' + 'ab'.repeat(32)

const AD_RESPONSE = {
  id: AD_ID,
  ad: { provider: 'velocity', sponsored: true, label: 'Sponsored', brand: 'Neon', headline: 'Serverless Postgres', body: 'Scale to zero.', cta: 'Try it', clickUrl: `https://x.supabase.co/functions/v1/goodwait/click?id=${AD_ID}`, favicon: '' },
  impact: { cause_name: null, cause_url: null, unit_label: null, pledge_pct: null, donated_usd: 0, units_funded: null, donated_updated_at: null, sponsored_waits: 50 },
  sandbox: false,
}
const STATS = {
  total: { sponsored_waits: 50, paid_waits: 40, clicks: 0, sites: 1 },
  site: { site_key: 'claude-code', name: null, sponsored_waits: 50, paid_waits: 40, clicks: 0 },
  leaderboard: [],
  impact: AD_RESPONSE.impact,
  earnings: [],
}
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} } } as const
const PANE = { component: 'Pane', requestId: 'goodwait', props: { title: 'Goodwait', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

type World = {
  fetched: { url: string; body?: string; auth?: string }[]
  toasts: string[]
  signups: number
  creditNext: boolean
  me: Record<string, unknown>
  payoutEmail: string | null
  signupStatus: number
}

const world = (): World => ({
  fetched: [],
  toasts: [],
  signups: 0,
  creditNext: true,
  signupStatus: 201,
  payoutEmail: null,
  me: {
    earner_id: 'e1', status: 'active', credited_total: 0, credited_today: 0, pending_waits: 0, owed_usd: 0, paid_usd: 0,
    est_pending_usd: null, created_at: '2026-10-20T00:00:00Z',
    program: { share_pct: 50, min_payout_usd: 10, daily_cap: 200, min_gap_seconds: 15, est_ecpm_usd: null },
  },
})

function bottom(on: On, w: World) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('http.fetch', ($, e) => {
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    w.fetched.push({ url: e.url, body: e.init?.body, auth: headers.authorization })
    const res = (status: number, body: unknown) => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) } })
    const authed = headers.authorization === `Bearer ${TOKEN}`
    if (e.url.endsWith('/earner') && e.init?.method === 'POST') {
      w.signups++
      return w.signupStatus === 201 ? res(201, { earner_id: 'e1', token: TOKEN, share_pct: 50 }) : res(w.signupStatus, { error: 'nope' })
    }
    if (e.url.endsWith('/earner/me')) return authed ? res(200, { ...w.me, payout_email: w.payoutEmail }) : res(401, { error: 'earner token required' })
    if (e.url.endsWith('/earner/payout')) {
      if (!authed) return res(401, {})
      const email = JSON.parse(e.init?.body ?? '{}').email as string
      if (!/@/.test(email)) return res(400, { error: 'a valid PayPal email is required' })
      w.payoutEmail = `${email[0]}***@${email.split('@')[1]}`
      return res(200, { ok: true, payout_email: w.payoutEmail })
    }
    if (e.url.endsWith('/ad')) return res(200, AD_RESPONSE)
    if (e.url.endsWith('/event')) {
      const credited = w.creditNext
      if (credited) w.me = { ...w.me, credited_today: Number(w.me.credited_today) + 1, credited_total: Number(w.me.credited_total) + 1, pending_waits: Number(w.me.pending_waits) + 1 }
      return res(200, { ok: true, counted: true, credited })
    }
    if (e.url.includes('/stats')) return res(200, STATS)
    return res(404, {})
  })
}

async function start($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  await clock.settle()
}

test('first run signs up once, keeps the token, and says so; later sessions reuse it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  bottom(on, w)
  await start($, clock)
  expect(w.signups).toBe(1)
  expect(w.toasts.some(t => /You now earn 50% of the ad revenue/.test(t))).toBe(true)
  expect(w.fetched.some(f => f.url.endsWith('/earner/me') && f.auth === `Bearer ${TOKEN}`)).toBe(true)

  await start($, clock) // a new session
  expect(w.signups).toBe(1)
  expect(w.toasts.filter(t => /You now earn/.test(t)).length).toBe(1)
})

test('ad requests carry the earner token; a credited view refreshes the balance on the band', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  bottom(on, w)
  await start($, clock)

  await $.turn.start({ text: 'which postgres host should I use', turnId: 't1' })
  await clock.advance(0)
  await clock.settle()
  const adCall = w.fetched.find(f => f.url.endsWith('/ad'))
  expect(JSON.parse(adCall!.body ?? '{}').earner).toBe(TOKEN)

  await clock.advance(1000) // the impression, credited
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /^You: 1 paid views today · 1 pending · \$0\.00 owed · 50 waits so far/ })).toBeDefined()
  await band.unmount()
})

test('with no earner (sign-up refused) the band falls back to the old line and ads carry no token', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  w.signupStatus = 429
  bottom(on, w)
  await start($, clock)
  await $.turn.start({ text: 'hello', turnId: 't2' })
  await clock.advance(0)
  await clock.settle()
  expect(JSON.parse(w.fetched.find(f => f.url.endsWith('/ad'))!.body ?? '{}').earner).toBeUndefined()
  const band = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /lifetime · est\. \$0\.00 this session/ })).toBeDefined()
  await band.unmount()
  const r = await $.command.run({ command: 'earn', args: '', ...RUN })
  expect(r.text).toMatch(/not set up/)
})

test('/earn shows the balance; /earn paypal sets the payout email, shown masked', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  w.me = { ...w.me, owed_usd: 12.5, paid_usd: 3, pending_waits: 40, credited_today: 7, credited_total: 300 }
  bottom(on, w)
  await start($, clock)

  const bal = await $.command.run({ command: 'earn', args: '', ...RUN })
  expect(bal.text).toBe('You: 7 paid views today · 40 pending · $12.50 owed · $3.00 paid out · no PayPal set (/earn paypal you@example.com)')

  const bad = await $.command.run({ command: 'earn', args: 'paypal nope', ...RUN })
  expect(bad.text).toMatch(/does not look like an email/)
  const good = await $.command.run({ command: 'earn', args: 'paypal Kev@Example.com', ...RUN })
  expect(good.text).toBe('Payouts go to PayPal k***@example.com.')
  const sent = w.fetched.filter(f => f.url.endsWith('/earner/payout')).at(-1)!
  expect(JSON.parse(sent.body ?? '{}')).toEqual({ email: 'kev@example.com' })
  expect(sent.auth).toBe(`Bearer ${TOKEN}`)

  const huh = await $.command.run({ command: 'earn', args: 'withdraw', ...RUN })
  expect(huh.text).toMatch(/Use \/earn/)
})

test('the pane leads with your earnings and how payouts work', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const w = world()
  w.me = { ...w.me, owed_usd: 12.5, paid_usd: 3, pending_waits: 40, credited_today: 7, credited_total: 300, est_pending_usd: 0.08 }
  bottom(on, w)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'goodwait', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^You earn 50% of the ad revenue from your waits$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\$12\.50$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /paid views waiting to settle \(est\. \$0\.08\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^7 of 200 paid views today · 300 lifetime$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /once you are owed \$10\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/earn paypal you@example\.com/ })).toBeDefined()
  await ui.unmount()
})
