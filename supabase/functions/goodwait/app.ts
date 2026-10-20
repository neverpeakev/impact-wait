// Goodwait API. Routes (all under /functions/v1/goodwait):
//   POST /ad      {site, query, response?, sessionId?} -> {id, ad, impact}
//   POST /event   {id, type:"impression"}               -> {ok}
//   GET  /click?id=...                                   -> 302 to the advertiser
//   GET  /stats?site=...                                 -> public counter + leaderboard (+ actual earnings for the site)
//   GET  /health                                         -> which networks are configured
//   GET  /embed.js                                       -> the <good-wait> web component
// Earners (people paid a share of the ad revenue from their own waits):
//   POST /earner          {ref?}                         -> {earner_id, token} (token shown once; store it)
//   GET  /earner/me       Authorization: Bearer <token>  -> credited waits, owed and paid USD, program terms
//   POST /earner/payout   {email} + Bearer               -> sets the PayPal email payouts go to
// /ad takes an optional {earner: token}; a paid, counted impression on that ad is credited
// to the earner, within the program's daily cap and minimum gap. Money is only ever owed
// from settled network revenue (see the settle() SQL function), never from estimates.
import { EMBED_JS } from "./embed.ts";
import { type Ad, type Attempt, confirmImpression, reportClick, runChain } from "./networks.ts";

export type AdRow = { id: string; site_key: string; provider: string; live: boolean; earner_id?: string | null; tracking: Record<string, unknown>; click_url: string | null; created_at: Date; impression_at: Date | null; click_at: Date | null };
export type Impact = { cause_name: string | null; cause_url: string | null; unit_label: string | null; usd_per_unit: number | null; pledge_pct: number | null; donated_usd: number; donated_updated_at: Date | null };
// Actual publisher earnings as a network's dashboard reported them (newest report per network).
export type Earning = { network: string; site_key: string | null; earned_usd: number; paid_waits: number | null; clicks: number | null; as_of: Date | string; source: string };
// Terms of the earner program, one row in the database.
export type Program = { user_share_pct: number; est_ecpm_usd: number | null; min_payout_usd: number; daily_cap: number; min_gap_seconds: number; max_earners_per_ip_day: number };
export type EarnerSummary = { earner_id: string; status: string; credited_total: number; credited_today: number; pending_waits: number; owed_usd: number; paid_usd: number; payout_email: string | null; created_at: Date | string };
export interface Store {
  ensureSite(site: string, origin: string): Promise<boolean>;
  recentAds(ipHash: string, seconds: number): Promise<number>;
  insertAd(row: { site_key: string; provider: string; live: boolean; tracking: Record<string, unknown>; click_url: string; ip_hash: string; origin: string; earner_id?: string | null }): Promise<string>;
  // Atomic: marks the impression only if unmarked and at least minAgeMs old. Returns the row or null.
  claimImpression(id: string, minAgeMs: number): Promise<AdRow | null>;
  finishImpression(id: string, site: string, confirmStatus: number, paid: boolean): Promise<void>;
  claimClick(id: string): Promise<{ row: AdRow; first: boolean } | null>;
  program(): Promise<Program>;
  earnersFromIp(ipHash: string, seconds: number): Promise<number>;
  createEarner(row: { token_hash: string; ip_hash: string; ref: string | null }): Promise<string>;
  findEarner(tokenHash: string): Promise<{ id: string; status: string } | null>;
  // Atomic: credits the ad to the earner only if it is not credited yet, the earner has fewer than
  // dailyCap credits in the last 24h and none in the last gapSeconds. Returns whether it credited.
  creditImpression(adId: string, earnerId: string, dailyCap: number, gapSeconds: number): Promise<boolean>;
  earnerSummary(earnerId: string): Promise<EarnerSummary | null>;
  setPayoutEmail(earnerId: string, email: string): Promise<void>;
  stats(site: string | null): Promise<{ total: { sponsored_waits: number; paid_waits: number; clicks: number; sites: number }; site: null | { site_key: string; name: string | null; sponsored_waits: number; paid_waits: number; clicks: number }; leaderboard: { site_key: string; name: string | null; sponsored_waits: number }[]; impact: Impact; earnings?: Earning[] }>;
}
export type Keys = { idlen?: string; admesh?: string; agentads?: string };

