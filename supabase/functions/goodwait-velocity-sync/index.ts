import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
import { createSync, type SyncDb } from "./sync.ts";

// Called by pg_cron (job goodwait-velocity-sync) with the Vault cron key. See sync.ts.
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false, idle_timeout: 20 });

const db: SyncDb = {
  async secrets() {
    const rows = await sql`select name, decrypted_secret from vault.decrypted_secrets
      where name in ('impact_wait_cron_key', 'impact_wait_velocity_client_id', 'impact_wait_velocity_client_secret')`;
    const v: Record<string, string> = {};
    for (const r of rows as any[]) v[r.name] = String(r.decrypted_secret || "").trim();
    return { cronKey: v.impact_wait_cron_key || "", clientId: v.impact_wait_velocity_client_id || "", clientSecret: v.impact_wait_velocity_client_secret || "" };
  },
  async upsertDaily(rows) {
    if (!rows.length) return;
    await sql`insert into impact_wait.velocity_daily ${sql(rows.map((r) => ({ ...r, pulled_at: new Date() })), "report_date", "ad_unit_key", "ad_unit_name", "revenue", "impressions", "clicks", "pulled_at")}
      on conflict (report_date, ad_unit_key) do update set ad_unit_name = excluded.ad_unit_name, revenue = excluded.revenue,
        impressions = excluded.impressions, clicks = excluded.clicks, pulled_at = excluded.pulled_at`;
  },
  async totals(units) {
    const [r] = await sql`select coalesce(sum(revenue), 0)::float8 as revenue, coalesce(sum(impressions), 0)::int as impressions, coalesce(sum(clicks), 0)::int as clicks
      from impact_wait.velocity_daily where ad_unit_key = any(${units})`;
    return { revenue: Number(r.revenue), impressions: Number(r.impressions), clicks: Number(r.clicks) };
  },
  async lastEarning(network, siteKey) {
    const [r] = await sql`select earned_usd::float8 as earned_usd, paid_waits from impact_wait.earnings
      where network = ${network} and site_key = ${siteKey} order by as_of desc, created_at desc limit 1`;
    return r ? { earned_usd: Number(r.earned_usd), paid_waits: r.paid_waits } : null;
  },
  async insertEarning(row) {
    await sql`insert into impact_wait.earnings (network, site_key, earned_usd, paid_waits, clicks, as_of, source, note)
      values (${row.network}, ${row.site_key}, ${row.earned_usd}, ${row.paid_waits}, ${row.clicks}, ${row.as_of}, ${row.source}, ${row.note})`;
  },
  async logRun(row) {
    await sql`insert into impact_wait.sync_runs (job, ok, rows, note) values ('velocity', ${row.ok}, ${row.rows}, ${row.note})`;
  },
};

Deno.serve(createSync({ db, log: (m) => console.log(m) }));
