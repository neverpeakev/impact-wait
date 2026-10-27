import { assert, assertEquals } from "jsr:@std/assert@1";
import { createSync, type DailyRow, safeEqual, type SyncDb, VELOCITY_API } from "../supabase/functions/goodwait-velocity-sync/sync.ts";

const KEY = "a".repeat(64);
const URL_ = "https://x.supabase.co/functions/v1/goodwait-velocity-sync";
const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

function memDb(over: Partial<{ cronKey: string; clientId: string; clientSecret: string }> = {}) {
  const daily = new Map<string, DailyRow>();
  const earnings: any[] = [];
  const runs: any[] = [];
  const db: SyncDb = {
    async secrets() { return { cronKey: KEY, clientId: "cid", clientSecret: "csecret", ...over }; },
    async upsertDaily(rows) { for (const r of rows) daily.set(`${r.report_date}|${r.ad_unit_key}`, r); },
    async totals(units) {
      const t = { revenue: 0, impressions: 0, clicks: 0 };
      for (const r of daily.values()) if (units.includes(r.ad_unit_key)) { t.revenue += r.revenue; t.impressions += r.impressions; t.clicks += r.clicks; }
      return t;
    },
    async lastEarning(n, s) { const e = earnings.filter((x) => x.network === n && x.site_key === s).at(-1); return e ? { earned_usd: e.earned_usd, paid_waits: e.paid_waits } : null; },
    async insertEarning(row) { earnings.push(row); },
    async logRun(row) { runs.push(row); },
  };
  return { db, daily, earnings, runs };
}

type Page = { items: unknown[]; total: number; perPage?: number };
function velocity(pages: Page[], opts: { tokenStatus?: number; reportStatus?: number } = {}) {
  const calls: { url: string; body?: string; auth?: string }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ url, body: init?.body ? String(init.body) : undefined, auth: headers.Authorization });
    if (url === `${VELOCITY_API}/token`) return opts.tokenStatus ? new Response("{}", { status: opts.tokenStatus }) : ok({ access_token: "vtok", token_type: "Bearer", expires_in: 900 });
    if (url.startsWith(`${VELOCITY_API}/reporting?`)) {
      if (opts.reportStatus) return new Response("{}", { status: opts.reportStatus });
      const page = Number(new URL(url).searchParams.get("page"));
      const p = pages[page - 1] || { items: [], total: 0 };
      return ok({ ...p, page, perPage: p.perPage ?? 100, dataLastUpdatedAt: "2026-10-21T00:20:19Z" });
    }
    throw new Error("unexpected fetch " + url);
  };
  return { f, calls };
}

const NOW = () => new Date("2026-10-21T06:00:00Z");
const post = (headers: Record<string, string> = { "x-goodwait-cron": KEY }, body: unknown = {}) =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ROWS = [
  { date: "2026-10-20", ad_unit_key: "e7b24fe95681", ad_unit_name: "goodwait-claude-code", revenue: 0.05, impressions: 10, clicks: 1 },
  { date: "2026-10-20", ad_unit_key: "bc4dd95b1d17", ad_unit_name: "hellostudys-native", revenue: 0.028, impressions: 6, clicks: 0 },
  { date: "2026-10-19", ad_unit_key: "e7b24fe95681", ad_unit_name: "goodwait-claude-code", revenue: 0.02, impressions: 4, clicks: 0 },
];

Deno.test("safeEqual: equal, unequal, different length, empty", () => {
  assert(safeEqual(KEY, KEY));
  assert(!safeEqual(KEY, "a".repeat(63) + "b"));
  assert(!safeEqual(KEY, KEY + "a"));
  assert(!safeEqual("", ""));
});

Deno.test("no key, wrong key, near-miss key or GET: bare 404, nothing called, nothing written", async () => {
  for (const req of [
    post({}),
    post({ "x-goodwait-cron": "nope" }),
    post({ "x-goodwait-cron": "a".repeat(63) + "b" }),
    post({ "x-goodwait-cron": KEY.toUpperCase() }),
    new Request(URL_, { method: "GET", headers: { "x-goodwait-cron": KEY } }),
  ]) {
    const m = memDb();
    const v = velocity([{ items: ROWS, total: 3 }]);
    const res = await createSync({ db: m.db, fetch: v.f, now: NOW })(req);
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "Not Found");
    assertEquals(v.calls.length, 0);
    assertEquals(m.runs.length + m.earnings.length + m.daily.size, 0);
  }
});

Deno.test("an unset cron key in Vault never matches an empty header", async () => {
  const m = memDb({ cronKey: "" });
  const v = velocity([]);
  const res = await createSync({ db: m.db, fetch: v.f, now: NOW })(post({ "x-goodwait-cron": "" }));
  assertEquals(res.status, 404);
  assertEquals(v.calls.length, 0);
});

Deno.test("happy path: pulls 7 days by date and ad unit, stores every row, records Goodwait's lifetime actual", async () => {
  const m = memDb();
  const v = velocity([{ items: ROWS, total: 3 }]);
  const res = await createSync({ db: m.db, fetch: v.f, now: NOW })(post());
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.ok, true);
  assertEquals(j.rows, 3);
  assertEquals(m.daily.size, 3);
  const tok = JSON.parse(v.calls[0].body!);
  assertEquals(tok, { grant_type: "client_credentials", client_id: "cid", client_secret: "csecret" });
  const q = new URL(v.calls[1].url).searchParams;
  assertEquals([q.get("dateFrom"), q.get("dateTo"), q.get("breakBy"), q.get("metrics")], ["2026-10-14", "2026-10-21", "date,ad_unit", "revenue,impressions,clicks"]);
  assertEquals(v.calls[1].auth, "Bearer vtok");
  assertEquals(m.earnings.length, 1);
  assertEquals(m.earnings[0].network, "velocity");
  assertEquals(m.earnings[0].site_key, "claude-code");
  assertEquals(m.earnings[0].earned_usd, 0.07); // only Goodwait's unit, not HelloStudys
  assertEquals(m.earnings[0].paid_waits, 14);
  assertEquals(m.earnings[0].as_of, "2026-10-21T00:20:19Z");
  assertEquals(m.runs.at(-1).ok, true);
  assertEquals(m.runs.at(-1).note, "2026-10-14..2026-10-21 earnings updated");
  // Nothing secret in the response.
  const text = JSON.stringify(j);
  assert(!text.includes("csecret") && !text.includes("vtok") && !text.includes(KEY));
});

