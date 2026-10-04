import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createApp, type Keys } from "./app.ts";
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

async function refreshKeys() {
  try {
    const v = await loadVaultKeys(DB);
    for (const n of ["idlen", "admesh", "agentads"] as const) keys[n] = fromEnv[n] || v[n] || undefined;
  } catch (e) {
    console.log(`vault keys not loaded: ${(e as Error).message}`);
  }
}
await refreshKeys();
setInterval(refreshKeys, 5 * 60 * 1000);

const app = createApp({
  store: pgStore(DB),
  keys,
  baseUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/goodwait`,
  salt: env2("SALT") || "impact-wait-default-salt",
  log: (m) => console.log(m),
});

Deno.serve(app);
