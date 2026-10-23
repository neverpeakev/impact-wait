// Postgres-backed Store. Tables live in the private impact_wait schema (not exposed via the REST API).
import postgres from "npm:postgres@3.4.5";
import type { AdRow, Draw, EarnerSummary, Impact, Ledger, Program, Store } from "./app.ts";
import { type Account, type Install, type TaxFormSummary, WEB_EARNER_REF } from "./accounts.ts";

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
        daily_cap, min_gap_seconds, max_earners_per_ip_day, referral_pct::float8 as referral_pct, hold_days,
        earnings_need_payout_info, max_installs_per_account from impact_wait.program where id = 1`;
      return r as unknown as Program;
    },
    async earnersFromIp(ipHash, seconds) {
      const [r] = await sql`select count(*)::int as n from impact_wait.earners where ip_hash = ${ipHash} and created_at > now() - make_interval(secs => ${seconds})`;
      return r.n;
    },
    async createEarner(row) {
      // The referral code comes from the column default; a rare collision just retries.
      for (let i = 0; ; i++) {
        try {
          const [r] = await sql`insert into impact_wait.earners (token_hash, ip_hash, ref, referred_by)
            values (${row.token_hash}, ${row.ip_hash}, ${row.ref}, ${row.referred_by}) returning id, referral_code`;
          return { id: r.id, referral_code: r.referral_code };
        } catch (e) {
          if (i < 3 && (e as { code?: string; constraint_name?: string }).code === "23505" && /referral_code/.test(String((e as { constraint_name?: string }).constraint_name))) continue;
          throw e;
        }
      }
    },
    async findReferrer(code) {
      const [r] = await sql`select id, status, ip_hash from impact_wait.earners where referral_code = ${code}`;
      return r ? { id: r.id, status: r.status, ip_hash: r.ip_hash } : null;
    },
    async referralsSince(referrerId, seconds) {
      const [r] = await sql`select count(*)::int as n from impact_wait.earners where referred_by = ${referrerId} and created_at > now() - make_interval(secs => ${seconds})`;
      return r.n;
    },
    async setAutoExit(earnerId, exit) {
      await sql`update impact_wait.earners set auto_exit = ${exit} where id = ${earnerId}`;
    },
    async donate(earnerId, amount, cause) {
      return await sql.begin(async (tx: any) => {
        await tx`select pg_advisory_xact_lock(hashtext(${earnerId}::text))`;
        const [b] = await tx`select balance_usd::float8 as balance from impact_wait.balances where earner_id = ${earnerId}`;
        const balance = b ? Number(b.balance) : 0;
        const give = Math.floor(Math.min(amount ?? balance, balance) * 10000) / 10000;
        if (give <= 0) return { donated: 0, balance };
        await tx`insert into impact_wait.redemptions (earner_id, kind, amount_usd, cause, status, method)
          values (${earnerId}, 'donate', ${give}, ${cause}, 'pending', 'user')`;
        return { donated: give, balance: Math.round((balance - give) * 10000) / 10000 };
      });
    },
    async ledger() {
      const [r] = await sql`select credited_to_users_usd::float8 as credited_to_users_usd, paid_out_usd::float8 as paid_out_usd, donated_usd::float8 as donated_usd,
        donation_pending_usd::float8 as donation_pending_usd, people_paid::int as people_paid, last_activity_at from impact_wait.public_ledger`;
      return r as unknown as Ledger;
    },
    async openDraw() {
      const [r] = await sql`select id, name, prize_usd::float8 as prize_usd, opens_at, closes_at, rules_url from impact_wait.draws
        where status = 'open' and now() >= opens_at and now() < closes_at order by closes_at limit 1`;
      return (r as unknown as Draw) || null;
    },
    async drawEntries(drawId, earnerId) {
      const [r] = await sql`select coalesce(sum(entries), 0)::int as n from impact_wait.draw_entries where draw_id = ${drawId} and entrant_key = ${"earner:" + earnerId}`;
      return r.n;
    },
    async addFreeEntry(drawId, email, ipHash) {
      const [c] = await sql`select count(*)::int as n from impact_wait.draw_free_entries where ip_hash = ${ipHash} and created_at > now() - interval '1 day'`;
      if (c.n >= 5) return "limited";
      const rows = await sql`insert into impact_wait.draw_free_entries (draw_id, email, ip_hash) values (${drawId}, ${email}, ${ipHash})
        on conflict (draw_id, email, entry_day) do nothing returning id`;
      return rows.length ? "added" : "already";
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
      const [r] = await sql`select e.id as earner_id, e.status, e.payout_email, e.created_at, e.referral_code, e.auto_exit,
          (select count(*)::int from impact_wait.ads a where a.earner_id = e.id and a.credited) as credited_total,
          (select count(*)::int from impact_wait.ads a where a.earner_id = e.id and a.credited and a.impression_at > now() - interval '24 hours') as credited_today,
          (select count(*)::int from impact_wait.ads a where a.earner_id = e.id and a.credited and a.settlement_id is null) as pending_waits,
          (select min(a.impression_at) from impact_wait.ads a where a.earner_id = e.id and a.credited) as first_credit_at,
          b.balance_usd::float8 as balance_usd, b.credited_usd::float8 as credited_usd, b.balance_usd::float8 as owed_usd,
          (select coalesce(sum(amount_usd), 0)::float8 from impact_wait.redemptions r where r.earner_id = e.id and r.kind = 'cash' and r.status = 'paid') as paid_usd,
          (select coalesce(sum(amount_usd), 0)::float8 from impact_wait.redemptions r where r.earner_id = e.id and r.kind = 'donate' and r.status <> 'void') as donated_usd,
          (select count(*)::int from impact_wait.earners f where f.referred_by = e.id) as referrals,
          (select coalesce(sum(amount_usd), 0)::float8 from impact_wait.earner_payouts p where p.earner_id = e.id and p.kind = 'referral' and p.status <> 'void') as referral_earned_usd
        from impact_wait.earners e join impact_wait.balances b on b.earner_id = e.id
        where e.id = ${earnerId}`;
      return (r as unknown as EarnerSummary) || null;
    },
    async setPayoutEmail(earnerId, email) {
      await sql`update impact_wait.earners set payout_email = ${email} where id = ${earnerId}`;
    },
    async ensureAccount(row) {
      // Almost every call is a returning account with the same email: one read and done.
      const [have] = await sql`select id, user_id, email, install_code, paypal_email, created_at, welcome_sent_at from impact_wait.accounts where user_id = ${row.user_id}`;
      if (have && have.email === row.email) return { account: have as unknown as Account, created: false };
      // The install code comes from the column default; a rare collision just retries.
      for (let i = 0; ; i++) {
        try {
          const made = await sql`insert into impact_wait.accounts (user_id, email, provider, source)
            values (${row.user_id}, ${row.email}, ${row.provider}, ${row.source ? sql.json(row.source as any) : null})
            on conflict (user_id) do nothing
            returning id, user_id, email, install_code, paypal_email, created_at, welcome_sent_at`;
          if (made[0]) return { account: made[0] as unknown as Account, created: true };
          // Writes only when the sign-in email changed; the account page polls this.
          const [moved] = await sql`update impact_wait.accounts set email = ${row.email}, updated_at = now() where user_id = ${row.user_id} and email is distinct from ${row.email}
            returning id, user_id, email, install_code, paypal_email, created_at, welcome_sent_at`;
          const [a] = moved ? [moved] : await sql`select id, user_id, email, install_code, paypal_email, created_at, welcome_sent_at from impact_wait.accounts where user_id = ${row.user_id}`;
          return { account: a as unknown as Account, created: false };
        } catch (e) {
          if (i < 3 && (e as { code?: string; constraint_name?: string }).code === "23505" && /install_code/.test(String((e as { constraint_name?: string }).constraint_name))) continue;
          throw e;
        }
      }
    },
    async claimWelcome(accountId) {
      const rows = await sql`update impact_wait.accounts set welcome_sent_at = now() where id = ${accountId} and welcome_sent_at is null returning id`;
      return rows.length === 1;
    },
    async releaseWelcome(accountId) {
      await sql`update impact_wait.accounts set welcome_sent_at = null where id = ${accountId}`;
    },
    async installs(accountId) {
      const rows = await sql`select id as earner_id, case when ref = ${WEB_EARNER_REF} then 'web' else 'install' end as kind, linked_at, last_seen_at
        from impact_wait.earners where account_id = ${accountId} order by linked_at`;
      return rows as unknown as Install[];
    },
    async taxForm(accountId) {
      const [r] = await sql`select tin_type, tin_last4, legal_name, signed_at from impact_wait.tax_forms where account_id = ${accountId}`;
      return (r as unknown as TaxFormSummary) || null;
    },
    async saveTaxForm(accountId, f, ipHash, userAgent) {
      const [r] = await sql`select impact_wait.save_tax_form(${accountId}, ${f.legal_name}, ${f.business_name}, ${f.tax_class}, ${f.line1}, ${f.city}, ${f.state}, ${f.zip},
        ${f.tin_type}, ${f.tin}, ${f.signed_name}, ${ipHash}, ${userAgent || null}) as last4`;
      return r.last4;
    },
    async setAccountPaypal(accountId, email) {
      await sql.begin(async (tx: any) => {
        await tx`update impact_wait.accounts set paypal_email = ${email}, updated_at = now() where id = ${accountId}`;
        await tx`update impact_wait.earners set payout_email = ${email} where account_id = ${accountId}`;
      });
    },
    async rotateInstallCode(accountId) {
      for (let i = 0; ; i++) {
        try {
          const [r] = await sql`update impact_wait.accounts set install_code = impact_wait.new_install_code(), updated_at = now() where id = ${accountId} returning install_code`;
          return r.install_code;
        } catch (e) {
          if (i < 3 && (e as { code?: string }).code === "23505") continue;
          throw e;
        }
      }
    },
    async findAccountByCode(code) {
      const [r] = await sql`select id, user_id, email, install_code, paypal_email, created_at, welcome_sent_at from impact_wait.accounts where install_code = ${code}`;
      return (r as unknown as Account) || null;
    },
    async linkEarner(earnerId, accountId, maxInstalls) {
      // Serialized per account so two installs linking at once can't both slip under the cap.
      return await sql.begin(async (tx: any) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"acct:" + accountId}))`;
        const [e] = await tx`select account_id from impact_wait.earners where id = ${earnerId}`;
        if (e.account_id === accountId) return "linked";
        if (e.account_id) return "other";
        const [c] = await tx`select count(*)::int as n from impact_wait.earners where account_id = ${accountId} and ref is distinct from ${WEB_EARNER_REF}`;
        if (c.n >= maxInstalls) return "full";
        await tx`update impact_wait.earners e set account_id = ${accountId}, linked_at = now(),
            payout_email = coalesce((select a.paypal_email from impact_wait.accounts a where a.id = ${accountId}), e.payout_email)
          where e.id = ${earnerId}`;
        return "linked";
      });
    },
    async webEarner(accountId, ipHash) {
      return await sql.begin(async (tx: any) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"acct:" + accountId}))`;
        const [have] = await tx`select id from impact_wait.earners where account_id = ${accountId} and ref = ${WEB_EARNER_REF} limit 1`;
        if (have) return have.id;
        // No token exists for this earner: the hash is of random bytes nobody holds, so it can't be presented.
        const junk = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
        const [made] = await tx`insert into impact_wait.earners (token_hash, ip_hash, ref, account_id, linked_at, payout_email)
          values (${"web:" + junk}, ${ipHash}, ${WEB_EARNER_REF}, ${accountId}, now(), (select paypal_email from impact_wait.accounts where id = ${accountId}))
          returning id`;
        return made.id;
      });
    },
    async earnerAccount(earnerId) {
      const [r] = await sql`select account_id from impact_wait.earners where id = ${earnerId}`;
      return r ? r.account_id : null;
    },
    async touchEarner(earnerId) {
      await sql`update impact_wait.earners set last_seen_at = now() where id = ${earnerId} and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')`;
    },
    async rateCount(kind, key, seconds) {
      const [r] = await sql`select count(*)::int as n from impact_wait.rate_events where kind = ${kind} and key = ${key} and created_at > now() - make_interval(secs => ${seconds})`;
      return r.n;
    },
    async rateHit(kind, key) {
      await sql`insert into impact_wait.rate_events (kind, key) values (${kind}, ${key})`;
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
    const rows = await sql`select name, decrypted_secret from vault.decrypted_secrets where name in ('impact_wait_idlen_key', 'impact_wait_admesh_key', 'impact_wait_agentads_key', 'impact_wait_resend_key', 'impact_wait_anthropic_key')`;
    const out: Record<string, string> = {};
    for (const r of rows as any[]) if (r.decrypted_secret) out[String(r.name).replace(/^impact_wait_|_key$/g, "")] = String(r.decrypted_secret).trim();
    return out;
  } finally {
    await sql.end({ timeout: 2 });
  }
}
