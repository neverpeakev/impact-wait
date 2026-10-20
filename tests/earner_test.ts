// Earner program: sign-up, credit rules, earnings readout, payout email, settlement.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createApp, type Program } from "../supabase/functions/goodwait/app.ts";
import { memStore } from "./memstore.ts";

const BASE = "https://x.supabase.co/functions/v1/goodwait";
const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

// Idlen fills every request (a paying network); flip `fill` to false for house ads.
function mk(opts: { fill?: boolean; program?: Partial<Program> } = {}) {
  const fill = opts.fill ?? true;
  const store = memStore({}, opts.program);
  const f: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/serve")) return fill ? ok({ success: true, ad: { ad_id: "ad1", title: "Neon Postgres", body: "Scale to zero", cta_text: "Try", cta_url: "https://neon.tech/", advertiser_name: "Neon", impression_token: "tok1", publisher_id: "pub1", request_id: "req1" } }) : ok({ success: false });
    if (url.endsWith("/v1/impression")) return ok({});
    throw new Error("unexpected fetch " + url);
  };
  const app = createApp({ store, keys: { idlen: "idl_pk_x" }, baseUrl: BASE, salt: "t", fetch: f });
  const call = (path: string, init: RequestInit = {}, ip = "1.1.1.1", origin = "https://chat.acme.dev") =>
    app(new Request(BASE + path, { ...init, headers: { "content-type": "application/json", "x-forwarded-for": ip, origin, ...(init.headers || {}) } }));
  const signup = async (ip = "1.1.1.1") => (await call("/earner", { method: "POST", body: "{}" }, ip));
  const ad = async (earner?: string, origin?: string) => (await call("/ad", { method: "POST", body: JSON.stringify({ site: "claude-code", query: "best postgres host", earner }) }, "1.1.1.1", origin)).json();
  // Shows an ad and reports its impression after the 900ms on-screen minimum.
  const view = async (earner?: string) => {
    const j = await ad(earner);
    store.age(j.id, 1000);
    const ev = await (await call("/event", { method: "POST", body: JSON.stringify({ id: j.id, type: "impression" }) })).json();
    return { id: j.id as string, ad: j.ad, ev };
  };
  const me = async (token: string) => call("/earner/me", { headers: { authorization: `Bearer ${token}` } });
  return { store, call, signup, ad, view, me };
}

Deno.test("sign-up: returns a gw_ token once; only its hash is stored", async () => {
  const t = mk();
  const r = await t.signup();
  assertEquals(r.status, 201);
  const j = await r.json();
  assertMatch(j.token, /^gw_[0-9a-f]{64}$/);
  assertEquals(j.share_pct, 50);
  const stored = [...t.store.earners.values()][0];
  assertEquals(stored.id, j.earner_id);
  assert(!JSON.stringify(stored).includes(j.token), "the raw token must never be stored");
});

Deno.test("sign-up: the 4th from one network in a day is refused", async () => {
  const t = mk();
  for (let i = 0; i < 3; i++) assertEquals((await t.signup()).status, 201);
  assertEquals((await t.signup()).status, 429);
  assertEquals((await t.signup("2.2.2.2")).status, 201); // another network is fine
});

Deno.test("credit: a paid, counted impression is credited to the earner", async () => {
  const t = mk();
  const { token } = await (await t.signup()).json();
  const v = await t.view(token);
  assertEquals(v.ev, { ok: true, counted: true, credited: true });
  assert(!JSON.stringify(v.ad).includes(token), "the ad response never echoes the token");
  const m = await (await t.me(token)).json();
  assertEquals([m.credited_total, m.credited_today, m.pending_waits], [1, 1, 1]);
  assertEquals([m.owed_usd, m.paid_usd], [0, 0]); // nothing is owed until revenue is settled
  assertEquals(m.est_pending_usd, null); // no estimate unless an eCPM is configured
});

Deno.test("credit: house ads, sandbox and unknown tokens never credit, but the ad still serves", async () => {
  let t = mk({ fill: false });
  let { token } = await (await t.signup()).json();
  const house = await t.view(token);
  assertEquals(house.ad.provider, "house");
  assertEquals(house.ev.credited, false);

  t = mk();
  ({ token } = await (await t.signup()).json());
  const sandbox = await t.ad(token, "http://localhost:3000");
  assertEquals(sandbox.sandbox, true);
  assertEquals(t.store.ads.get(sandbox.id)!.earner_id, null);

  const fake = "gw_" + "0".repeat(64);
  const v = await t.view(fake);
  assertEquals(v.ad.provider, "idlen");
  assertEquals(v.ev.credited, false);
  const junk = await t.ad("not-a-token");
  assertEquals(junk.ad.provider, "idlen");
});

