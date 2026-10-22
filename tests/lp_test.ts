import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanUtm, createLp, type LpEvent, type LpStore } from "../supabase/functions/lp/lp.ts";

const ORIGIN = "https://impact-wait.vercel.app";
const URL_ = "https://x.supabase.co/functions/v1/lp";
const SESSION = "s_abcdefgh1234";

function mem() {
  const events: (LpEvent & { at: number })[] = [];
  const list = new Map<string, { variant: string; variants: string[]; session_id: string; tools: string[]; utm: Record<string, string> }>();
  const store: LpStore = {
    async recentEvents(ip, secs, kind) { return events.filter((e) => e.ip_hash === ip && (!kind || e.kind === kind) && e.at > Date.now() - secs * 1000).length; },
    async insertEvent(e) { events.push({ ...e, at: Date.now() }); },
    async upsertSignup(r) {
      const cur = list.get(r.email);
      if (cur) { if (!cur.variants.includes(r.variant)) cur.variants.push(r.variant); cur.session_id = r.session_id; return false; }
      list.set(r.email, { variant: r.variant, variants: [r.variant], session_id: r.session_id, tools: [], utm: r.utm });
      return true;
    },
    async setTools(email, session, tools) { const c = list.get(email); if (!c || c.session_id !== session) return false; c.tools = tools; return true; },
  };
  return { store, events, list };
}

