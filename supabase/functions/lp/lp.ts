// Landing-page test capture: page views and sign-ups for the offer test (cash / prize / give).
// Separate from the goodwait ad API on purpose: nothing here can affect ads, earners or payouts.
//
// POST {kind: "view"|"signup"|"tools", variant, session, email?, tools?, utm?, ref?, hp?}
// - Only listed origins get CORS; the rest are refused.
// - Honeypot field (hp) filled = silently accepted and dropped (bots learn nothing).
// - Rate limits per hashed IP; raw IPs are never stored.

export const VARIANTS = new Set(["cash", "prize", "give"]);
export const TOOLS = new Set(["claude-code", "cursor", "codex", "chatgpt", "claude", "gemini", "copilot", "other"]);
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,185}\.[a-z]{2,24}$/i;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid", "msclkid", "ttclid", "rdt_cid"];

export type LpEvent = { variant: string; kind: string; session_id: string; utm: Record<string, string>; referrer: string | null; ip_hash: string; ua: string | null };
export interface LpStore {
  recentEvents(ipHash: string, seconds: number, kind?: string): Promise<number>;
  insertEvent(e: LpEvent): Promise<void>;
  // Inserts or, for a known email, adds this variant. Returns true when the email is new.
  upsertSignup(row: { email: string; variant: string; session_id: string; utm: Record<string, string>; referrer: string | null; ip_hash: string }): Promise<boolean>;
  setTools(email: string, session: string, tools: string[]): Promise<boolean>;
}

export function cleanUtm(u: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!u || typeof u !== "object") return out;
  for (const k of UTM_KEYS) {
    const v = (u as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 200);
  }
  return out;
}

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function createLp(opts: { store: LpStore; origins: (string | RegExp)[]; salt: string; log?: (m: string) => void }) {
  const { store, salt } = opts;
  const log = opts.log || (() => {});
  const allowed = (o: string) => !!o && opts.origins.some((a) => (typeof a === "string" ? a === o : a.test(o)));

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin") || "";
    const cors: Record<string, string> = allowed(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" }
      : { "Vary": "Origin" };
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { status: allowed(origin) ? 204 : 403, headers: cors });
    if (req.method !== "POST") return json({ error: "not found" }, 404);
    if (!allowed(origin)) return json({ error: "forbidden" }, 403);

    try {
      const b = await req.json().catch(() => ({}));
      const kind = String(b.kind || "");
      const variant = String(b.variant || "");
      const session = String(b.session || "");
      if (!["view", "signup", "tools"].includes(kind) || !VARIANTS.has(variant) || !SESSION_RE.test(session)) return json({ error: "bad request" }, 400);
      // Honeypot: a bot filled the hidden field. Say yes, keep nothing.
      if (typeof b.hp === "string" && b.hp.length > 0) return json({ ok: true });

      // Real client address: Cloudflare overwrites cf-connecting-ip; x-forwarded-for is client-writable.
      const ip = (req.headers.get("cf-connecting-ip") || "").trim() || (req.headers.get("x-real-ip") || "").trim() || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
      const ipHash = await sha(`${ip}|${new Date().toISOString().slice(0, 10)}|${salt}`);
      if ((await store.recentEvents(ipHash, 60)) >= 30) return json({ error: "slow down" }, 429);
      const utm = cleanUtm(b.utm);
      const referrer = typeof b.ref === "string" && /^https?:\/\//i.test(b.ref) ? b.ref.slice(0, 300) : null;
      const ua = (req.headers.get("user-agent") || "").slice(0, 200) || null;

      if (kind === "view") {
        await store.insertEvent({ variant, kind, session_id: session, utm, referrer, ip_hash: ipHash, ua });
        return json({ ok: true });
      }

      const email = String(b.email || "").trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);

      if (kind === "signup") {
        if ((await store.recentEvents(ipHash, 3600, "signup")) >= 5) return json({ error: "Too many sign-ups from this network. Try again later." }, 429);
        const isNew = await store.upsertSignup({ email, variant, session_id: session, utm, referrer, ip_hash: ipHash });
        await store.insertEvent({ variant, kind, session_id: session, utm, referrer, ip_hash: ipHash, ua });
        log(`lp signup variant=${variant} new=${isNew}${utm.utm_source ? " src=" + utm.utm_source : ""}`);
        return json({ ok: true, new: isNew });
      }

      // tools: only for the session that signed this email up.
      const tools = Array.isArray(b.tools) ? [...new Set(b.tools.map(String).filter((t: string) => TOOLS.has(t)))].slice(0, 8) : [];
      const ok = await store.setTools(email, session, tools as string[]);
      if (ok) await store.insertEvent({ variant, kind, session_id: session, utm, referrer, ip_hash: ipHash, ua });
      return json({ ok });
    } catch (e) {
      log(`lp error: ${(e as Error).message}`);
      return json({ error: "Something went wrong on our side. Try again in a minute." }, 500);
    }
  };
}