const SITE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Local development never touches paid networks or the public counter.
export const SANDBOX_SITE = "sandbox";
const DEV_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+\.(?:local|localhost|internal))$/i;
export function isDevOrigin(origin: string, site: string): boolean {
  if (site === "localhost" || site === SANDBOX_SITE) return true;
  if (!origin) return false;
  try { return DEV_HOST_RE.test(new URL(origin).hostname); } catch (_) { return false; }
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Earner tokens carry 256 random bits, so a plain SHA-256 is the right hash: no salt to lose.
async function tokenHash(token: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const TOKEN_RE = /^gw_[0-9a-f]{64}$/;
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "gw_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,185}\.[a-z]{2,24}$/i;
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}
function bearer(req: Request): string {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return m && TOKEN_RE.test(m[1]) ? m[1] : "";
}
const money4 = (n: number) => Math.round(n * 10000) / 10000;

export function impactSummary(impact: Impact, totalWaits: number) {
  const units = impact.usd_per_unit && impact.usd_per_unit > 0 ? Math.floor(Number(impact.donated_usd) / Number(impact.usd_per_unit)) : null;
  return {
    cause_name: impact.cause_name, cause_url: impact.cause_url, unit_label: impact.unit_label,
    pledge_pct: impact.pledge_pct === null ? null : Number(impact.pledge_pct),
    donated_usd: Number(impact.donated_usd), units_funded: units,
    donated_updated_at: impact.donated_updated_at, sponsored_waits: totalWaits,
  };
}

export function createApp(opts: { store: Store; keys: Keys; baseUrl: string; salt: string; fetch?: typeof fetch; minImpressionMs?: number; rateLimitPerMin?: number; log?: (m: string) => void }) {
  const { store, keys, baseUrl, salt } = opts;
  const f = opts.fetch || fetch;
  const minMs = opts.minImpressionMs ?? 900;
  const rate = opts.rateLimitPerMin ?? 30;
  const log = opts.log || (() => {});

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/goodwait/, "") || "/";
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const ipHash = await sha(`${ip}|${new Date().toISOString().slice(0, 10)}|${salt}`);
    const origin = (req.headers.get("origin") || req.headers.get("referer") || "").slice(0, 200);
    try {
      if (route === "/embed.js" && req.method === "GET") {
        return new Response(EMBED_JS, { status: 200, headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", ...CORS } });
      }

      if (route === "/health" && req.method === "GET") {
        return json({ ok: true, networks: { idlen: !!keys.idlen, admesh: !!keys.admesh, agentads: !!keys.agentads } });
      }

      if (route === "/ad" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const site = String(b.site || "").toLowerCase();
        if (!SITE_RE.test(site)) return json({ error: "site must be 2-41 chars: a-z, 0-9, dash" }, 400);
        const query = String(b.query || "").slice(0, 2000).trim();
        if (!query) return json({ error: "query required" }, 400);
        const sandbox = isDevOrigin(origin, site);
        if (!sandbox && !(await store.ensureSite(site, origin))) return json({ error: "site disabled" }, 403);
        if ((await store.recentAds(ipHash, 60)) >= rate) return json({ error: "rate limited" }, 429, { "Retry-After": "30" });
        let host = "chat.example";
        try { if (origin) host = new URL(origin).host || host; } catch (_) { /* keep default */ }
        const ctx = { query, response: String(b.response || "").slice(0, 1500), sessionId: String(b.sessionId || crypto.randomUUID()).slice(0, 80), host };
        const { ad, attempts } = await runChain(ctx, sandbox ? {} : keys, f);
        // An earner token that does not resolve to an active earner just means no credit; the ad still serves.
        let earnerId: string | null = null;
        if (!sandbox && typeof b.earner === "string" && TOKEN_RE.test(b.earner)) {
          const e = await store.findEarner(await tokenHash(b.earner));
          if (e && e.status === "active") earnerId = e.id;
        }
        const id = await store.insertAd({ site_key: sandbox ? SANDBOX_SITE : site, provider: ad.provider, live: ad.live, tracking: ad.tracking, click_url: ad.clickUrl, ip_hash: ipHash, origin, earner_id: earnerId });
        const st = await store.stats(null);
        log(`ad site=${site}${sandbox ? " (sandbox)" : ""} provider=${ad.provider} ${attempts.map((a: Attempt) => `${a.provider}:${a.result}${a.note ? "(" + a.note + ")" : ""}`).join(" ")}`);
        return json({ id, ad: publicAd(ad, `${baseUrl}/click?id=${id}`), impact: impactSummary(st.impact, st.total.sponsored_waits), sandbox: sandbox || undefined, attempts: b.debug ? attempts : undefined });
      }

      if (route === "/event" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const id = String(b.id || "");
        if (!/^[0-9a-f-]{36}$/i.test(id) || b.type !== "impression") return json({ error: "bad event" }, 400);
        const row = await store.claimImpression(id, minMs);
        if (!row) return json({ ok: true, counted: false }); // duplicate, too early, expired or unknown
        if (row.site_key === SANDBOX_SITE) return json({ ok: true, counted: false, sandbox: true });
        let status = 0;
        if (row.live) {
          try { status = await confirmImpression(row.provider, row.tracking as Record<string, unknown>, keys, f); } catch (_) { status = -1; }
        }
        const paid = row.live && status >= 200 && status < 400;
        await store.finishImpression(id, row.site_key, status, paid);
        let credited = false;
        if (paid && row.earner_id) {
          const p = await store.program();
          credited = await store.creditImpression(id, row.earner_id, p.daily_cap, p.min_gap_seconds);
        }
        log(`impression site=${row.site_key} provider=${row.provider} confirm=${status}${row.earner_id ? ` earner credited=${credited}` : ""}`);
        return json({ ok: true, counted: true, credited });
      }

      if (route === "/click" && req.method === "GET") {
        const id = url.searchParams.get("id") || "";
        if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400);
        const c = await store.claimClick(id);
        if (!c || !c.row.click_url || !/^https:\/\//i.test(c.row.click_url)) return json({ error: "unknown ad" }, 404);
        if (c.first) { try { await reportClick(c.row.provider, c.row.tracking as Record<string, unknown>, f); } catch (_) { /* best effort */ } }
        return new Response(null, { status: 302, headers: { Location: c.row.click_url, "Cache-Control": "no-store", ...CORS } });
      }

      if (route === "/earner" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const ref = typeof b.ref === "string" && SITE_RE.test(b.ref.toLowerCase()) ? b.ref.toLowerCase() : null;
        const p = await store.program();
        if ((await store.earnersFromIp(ipHash, 86400)) >= p.max_earners_per_ip_day) return json({ error: "too many sign-ups from this network today" }, 429, { "Retry-After": "3600" });
        const token = newToken();
        const earner_id = await store.createEarner({ token_hash: await tokenHash(token), ip_hash: ipHash, ref });
        log(`earner created ${earner_id}${ref ? " ref=" + ref : ""}`);
        return json({ earner_id, token, share_pct: Number(p.user_share_pct) }, 201);
      }

      if (route === "/earner/me" && req.method === "GET") {
        const token = bearer(req);
        if (!token) return json({ error: "earner token required" }, 401);
        const e = await store.findEarner(await tokenHash(token));
        if (!e) return json({ error: "unknown earner" }, 401);
        const [sum, p] = await Promise.all([store.earnerSummary(e.id), store.program()]);
        if (!sum) return json({ error: "unknown earner" }, 401);
        const ecpm = p.est_ecpm_usd === null ? null : Number(p.est_ecpm_usd);
        return json({
          ...sum,
          payout_email: maskEmail(sum.payout_email),
          owed_usd: money4(Number(sum.owed_usd)),
          paid_usd: money4(Number(sum.paid_usd)),
          est_pending_usd: ecpm === null ? null : money4((sum.pending_waits / 1000) * ecpm * (Number(p.user_share_pct) / 100)),
          program: { share_pct: Number(p.user_share_pct), min_payout_usd: Number(p.min_payout_usd), daily_cap: p.daily_cap, min_gap_seconds: p.min_gap_seconds, est_ecpm_usd: ecpm },
        }, 200, { "Cache-Control": "no-store" });
      }

      if (route === "/earner/payout" && req.method === "POST") {
        const token = bearer(req);
        if (!token) return json({ error: "earner token required" }, 401);
        const e = await store.findEarner(await tokenHash(token));
        if (!e) return json({ error: "unknown earner" }, 401);
        const b = await req.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "a valid PayPal email is required" }, 400);
        await store.setPayoutEmail(e.id, email);
        return json({ ok: true, payout_email: maskEmail(email) });
      }

      if (route === "/stats" && req.method === "GET") {
        const site = (url.searchParams.get("site") || "").toLowerCase();
        const st = await store.stats(SITE_RE.test(site) ? site : null);
        return json({ total: st.total, site: st.site, leaderboard: st.leaderboard, impact: impactSummary(st.impact, st.total.sponsored_waits), earnings: st.earnings ?? [] }, 200, { "Cache-Control": "public, max-age=15" });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      log(`error ${route}: ${(e as Error).message}`);
      return json({ error: "server error" }, 500);
    }
  };
}

function publicAd(ad: Ad, clickUrl: string) {
  return { provider: ad.provider, sponsored: true, label: ad.label, brand: ad.brand, headline: ad.headline, body: ad.body, cta: ad.cta, clickUrl, favicon: ad.favicon || "" };
}
