import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createApp, type Keys } from "./app.ts";
import type { AuthApi, AuthUser, Mailer } from "./accounts.ts";
import type { ChatFn } from "./chat.ts";
import { loadVaultKeys, pgStore } from "./pgstore.ts";

// Network keys: Edge Function secrets (Supabase dashboard -> Edge Functions -> Secrets) win;
// otherwise they come from Supabase Vault (impact_wait_<network>_key), re-read every 5 minutes.
// Any key left unset is skipped; with none set, every wait gets a house ad.
const env = (k: string) => (Deno.env.get(k) || "").trim() || undefined;
// Secrets may still carry the old IMPACT_WAIT_* names; either spelling works.
const env2 = (k: string) => env(`GOODWAIT_${k}`) || env(`IMPACT_WAIT_${k}`);
const DB = Deno.env.get("SUPABASE_DB_URL")!;
const fromEnv: Keys = { idlen: env2("IDLEN_KEY"), admesh: env2("ADMESH_KEY"), agentads: env2("AGENTADS_KEY") };
const keys: Keys = { ...fromEnv };
// Resend key for the API's own email (sign-in links, welcome): secret RESEND_API_KEY, else Vault impact_wait_resend_key.
let resendKey = env("RESEND_API_KEY") || "";
// Claude key for the web chat: secret ANTHROPIC_API_KEY, else Vault impact_wait_anthropic_key. Unset = chat answers 503.
let anthropicKey = env("ANTHROPIC_API_KEY") || "";
const CHAT_MODEL = env("GOODWAIT_CHAT_MODEL") || "claude-opus-5-5";

async function refreshKeys() {
  try {
    const v = await loadVaultKeys(DB);
    for (const n of ["idlen", "admesh", "agentads"] as const) keys[n] = fromEnv[n] || v[n] || undefined;
    resendKey = env("RESEND_API_KEY") || v.resend || "";
    anthropicKey = env("ANTHROPIC_API_KEY") || v.anthropic || "";
  } catch (e) {
    console.log(`vault keys not loaded: ${(e as Error).message}`);
  }
}
await refreshKeys();
setInterval(refreshKeys, 5 * 60 * 1000);

// Supabase Auth, called directly over REST (no client library: one less thing to load on a cold start).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const userCache = new Map<string, { user: AuthUser | null; at: number }>();
const admin = (path: string, body: unknown) => fetch(`${SUPABASE_URL}/auth/v1${path}`, {
  method: "POST", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const auth: AuthApi = {
  async getUser(token) {
    const hit = userCache.get(token);
    if (hit && Date.now() - hit.at < 60_000) return hit.user;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON || SERVICE, authorization: `Bearer ${token}` } });
    const j = r.ok ? await r.json() : null;
    const user = j && j.id && j.email ? { id: j.id, email: j.email, provider: j.app_metadata?.provider || "email", meta: j.user_metadata || {} } : null;
    if (userCache.size > 5000) userCache.clear();
    userCache.set(token, { user, at: Date.now() });
    return user;
  },
  async signInLink(email) {
    let r = await admin("/admin/generate_link", { type: "magiclink", email });
    if (r.status === 404 || r.status === 422) {
      // No such user yet: create them (unconfirmed; the link confirms the address), then ask again.
      await r.body?.cancel();
      const c = await admin("/admin/users", { email, email_confirm: false, user_metadata: { product: "vibedough" } });
      if (!c.ok && c.status !== 422) { console.log(`auth create user ${c.status} ${(await c.text()).slice(0, 200)}`); return null; }
      await c.body?.cancel();
      r = await admin("/admin/generate_link", { type: "magiclink", email });
    }
    if (!r.ok) { console.log(`auth generate_link ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    const j = await r.json();
    const p = j.properties || j;
    if (!p.hashed_token) return null;
    return { tokenHash: p.hashed_token, type: p.verification_type || "magiclink", otp: p.email_otp || null };
  },
};
const mailer: Mailer = async (m) => {
  if (!resendKey) { console.log("email skipped: no Resend key"); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "Vibedough <hello@vibedough.com>", to: [m.to], reply_to: "kevin@neverpeakmarketing.com", subject: m.subject, html: m.html, text: m.text, tags: [{ name: "kind", value: m.tag }] }),
  });
  if (!r.ok) console.log(`resend ${r.status} ${(await r.text()).slice(0, 200)}`);
  else await r.body?.cancel();
  return r.ok;
};

// The chat module (and the Anthropic SDK) loads on the first chat message, not at cold start.
let chatImpl: { key: string; fn: ChatFn } | null = null;
const chat: ChatFn = async (turns) => {
  if (!chatImpl || chatImpl.key !== anthropicKey) {
    const { claudeChat } = await import("./chat.ts");
    chatImpl = { key: anthropicKey, fn: claudeChat(anthropicKey, CHAT_MODEL) };
  }
  return chatImpl.fn(turns);
};

const app = createApp({
  store: pgStore(DB),
  keys,
  baseUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/goodwait`,
  salt: env2("SALT") || "impact-wait-default-salt",
  log: (m) => console.log(m),
  auth: SERVICE ? auth : undefined,
  mailer,
  chat,
  chatEnabled: () => !!anthropicKey,
  appUrl: env("GOODWAIT_APP_URL") || "https://vibedough.com/app",
});

Deno.serve(app);
