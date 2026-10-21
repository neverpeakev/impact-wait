// One balance, three exits: settlement credits, referral cut, donate, ledger, draw entries.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createApp } from "../supabase/functions/goodwait/app.ts";
import { memStore } from "./memstore.ts";

const BASE = "https://x.supabase.co/functions/v1/goodwait";
const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

function mk() {
  const store = memStore({}, { min_gap_seconds: 0 });
  const f: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/serve")) return ok({ success: true, ad: { ad_id: "ad1", title: "Neon", body: "x", cta_text: "Try", cta_url: "https://neon.tech/", advertiser_name: "Neon", impression_token: "tok1", publisher_id: "pub1", request_id: "req1" } });
    if (url.endsWith("/v1/impression")) return ok({});
    throw new Error("unexpected fetch " + url);
  };
  const app = createApp({ store, keys: { idlen: "idl_pk_x" }, baseUrl: BASE, salt: "t", fetch: f });
  const call = (path: string, init: RequestInit = {}, ip = "1.1.1.1") =>
    app(new Request(BASE + path, { ...init, headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: "https://chat.acme.dev", ...(init.headers || {}) } }));
  const signup = async (ip: string, invite?: string) => (await call("/earner", { method: "POST", body: JSON.stringify(invite ? { invite } : {}) }, ip)).json();
  const view = async (token: string) => {
    const j = await (await call("/ad", { method: "POST", body: JSON.stringify({ site: "claude-code", query: "postgres", earner: token }) })).json();
    store.age(j.id, 1000);
    return (await call("/event", { method: "POST", body: JSON.stringify({ id: j.id, type: "impression" }) })).json();
  };
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const me = async (token: string) => (await call("/earner/me", { headers: auth(token) })).json();
  return { store, call, signup, view, me, auth };
}

Deno.test("sign-up returns a referral code; a valid invite from another network links the friend", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  assert(/^[a-z2-9]{8}$/.test(a.referral_code), a.referral_code);
  assertEquals(a.referred, false);
  const b = await t.signup("2.2.2.2", a.referral_code);
  assertEquals(b.referred, true);
  assertEquals(t.store.earners.get(b.earner_id).referred_by, a.earner_id);
  assertEquals((await t.me(a.token)).referrals, 1);
});

Deno.test("invites that don't count still let the person sign up: same network, unknown code, banned referrer, junk", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  const same = await t.signup("1.1.1.1", a.referral_code); // self-referral from the same network
  assertEquals([same.referred, !!same.token], [false, true]);
  const unknown = await t.signup("3.3.3.3", "zzzzzzzz");
  assertEquals([unknown.referred, !!unknown.token], [false, true]);
  const junk = await t.signup("4.4.4.4", "<script>");
  assertEquals([junk.referred, !!junk.token], [false, true]);
  t.store.earners.get(a.earner_id).status = "banned";
  const toBanned = await t.signup("5.5.5.5", a.referral_code);
  assertEquals(toBanned.referred, false);
});

Deno.test("referrals are capped at 25 a day per referrer", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  for (let i = 0; i < 25; i++) assertEquals((await t.signup(`10.0.${Math.floor(i / 3)}.${i}`, a.referral_code)).referred, true);
  assertEquals((await t.signup("10.9.9.9", a.referral_code)).referred, false);
});

Deno.test("settlement: friend gets the user share, referrer gets 10% of it on top, from the house half", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  const b = await t.signup("2.2.2.2", a.referral_code);
  for (let i = 0; i < 4; i++) await t.view(b.token);
  t.store.settle("idlen", 10); // network paid $10 for 4 views: users' half = $5, all to b
  const mb = await t.me(b.token), ma = await t.me(a.token);
  assertEquals([mb.balance_usd, mb.owed_usd], [5, 5]);
  assertEquals([ma.balance_usd, ma.referral_earned_usd], [0.5, 0.5]); // 10% of b's $5, paid by the house
  // The friend's money is never reduced by the referral.
  assertEquals(t.store.payouts.filter((p) => p.earner_id === b.earner_id).reduce((s, p) => s + p.amount_usd, 0), 5);
});

Deno.test("referral cut is one level only: a referrer's referral earnings earn their own referrer nothing", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  const b = await t.signup("2.2.2.2", a.referral_code);
  const c = await t.signup("3.3.3.3", b.referral_code);
  for (let i = 0; i < 2; i++) await t.view(c.token);
  t.store.settle("idlen", 4); // c earns $2; b gets $0.20; a gets nothing from b's referral cut
  assertEquals([(await t.me(c.token)).balance_usd, (await t.me(b.token)).balance_usd, (await t.me(a.token)).balance_usd], [2, 0.2, 0]);
});

