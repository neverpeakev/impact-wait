// Postgres-backed Store. Tables live in the private impact_wait schema (not exposed via the REST API).
import postgres from "npm:postgres@3.4.5";
import type { AdRow, EarnerSummary, Impact, Program, Store } from "./app.ts";

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
      const [r] = await sql`insert into impact_wait.ads (site_key, provider, live, tracking, click_url, ip_hash, origin, earner_id)
        values (${row.site_key}, ${row.provider}, ${row.live}, ${sql.json(row.tracking as any)}, ${row.click_url || null}, ${row.ip_hash}, ${row.origin || null}, ${row.earner_id || null}) returning id`;
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
    async insertExternalImpression(row) {
      const rows = await sql`insert into impact_wait.ads (site_key, provider, live, tracking, click_url, ip_hash, origin, earner_id, impression_at)
        values (${row.site_key}, ${row.provider}, true, ${sql.json(row.tracking as any)}, null, ${row.ip_hash}, ${row.origin || null}, ${row.earner_id}, now())
        on conflict do nothing returning id`;
      return rows[0] ? rows[0].id : null;
    },
    async program() {
      const [r] = await sql`select user_share_pct::float8 as user_share_pct, est_ecpm_usd::float8 as est_ecpm_usd, min_payout_usd::float8 as min_payout_usd,
        daily_cap, min_gap_seconds, max_earners_per_ip_day from impact_wait.program where id = 1`;
      return r as unknown as Program;
    },
    async earnersFromIp(ipHash, seconds) {
      const [r] = await sql`select count(*)::int as n from impact_wait.earners where ip_hash = ${ipHash} and created_at > now() - make_interval(secs => ${seconds})`;
      return r.n;
    },
    async createEarner(row) {
      const [r] = await sql`insert into impact_wait.earners (token_hash, ip_hash, ref) values (${row.token_hash}, ${row.ip_hash}, ${row.ref}) returning id`;
      return r.id;
    },
    async findEarner(tokenHash) {
      const [r] = await sql`select id, status from impact_wait.earners where token_hash = ${tokenHash}`;
      return r ? { id: r.id, status: r.status } : null;
    },
    async creditImpression(adId, earnerId, dailyCap, gapSeconds) {
      // One earner's credits are serialized by an advisory lock, so two impressions landing
      // together cannot both slip under the cap or the gap.
      return await sql.begin(async (tx: any) => {
        await tx`select pg_advisory_xact_lock(hashtext(${earnerId}::text))`;
        const [w] = await tx`select count(*) filter (where impression_at > now() - interval '24 hours')::int as today,
            max(impression_at) as last from impact_wait.ads where earner_id = ${earnerId} and credited`;
        if (w.today >= dailyCap) return false;
        if (w.last && new Date(w.last).getTime() > Date.now() - gapSeconds * 1000) return false;
        const rows = await tx`update impact_wait.ads set credited = true where id = ${adId} and earner_id = ${earnerId} and not credited returning id`;
        return rows.length === 1;
      });
    },
    async earnerSummary(earnerId) {
      const [r] = await sql`select e.id as earner_id, e.status, e.payout_email, e.created_at,
          (select count(*)::int from impact_wait.ads a where a.earner_id = e.id and a.credited) as credited_total,
          (select count(*)::int from impact_wait.ads a where a.earner_id = e.id and a.credited and a.impression_at > now() - interval '24 hours') as credited_today,
          (select count(*)::int from impact_wait.ads a where a.earner_id = e.id and a.credited and a.settlement_id is null) as pending_waits,
          (select coalesce(sum(amount_usd), 0)::float8 from impact_wait.earner_payouts p where p.earner_id = e.id and p.status = 'owed') as owed_usd,
          (select coalesce(sum(amount_usd), 0)::float8 from impact_wait.earner_payouts p where p.earner_id = e.id and p.status = 'paid') as paid_usd
        from impact_wait.earners e where e.id = ${earnerId}`;
      return (r as unknown as EarnerSummary) || null;
    },
    async setPayoutEmail(earnerId, email) {
      await sql`update impact_wait.earners set payout_email = ${email} where id = ${earnerId}`;
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
