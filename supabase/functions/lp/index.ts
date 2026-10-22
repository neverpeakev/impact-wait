import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";
import { createLp, type LpStore } from "./lp.ts";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, prepare: false, idle_timeout: 20 });

const store: LpStore = {
  async recentEvents(ipHash, seconds, kind) {
    const [r] = kind
      ? await sql`select count(*)::int n from impact_wait.lp_events where ip_hash = ${ipHash} and kind = ${kind} and created_at > now() - make_interval(secs => ${seconds})`
      : await sql`select count(*)::int n from impact_wait.lp_events where ip_hash = ${ipHash} and created_at > now() - make_interval(secs => ${seconds})`;
    return r.n;
  },
  async insertEvent(e) {
    await sql`insert into impact_wait.lp_events (variant, kind, session_id, utm, referrer, ip_hash, ua)
      values (${e.variant}, ${e.kind}, ${e.session_id}, ${sql.json(e.utm)}, ${e.referrer}, ${e.ip_hash}, ${e.ua})`;
  },
  async upsertSignup(r) {
    const rows = await sql`insert into impact_wait.waitlist (email, variant, variants, session_id, utm, referrer, ip_hash)
      values (${r.email}, ${r.variant}, array[${r.variant}]::text[], ${r.session_id}, ${sql.json(r.utm)}, ${r.referrer}, ${r.ip_hash})
      on conflict (email) do update set
        variants = case when ${r.variant} = any(impact_wait.waitlist.variants) then impact_wait.waitlist.variants
                        else impact_wait.waitlist.variants || ${r.variant}::text end,
        session_id = excluded.session_id, updated_at = now()
      returning (xmax = 0) as inserted`;
    return !!rows[0]?.inserted;
  },
  async setTools(email, session, tools) {
    const rows = await sql`update impact_wait.waitlist set tools = ${tools}::text[], updated_at = now()
      where email = ${email} and session_id = ${session} returning id`;
    return rows.length === 1;
  },
};

const origins: (string | RegExp)[] = [
  "https://impact-wait.vercel.app",
  /^https:\/\/impact-wait-[a-z0-9-]+\.vercel\.app$/,
  // Only domains we own: an origin someone else can register could post signups here.
  "https://vibedough.com", "https://www.vibedough.com",
];

Deno.serve(createLp({ store, origins, salt: Deno.env.get("GOODWAIT_SALT") || "lp-default-salt", log: (m) => console.log(m) }));