Deno.test("donate: all or part of the balance, never more; zero balance says so plainly", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  const empty = await t.call("/earner/donate", { method: "POST", headers: t.auth(a.token), body: "{}" });
  assertEquals(empty.status, 409);
  for (let i = 0; i < 2; i++) await t.view(a.token);
  t.store.settle("idlen", 8); // $4 balance
  const part = await (await t.call("/earner/donate", { method: "POST", headers: t.auth(a.token), body: JSON.stringify({ amount: 1.5 }) })).json();
  assertEquals([part.donated_usd, part.balance_usd, part.cause], [1.5, 2.5, "charity: water"]);
  const over = await (await t.call("/earner/donate", { method: "POST", headers: t.auth(a.token), body: JSON.stringify({ amount: 100 }) })).json();
  assertEquals([over.donated_usd, over.balance_usd], [2.5, 0]); // capped at the balance
  const m = await t.me(a.token);
  assertEquals([m.balance_usd, m.donated_usd], [0, 4]);
  for (const bad of [{ amount: -1 }, { amount: "lots" }, { amount: 0 }]) {
    assertEquals((await t.call("/earner/donate", { method: "POST", headers: t.auth(a.token), body: JSON.stringify(bad) })).status, 400);
  }
  assertEquals((await t.call("/earner/donate", { method: "POST", body: "{}" })).status, 401);
});

Deno.test("exit set to donate: new settlements go straight to the cause", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  assertEquals((await t.call("/earner/exit", { method: "POST", headers: t.auth(a.token), body: JSON.stringify({ exit: "lotto" }) })).status, 400);
  assertEquals(await (await t.call("/earner/exit", { method: "POST", headers: t.auth(a.token), body: JSON.stringify({ exit: "donate" }) })).json(), { ok: true, auto_exit: "donate" });
  for (let i = 0; i < 2; i++) await t.view(a.token);
  t.store.settle("idlen", 6);
  const m = await t.me(a.token);
  assertEquals([m.auto_exit, m.balance_usd, m.donated_usd], ["donate", 0, 3]);
});

Deno.test("ledger: public totals only, no identities", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  for (let i = 0; i < 2; i++) await t.view(a.token);
  t.store.settle("idlen", 8);
  await t.call("/earner/donate", { method: "POST", headers: t.auth(a.token), body: JSON.stringify({ amount: 1 }) });
  t.store.redemptions.push({ earner_id: a.earner_id, kind: "cash", amount_usd: 2, status: "paid" });
  const res = await t.call("/ledger");
  const l = await res.json();
  assertEquals(l, { credited_to_users_usd: 4, paid_out_usd: 2, donated_usd: 0, donation_pending_usd: 1, people_paid: 1, last_activity_at: null, cause: "charity: water" });
  assert(!JSON.stringify(l).includes(a.earner_id));
  assert((res.headers.get("cache-control") || "").includes("max-age=60"));
});

Deno.test("cash-out date: hold days after both the account and the first credited view", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  assertEquals((await t.me(a.token)).cash_out_from, null); // no credited view yet
  await t.view(a.token);
  const m = await t.me(a.token);
  const days = (new Date(m.cash_out_from).getTime() - Date.now()) / 86400e3;
  assert(days > 29.9 && days <= 30, String(days));
});

Deno.test("draw: no open draw means no entries shown and the free entry says so", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  assertEquals((await t.me(a.token)).draw, null);
  const r = await t.call("/draw/free-entry", { method: "POST", body: JSON.stringify({ email: "k@x.com" }) });
  assertEquals(r.status, 409);
});

Deno.test("draw: an open draw counts credited views in its window, and the free entry works once a day", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  t.store.draws.push({ id: "d1", name: "Launch draw", prize_usd: 1000, status: "open", opens_at: new Date(Date.now() - 3600e3), closes_at: new Date(Date.now() + 86400e3), rules_url: "https://example.com/rules" });
  for (let i = 0; i < 3; i++) await t.view(a.token);
  const m = await t.me(a.token);
  assertEquals(m.draw, { name: "Launch draw", prize_usd: 1000, closes_at: m.draw.closes_at, rules_url: "https://example.com/rules", entries: 3 });
  const first = await (await t.call("/draw/free-entry", { method: "POST", body: JSON.stringify({ email: " K@X.com " }) })).json();
  assertEquals([first.entered, first.already_today], [true, false]);
  const again = await (await t.call("/draw/free-entry", { method: "POST", body: JSON.stringify({ email: "k@x.com" }) })).json();
  assertEquals([again.entered, again.already_today], [false, true]);
  assertEquals((await t.call("/draw/free-entry", { method: "POST", body: JSON.stringify({ email: "nope" }) })).status, 400);
  for (let i = 0; i < 4; i++) await t.call("/draw/free-entry", { method: "POST", body: JSON.stringify({ email: `p${i}@x.com` }) });
  assertEquals((await t.call("/draw/free-entry", { method: "POST", body: JSON.stringify({ email: "p9@x.com" }) })).status, 429);
});

Deno.test("a draw that isn't open (draft) is invisible", async () => {
  const t = mk();
  const a = await t.signup("1.1.1.1");
  t.store.draws.push({ id: "d2", name: "Launch draw", prize_usd: 1000, status: "draft", opens_at: new Date(Date.now() - 3600e3), closes_at: new Date(Date.now() + 86400e3), rules_url: null });
  assertEquals((await t.me(a.token)).draw, null);
});
