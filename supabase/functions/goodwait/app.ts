// Goodwait API. Routes (all under /functions/v1/goodwait):
//   POST /ad      {site, query, response?, sessionId?} -> {id, ad, impact} (ad null for earners when nothing paying fills)
//   POST /event   {id, type:"impression"}               -> {ok}
//   GET  /click?id=...                                   -> 302 to the advertiser
//   GET  /stats?site=...                                 -> public counter + leaderboard (+ actual earnings for the site)
//   GET  /health                                         -> which networks are configured
//   GET  /embed.js                                       -> the <good-wait> web component
// Earners (people paid a share of the ad revenue from their own waits):
//   POST /earner          {ref?}                         -> {earner_id, token} (token shown once; store it)
//   GET  /earner/me       Authorization: Bearer <token>  -> credited waits, owed and paid USD, program terms
//   POST /earner/payout   {email} + Bearer               -> sets the PayPal email payouts go to
//   POST /earner/exit     {exit: "cash"|"donate"} + Bearer -> where new earnings go by default
//   POST /earner/donate   {amount?} + Bearer             -> donates the balance (or part) to charity: water
//   GET  /ledger                                         -> public totals: credited, paid out, donated
//   POST /draw/free-entry {email}                        -> the no-purchase entry to the open draw
// Accounts (Vibedough web sign-in; Supabase Auth session in Authorization: Bearer <access token>):
//   POST /auth/email      {email}                        -> {ok} and a branded sign-in email (link + 6-digit code)
//   GET  /account/me                                     -> install code, installs, payout setup, earnings once payout-ready
//   POST /account/paypal  {email}                        -> where cash goes, for the account and every linked install
//   POST /account/w9      {legal_name, ..., tin, certify, signature} -> {ok, tin_last4}
//   POST /account/code    {}                             -> a fresh install code (the old one stops working)
//   POST /earner/link     {code} + earner Bearer         -> joins this install to the account that owns the code
//   POST /account/impression {network, request_id, ad_id?} -> {ok, counted, credited}: a view of an ad the web
//        chat fetched from Velocity in the browser (after firing Velocity's impression URL), credited to the account
//   POST /account/chat    {messages: [{role, content}]}  -> {reply} (503 until a model key is set)
// Referrals: POST /earner takes {invite: "<code>"}; the referrer earns 10% of the friend's share,
// paid out of the house half at settlement (see settle()). Never multi-level.
//   POST /impression/external {network, site, request_id, ad_id?, earner?} -> {ok, counted, credited}
//        A view of an ad the client fetched straight from a network that must be called from the
//        viewer's own device (Velocity): the client fires the network's impression URL itself and
//        reports it here once, keyed by the network's request id, so it counts and credits.
// /ad takes an optional {earner: token}; a paid, counted impression on that ad is credited
// to the earner, within the program's daily cap and minimum gap. Money is only ever owed
// from settled network revenue (see the settle() SQL function), never from estimates.
import { EMBED_JS } from "./embed.ts";
import { type Account, type AuthApi, type Install, installCommand, type Mailer, normalizeInstallCode, parseTaxForm, signInEmail, type TaxForm, type TaxFormSummary, welcomeEmail } from "./accounts.ts";
import type { ChatFn, ChatTurn } from "./chat.ts";
import { type Ad, type Attempt, confirmImpression, reportClick, runChain } from "./networks.ts";

export type AdRow = { id: string; site_key: string; provider: string; live: boolean; earner_id?: string | null; tracking: Record<string, unknown>; click_url: string | null; created_at: Date; impression_at: Date | null; click_at: Date | null };
export type Impact = { cause_name: string | null; cause_url: string | null; unit_label: string | null; usd_per_unit: number | null; pledge_pct: number | null; donated_usd: number; donated_updated_at: Date | null };
// Actual publisher earnings as a network's dashboard reported them (newest report per network).
export type Earning = { network: string; site_key: string | null; earned_usd: number; paid_waits: number | null; clicks: number | null; as_of: Date | string; source: string };
// Terms of the earner program, one row in the database.
export type Program = { user_share_pct: number; est_ecpm_usd: number | null; min_payout_usd: number; daily_cap: number; min_gap_seconds: number; max_earners_per_ip_day: number; referral_pct: number; hold_days: number;
  earnings_need_payout_info?: boolean; max_installs_per_account?: number };