const mk = () => { const m = mem(); return { ...m, h: createLp({ store: m.store, origins: [ORIGIN, /^https:\/\/impact-wait-[a-z0-9-]+\.vercel\.app$/], salt: "t" }) }; };
const post = (body: unknown, origin = ORIGIN, ip = "1.2.3.4") =>
  new Request(URL_, { method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": ip }, body: JSON.stringify(body) });

Deno.test("view: recorded with cleaned UTMs and CORS for the listed origin", async () => {
  const t = mk();
  const res = await t.h(post({ kind: "view", variant: "cash", session: SESSION, utm: { utm_source: "reddit", utm_campaign: "c1", evil: "x", fbclid: "abc" }, ref: "https://www.reddit.com/" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), ORIGIN);
  assertEquals(t.events.length, 1);
  assertEquals(t.events[0].utm, { utm_source: "reddit", utm_campaign: "c1", fbclid: "abc" });
  assertEquals(t.events[0].referrer, "https://www.reddit.com/");
  assert(!JSON.stringify(t.events[0]).includes("1.2.3.4")); // raw IP never stored
});

Deno.test("unlisted origin, no origin, GET: refused, nothing stored", async () => {
  const t = mk();
  for (const req of [post({ kind: "view", variant: "cash", session: SESSION }, "https://evil.example"), post({ kind: "view", variant: "cash", session: SESSION }, ""),
    new Request(URL_, { headers: { origin: ORIGIN } })]) {
    const res = await t.h(req);
    assert(res.status === 403 || res.status === 404, String(res.status));
    if (req.headers.get("origin") !== ORIGIN) assertEquals(res.headers.get("access-control-allow-origin"), null);
  }
  assertEquals(t.events.length, 0);
});

Deno.test("preview deployments of the project are allowed; look-alikes are not", async () => {
  const t = mk();
  assertEquals((await t.h(post({ kind: "view", variant: "give", session: SESSION }, "https://impact-wait-git-main-kev.vercel.app"))).status, 200);
  assertEquals((await t.h(post({ kind: "view", variant: "give", session: SESSION }, "https://impact-wait.vercel.app.evil.com"))).status, 403);
  assertEquals((await t.h(post({ kind: "view", variant: "give", session: SESSION }, "https://evilimpact-wait-x.vercel.app"))).status, 403);
});

Deno.test("bad variant, kind or session: 400", async () => {
  const t = mk();
  for (const b of [{ kind: "view", variant: "lotto", session: SESSION }, { kind: "hack", variant: "cash", session: SESSION }, { kind: "view", variant: "cash", session: "x" }]) {
    assertEquals((await t.h(post(b))).status, 400);
  }
  assertEquals(t.events.length, 0);
});

Deno.test("signup: new email stored lowercased; the same email on another page adds that variant, not a new row", async () => {
  const t = mk();
  const r1 = await t.h(post({ kind: "signup", variant: "prize", session: SESSION, email: " Kev@Example.COM ", utm: { utm_source: "meta" } }));
  assertEquals(await r1.json(), { ok: true, new: true });
  const r2 = await t.h(post({ kind: "signup", variant: "give", session: "s_other_session1", email: "kev@example.com" }));
  assertEquals(await r2.json(), { ok: true, new: false });
  assertEquals(t.list.size, 1);
  assertEquals(t.list.get("kev@example.com")!.variant, "prize"); // first touch kept
  assertEquals(t.list.get("kev@example.com")!.variants, ["prize", "give"]);
  assertEquals(t.events.filter((e) => e.kind === "signup").length, 2);
});

Deno.test("signup: invalid email gets a plain message and nothing is stored", async () => {
  const t = mk();
  const res = await t.h(post({ kind: "signup", variant: "cash", session: SESSION, email: "nope" }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "Enter a valid email address.");
  assertEquals(t.list.size + t.events.length, 0);
});

Deno.test("honeypot filled: looks accepted, nothing stored", async () => {
  const t = mk();
  const res = await t.h(post({ kind: "signup", variant: "cash", session: SESSION, email: "bot@spam.com", hp: "http://spam" }));
  assertEquals(await res.json(), { ok: true });
  assertEquals(t.list.size + t.events.length, 0);
});

Deno.test("rate limits: 30 events a minute per network, 5 sign-ups an hour", async () => {
  const t = mk();
  for (let i = 0; i < 5; i++) assertEquals((await t.h(post({ kind: "signup", variant: "cash", session: SESSION, email: `a${i}@x.com` }))).status, 200);
  assertEquals((await t.h(post({ kind: "signup", variant: "cash", session: SESSION, email: "a6@x.com" }))).status, 429);
  for (let i = 0; i < 25; i++) await t.h(post({ kind: "view", variant: "cash", session: SESSION }));
  assertEquals((await t.h(post({ kind: "view", variant: "cash", session: SESSION }))).status, 429);
  // A different network is unaffected.
  assertEquals((await t.h(post({ kind: "view", variant: "cash", session: SESSION }, ORIGIN, "9.9.9.9"))).status, 200);
});

Deno.test("tools: only the session that signed up can set them; unknown tools dropped", async () => {
  const t = mk();
  await t.h(post({ kind: "signup", variant: "cash", session: SESSION, email: "k@x.com" }));
  const other = await t.h(post({ kind: "tools", variant: "cash", session: "s_attacker_123", email: "k@x.com", tools: ["cursor"] }));
  assertEquals(await other.json(), { ok: false });
  const mine = await t.h(post({ kind: "tools", variant: "cash", session: SESSION, email: "k@x.com", tools: ["claude-code", "cursor", "claude-code", "<script>"] }));
  assertEquals(await mine.json(), { ok: true });
  assertEquals(t.list.get("k@x.com")!.tools, ["claude-code", "cursor"]);
});

Deno.test("cleanUtm drops non-strings and caps length", () => {
  assertEquals(cleanUtm({ utm_source: "x".repeat(500), utm_medium: 5, gclid: " g " }), { utm_source: "x".repeat(200), gclid: "g" });
  assertEquals(cleanUtm(null), {});
});

Deno.test("a forged x-forwarded-for can't dodge the sign-up limit: Cloudflare's address wins", async () => {
  const t = mk();
  const req = (i: number) => new Request(URL_, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "5.5.5.5", "x-forwarded-for": `10.0.0.${i}` }, body: JSON.stringify({ kind: "signup", variant: "cash", session: SESSION, email: `p${i}@x.com` }) });
  for (let i = 0; i < 5; i++) assertEquals((await t.h(req(i))).status, 200);
  assertEquals((await t.h(req(99))).status, 429);
});
