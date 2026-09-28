import { assert, assertEquals } from "jsr:@std/assert@1";
import { createApp } from "../supabase/functions/impact-wait/app.ts";
import { memStore } from "./memstore.ts";

const BASE = "https://x.supabase.co/functions/v1/impact-wait";
const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

// Fetch stub: records every outbound call; networks respond per `fill`.
function stub(fill: { idlen?: boolean; admesh?: boolean; agentads?: boolean; idlenHouse?: boolean; slowAdmeshMs?: number }) {
  const calls: { url: string; body?: any; method: string }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, method: init?.method || "GET" });
    if (url.endsWith("/v1/serve")) {
      if (fill.idlenHouse) return ok({ success: true, ad: { ad_id: "house-welcome-offer", publisher_id: "house", title: "promo", cta_url: "https://idlen.io" } });
      return fill.idlen ? ok({ success: true, ad: { ad_id: "ad1", title: "Neon Postgres", body: "Scale to zero", cta_text: "Try", cta_url: "https://neon.tech/?x=1", advertiser_name: "Neon", impression_token: "tok1", publisher_id: "pub1", request_id: "req1" } }) : ok({ success: false });
    }
    if (url.endsWith("/v1/impression") || url.endsWith("/v1/click") || url.endsWith("/v1/events")) return ok({});
    if (url.endsWith("/aip/context")) {
      if (fill.slowAdmeshMs) await new Promise((r, rej) => { const t = setTimeout(r, fill.slowAdmeshMs); init?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }); });
      return fill.admesh ? ok({ status: "generated", recommendation: { disclosure: "Sponsored", creative: { brand_name: "HubSpot", headline: "HubSpot CRM", description: "Free CRM for small teams", cta_text: "Go" } }, tracking: { click_url: "https://api.useadmesh.com/click/r/1", exposure_url: "https://api.useadmesh.com/exposure?rid=1" } }) : ok({ status: "no_match" });
    }
    if (url.includes("/exposure")) return new Response(null, { status: 204 });
    if (url.endsWith("/v1/bid")) return fill.agentads ? ok({ filled: true, ad: { brand: "Linear", headline: "Plan sprints faster", description: "Issue tracking for software teams", cta: "Go", clickUrl: "https://linear.app/?ref=aa", trackingId: "t1" } }) : ok({ filled: false });
    throw new Error("unexpected fetch " + url);
  };
  return { f, calls };
}

function mk(fill: Parameters<typeof stub>[0], keys = { idlen: "idl_pk_x", admesh: "sk_x", agentads: "pub_x" }, extra: Record<string, unknown> = {}) {
  const store = memStore();
  const s = stub(fill);
  const app = createApp({ store, keys, baseUrl: BASE, salt: "t", fetch: s.f, ...extra });
  const call = (path: string, init?: RequestInit, ip = "1.1.1.1") => app(new Request(BASE + path, { ...init, headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: "https://chat.acme.dev", ...(init?.headers || {}) } }));
  const ad = (q: string, site = "demo", ip?: string) => call("/ad", { method: "POST", body: JSON.stringify({ site, query: q, debug: true }) }, ip);
  return { store, s, call, ad };
}

Deno.test("priority: Idlen wins when all three fill", async () => {
  const t = mk({ idlen: true, admesh: true, agentads: true });
  const j = await (await t.ad("best postgres host for a small saas")).json();
  assertEquals(j.ad.provider, "idlen");
  assertEquals(j.ad.clickUrl, `${BASE}/click?id=${j.id}`);
  assert(!("tracking" in j.ad), "tracking tokens must never reach the client");
  const serve = t.s.calls.find((c) => c.url.endsWith("/v1/serve"))!;
  assert(serve.body.context.topics.includes("postgres"));
});

Deno.test("priority: AdMesh beats AgentAds; house when nothing fills", async () => {
  let t = mk({ admesh: true, agentads: true });
  assertEquals((await (await t.ad("best crm")).json()).ad.provider, "admesh");
  t = mk({});
  const j = await (await t.ad("help me write an email")).json();
  assertEquals(j.ad.provider, "house");
  assertEquals(j.ad.brand, "Wispr Flow"); // keyword match
});