Deno.test("a rerun with no change adds no new earnings row; a restated day updates it", async () => {
  const m = memDb();
  await createSync({ db: m.db, fetch: velocity([{ items: ROWS, total: 3 }]).f, now: NOW })(post());
  await createSync({ db: m.db, fetch: velocity([{ items: ROWS, total: 3 }]).f, now: NOW })(post());
  assertEquals(m.earnings.length, 1);
  const restated = ROWS.map((r) => (r.date === "2026-10-20" && r.ad_unit_key === "e7b24fe95681" ? { ...r, revenue: 0.06, impressions: 12 } : r));
  await createSync({ db: m.db, fetch: velocity([{ items: restated, total: 3 }]).f, now: NOW })(post());
  assertEquals(m.daily.size, 3); // upserted, not duplicated
  assertEquals(m.earnings.length, 2);
  assertEquals(m.earnings[1].earned_usd, 0.08);
  assertEquals(m.earnings[1].paid_waits, 16);
});

Deno.test("no Goodwait traffic yet: no zero earnings row is written", async () => {
  const m = memDb();
  await createSync({ db: m.db, fetch: velocity([{ items: [ROWS[1]], total: 1 }]).f, now: NOW })(post());
  assertEquals(m.daily.size, 1);
  assertEquals(m.earnings.length, 0);
  assertEquals(m.runs.at(-1).note, "2026-10-14..2026-10-21"); // the log never claims a write that did not happen
});

Deno.test("pages through results", async () => {
  const m = memDb();
  const v = velocity([{ items: ROWS.slice(0, 2), total: 3, perPage: 2 }, { items: ROWS.slice(2), total: 3, perPage: 2 }]);
  await createSync({ db: m.db, fetch: v.f, now: NOW })(post());
  assertEquals(m.daily.size, 3);
  assertEquals(v.calls.filter((c) => c.url.includes("/reporting?")).length, 2);
});

Deno.test("days is clamped to 1-31", async () => {
  for (const [days, from] of [[0, "2026-10-14"], [400, "2026-09-20"], [1, "2026-10-20"], ["x", "2026-10-14"]] as const) {
    const v = velocity([{ items: [], total: 0 }]);
    await createSync({ db: memDb().db, fetch: v.f, now: NOW })(post(undefined, { days }));
    assertEquals(new URL(v.calls[1].url).searchParams.get("dateFrom"), from);
  }
});

Deno.test("Velocity failures: generic 502, logged without secrets, nothing stored", async () => {
  for (const o of [{ tokenStatus: 401 }, { reportStatus: 500 }]) {
    const m = memDb();
    const logs: string[] = [];
    const res = await createSync({ db: m.db, fetch: velocity([], o).f, now: NOW, log: (s) => logs.push(s) })(post());
    assertEquals(res.status, 502);
    assertEquals(await res.json(), { ok: false, error: "sync failed" });
    assertEquals(m.daily.size, 0);
    assertEquals(m.runs.length, 1);
    assertEquals(m.runs[0].ok, false);
    const all = JSON.stringify([m.runs, logs]);
    assert(!all.includes("csecret") && !all.includes("vtok") && !all.includes(KEY), all);
  }
});

Deno.test("missing Velocity credentials: 503, logged, Velocity never called", async () => {
  const m = memDb({ clientSecret: "" });
  const v = velocity([]);
  const res = await createSync({ db: m.db, fetch: v.f, now: NOW })(post());
  assertEquals(res.status, 503);
  assertEquals(v.calls.length, 0);
  assertEquals(m.runs[0].note, "velocity credentials missing");
});

Deno.test("junk rows from Velocity are skipped, not stored", async () => {
  const m = memDb();
  const junk = [{ date: "yesterday", ad_unit_key: "e7b24fe95681", revenue: 1 }, { date: "2026-10-20", ad_unit_key: "bad key; drop table", revenue: 1 }, ROWS[0]];
  await createSync({ db: m.db, fetch: velocity([{ items: junk, total: 3 }]).f, now: NOW })(post());
  assertEquals(m.daily.size, 1);
});

Deno.test("the vibedough.com web unit records its own actual under vibedough-app, apart from claude-code", async () => {
  const m = memDb();
  const rows = [...ROWS, { date: "2026-10-20", ad_unit_key: "aae252cd6ea3", ad_unit_name: "vibedough-web-chat", revenue: 0.012, impressions: 2, clicks: 0 }];
  const res = await createSync({ db: m.db, fetch: velocity([{ items: rows, total: 4 }]).f, now: NOW })(post());
  const j = await res.json();
  assertEquals(j.goodwait.impressions, 14);
  assertEquals(j.sites["vibedough-app"].impressions, 2);
  const web = m.earnings.filter((e) => e.site_key === "vibedough-app");
  assertEquals(web.length, 1);
  assertEquals(web[0].earned_usd, 0.012);
  assertEquals(m.earnings.filter((e) => e.site_key === "claude-code")[0].earned_usd, 0.07);
});
