import type { AdRow, Impact, Store } from "../supabase/functions/goodwait/app.ts";

export function memStore(impact: Partial<Impact> = {}): Store & { ads: Map<string, AdRow & { ip_hash: string }>; totals: Map<string, any>; sites: Map<string, any>; age(id: string, ms: number): void } {
  const sites = new Map<string, any>();
  const totals = new Map<string, any>();
  const ads = new Map<string, any>();
  const imp: Impact = { cause_name: null, cause_url: null, unit_label: null, usd_per_unit: null, pledge_pct: null, donated_usd: 0, donated_updated_at: null, ...impact };
  return {
    sites, totals, ads,
    age(id, ms) { const a = ads.get(id); a.created_at = new Date(a.created_at.getTime() - ms); },
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
      };
    },
  };
}
