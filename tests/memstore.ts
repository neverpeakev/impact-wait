import type { AdRow, Impact, Program, Store } from "../supabase/functions/goodwait/app.ts";

export function memStore(impact: Partial<Impact> = {}, programOverrides: Partial<Program> = {}): Store & { ads: Map<string, AdRow & { ip_hash: string }>; totals: Map<string, any>; sites: Map<string, any>; earners: Map<string, any>; payouts: any[]; redemptions: any[]; draws: any[]; freeEntries: any[]; prog: Program; age(id: string, ms: number): void; settle(network: string, actualUsd: number): void; balance(earnerId: string): number } {
  const sites = new Map<string, any>();
  const totals = new Map<string, any>();
  const ads = new Map<string, any>();
  const earners = new Map<string, any>();
  const payouts: any[] = [];
  const redemptions: any[] = [];
  const draws: any[] = [];
  const freeEntries: any[] = [];
  const prog: Program = { user_share_pct: 50, est_ecpm_usd: null, min_payout_usd: 10, daily_cap: 200, min_gap_seconds: 15, max_earners_per_ip_day: 3, referral_pct: 10, hold_days: 30, ...programOverrides };
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const balance = (id: string) => r4(payouts.filter((p) => p.earner_id === id && p.status !== "void").reduce((s, p) => s + p.amount_usd, 0)
    - redemptions.filter((r) => r.earner_id === id && r.status !== "void").reduce((s, r) => s + r.amount_usd, 0));
  let codeN = 0;
  const imp: Impact = { cause_name: null, cause_url: null, unit_label: null, usd_per_unit: null, pledge_pct: null, donated_usd: 0, donated_updated_at: null, ...impact };
  return {
    sites, totals, ads, earners, payouts, redemptions, draws, freeEntries, prog, balance,
    age(id, ms) {
      const a = ads.get(id); a.created_at = new Date(a.created_at.getTime() - ms);
      if (a.impression_at) a.impression_at = new Date(a.impression_at.getTime() - ms);
    },
    // Mirror of impact_wait.settle() for one network over all time: earnings, referral cuts, auto-donations.
    settle(network, actualUsd) {
      const open = [...ads.values()].filter((a) => a.credited && !a.settlement_id && a.provider === network);
      const sid = crypto.randomUUID();
      const by = new Map<string, number>();
      for (const a of open) { a.settlement_id = sid; by.set(a.earner_id, (by.get(a.earner_id) || 0) + 1); }
      const fresh: any[] = [];
      for (const [earner_id, n] of by) fresh.push({ settlement_id: sid, earner_id, credited_waits: n, amount_usd: r4(actualUsd * (prog.user_share_pct / 100) * n / open.length), status: "owed", kind: "earnings" });
      for (const p of [...fresh]) {
        const f = earners.get(p.earner_id); const r = f?.referred_by && earners.get(f.referred_by);
        const cut = r4(p.amount_usd * prog.referral_pct / 100);
        if (r && r.status === "active" && cut > 0) fresh.push({ settlement_id: sid, earner_id: r.id, credited_waits: 0, amount_usd: cut, status: "owed", kind: "referral", from_earner_id: p.earner_id });
      }
      payouts.push(...fresh);
      const give = new Map<string, number>();
      for (const p of fresh) if (earners.get(p.earner_id)?.auto_exit === "donate") give.set(p.earner_id, r4((give.get(p.earner_id) || 0) + p.amount_usd));
      for (const [earner_id, amt] of give) if (amt > 0) redemptions.push({ earner_id, kind: "donate", amount_usd: amt, cause: "charity-water", status: "pending", method: "auto" });
    },
    async insertExternalImpression(row) {
      const key = String(row.tracking.requestId);
      if ([...ads.values()].some((a) => a.provider === row.provider && a.tracking?.requestId === key && a.tracking?.clientReported)) return null;
      const id = crypto.randomUUID();
      ads.set(id, { id, ...row, live: true, click_url: null, created_at: new Date(), impression_at: new Date(), click_at: null });
      return id;
    },
    async program() { return prog; },
    async earnersFromIp(ipHash, seconds) {
      const cut = Date.now() - seconds * 1000;
      return [...earners.values()].filter((e) => e.ip_hash === ipHash && e.created_at.getTime() > cut).length;
    },
    async createEarner(row) {
      const id = crypto.randomUUID();
      // Unique 8-char code in the real alphabet (base 31 of a counter).
      const A = "abcdefghjkmnpqrstuvwxyz23456789"; let n = ++codeN, referral_code = "";
      for (let i = 0; i < 8; i++) { referral_code = A[n % 31] + referral_code; n = Math.floor(n / 31); }
      earners.set(id, { id, ...row, status: "active", payout_email: null, created_at: new Date(), referral_code, auto_exit: "cash" });
      return { id, referral_code };
    },
    async findReferrer(code) {
      const e = [...earners.values()].find((x) => x.referral_code === code);
      return e ? { id: e.id, status: e.status, ip_hash: e.ip_hash } : null;
    },
    async referralsSince(referrerId, seconds) {
      return [...earners.values()].filter((e) => e.referred_by === referrerId && e.created_at.getTime() > Date.now() - seconds * 1000).length;
    },
    async setAutoExit(earnerId, exit) { earners.get(earnerId).auto_exit = exit; },
    async donate(earnerId, amount, cause) {
      const bal = balance(earnerId);
      const give = Math.floor(Math.min(amount ?? bal, bal) * 1e4) / 1e4;
      if (give <= 0) return { donated: 0, balance: bal };
      redemptions.push({ earner_id: earnerId, kind: "donate", amount_usd: give, cause, status: "pending", method: "user" });
      return { donated: give, balance: r4(bal - give) };
    },
    async ledger() {
      const sum = (f: (r: any) => boolean) => r4(redemptions.filter(f).reduce((s, r) => s + r.amount_usd, 0));
      return {
        credited_to_users_usd: r4(payouts.filter((p) => p.status !== "void").reduce((s, p) => s + p.amount_usd, 0)),
        paid_out_usd: sum((r) => r.kind === "cash" && r.status === "paid"),
        donated_usd: sum((r) => r.kind === "donate" && r.status === "paid"),
        donation_pending_usd: sum((r) => r.kind === "donate" && r.status === "pending"),
        people_paid: new Set(redemptions.filter((r) => r.kind === "cash" && r.status === "paid").map((r) => r.earner_id)).size,
        last_activity_at: null,
      };
    },
    async openDraw() {
      const now = Date.now();
      return draws.find((d) => d.status === "open" && now >= new Date(d.opens_at).getTime() && now < new Date(d.closes_at).getTime()) || null;
    },
    async drawEntries(drawId, earnerId) {
      const d = draws.find((x) => x.id === drawId); if (!d) return 0;
      return [...ads.values()].filter((a) => a.earner_id === earnerId && a.credited && a.impression_at >= new Date(d.opens_at) && a.impression_at < new Date(d.closes_at)).length;
    },
    async addFreeEntry(drawId, email, ipHash) {
      if (freeEntries.filter((f) => f.ip_hash === ipHash).length >= 5) return "limited";
      const day = new Date().toISOString().slice(0, 10);
      if (freeEntries.some((f) => f.draw_id === drawId && f.email === email && f.day === day)) return "already";
      freeEntries.push({ draw_id: drawId, email, ip_hash: ipHash, day });
      return "added";
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
      const credits = payouts.filter((p) => p.earner_id === earnerId && p.status !== "void");
      const reds = redemptions.filter((r) => r.earner_id === earnerId && r.status !== "void");
      const bal = balance(earnerId);
      return { earner_id: e.id, status: e.status, payout_email: e.payout_email, created_at: e.created_at,
        credited_total: mine.length, credited_today: mine.filter((a) => a.impression_at.getTime() > Date.now() - 86400e3).length,
        pending_waits: mine.filter((a) => !a.settlement_id).length,
        first_credit_at: mine.length ? new Date(Math.min(...mine.map((a) => a.impression_at.getTime()))) : null,
        balance_usd: bal, owed_usd: bal, credited_usd: r4(credits.reduce((s, p) => s + p.amount_usd, 0)),
        paid_usd: r4(reds.filter((r) => r.kind === "cash" && r.status === "paid").reduce((s, r) => s + r.amount_usd, 0)),
        donated_usd: r4(reds.filter((r) => r.kind === "donate").reduce((s, r) => s + r.amount_usd, 0)),
        referral_code: e.referral_code, auto_exit: e.auto_exit,
        referrals: [...earners.values()].filter((f) => f.referred_by === e.id).length,
        referral_earned_usd: r4(credits.filter((p) => p.kind === "referral").reduce((s, p) => s + p.amount_usd, 0)) };
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