export type EarnerSummary = { earner_id: string; status: string; credited_total: number; credited_today: number; pending_waits: number; owed_usd: number; paid_usd: number; payout_email: string | null; created_at: Date | string;
  balance_usd: number; credited_usd: number; donated_usd: number; referral_code: string; referrals: number; referral_earned_usd: number; auto_exit: "cash" | "donate"; first_credit_at: Date | string | null };
export type Ledger = { credited_to_users_usd: number; paid_out_usd: number; donated_usd: number; donation_pending_usd: number; people_paid: number; last_activity_at: Date | string | null };
export type Draw = { id: string; name: string; prize_usd: number; opens_at: Date | string; closes_at: Date | string; rules_url: string | null };
export interface Store {
  ensureSite(site: string, origin: string): Promise<boolean>;
  recentAds(ipHash: string, seconds: number): Promise<number>;
  insertAd(row: { site_key: string; provider: string; live: boolean; tracking: Record<string, unknown>; click_url: string; ip_hash: string; origin: string; earner_id?: string | null }): Promise<string>;
  // Atomic: marks the impression only if unmarked and at least minAgeMs old. Returns the row or null.
  claimImpression(id: string, minAgeMs: number): Promise<AdRow | null>;
  finishImpression(id: string, site: string, confirmStatus: number, paid: boolean): Promise<void>;
  claimClick(id: string): Promise<{ row: AdRow; first: boolean } | null>;
  // Records an already-seen impression of a client-fetched ad. Returns null when this
  // (provider, requestId) was reported before.
  insertExternalImpression(row: { site_key: string; provider: string; tracking: Record<string, unknown>; ip_hash: string; origin: string; earner_id: string | null }): Promise<string | null>;
  program(): Promise<Program>;
  earnersFromIp(ipHash: string, seconds: number): Promise<number>;
  createEarner(row: { token_hash: string; ip_hash: string; ref: string | null; referred_by: string | null }): Promise<{ id: string; referral_code: string }>;
  findReferrer(code: string): Promise<{ id: string; status: string; ip_hash: string | null } | null>;
  referralsSince(referrerId: string, seconds: number): Promise<number>;
  setAutoExit(earnerId: string, exit: "cash" | "donate"): Promise<void>;
  // Atomic against the balance: donates min(amount, balance) (all of it when amount is null). Returns what was donated.
  donate(earnerId: string, amount: number | null, cause: string): Promise<{ donated: number; balance: number }>;
  ledger(): Promise<Ledger>;
  openDraw(): Promise<Draw | null>;
  drawEntries(drawId: string, earnerId: string): Promise<number>;
  // "added", "already" (this email entered today) or "limited" (too many from this network today).
  addFreeEntry(drawId: string, email: string, ipHash: string): Promise<"added" | "already" | "limited">;
  findEarner(tokenHash: string): Promise<{ id: string; status: string } | null>;
  // Atomic: credits the ad to the earner only if it is not credited yet, the earner has fewer than
  // dailyCap credits in the last 24h and none in the last gapSeconds. Returns whether it credited.
  creditImpression(adId: string, earnerId: string, dailyCap: number, gapSeconds: number): Promise<boolean>;
  earnerSummary(earnerId: string): Promise<EarnerSummary | null>;
  setPayoutEmail(earnerId: string, email: string): Promise<void>;
  // Accounts. ensureAccount creates the row (and its install code) on the first call for a user.
  ensureAccount(row: { user_id: string; email: string; provider: string; source: Record<string, unknown> | null }): Promise<{ account: Account; created: boolean }>;
  // Atomic claim: true exactly once per account, so the welcome email goes out once.
  claimWelcome(accountId: string): Promise<boolean>;
  // Undoes the claim after a failed send, so the next visit tries again.
  releaseWelcome(accountId: string): Promise<void>;
  installs(accountId: string): Promise<Install[]>;
  taxForm(accountId: string): Promise<TaxFormSummary | null>;
  saveTaxForm(accountId: string, form: TaxForm, ipHash: string, userAgent: string): Promise<string>;
  // Sets the account's PayPal email and copies it to every linked install (payouts are per install).
  setAccountPaypal(accountId: string, email: string): Promise<void>;
  rotateInstallCode(accountId: string): Promise<string>;
  findAccountByCode(code: string): Promise<Account | null>;
  // "linked" (now or already, to this account), "other" (linked to another account) or "full".
  linkEarner(earnerId: string, accountId: string, maxInstalls: number): Promise<"linked" | "other" | "full">;
  earnerAccount(earnerId: string): Promise<string | null>;
  // The account's own earner for views in the web chat (created on first use; it has no token).
  webEarner(accountId: string, ipHash: string): Promise<string>;
  // Marks an install as alive (throttled in the store). Drives "installed" on the account page.
  touchEarner(earnerId: string): Promise<void>;
  // Web chat model spend (USD) since a moment, and one reply's usage.
  chatSpendSince(since: Date): Promise<number>;
  recordChatUsage(row: { account_id: string; model: string; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; cost_usd: number }): Promise<void>;
  rateCount(kind: string, key: string, seconds: number): Promise<number>;
  rateHit(kind: string, key: string): Promise<void>;
  stats(site: string | null): Promise<{ total: { sponsored_waits: number; paid_waits: number; clicks: number; sites: number }; site: null | { site_key: string; name: string | null; sponsored_waits: number; paid_waits: number; clicks: number }; leaderboard: { site_key: string; name: string | null; sponsored_waits: number }[]; impact: Impact; earnings?: Earning[] }>;
}
export type Keys = { idlen?: string; admesh?: string; agentads?: string };