Deno.test("Idlen's own house promo counts as no fill", async () => {
  const t = mk({ idlenHouse: true });
  assertEquals((await (await t.ad("postgres")).json()).ad.provider, "house");
});

Deno.test("no keys: networks skipped, house ad served", async () => {
  const t = mk({ idlen: true }, {});
  const j = await (await t.ad("postgres")).json();
  assertEquals(j.ad.provider, "house");
  assertEquals(t.s.calls.length, 0);
  assert(j.attempts.every((a: any) => a.result === "skipped"));
});

Deno.test("impression: rejected before 900ms, counted once after, confirmed to the network", async () => {
  const t = mk({ idlen: true });
  const { id } = await (await t.ad("postgres")).json();
  const early = await (await t.call("/event", { method: "POST", body: JSON.stringify({ id, type: "impression" }) })).json();
  assertEquals(early.counted, false);
  t.store.age(id, 1000);
  const good = await (await t.call("/event", { method: "POST", body: JSON.stringify({ id, type: "impression" }) })).json();
  assertEquals(good.counted, true);
  const dup = await (await t.call("/event", { method: "POST", body: JSON.stringify({ id, type: "impression" }) })).json();
  assertEquals(dup.counted, false);
  const imps = t.s.calls.filter((c) => c.url.endsWith("/v1/impression"));
  assertEquals(imps.length, 1);
  assertEquals(imps[0].body, { impressionToken: "tok1", adId: "ad1", publisherId: "pub1" });
  const st = await (await t.call("/stats?site=demo")).json();
  assertEquals(st.total.sponsored_waits, 1);
  assertEquals(st.total.paid_waits, 1);
});

Deno.test("impression confirms: AdMesh GET exposure, AgentAds /v1/events", async () => {
  for (const [fill, match] of [[{ admesh: true }, "/exposure"], [{ agentads: true }, "/v1/events"]] as const) {
    const t = mk(fill);
    const { id } = await (await t.ad("crm")).json();
    t.store.age(id, 1000);
    await t.call("/event", { method: "POST", body: JSON.stringify({ id, type: "impression" }) });
    assertEquals(t.s.calls.filter((c) => c.url.includes(match)).length, 1, match);
  }
});

Deno.test("house impressions count as sponsored waits, not paid, and fire no network calls", async () => {
  const t = mk({});
  const { id } = await (await t.ad("meeting notes")).json();
  t.store.age(id, 1000);
  const before = t.s.calls.length;
  await t.call("/event", { method: "POST", body: JSON.stringify({ id, type: "impression" }) });
  assertEquals(t.s.calls.length, before);
  const st = await (await t.call("/stats")).json();
  assertEquals([st.total.sponsored_waits, st.total.paid_waits], [1, 0]);
});

Deno.test("click: 302 to advertiser, Idlen click reported once, counted once", async () => {
  const t = mk({ idlen: true });
  const { id } = await (await t.ad("postgres")).json();
  const r = await t.call(`/click?id=${id}`);
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("location"), "https://neon.tech/?x=1");
  await t.call(`/click?id=${id}`);
  assertEquals(t.s.calls.filter((c) => c.url.endsWith("/v1/click")).length, 1);
  assertEquals((await (await t.call("/stats")).json()).total.clicks, 1);
});

Deno.test("rate limit: 31st ad request in a minute from one IP gets 429", async () => {
  const t = mk({}, {});
  for (let i = 0; i < 30; i++) assertEquals((await t.ad("q")).status, 200);
  assertEquals((await t.ad("q")).status, 429);
  assertEquals((await t.ad("q", "demo", "2.2.2.2")).status, 200); // other users unaffected
});

Deno.test("validation: bad site key, missing query, bad event, unknown route", async () => {
  const t = mk({}, {});
  assertEquals((await t.ad("q", "Bad Site!")).status, 400);
  assertEquals((await t.call("/ad", { method: "POST", body: JSON.stringify({ site: "demo" }) })).status, 400);
  assertEquals((await t.call("/event", { method: "POST", body: JSON.stringify({ id: "x", type: "impression" }) })).status, 400);
  assertEquals((await t.call("/nope")).status, 404);
  assertEquals((await t.call("/ad", { method: "OPTIONS" })).status, 204);
});

