import type { AdRow, Impact, Program, Store } from "../supabase/functions/goodwait/app.ts";

export function memStore(impact: Partial<Impact> = {}, programOverrides: Partial<Program> = {}): Store & { ads: Map<string, AdRow & { ip_hash: string }>; totals: Map<string, any>; sites: Map<string, any>; earners: Map<string, any>; accounts: Map<string, any>; taxForms: Map<string, any>; payouts: any[]; redemptions: any[]; draws: any[]; freeEntries: any[]; prog: Program; chats: Map<string, any>; age(id: string, ms: number): void; settle(network: string, actualUsd: number): void; balance(earnerId: string): number } {
  const sites = new Map<string, any>();
  const totals = new Map<string, any>();
  const ads = new Map<string, any>();
  const earners = new Map<string, any>();
  const accounts = new Map<string, any>();
  const taxForms = new Map<string, any>();
  const rates: { kind: string; key: string; at: number }[] = [];
  const chatUsage: { account_id: string; cost_usd: number; at: number }[] = [];
  const chats = new Map<string, any>();
  const chatMsgs: { chat_id: string; role: "user" | "assistant"; content: string; created_at: Date; n: number }[] = [];
  const settlements: any[] = [];
  let msgN = 0, tick = 0;
  const pubChat = (c: any) => ({ id: c.id, title: c.title, created_at: c.created_at, updated_at: c.updated_at });
  const A31 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const newCode = () => { const c = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => A31[b % 31]).join(""); return `VD-${c.slice(0, 4)}-${c.slice(4)}`; };
  const pubAccount = (a: any) => ({ id: a.id, user_id: a.user_id, email: a.email, install_code: a.install_code, paypal_email: a.paypal_email, created_at: a.created_at, welcome_sent_at: a.welcome_sent_at, web_only_at: a.web_only_at ?? null });
  const payouts: any[] = [];
  const redemptions: any[] = [];
  const draws: any[] = [];
  const freeEntries: any[] = [];
  const prog: Program = { user_share_pct: 50, est_ecpm_usd: null, min_payout_usd: 10, daily_cap: 200, min_gap_seconds: 15, max_earners_per_ip_day: 3, referral_pct: 10, hold_days: 30, earnings_need_payout_info: true, max_installs_per_account: 5, ...programOverrides };
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const balance = (id: string) => r4(payouts.filter((p) => p.earner_id === id && p.status !== "void").reduce((s, p) => s + p.amount_usd, 0)
    - redemptions.filter((r) => r.earner_id === id && r.status !== "void").reduce((s, r) => s + r.amount_usd, 0));
  let codeN = 0;
  const imp: Impact = { cause_name: null, cause_url: null, unit_label: null, usd_per_unit: null, pledge_pct: null, donated_usd: 0, donated_updated_at: null, ...impact };
  return {
    sites, totals, ads, earners, accounts, taxForms, payouts, redemptions, draws, freeEntries, prog, balance, chats,
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
      if (open.length && actualUsd > 0) settlements.push({ network, actual_usd: actualUsd, user_share_pct: prog.user_share_pct, credited_waits: open.length, period_start: new Date(0), period_end: new Date(), created_at: new Date(Date.now() + settlements.length) });
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
    async ensureAccount(row) {
      const have = [...accounts.values()].find((a) => a.user_id === row.user_id);
      if (have) { have.email = row.email; return { account: pubAccount(have), created: false }; }
      const a = { id: crypto.randomUUID(), ...row, install_code: newCode(), paypal_email: null, welcome_sent_at: null, created_at: new Date() };
      accounts.set(a.id, a);
      return { account: pubAccount(a), created: true };
    },
    async claimWelcome(accountId) {
      const a = accounts.get(accountId); if (!a || a.welcome_sent_at) return false;
      a.welcome_sent_at = new Date(); return true;
    },
    async releaseWelcome(accountId) { accounts.get(accountId).welcome_sent_at = null; },
    async installs(accountId) {
      return [...earners.values()].filter((e) => e.account_id === accountId).map((e) => ({ earner_id: e.id, kind: e.ref === "web-app" ? "web" as const : "install" as const, linked_at: e.linked_at, last_seen_at: e.last_seen_at ?? null }));
    },
    async taxForm(accountId) {
      const t = taxForms.get(accountId);
      return t ? { tin_type: t.tin_type, tin_last4: t.tin_last4, legal_name: t.legal_name, signed_at: t.signed_at } : null;
    },
    async saveTaxForm(accountId, f, ipHash, userAgent) {
      // Like the SQL function: the clear TIN is never kept, only the last 4 and an opaque stand-in.
      const { tin, ...rest } = f;
      taxForms.set(accountId, { ...rest, tin_last4: tin.slice(-4), tin_enc: "enc:" + tin.length, ip_hash: ipHash, user_agent: userAgent, signed_at: new Date() });
      return tin.slice(-4);
    },
    async setAccountPaypal(accountId, email) {
      accounts.get(accountId).paypal_email = email;
      for (const e of earners.values()) if (e.account_id === accountId) e.payout_email = email;
    },
    async rotateInstallCode(accountId) { const a = accounts.get(accountId); a.install_code = newCode(); return a.install_code; },
    async findAccountByCode(code) {
      const a = [...accounts.values()].find((x) => x.install_code === code);
      return a ? pubAccount(a) : null;
    },
    async linkEarner(earnerId, accountId, maxInstalls) {
      const e = earners.get(earnerId);
      if (e.account_id === accountId) return "linked";
      if (e.account_id) return "other";
      if ([...earners.values()].filter((x) => x.account_id === accountId && x.ref !== "web-app").length >= maxInstalls) return "full";
      e.account_id = accountId; e.linked_at = new Date();
      e.payout_email = accounts.get(accountId).paypal_email ?? e.payout_email;
      return "linked";
    },
    async webEarner(accountId, ipHash) {
      const have = [...earners.values()].find((e) => e.account_id === accountId && e.ref === "web-app");
      if (have) return have.id;
      const { id } = await this.createEarner({ token_hash: "web:" + crypto.randomUUID(), ip_hash: ipHash, ref: "web-app", referred_by: null });
      const e = earners.get(id); e.account_id = accountId; e.linked_at = new Date(); e.payout_email = accounts.get(accountId).paypal_email;
      return id;
    },
    async earnerAccount(earnerId) { return earners.get(earnerId)?.account_id ?? null; },
    async touchEarner(earnerId) { const e = earners.get(earnerId); if (e) e.last_seen_at = new Date(); },
    async chatSpendSince(since) { return chatUsage.filter((u) => u.at >= since.getTime()).reduce((t, u) => t + u.cost_usd, 0); },
    async recordChatUsage(row) { chatUsage.push({ ...row, at: Date.now() }); },
    async listChats(accountId, limit) {
      return [...chats.values()].filter((c) => c.account_id === accountId).sort((a, b) => b.order - a.order).slice(0, limit).map(pubChat);
    },
    async chatMessages(accountId, chatId, limit) {
      const c = chats.get(chatId);
      if (!c || c.account_id !== accountId) return null;
      const ms = chatMsgs.filter((m) => m.chat_id === chatId).sort((a, b) => a.n - b.n).slice(-limit).map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }));
      return { chat: pubChat(c), messages: ms };
    },
    async createChat(accountId, title) {
      const c = { id: crypto.randomUUID(), account_id: accountId, title, created_at: new Date(), updated_at: new Date(), order: ++tick };
      chats.set(c.id, c);
      return pubChat(c);
    },
    async addChatMessages(chatId, messages) {
      for (const m of messages) chatMsgs.push({ chat_id: chatId, role: m.role, content: m.content, created_at: new Date(), n: ++msgN });
      const c = chats.get(chatId); c.updated_at = new Date(); c.order = ++tick;
    },
    async deleteChat(accountId, chatId) {
      const c = chats.get(chatId);
      if (!c || c.account_id !== accountId) return false;
      chats.delete(chatId);
      for (let i = chatMsgs.length - 1; i >= 0; i--) if (chatMsgs[i].chat_id === chatId) chatMsgs.splice(i, 1);
      return true;
    },
    async setWebOnly(accountId, on) { const a = accounts.get(accountId); a.web_only_at = on ? (a.web_only_at ?? new Date()) : null; },
    async settledRate() {
      const r = [...settlements].sort((a, b) => b.created_at - a.created_at)[0];
      if (!r) return null;
      return { network: r.network, actual_usd: r.actual_usd, credited_waits: r.credited_waits, period_start: r.period_start, period_end: r.period_end, settled_at: r.created_at,
        per_view_usd: r.actual_usd * (r.user_share_pct / 100) / r.credited_waits };
    },
    async rateCount(kind, key, seconds) { return rates.filter((r) => r.kind === kind && r.key === key && r.at > Date.now() - seconds * 1000).length; },
    async rateHit(kind, key) { rates.push({ kind, key, at: Date.now() }); },
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