const SITE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Networks whose ads the client fetches and whose impressions the client fires itself.
const EXTERNAL_NETWORKS = new Set(["velocity"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
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
const INVITE_RE = /^[a-z2-9]{8}$/;
const MAX_REFERRALS_PER_DAY = 25;
const CAUSE = "charity-water";
const CAUSE_NAME = "charity: water";
const money2 = (n: number) => Math.round(n * 100) / 100;
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
// A Supabase Auth access token (a JWT). Auth itself checks it; this only rejects obvious junk.
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
function sessionToken(req: Request): string {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return m && m[1].length < 8192 && JWT_RE.test(m[1]) ? m[1] : "";
}
// The Claude Code plugin's site key (its users are all earners).
const PLUGIN_SITE = "claude-code";
// The site key for views in the Vibedough web chat.
const WEB_SITE = "vibedough-app";
const SIGNIN_PER_EMAIL_HOUR = 5;
const SIGNIN_PER_NETWORK_HOUR = 20;
const LINK_FAILS_PER_HOUR = 10;
// An install counts as installed while it has been seen this recently.
const INSTALL_FRESH_DAYS = 30;
function bearer(req: Request): string {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return m && TOKEN_RE.test(m[1]) ? m[1] : "";
}
const money4 = (n: number) => Math.round(n * 10000) / 10000;
// The caller's real address. Cloudflare (in front of Supabase) sets cf-connecting-ip and overwrites any
// value a client sends; x-forwarded-for keeps whatever the client wrote first, so it is only a fallback.
// Every per-network guard (sign-up caps, referral same-network check, rate limits) depends on this.
export function clientIp(req: Request): string {
  const cf = (req.headers.get("cf-connecting-ip") || "").trim();
  if (cf) return cf;
  const real = (req.headers.get("x-real-ip") || "").trim();
  if (real) return real;
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

export function impactSummary(impact: Impact, totalWaits: number) {
  const units = impact.usd_per_unit && impact.usd_per_unit > 0 ? Math.floor(Number(impact.donated_usd) / Number(impact.usd_per_unit)) : null;
  return {
    cause_name: impact.cause_name, cause_url: impact.cause_url, unit_label: impact.unit_label,
    pledge_pct: impact.pledge_pct === null ? null : Number(impact.pledge_pct),
    donated_usd: Number(impact.donated_usd), units_funded: units,
    donated_updated_at: impact.donated_updated_at, sponsored_waits: totalWaits,
  };
}

export function createApp(opts: { store: Store; keys: Keys; baseUrl: string; salt: string; fetch?: typeof fetch; minImpressionMs?: number; rateLimitPerMin?: number; log?: (m: string) => void;
  auth?: AuthApi; mailer?: Mailer; appUrl?: string; chat?: ChatFn; chatEnabled?: () => boolean; chatPerDay?: number; chatMonthlyCapUsd?: number }) {
  const { store, keys, baseUrl, salt } = opts;
  const appUrl = opts.appUrl || "https://vibedough.com/app";
  const mailer: Mailer = opts.mailer || (async () => false);
  const chatPerDay = opts.chatPerDay ?? 50;

  const f = opts.fetch || fetch;
  const minMs = opts.minImpressionMs ?? 900;
  const rate = opts.rateLimitPerMin ?? 30;
  const log = opts.log || (() => {});
  // The chat stops for the rest of the calendar month (UTC) once its model spend reaches the cap.
  const chatCap = opts.chatMonthlyCapUsd ?? 200;
  let spend = { at: 0, month: "", usd: 0 };
  const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
  async function chatSpend(fresh = false) {
    const m = monthStart().toISOString();
    if (fresh || spend.month !== m || Date.now() - spend.at > 60_000) spend = { at: Date.now(), month: m, usd: await store.chatSpendSince(monthStart()) };
    return spend.usd;
  }
  const chatOpen = async () => !!opts.chat && (!opts.chatEnabled || opts.chatEnabled()) && (await chatSpend()) < chatCap;

  // One sponsored line: the network chain, then the ad row (credited later, at its impression).
  // paidOnly: people who are told they earn from views (earners, the Claude Code plugin) never get a
  // house ad; with no paying fill the answer is {ad: null} and nothing shows.
  async function serveAd(o: { site: string; query: string; response: string; sessionId: string; origin: string; ipHash: string; earnerId: string | null; sandbox: boolean; paidOnly: boolean; debug?: boolean }) {
    let host = "chat.example";
    try { if (o.origin) host = new URL(o.origin).host || host; } catch (_) { /* keep default */ }
    const ctx = { query: o.query, response: o.response, sessionId: o.sessionId, host };
    const { ad, attempts } = await runChain(ctx, o.sandbox ? {} : keys, f);
    if (o.paidOnly && !o.sandbox && !ad.live) {
      log(`ad site=${o.site} no paid fill (no house ad for earners) ${attempts.map((a: Attempt) => `${a.provider}:${a.result}`).join(" ")}`);
      return { id: null, ad: null, attempts: o.debug ? attempts : undefined };
    }
    const id = await store.insertAd({ site_key: o.sandbox ? SANDBOX_SITE : o.site, provider: ad.provider, live: ad.live, tracking: ad.tracking, click_url: ad.clickUrl, ip_hash: o.ipHash, origin: o.origin, earner_id: o.earnerId });
    const st = await store.stats(null);
    log(`ad site=${o.site}${o.sandbox ? " (sandbox)" : ""} provider=${ad.provider} ${attempts.map((a: Attempt) => `${a.provider}:${a.result}${a.note ? "(" + a.note + ")" : ""}`).join(" ")}`);
    return { id, ad: publicAd(ad, `${baseUrl}/click?id=${id}`), impact: impactSummary(st.impact, st.total.sponsored_waits), sandbox: o.sandbox || undefined, attempts: o.debug ? attempts : undefined };
  }

  // Counts (once per network request id) a view the client already reported to the network, and credits it.
  async function recordExternal(o: { site: string; network: string; requestId: string; adId: unknown; ipHash: string; origin: string; earnerId: string | null }) {
    const adId = typeof o.adId === "string" ? o.adId.slice(0, 128) : null;
    const id = await store.insertExternalImpression({ site_key: o.site, provider: o.network, tracking: { requestId: o.requestId, adId, clientReported: true }, ip_hash: o.ipHash, origin: o.origin, earner_id: o.earnerId });
    if (!id) return { ok: true, counted: false, duplicate: true };
    await store.finishImpression(id, o.site, 200, true);
    let credited = false;
    if (o.earnerId) {
      const p = await store.program();
      credited = await store.creditImpression(id, o.earnerId, p.daily_cap, p.min_gap_seconds);
    }
    log(`impression site=${o.site} provider=${o.network} client-reported${o.earnerId ? ` earner credited=${credited}` : ""}`);
    return { ok: true, counted: true, credited };
  }

  // The signed-in person's account, created on first sight. Sends the welcome email exactly once.
  async function signedIn(req: Request): Promise<{ account: Account } | Response> {
    if (!opts.auth) return json({ error: "accounts are not set up" }, 503);
    const t = sessionToken(req);
    if (!t) return json({ error: "sign in first" }, 401);
    const user = await opts.auth.getUser(t);
    if (!user || !user.email) return json({ error: "your session expired, sign in again" }, 401);
    const src = user.meta && typeof user.meta.source === "object" && user.meta.source ? user.meta.source as Record<string, unknown> : null;
    const { account, created } = await store.ensureAccount({ user_id: user.id, email: user.email.toLowerCase(), provider: user.provider || "email", source: src });
    if (created) log(`account created ${account.id} via ${user.provider || "email"}`);
    if (!account.welcome_sent_at && (await store.claimWelcome(account.id))) {
      const sent = await mailer(welcomeEmail(account.email, account.install_code, appUrl, installCommand(account.install_code))).catch(() => false);
      log(`welcome email ${sent ? "sent" : "FAILED, will retry on next visit"} ${account.id}`);
      if (!sent) await store.releaseWelcome(account.id);
    }
    return { account };
  }

  async function accountView(account: Account) {
    const [installs, tax, p] = await Promise.all([store.installs(account.id), store.taxForm(account.id), store.program()]);
    const fresh = Date.now() - INSTALL_FRESH_DAYS * 86400e3;
    // The web chat's own earner earns for the account but is not an install.
    const plugins = installs.filter((i) => i.kind === "install");
    const seen = plugins.map((i) => (i.last_seen_at ? new Date(i.last_seen_at as string).getTime() : 0));
    const lastSeen = seen.length ? Math.max(...seen) : 0;
    const payoutReady = !!account.paypal_email && !!tax;
    const gated = (p.earnings_need_payout_info ?? true) && !payoutReady;
    let earnings = null;
    if (!gated) {
      const sums = (await Promise.all(installs.map((i) => store.earnerSummary(i.earner_id)))).filter((x): x is EarnerSummary => !!x);
      const add = (k: keyof EarnerSummary) => money4(sums.reduce((s, x) => s + Number(x[k] || 0), 0));
      const ecpm = p.est_ecpm_usd === null ? null : Number(p.est_ecpm_usd);
      const pending = sums.reduce((s, x) => s + x.pending_waits, 0);
      earnings = {
        balance_usd: add("balance_usd"), credited_usd: add("credited_usd"), paid_usd: add("paid_usd"), donated_usd: add("donated_usd"),
        views_today: sums.reduce((s, x) => s + x.credited_today, 0), views_total: sums.reduce((s, x) => s + x.credited_total, 0), pending_views: pending,
        est_pending_usd: ecpm === null ? null : money4((pending / 1000) * ecpm * (Number(p.user_share_pct) / 100)),
        min_payout_usd: Number(p.min_payout_usd), share_pct: Number(p.user_share_pct),
      };
    }
    return {
      email: account.email, install_code: account.install_code, install_command: installCommand(account.install_code), created_at: account.created_at,
      installs: plugins.length, installed: lastSeen > fresh, last_seen_at: lastSeen ? new Date(lastSeen).toISOString() : null,
      paypal_email: maskEmail(account.paypal_email), w9: tax ? { on_file: true, tin_type: tax.tin_type, tin_last4: tax.tin_last4, signed_at: tax.signed_at } : { on_file: false },
      payout_ready: payoutReady, earnings_locked: gated, earnings,
      // An opaque id the web chat passes to ad networks as the publisher's user id (never the email).
      ad_user_id: await sha(`ad-user|${account.id}|${salt}`),
      // The web chat only asks for ads while it can answer: no sponsored line on a message that gets no reply.
      chat_open: await chatOpen(),
    };
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*\/goodwait/, "") || "/";
    const ip = clientIp(req);
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
        // An earner token that does not resolve to an active earner just means no credit; the ad still serves.
        let earnerId: string | null = null;
        if (!sandbox && typeof b.earner === "string" && TOKEN_RE.test(b.earner)) {
          const e = await store.findEarner(await tokenHash(b.earner));
          if (e && e.status === "active") earnerId = e.id;
        }
        if (earnerId) await store.touchEarner(earnerId);
        const paidOnly = typeof b.earner === "string" || site === PLUGIN_SITE;
        return json(await serveAd({ site, query, response: String(b.response || "").slice(0, 1500), sessionId: String(b.sessionId || crypto.randomUUID()).slice(0, 80), origin, ipHash, earnerId, sandbox, paidOnly, debug: !!b.debug }));
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

      if (route === "/impression/external" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const network = String(b.network || "");
        const site = String(b.site || "").toLowerCase();
        const requestId = String(b.request_id || "");
        if (!EXTERNAL_NETWORKS.has(network) || !SITE_RE.test(site) || !REQUEST_ID_RE.test(requestId)) return json({ error: "bad impression" }, 400);
        if (isDevOrigin(origin, site)) return json({ ok: true, counted: false, sandbox: true });
        if (!(await store.ensureSite(site, origin))) return json({ error: "site disabled" }, 403);
        if ((await store.recentAds(ipHash, 60)) >= rate) return json({ error: "rate limited" }, 429, { "Retry-After": "30" });
        let earnerId: string | null = null;
        if (typeof b.earner === "string" && TOKEN_RE.test(b.earner)) {
          const e = await store.findEarner(await tokenHash(b.earner));
          if (e && e.status === "active") earnerId = e.id;
        }
        if (earnerId) await store.touchEarner(earnerId);
        return json(await recordExternal({ site, network, requestId, adId: b.ad_id, ipHash, origin, earnerId }));
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
        // An invite only counts from someone else: an active referrer, not on this same network today,
        // with a daily cap so one person can't farm sign-ups. A bad invite never blocks the sign-up.
        let referredBy: string | null = null;
        if (typeof b.invite === "string" && INVITE_RE.test(b.invite.toLowerCase())) {
          const r = await store.findReferrer(b.invite.toLowerCase());
          if (r && r.status === "active" && r.ip_hash !== ipHash && (await store.referralsSince(r.id, 86400)) < MAX_REFERRALS_PER_DAY) referredBy = r.id;
        }
        const token = newToken();
        const made = await store.createEarner({ token_hash: await tokenHash(token), ip_hash: ipHash, ref, referred_by: referredBy });
        log(`earner created ${made.id}${ref ? " ref=" + ref : ""}${referredBy ? " invited" : ""}`);
        return json({ earner_id: made.id, token, share_pct: Number(p.user_share_pct), referral_code: made.referral_code, referred: !!referredBy }, 201);
      }

      if (route === "/earner/me" && req.method === "GET") {
        const token = bearer(req);
        if (!token) return json({ error: "earner token required" }, 401);
        const e = await store.findEarner(await tokenHash(token));
        if (!e) return json({ error: "unknown earner" }, 401);
        const [sum, p, draw, accountId] = await Promise.all([store.earnerSummary(e.id), store.program(), store.openDraw(), store.earnerAccount(e.id), store.touchEarner(e.id)]);
        if (!sum) return json({ error: "unknown earner" }, 401);
        const ecpm = p.est_ecpm_usd === null ? null : Number(p.est_ecpm_usd);
        const holdDays = Number(p.hold_days ?? 30);
        const holdFrom = [sum.created_at, sum.first_credit_at].filter(Boolean).map((d) => new Date(d as string).getTime());
        const holdUntil = holdFrom.length === 2 ? new Date(Math.max(...holdFrom) + holdDays * 86400e3).toISOString() : null;
        return json({
          ...sum,
          first_credit_at: undefined,
          account_linked: !!accountId,
          payout_email: maskEmail(sum.payout_email),
          owed_usd: money4(Number(sum.balance_usd)),
          balance_usd: money4(Number(sum.balance_usd)),
          credited_usd: money4(Number(sum.credited_usd)),
          paid_usd: money4(Number(sum.paid_usd)),
          donated_usd: money4(Number(sum.donated_usd)),
          referral_earned_usd: money4(Number(sum.referral_earned_usd)),
          cash_out_from: holdUntil,
          est_pending_usd: ecpm === null ? null : money4((sum.pending_waits / 1000) * ecpm * (Number(p.user_share_pct) / 100)),
          draw: draw ? { name: draw.name, prize_usd: Number(draw.prize_usd), closes_at: draw.closes_at, rules_url: draw.rules_url, entries: await store.drawEntries(draw.id, e.id) } : null,
          program: { share_pct: Number(p.user_share_pct), referral_pct: Number(p.referral_pct ?? 10), min_payout_usd: Number(p.min_payout_usd), hold_days: holdDays, daily_cap: p.daily_cap, min_gap_seconds: p.min_gap_seconds, est_ecpm_usd: ecpm },
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

      if (route === "/earner/exit" && req.method === "POST") {
        const token = bearer(req);
        if (!token) return json({ error: "earner token required" }, 401);
        const e = await store.findEarner(await tokenHash(token));
        if (!e) return json({ error: "unknown earner" }, 401);
        const b = await req.json().catch(() => ({}));
        if (b.exit !== "cash" && b.exit !== "donate") return json({ error: "exit must be cash or donate" }, 400);
        await store.setAutoExit(e.id, b.exit);
        return json({ ok: true, auto_exit: b.exit });
      }

      if (route === "/earner/donate" && req.method === "POST") {
        const token = bearer(req);
        if (!token) return json({ error: "earner token required" }, 401);
        const e = await store.findEarner(await tokenHash(token));
        if (!e || e.status !== "active") return json({ error: "unknown earner" }, 401);
        const b = await req.json().catch(() => ({}));
        let amount: number | null = null;
        if (b.amount !== undefined && b.amount !== null) {
          amount = Number(b.amount);
          if (!Number.isFinite(amount) || amount <= 0) return json({ error: "amount must be a positive number of dollars" }, 400);
          amount = Math.floor(amount * 10000) / 10000;
        }
        const r = await store.donate(e.id, amount, CAUSE);
        if (r.donated <= 0) return json({ error: "nothing to donate yet: your balance fills as ad revenue is settled", balance_usd: money4(r.balance) }, 409);
        log(`donation queued ${money4(r.donated)} to ${CAUSE}`);
        return json({ ok: true, donated_usd: money4(r.donated), balance_usd: money4(r.balance), cause: CAUSE_NAME });
      }

      if (route === "/ledger" && req.method === "GET") {
        const l = await store.ledger();
        return json({
          credited_to_users_usd: money2(Number(l.credited_to_users_usd)), paid_out_usd: money2(Number(l.paid_out_usd)),
          donated_usd: money2(Number(l.donated_usd)), donation_pending_usd: money2(Number(l.donation_pending_usd)),
          people_paid: Number(l.people_paid), last_activity_at: l.last_activity_at, cause: CAUSE_NAME,
        }, 200, { "Cache-Control": "public, max-age=60" });
      }

      if (route === "/draw/free-entry" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
        const d = await store.openDraw();
        if (!d) return json({ error: "There's no draw open right now." }, 409);
        const r = await store.addFreeEntry(d.id, email, ipHash);
        if (r === "limited") return json({ error: "Too many entries from this network today." }, 429);
        return json({ ok: true, entered: r === "added", already_today: r === "already", draw: d.name });
      }

      if (route === "/earner/link" && req.method === "POST") {
        const token = bearer(req);
        if (!token) return json({ error: "earner token required" }, 401);
        const e = await store.findEarner(await tokenHash(token));
        if (!e || e.status !== "active") return json({ error: "unknown earner" }, 401);
        if ((await store.rateCount("link_fail", ipHash, 3600)) >= LINK_FAILS_PER_HOUR) return json({ error: "too many tries, wait an hour" }, 429, { "Retry-After": "3600" });
        const b = await req.json().catch(() => ({}));
        const code = normalizeInstallCode(b.code);
        const acct = code ? await store.findAccountByCode(code) : null;
        if (!acct) {
          await store.rateHit("link_fail", ipHash);
          return json({ error: "that install code doesn't match an account. Copy it again from vibedough.com/app" }, 404);
        }
        const p = await store.program();
        const r = await store.linkEarner(e.id, acct.id, p.max_installs_per_account ?? 5);
        if (r === "other") return json({ error: "this install is already linked to a different account" }, 409);
        if (r === "full") return json({ error: `an account can link up to ${p.max_installs_per_account ?? 5} installs` }, 409);
        await store.touchEarner(e.id);
        log(`earner ${e.id} linked to account ${acct.id}`);
        return json({ ok: true, email: maskEmail(acct.email), paypal_email: maskEmail(acct.paypal_email) });
      }

      if (route === "/auth/email" && req.method === "POST") {
        if (!opts.auth) return json({ error: "accounts are not set up" }, 503);
        const b = await req.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
        const emailKey = await sha(`${email}|${salt}`);
        if ((await store.rateCount("signin_email", emailKey, 3600)) >= SIGNIN_PER_EMAIL_HOUR) return json({ error: "We've sent a few links already. Check your inbox (and spam), or try again in an hour." }, 429, { "Retry-After": "3600" });
        if ((await store.rateCount("signin_net", ipHash, 3600)) >= SIGNIN_PER_NETWORK_HOUR) return json({ error: "Too many sign-ins from this network. Try again in an hour." }, 429, { "Retry-After": "3600" });
        await Promise.all([store.rateHit("signin_email", emailKey), store.rateHit("signin_net", ipHash)]);
        const link = await opts.auth.signInLink(email);
        if (!link) return json({ error: "We couldn't send a link to that address. Check it and try again." }, 502);
        const url = `${appUrl}?th=${encodeURIComponent(link.tokenHash)}&tt=${encodeURIComponent(link.type)}`;
        const sent = await mailer(signInEmail(email, url, link.otp)).catch(() => false);
        log(`sign-in email ${sent ? "sent" : "FAILED"}`);
        if (!sent) return json({ error: "Our email didn't go out. Try again in a minute." }, 502);
        return json({ ok: true });
      }

      if (route === "/account/me" && req.method === "GET") {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        return json(await accountView(s.account), 200, { "Cache-Control": "no-store" });
      }

      if (route === "/account/paypal" && req.method === "POST") {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        const b = await req.json().catch(() => ({}));
        const email = String(b.email || "").trim().toLowerCase();
        if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter the email your PayPal account uses." }, 400);
        await store.setAccountPaypal(s.account.id, email);
        return json({ ok: true, paypal_email: maskEmail(email) });
      }

      if (route === "/account/w9" && req.method === "POST") {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        const b = await req.json().catch(() => ({}));
        const r = parseTaxForm(b && typeof b === "object" ? b : {});
        if ("error" in r) return json({ error: r.error }, 400);
        const last4 = await store.saveTaxForm(s.account.id, r.form, ipHash, (req.headers.get("user-agent") || "").slice(0, 300));
        log(`w9 saved for account ${s.account.id}`);
        return json({ ok: true, tin_type: r.form.tin_type, tin_last4: last4 });
      }

      if (route === "/account/impression" && req.method === "POST") {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        const b = await req.json().catch(() => ({}));
        const network = String(b.network || "");
        const requestId = String(b.request_id || "");
        if (!EXTERNAL_NETWORKS.has(network) || !REQUEST_ID_RE.test(requestId)) return json({ error: "bad impression" }, 400);
        if (isDevOrigin(origin, WEB_SITE)) return json({ ok: true, counted: false, sandbox: true });
        if (!(await store.ensureSite(WEB_SITE, origin))) return json({ error: "site disabled" }, 403);
        if ((await store.recentAds(ipHash, 60)) >= rate) return json({ error: "rate limited" }, 429, { "Retry-After": "30" });
        const earnerId = await store.webEarner(s.account.id, ipHash);
        return json(await recordExternal({ site: WEB_SITE, network, requestId, adId: b.ad_id, ipHash, origin, earnerId }));
      }

      if (route === "/account/chat" && req.method === "POST") {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        if (!opts.chat || !(await chatOpen())) {
          const capped = !!opts.chat && (!opts.chatEnabled || opts.chatEnabled());
          return json({ error: capped ? "Chat is paused until the 1st. Your earnings and installs keep working." : "Chat opens soon. Your account is ready; install on your computer to start earning now." }, 503);
        }
        const b = await req.json().catch(() => ({}));
        const raw = Array.isArray(b.messages) ? b.messages.slice(-20) : [];
        const turns: ChatTurn[] = raw.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
          .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
        while (turns.length && turns[0].role !== "user") turns.shift();
        if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "send a message" }, 400);
        if ((await store.rateCount("chat", s.account.id, 86400)) >= chatPerDay) return json({ error: `That's today's ${chatPerDay} messages. More tomorrow.` }, 429);
        await store.rateHit("chat", s.account.id);
        // Re-check against the database (not the 60s cache) right before spending.
        if ((await chatSpend(true)) >= chatCap) { log(`chat paused: month spend reached $${chatCap}`); return json({ error: "Chat is paused until the 1st. Your earnings and installs keep working." }, 503); }
        const r = await opts.chat(turns);
        if (r.usage) {
          await store.recordChatUsage({ account_id: s.account.id, ...r.usage }).catch((e) => log(`chat usage not recorded: ${(e as Error).message}`));
          spend.usd += r.usage.cost_usd;
        }
        if ("refused" in r) return json({ reply: "I can't help with that one. Try asking another way." });
        if ("error" in r) { log(`chat error ${r.error}`); return json({ error: "The chat is busy. Try again in a moment." }, 502); }
        return json({ reply: r.text });
      }

      if (route === "/account/code" && req.method === "POST") {
        const s = await signedIn(req);
        if (s instanceof Response) return s;
        const code = await store.rotateInstallCode(s.account.id);
        return json({ ok: true, install_code: code, install_command: installCommand(code) });
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