Deno.test("new site keys auto-register and appear on the leaderboard", async () => {
  const t = mk({}, {});
  const { id } = await (await t.ad("q", "acme-school")).json();
  t.store.age(id, 1000);
  await t.call("/event", { method: "POST", body: JSON.stringify({ id, type: "impression" }) });
  const st = await (await t.call("/stats?site=acme-school")).json();
  assertEquals(st.site.sponsored_waits, 1);
  assertEquals(st.leaderboard[0].site_key, "acme-school");
});

Deno.test("impact: units funded come only from recorded donations", async () => {
  const { impactSummary } = await import("../supabase/functions/impact-wait/app.ts");
  const none = impactSummary({ cause_name: null, cause_url: null, unit_label: null, usd_per_unit: null, pledge_pct: null, donated_usd: 0, donated_updated_at: null }, 500);
  assertEquals(none.units_funded, null);
  const some = impactSummary({ cause_name: "Meals", cause_url: "https://x.org", unit_label: "meals", usd_per_unit: 0.1, pledge_pct: 50, donated_usd: 12.35, donated_updated_at: null }, 500);
  assertEquals(some.units_funded, 123);
});

Deno.test("deadline: a slow AdMesh auction never holds the wait line past ~2.8s", async () => {
  const t = mk({ admesh: true, slowAdmeshMs: 5000 });
  const t0 = Date.now();
  const j = await (await t.ad("crm")).json();
  const ms = Date.now() - t0;
  assert(ms >= 2700 && ms < 3300, `took ${ms}ms`);
  assertEquals(j.ad.provider, "house");
  assert(j.attempts.some((a: any) => a.provider === "admesh" && a.note === "timeout"), JSON.stringify(j.attempts));
});

Deno.test("deadline: AdMesh filling inside the deadline still wins over AgentAds", async () => {
  const t = mk({ admesh: true, agentads: true, slowAdmeshMs: 1500 });
  assertEquals((await (await t.ad("crm")).json()).ad.provider, "admesh");
});

Deno.test("deadline: fast Idlen is returned without waiting for a slow AdMesh", async () => {
  const t = mk({ idlen: true, admesh: true, slowAdmeshMs: 5000 });
  const t0 = Date.now();
  const j = await (await t.ad("postgres")).json();
  assertEquals(j.ad.provider, "idlen");
  assert(Date.now() - t0 < 3300);
});

Deno.test("sandbox: localhost origin gets a house ad, no paid network calls, nothing counted or registered", async () => {
  const t = mk({ idlen: true, admesh: true, agentads: true });
  const r = await t.call("/ad", { method: "POST", body: JSON.stringify({ site: "my-bot-vercel-app", query: "best crm" }), headers: { origin: "http://localhost:3000" } });
  const j = await r.json();
  assertEquals(j.sandbox, true);
  assertEquals(j.ad.provider, "house");
  assertEquals(t.s.calls.length, 0);
  assertEquals(t.store.sites.has("my-bot-vercel-app"), false);
  t.store.age(j.id, 1000);
  const ev = await (await t.call("/event", { method: "POST", body: JSON.stringify({ id: j.id, type: "impression" }) })).json();
  assertEquals([ev.counted, ev.sandbox], [false, true]);
  const click = await t.call(`/click?id=${j.id}`, { method: "GET" });
  assertEquals(click.status, 302);
  const st = await (await t.call("/stats")).json();
  assertEquals([st.total.sponsored_waits, st.total.clicks, st.leaderboard.length], [0, 0, 0]);
});

