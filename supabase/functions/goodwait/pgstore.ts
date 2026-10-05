// Postgres-backed Store. Tables live in the private impact_wait schema (not exposed via the REST API).
import postgres from "npm:postgres@3.4.5";
import type { AdRow, Impact, Store } from "./app.ts";

export function pgStore(dbUrl: string): Store {
  const sql = postgres(dbUrl, { max: 3, prepare: false, idle_timeout: 20 });
  return {
    async ensureSite(site, origin) {
      await sql`insert into impact_wait.sites (site_key, first_origin) values (${site}, ${origin || null}) on conflict (site_key) do nothing`;
      await sql`insert into impact_wait.site_totals (site_key) values (${site}) on conflict (site_key) do nothing`;
      const [r] = await sql`select active from impact_wait.sites where site_key = ${site}`;
      return !!(r && r.active);
    },
    async recentAds(ipHash, seconds) {
      const [r] = await sql`select count(*)::int as n from impact_wait.ads where ip_hash = ${ipHash} and created_at > now() - make_interval(secs => ${seconds})`;
      return r.n;
    },
    async insertAd(row) {
      const [r] = await sql`insert into impact_wait.ads (site_key, provider, live, tracking, click_url, ip_hash, origin)
        values (${row.site_key}, ${row.provider}, ${row.live}, ${sql.json(row.tracking as any)}, ${row.click_url || null}, ${row.ip_hash}, ${row.origin || null}) returning id`;
      return r.id;
    },
    async claimImpression(id, minAgeMs) {
      const rows = await sql`update impact_wait.ads set impression_at = now()
        where id = ${id} and impression_at is null
          and created_at < now() - make_interval(secs => ${minAgeMs / 1000})
          and created_at > now() - interval '15 minutes'
        returning *`;
      return (rows[0] as unknown as AdRow) || null;
    },
    async finishImpression(id, site, status, paid) {
      await sql`update impact_wait.ads set impression_confirm = ${status} where id = ${id}`;
      await sql`update impact_wait.site_totals set sponsored_waits = sponsored_waits + 1, paid_waits = paid_waits + ${paid ? 1 : 0}, updated_at = now() where site_key = ${site}`;
    },
    async claimClick(id) {
      const first = await sql`update impact_wait.ads set click_at = now() where id = ${id} and click_at is null and created_at > now() - interval '1 day' returning *`;
      if (first[0]) {
        await sql`update impact_wait.site_totals set clicks = clicks + 1, updated_at = now() where site_key = ${(first[0] as any).site_key}`;
        return { row: first[0] as unknown as AdRow, first: true };
      }
      const again = await sql`select * from impact_wait.ads where id = ${id} and created_at > now() - interval '1 day'`;
      return again[0] ? { row: again[0] as unknown as AdRow, first: false } : null;
    },
    async stats(site) {
      const [t] = await sql`select coalesce(sum(sponsored_waits),0)::bigint as sponsored_waits, coalesce(sum(paid_waits),0)::bigint as paid_waits, coalesce(sum(clicks),0)::bigint as clicks, count(*) filter (where sponsored_waits > 0)::int as sites from impact_wait.site_totals`;
      const lb = await sql`select t.site_key, s.name, t.sponsored_waits::bigint from impact_wait.site_totals t join impact_wait.sites s using (site_key) where s.active and t.sponsored_waits > 0 order by t.sponsored_waits desc limit 10`;
      let s = null;
      if (site) {
        const [r] = await sql`select t.site_key, s.name, t.sponsored_waits::bigint, t.paid_waits::bigint, t.clicks::bigint from impact_wait.site_totals t join impact_wait.sites s using (site_key) where t.site_key = ${site}`;
        if (r) s = { site_key: r.site_key, name: r.name, sponsored_waits: Number(r.sponsored_waits), paid_waits: Number(r.paid_waits), clicks: Number(r.clicks) };
      }
      const [imp] = await sql`select cause_name, cause_url, unit_label, usd_per_unit, pledge_pct, donated_usd, donated_updated_at from impact_wait.impact`;
      // Newest dashboard report per network, for this site or the whole account (site_key null).
      const earnings = site
        ? await sql`select distinct on (network, site_key) network, site_key, earned_usd::float8 as earned_usd, paid_waits, clicks, as_of, source
            from impact_wait.earnings where site_key = ${site} or site_key is null order by network, site_key, as_of desc`
        : [];
      return {
        total: { sponsored_waits: Number(t.sponsored_waits), paid_waits: Number(t.paid_waits), clicks: Number(t.clicks), sites: t.sites },
        site: s,
        leaderboard: lb.map((r: any) => ({ site_key: r.site_key, name: r.name, sponsored_waits: Number(r.sponsored_waits) })),
        impact: imp as unknown as Impact,
        earnings: earnings.map((r: any) => ({ network: r.network, site_key: r.site_key, earned_usd: Number(r.earned_usd), paid_waits: r.paid_waits, clicks: r.clicks, as_of: r.as_of, source: r.source })),
      };
    },
  };
}

// Network keys kept in Supabase Vault (names impact_wait_<network>_key). Edge Function secrets, when set, win.
export async function loadVaultKeys(dbUrl: string): Promise<Record<string, string>> {
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    const rows = await sql`select name, decrypted_secret from vault.decrypted_secrets where name in ('impact_wait_idlen_key', 'impact_wait_admesh_key', 'impact_wait_agentads_key')`;
    const out: Record<string, string> = {};
    for (const r of rows as any[]) if (r.decrypted_secret) out[String(r.name).replace(/^impact_wait_|_key$/g, "")] = String(r.decrypted_secret).trim();
    return out;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
