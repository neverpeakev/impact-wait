import type { AdRow, Impact, Program, Store } from "../supabase/functions/goodwait/app.ts";

export function memStore(impact: Partial<Impact> = {}, programOverrides: Partial<Program> = {}): Store & { ads: Map<string, AdRow & { ip_hash: string }>; totals: Map<string, any>; sites: Map<string, any>; earners: Map<string, any>; payouts: any[]; prog: Program; age(id: string, ms: number): void; settle(network: string, actualUsd: number): void } {
  const sites = new Map<string, any>();
  const totals = new Map<string, any>();
  const ads = new Map<string, any>();
  const earners = new Map<string, any>();
  const payouts: any[] = [];
  const prog: Program = { user_share_pct: 50, est_ecpm_usd: null, min_payout_usd: 10, daily_cap: 200, min_gap_seconds: 15, max_earners_per_ip_day: 3, ...programOverrides };
  const imp: Impact = { cause_name: null, cause_url: null, unit_label: null, usd_per_unit: null, pledge_pct: null, donated_usd: 0, donated_updated_at: null, ...impact };
  return {
    sites, totals, ads, earners, payouts, prog,
    age(id, ms) {
      const a = ads.get(id); a.created_at = new Date(a.created_at.getTime() - ms);
      if (a.impression_at) a.impression_at = new Date(a.impression_at.getTime() - ms);
    },
    // Mirror of impact_wait.settle() for one network over all time.
    settle(network, actualUsd) {
      const open = [...ads.values()].filter((a) => a.credited && !a.settlement_id && a.provider === network);
      const sid = crypto.randomUUID();
      const by = new Map<string, number>();
      for (const a of open) { a.settlement_id = sid; by.set(a.earner_id, (by.get(a.earner_id) || 0) + 1); }
      for (const [earner_id, n] of by) payouts.push({ settlement_id: sid, earner_id, credited_waits: n, amount_usd: Math.round(actualUsd * (prog.user_share_pct / 100) * n / open.length * 1e4) / 1e4, status: "owed" });
    },
    async program() { return prog; },
    async earnersFromIp(ipHash, seconds) {
      const cut = Date.now() - seconds * 1000;
      return [...earners.values()].filter((e) => e.ip_hash === ipHash && e.created_at.getTime() > cut).length;
    },
    async createEarner(row) {
      const id = crypto.randomUUID();
      earners.set(id, { id, ...row, status: "active", payout_email: null, created_at: new Date() });
      return id;
    },
    async findEarner(tokenHash) {
      const e = [...earners.values()].find((x) => x.token_hash === tokenHash);
      return e ? { id: e.id, status: e.status } : null;
    },
    async creditImpression(adId, earnerId, dailyCap, gapSeconds) {
      const mine = [...ads.values()].filter((a) => a.earner_id === earnerId && a.credited);
      const today = mine.filter((a) => a.impression_at.getTime() > Date.now() - 86400e3).length;
      const last = Math.max(0, ...mine.map((a) => a.impression_at.getTime()));
      if (today >= dailyCap || (last && last > Date.now() - gapSeconds * 1000)) return false;
      const a = ads.get(adId);
      if (!a || a.earner_id !== earnerId || a.credited) return false;
      a.credited = true;
      return true;
    },
    async earnerSummary(earnerId) {
      const e = earners.get(earnerId); if (!e) return null;
      const mine = [...ads.values()].filter((a) => a.earner_id === earnerId && a.credited);
      const sum = (st: string) => payouts.filter((p) => p.earner_id === earnerId && p.status === st).reduce((s, p) => s + p.amount_usd, 0);
      return { earner_id: e.id, status: e.status, payout_email: e.payout_email, created_at: e.created_at,
        credited_total: mine.length, credited_today: mine.filter((a) => a.impression_at.getTime() > Date.now() - 86400e3).length,
        pending_waits: mine.filter((a) => !a.settlement_id).length, owed_usd: sum("owed"), paid_usd: sum("paid") };
    },
    async setPayoutEmail(earnerId, email) { earners.get(earnerId).payout_email = email; },
    async ensureSite(site, origin) {
      if (!sites.has(site)) { sites.set(site, { site_key: site, name: null, first_origin: origin, active: true }); totals.set(site, { sponsored_waits: 0, paid_waits: 0, clicks: 0 }); }
      return sites.get(site).active;
    },
    async recentAds(ipHash, seconds) {
      const cut = Date.now() - seconds * 1000;
      return [...ads.values()].filter((a) => a.ip_hash === ipHash && a.created_at.getTime() > cut).length;
    },
    async insertAd(row) {
      const id = crypto.randomUUID();
      ads.set(id, { id, ...row, created_at: new Date(), impression_at: null, click_at: null });
      return id;
    },
    async claimImpression(id, minAgeMs) {
      const a = ads.get(id);
      if (!a || a.impression_at || Date.now() - a.created_at.getTime() < minAgeMs || Date.now() - a.created_at.getTime() > 15 * 60e3) return null;
      a.impression_at = new Date();
      return a;
    },
    async finishImpression(id, site, status, paid) {
      ads.get(id).impression_confirm = status;
      const t = totals.get(site); t.sponsored_waits++; if (paid) t.paid_waits++;
    },
    async claimClick(id) {
      const a = ads.get(id); if (!a) return null;
      const first = !a.click_at; if (first) { a.click_at = new Date(); const t = totals.get(a.site_key); if (t) t.clicks++; }
      return { row: a, first };
    },
    async stats(site) {
      const all = [...totals.entries()];
      const sum = (k: string) => all.reduce((s, [, t]) => s + t[k], 0);
      return {
        total: { sponsored_waits: sum("sponsored_waits"), paid_waits: sum("paid_waits"), clicks: sum("clicks"), sites: all.filter(([, t]) => t.sponsored_waits > 0).length },
        site: site && totals.has(site) ? { site_key: site, name: null, ...totals.get(site) } : null,
        leaderboard: all.filter(([, t]) => t.sponsored_waits > 0).sort((a, b) => b[1].sponsored_waits - a[1].sponsored_waits).slice(0, 10).map(([k, t]) => ({ site_key: k, name: null, sponsored_waits: t.sponsored_waits })),
        impact: imp,
        earnings: [],
      };
    },
  };
}