Deno.test("sandbox: site key 'localhost' and dev hosts (127.0.0.1, *.local) are sandboxed; real domains are not", async () => {
  const { isDevOrigin } = await import("../supabase/functions/impact-wait/app.ts");
  assert(isDevOrigin("", "localhost"));
  assert(isDevOrigin("http://127.0.0.1:5173", "x1"));
  assert(isDevOrigin("http://mybox.local:3000/chat", "x1"));
  assert(isDevOrigin("http://[::1]:3000", "x1"));
  assert(!isDevOrigin("https://chat.acme.dev", "acme"));
  assert(!isDevOrigin("https://localhost.evil.com", "acme"));
  assert(!isDevOrigin("", "acme"));
  const t = mk({ idlen: true });
  const j = await (await t.ad("best crm", "acme")).json();
  assertEquals([j.ad.provider, j.sandbox], ["idlen", undefined]);
});

Deno.test("embed.js: serves the web component as JavaScript", async () => {
  const t = mk({});
  const r = await t.call("/embed.js", { method: "GET" });
  assertEquals(r.status, 200);
  assert(r.headers.get("content-type")!.startsWith("application/javascript"));
  assert((await r.text()).includes('customElements.define("impact-wait"'));
});

Deno.test("brand safety: every paying ad shows (even thin creatives); only sensitive categories are blocked", async () => {
  const { safetyReason } = await import("../supabase/functions/impact-wait/networks.ts");
  const base = { provider: "idlen", live: true, label: "Sponsored", brand: "Neon", headline: "Serverless Postgres", body: "Scale to zero", cta: "Try", clickUrl: "https://neon.tech/?x=1", tracking: {} };
  assertEquals(safetyReason(base), null);
  assertEquals(safetyReason({ ...base, brand: "STUDENT", headline: "Just launched \u2014 built for developers", body: "See what's new and try it where you already work.", clickUrl: "https://www.linkedin.com/x" }), null);
  assertEquals(safetyReason({ ...base, brand: "Saadullah", headline: "ToolNest \u2013 Free Online Tools for Everyone", clickUrl: "https://freetoolnest.vercel.app/" }), null);
  assertEquals(safetyReason({ ...base, brand: "acme", headline: "boost your revenue" }), null);
  assertEquals(safetyReason({ ...base, headline: "Best online casino bonus" }), "sensitive category");
  assertEquals(safetyReason({ ...base, clickUrl: "https://vape-deals.shop/?cbd=1" }), "sensitive category");
  assertEquals(safetyReason({ ...base, clickUrl: "" }), "no https landing page");
});

Deno.test("brand safety: a sensitive Idlen fill loses to AdMesh, and alone falls back to the house ad; a thin Idlen fill still wins", async () => {
  const idlenAd = (title: string) => ({ success: true, ad: { ad_id: "x", title, body: "b", advertiser_name: "capilorix", cta_url: "https://capilorix.store/", impression_token: "t", publisher_id: "p", request_id: "r" } });
  const t = mk({ admesh: true });
  const base = t.s.f;
  let title = "Best online casino bonus";
  const f: typeof fetch = async (input, init) => String(input).endsWith("/v1/serve") ? new Response(JSON.stringify(idlenAd(title)), { headers: { "Content-Type": "application/json" } }) : base(input, init);
  const { createApp } = await import("../supabase/functions/impact-wait/app.ts");
  const ask = (keys: Record<string, string>, ip: string) => createApp({ store: t.store, keys, baseUrl: BASE, salt: "t", fetch: f })(new Request(BASE + "/ad", { method: "POST", headers: { "content-type": "application/json", origin: "https://chat.acme.dev", "x-forwarded-for": ip }, body: JSON.stringify({ site: "demo", query: "crm for startups", debug: true }) }));
  const j1 = await (await ask({ idlen: "idl_pk_x", admesh: "sk_x" }, "8.8.8.8")).json();
  assertEquals(j1.ad.provider, "admesh");
  assert(j1.attempts.some((a: any) => a.provider === "idlen" && a.result === "filtered" && a.note === "sensitive category"));
  const j2 = await (await ask({ idlen: "idl_pk_x" }, "9.9.9.9")).json();
  assertEquals(j2.ad.provider, "house");
  title = "Just launched \u2014 built for developers";
  const j3 = await (await ask({ idlen: "idl_pk_x", admesh: "sk_x" }, "7.7.7.7")).json();
  assertEquals(j3.ad.provider, "idlen");
});
