// Pulls Velocity's reporting (what Velocity says the account earned, per day and ad unit)
// into impact_wait.velocity_daily, and records Goodwait's own running total as an actual in
// impact_wait.earnings, which /stats and the mod show.
//
// Security:
// - Not callable by the public: every request must carry the cron key from Vault in the
//   x-goodwait-cron header, compared in constant time. Anything else gets a bare 404.
// - Velocity's client id/secret live only in Vault and are read per run; they, the access
//   token and the cron key are never logged, returned or stored anywhere else.
// - The only input is an optional {days} lookback, clamped to 1-31.

export type DailyRow = { report_date: string; ad_unit_key: string; ad_unit_name: string | null; revenue: number; impressions: number; clicks: number };
export type Totals = { revenue: number; impressions: number; clicks: number };
export interface SyncDb {
  secrets(): Promise<{ cronKey: string; clientId: string; clientSecret: string }>;
  upsertDaily(rows: DailyRow[]): Promise<void>;
  // Lifetime totals for these ad units, from velocity_daily.
  totals(units: string[]): Promise<Totals>;
  // The newest recorded actual for this network and site, or null.
  lastEarning(network: string, siteKey: string): Promise<{ earned_usd: number; paid_waits: number | null } | null>;
  insertEarning(row: { network: string; site_key: string; earned_usd: number; paid_waits: number; clicks: number; as_of: string; source: string; note: string }): Promise<void>;
  logRun(row: { ok: boolean; rows: number; note: string }): Promise<void>;
}

export const VELOCITY_API = "https://dashboard.velocity.io/api/public/v1";
// Goodwait's Velocity ad units and the site key their earnings show under.
export const GOODWAIT_UNITS = ["e7b24fe95681"];
export const GOODWAIT_SITE = "claude-code";

const notFound = () => new Response("Not Found", { status: 404 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Constant-time string compare (lengths are not secret: the key is a fixed 64 hex chars).
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function createSync(opts: { db: SyncDb; fetch?: typeof fetch; now?: () => Date; log?: (m: string) => void }) {
  const { db } = opts;
  const f = opts.fetch || fetch;
  const now = opts.now || (() => new Date());
  const log = opts.log || (() => {});

  async function timed(url: string, init: RequestInit, ms = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await f(url, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); }
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return notFound();
    let s: Awaited<ReturnType<SyncDb["secrets"]>>;
    try { s = await db.secrets(); } catch (_) { return json({ ok: false, error: "unavailable" }, 503); }
    if (!s.cronKey || !safeEqual(req.headers.get("x-goodwait-cron") || "", s.cronKey)) return notFound();
    if (!s.clientId || !s.clientSecret) { await db.logRun({ ok: false, rows: 0, note: "velocity credentials missing" }); return json({ ok: false, error: "not configured" }, 503); }

    const b = await req.json().catch(() => ({}));
    const days = Math.min(31, Math.max(1, Math.floor(num(b?.days) || 7)));
    const to = now();
    const from = new Date(to.getTime() - days * 86400000);

    try {
      const tr = await timed(`${VELOCITY_API}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: s.clientId, client_secret: s.clientSecret }) });
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || typeof tj.access_token !== "string") throw new Error(`token HTTP ${tr.status}`);
      const auth = { Authorization: `Bearer ${tj.access_token}` };

      const rows: DailyRow[] = [];
      let lastUpdated = "";
      for (let page = 1; page <= 50; page++) {
        const qs = new URLSearchParams({ dateFrom: isoDay(from), dateTo: isoDay(to), breakBy: "date,ad_unit", metrics: "revenue,impressions,clicks", page: String(page), perPage: "100" });
        const r = await timed(`${VELOCITY_API}/reporting?${qs}`, { headers: auth });
        if (!r.ok) throw new Error(`reporting HTTP ${r.status}`);
        const j = await r.json().catch(() => null);
        if (!j || !Array.isArray(j.items)) throw new Error("reporting: unexpected body");
        if (typeof j.dataLastUpdatedAt === "string") lastUpdated = j.dataLastUpdatedAt;
        for (const it of j.items) {
          const date = String(it.date || ""), unit = String(it.ad_unit_key || "");
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[A-Za-z0-9_-]{1,64}$/.test(unit)) continue;
          rows.push({ report_date: date, ad_unit_key: unit, ad_unit_name: it.ad_unit_name ? String(it.ad_unit_name).slice(0, 200) : null, revenue: num(it.revenue), impressions: Math.round(num(it.impressions)), clicks: Math.round(num(it.clicks)) });
        }
        const total = num(j.total), per = num(j.perPage) || 100;
        if (page * per >= total || j.items.length === 0) break;
      }

      await db.upsertDaily(rows);
      const t = await db.totals(GOODWAIT_UNITS);
      const last = await db.lastEarning("velocity", GOODWAIT_SITE);
      const changed = !last || Math.abs(Number(last.earned_usd) - t.revenue) > 1e-9 || Number(last.paid_waits ?? -1) !== t.impressions;
      // A first actual is only worth recording once there is Goodwait traffic.
      const wrote = changed && (!!last || t.impressions > 0 || t.revenue > 0);
      if (wrote) {
        await db.insertEarning({ network: "velocity", site_key: GOODWAIT_SITE, earned_usd: Math.round(t.revenue * 1e6) / 1e6, paid_waits: t.impressions, clicks: t.clicks, as_of: lastUpdated || to.toISOString(), source: "velocity-api", note: `units ${GOODWAIT_UNITS.join(",")}, lifetime` });
      }
      await db.logRun({ ok: true, rows: rows.length, note: `${isoDay(from)}..${isoDay(to)}${wrote ? " earnings updated" : ""}` });
      log(`velocity sync ok rows=${rows.length} goodwait_impressions=${t.impressions}`);
      return json({ ok: true, rows: rows.length, goodwait: t, earnings_updated: wrote });
    } catch (e) {
      const note = (e as Error).name === "AbortError" ? "velocity timeout" : String((e as Error).message || e).slice(0, 120);
      await db.logRun({ ok: false, rows: 0, note }).catch(() => {});
      log(`velocity sync failed: ${note}`);
      return json({ ok: false, error: "sync failed" }, 502);
    }
  };
}