Deno.test("credit: a second view inside the minimum gap is counted but not credited", async () => {
  const t = mk();
  const { token } = await (await t.signup()).json();
  const first = await t.view(token);
  assertEquals(first.ev.credited, true);
  const second = await t.view(token);
  assertEquals(second.ev, { ok: true, counted: true, credited: false });
  t.store.age(first.id, 30_000); // the first credit is now 30s old
  const third = await t.view(token);
  assertEquals(third.ev.credited, true);
  assertEquals((await (await t.me(token)).json()).credited_total, 2);
});

Deno.test("credit: the daily cap stops credit for 24 hours", async () => {
  const t = mk({ program: { daily_cap: 2, min_gap_seconds: 0 } });
  const { token } = await (await t.signup()).json();
  assertEquals((await t.view(token)).ev.credited, true);
  assertEquals((await t.view(token)).ev.credited, true);
  assertEquals((await t.view(token)).ev.credited, false);
  for (const a of t.store.ads.values()) if ((a as { credited?: boolean }).credited) t.store.age(a.id, 86_400_000 + 1000);
  assertEquals((await t.view(token)).ev.credited, true);
});

Deno.test("credit: a banned earner earns nothing", async () => {
  const t = mk();
  const { token, earner_id } = await (await t.signup()).json();
  t.store.earners.get(earner_id).status = "banned";
  assertEquals((await t.view(token)).ev.credited, false);
});

Deno.test("earnings: /earner/me needs a valid token", async () => {
  const t = mk();
  assertEquals((await t.call("/earner/me")).status, 401);
  assertEquals((await t.me("gw_" + "f".repeat(64))).status, 401);
  assertEquals((await t.call("/earner/me", { headers: { authorization: "Bearer nope" } })).status, 401);
});

Deno.test("settlement: actual revenue is split pro rata by credited waits, at the user share", async () => {
  const t = mk({ program: { min_gap_seconds: 0 } });
  const a = (await (await t.signup()).json()).token;
  const b = (await (await t.signup()).json()).token;
  for (let i = 0; i < 3; i++) await t.view(a);
  await t.view(b);
  t.store.settle("idlen", 8); // network paid $8 for these 4 waits; users share 50% = $4
  const ma = await (await t.me(a)).json();
  const mb = await (await t.me(b)).json();
  assertEquals([ma.owed_usd, mb.owed_usd], [3, 1]);
  assertEquals([ma.pending_waits, mb.pending_waits], [0, 0]);
  await t.view(a);
  assertEquals((await (await t.me(a)).json()).pending_waits, 1); // new waits wait for the next settlement
});

Deno.test("earnings: an estimate shows only when an eCPM is configured, at the user share", async () => {
  const t = mk({ program: { est_ecpm_usd: 4, min_gap_seconds: 0 } });
  const { token } = await (await t.signup()).json();
  for (let i = 0; i < 5; i++) await t.view(token);
  const m = await (await t.me(token)).json();
  assertEquals(m.est_pending_usd, 0.01); // 5/1000 x $4 x 50%
  assertEquals(m.program, { share_pct: 50, min_payout_usd: 10, daily_cap: 200, min_gap_seconds: 0, est_ecpm_usd: 4 });
});

Deno.test("payout email: validated, stored, and only ever shown masked", async () => {
  const t = mk();
  const { token, earner_id } = await (await t.signup()).json();
  const auth = { authorization: `Bearer ${token}` };
  assertEquals((await t.call("/earner/payout", { method: "POST", headers: auth, body: JSON.stringify({ email: "nope" }) })).status, 400);
  assertEquals((await t.call("/earner/payout", { method: "POST", body: JSON.stringify({ email: "kev@example.com" }) })).status, 401);
  const r = await (await t.call("/earner/payout", { method: "POST", headers: auth, body: JSON.stringify({ email: " Kev@Example.com " }) })).json();
  assertEquals(r, { ok: true, payout_email: "k***@example.com" });
  assertEquals(t.store.earners.get(earner_id).payout_email, "kev@example.com");
  assertEquals((await (await t.me(token)).json()).payout_email, "k***@example.com");
});

Deno.test("CORS allows the Authorization header", async () => {
  const t = mk();
  const r = await t.call("/earner/me", { method: "OPTIONS" });
  assertMatch(r.headers.get("access-control-allow-headers") || "", /authorization/);
});
