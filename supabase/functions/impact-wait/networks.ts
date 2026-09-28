// Ad networks for ImpactWait. Ported from the Wait Ads extension (v1.3.3),
// where each request shape was verified live against the real APIs.
// Keys come from Edge Function secrets; a network with no key is skipped.

export type Ad = {
  provider: string;
  live: boolean;
  label: string;
  brand: string;
  headline: string;
  body: string;
  cta: string;
  clickUrl: string;
  favicon?: string;
  tracking: Record<string, unknown>; // server-side only, never sent to clients
};
export type Ctx = { query: string; response?: string; sessionId: string; host: string };
type Keys = { idlen?: string; admesh?: string; agentads?: string };

const https = (u: unknown) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : "");

async function timed(url: string, init: RequestInit, ms: number, f: typeof fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- Idlen
// Same request as @idlen/chat-sdk 1.0.5 (MIT), incl. its topic dictionary.
const IDLEN = "https://chat-sdk.idlen.io";
const TOPICS: Record<string, { category: string; synonyms: string[] }> = {react:{category:"frontend",synonyms:["reactjs","react.js"]},vue:{category:"frontend",synonyms:["vuejs","vue.js","vue3"]},angular:{category:"frontend",synonyms:["angularjs"]},svelte:{category:"frontend",synonyms:["sveltejs","sveltekit"]},nextjs:{category:"frontend",synonyms:["next.js","next"]},nuxt:{category:"frontend",synonyms:["nuxtjs","nuxt.js","nuxt3"]},tailwind:{category:"frontend",synonyms:["tailwindcss","tailwind css"]},css:{category:"frontend",synonyms:["sass","scss","less"]},remix:{category:"frontend",synonyms:["remix.run"]},astro:{category:"frontend",synonyms:["astro.build"]},solidjs:{category:"frontend",synonyms:["solid.js"]},htmx:{category:"frontend",synonyms:[]},vite:{category:"frontend",synonyms:["vitejs"]},webpack:{category:"frontend",synonyms:[]},node:{category:"backend",synonyms:["nodejs","node.js"]},express:{category:"backend",synonyms:["expressjs","express.js"]},fastapi:{category:"backend",synonyms:["fast api"]},django:{category:"backend",synonyms:[]},rails:{category:"backend",synonyms:["ruby on rails"]},laravel:{category:"backend",synonyms:[]},spring:{category:"backend",synonyms:["spring boot","springboot"]},nestjs:{category:"backend",synonyms:["nest.js"]},hono:{category:"backend",synonyms:["honojs"]},flask:{category:"backend",synonyms:[]},graphql:{category:"backend",synonyms:["gql"]},grpc:{category:"backend",synonyms:[]},aws:{category:"cloud",synonyms:["amazon web services","s3","ec2","lambda"]},gcp:{category:"cloud",synonyms:["google cloud"]},azure:{category:"cloud",synonyms:["microsoft azure"]},vercel:{category:"cloud",synonyms:[]},netlify:{category:"cloud",synonyms:[]},cloudflare:{category:"cloud",synonyms:["cf workers","cloudflare workers"]},heroku:{category:"cloud",synonyms:[]},fly:{category:"cloud",synonyms:["fly.io"]},render:{category:"cloud",synonyms:["render.com"]},railway:{category:"cloud",synonyms:["railway.app"]},deploy:{category:"cloud",synonyms:["deployment","hosting"]},docker:{category:"infrastructure",synonyms:["dockerfile","container"]},kubernetes:{category:"infrastructure",synonyms:["k8s","kube","kubectl"]},terraform:{category:"infrastructure",synonyms:["hcl"]},nginx:{category:"infrastructure",synonyms:["reverse proxy"]},postgres:{category:"database",synonyms:["postgresql","psql"]},mysql:{category:"database",synonyms:["mariadb"]},mongodb:{category:"database",synonyms:["mongo","nosql"]},redis:{category:"database",synonyms:["valkey"]},supabase:{category:"database",synonyms:[]},firebase:{category:"database",synonyms:["firestore"]},prisma:{category:"database",synonyms:["prisma orm"]},drizzle:{category:"database",synonyms:["drizzle-orm","drizzle orm"]},sqlite:{category:"database",synonyms:["sqlite3"]},dynamodb:{category:"database",synonyms:["dynamo"]},planetscale:{category:"database",synonyms:[]},neon:{category:"database",synonyms:["neon.tech"]},typescript:{category:"devtools",synonyms:["ts"]},javascript:{category:"devtools",synonyms:["js","ecmascript"]},python:{category:"devtools",synonyms:["py","python3"]},rust:{category:"devtools",synonyms:["rustlang","cargo"]},go:{category:"devtools",synonyms:["golang"]},java:{category:"devtools",synonyms:["jvm"]},kotlin:{category:"devtools",synonyms:["kt"]},swift:{category:"devtools",synonyms:["swiftui"]},csharp:{category:"devtools",synonyms:["c#","dotnet",".net"]},php:{category:"devtools",synonyms:["php8"]},ruby:{category:"devtools",synonyms:["rb"]},elixir:{category:"devtools",synonyms:["phoenix"]},openai:{category:"ai_ml",synonyms:["chatgpt","gpt","gpt-4","gpt4"]},langchain:{category:"ai_ml",synonyms:["lang chain"]},tensorflow:{category:"ai_ml",synonyms:["keras"]},pytorch:{category:"ai_ml",synonyms:["torch"]},huggingface:{category:"ai_ml",synonyms:["transformers"]},llm:{category:"ai_ml",synonyms:["large language model"]},anthropic:{category:"ai_ml",synonyms:["claude"]},gemini:{category:"ai_ml",synonyms:["google gemini"]},rag:{category:"ai_ml",synonyms:["retrieval augmented generation"]},embeddings:{category:"ai_ml",synonyms:["vector search","vector db"]},stripe:{category:"payments",synonyms:["stripe api"]},paypal:{category:"payments",synonyms:[]},auth0:{category:"auth",synonyms:[]},clerk:{category:"auth",synonyms:[]},jwt:{category:"auth",synonyms:["json web token"]},oauth:{category:"auth",synonyms:["oauth2","openid"]},nextauth:{category:"auth",synonyms:["next-auth","authjs","auth.js"]},jest:{category:"testing",synonyms:[]},cypress:{category:"testing",synonyms:[]},playwright:{category:"testing",synonyms:[]},vitest:{category:"testing",synonyms:[]},sentry:{category:"monitoring",synonyms:[]},datadog:{category:"monitoring",synonyms:[]},grafana:{category:"monitoring",synonyms:["prometheus"]},figma:{category:"design",synonyms:[]},storybook:{category:"design",synonyms:[]},git:{category:"devtools",synonyms:["version control"]},github:{category:"devtools",synonyms:["gh"]},vscode:{category:"devtools",synonyms:["visual studio code","vs code"]},cursor:{category:"devtools",synonyms:["cursor ai"]}};
let topicIndex: Map<string, string> | null = null;
export function idlenContext(text: string) {
  if (!topicIndex) {
    topicIndex = new Map();
    for (const [k, v] of Object.entries(TOPICS)) { topicIndex.set(k, k); for (const s of v.synonyms) topicIndex.set(s.toLowerCase(), k); }
  }
  const t = text.toLowerCase();
  const topics = new Set<string>(); const cats: Record<string, number> = {};
  for (const [needle, topic] of topicIndex) {
    if (needle.length <= 2 || !t.includes(needle)) continue;
    topics.add(topic);
    const c = TOPICS[topic].category; cats[c] = (cats[c] || 0) + 1;
  }
  const category = Object.entries(cats).sort(([, a], [, b]) => b - a)[0]?.[0] || "general";
  let intent = "informational";
  if (/\b(compare|vs|versus|better|alternative|difference)\b/i.test(t)) intent = "comparison";
  else if (/\b(buy|pricing|plan|subscribe|sign up|get started|free trial)\b/i.test(t)) intent = "transactional";
  else if (/\b(go to|find|where is|link|url|navigate)\b/i.test(t)) intent = "navigational";
  return { topics: [...topics].slice(0, 10), category, intent };
}

async function idlen(ctx: Ctx, key: string, f: typeof fetch): Promise<Ad | null> {
  const context = idlenContext(`${ctx.query} ${ctx.response || ""}`);
  const r = await timed(`${IDLEN}/v1/serve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ apiKey: key, sessionId: ctx.sessionId, context, format: "chat_sponsored_recommendation", maxAds: 1 }),
  }, 2500, f);
  if (!r.ok) throw new Error(`idlen HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  const a = j && j.success && j.ad;
  if (!a || a.publisher_id === "house" || /^house[-_]/.test(a.ad_id || "")) return null; // Idlen's own promo = no fill
  return {
    provider: "idlen", live: true, label: "Sponsored",
    brand: a.advertiser_name || "", headline: a.title || a.advertiser_name || "", body: a.body || "",
    cta: a.cta_text || "Learn more", clickUrl: https(a.cta_url), favicon: https(a.advertiser_logo),
    tracking: { impressionToken: a.impression_token, adId: a.ad_id, publisherId: a.publisher_id, requestId: a.request_id },
  };
}

// --------------------------------------------------------------- AdMesh
// Same payload as admesh-ui-sdk 1.0.48. Auctions take 1-6s, so it gets the full budget.
const ADMESH = "https://api.useadmesh.com";
async function admesh(ctx: Ctx, key: string, f: typeof fetch): Promise<Ad | null> {
  const q = ctx.query.trim(); if (!q) return null;
  const messages = [{ role: "user", content: q.slice(0, 2000) }];
  if (ctx.response) messages.push({ role: "assistant", content: ctx.response.slice(0, 1500) });
  const body = {
    spec_version: "1.0", message_id: `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, timestamp: new Date().toISOString(),
    platform: { platform_id: "placeholder", role: "platform", software: { name: "impact_wait", version: "0.1.0" } },
    identity: { namespace: "platform_user", value_hash: "", confidence: 0 },
    consent: { status: "granted", source: "impact_wait", scope: { intent_based_monetization: true, agent_participation: false, measurement: true }, constraints: { allow_identity_downstream: false } },
    classification_input: { type: "interaction", interaction: {
      session: { id: ctx.sessionId, turn_index: 0 },
      surface: { channel: "conversation", interaction_mode: "text", platform: "web", form_factor: "desktop", locale: "en-US", country: "US", publisher: "placeholder" },
      input: { query_text: q.slice(0, 1000), messages },
      context: { location: { country_code: "US" }, page: { url: `https://${ctx.host}/`, origin: `https://${ctx.host}`, host: ctx.host } },
    } },
    monetization: { enabled: true, pricing_model: "CPX", auction: { enabled: true, floor: { amount: 0, currency: "USD" } } },
  };
  const r = await timed(`${ADMESH}/aip/context`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, 6500, f);
  if (!r.ok) throw new Error(`admesh HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  const rec = j && j.recommendation; const c = rec && rec.creative;
  if (!j || j.status !== "generated" || !c || !(c.brand_name || c.headline)) return null;
  const t = j.tracking || {};
  const brand = c.brand_name || "";
  return {
    provider: "admesh", live: true, label: rec.disclosure || "Sponsored",
    brand, headline: c.headline && c.headline !== brand ? c.headline : brand, body: c.description || "",
    cta: c.cta_text || "Learn more", clickUrl: https(t.click_url || c.landing_page_url), favicon: https(c.logo_url),
    tracking: { exposureUrl: /^https:\/\/api\.useadmesh\.com\//i.test(t.exposure_url || "") ? t.exposure_url : "" },
  };
}

// ------------------------------------------------------------- AgentAds
const AGENTADS = "https://api.tryagentads.com";
const AA_HDR = "impact-wait/0.1.0 (agentads-sdk-0.5.0-compatible)";
async function agentads(ctx: Ctx, key: string, f: typeof fetch): Promise<Ad | null> {
  const response = ctx.response || ctx.query;
  const r = await timed(`${AGENTADS}/v1/bid`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-AgentAds-SDK": AA_HDR },
    body: JSON.stringify({ query: ctx.query.slice(0, 500), response: response.slice(0, 300), format: "suffix", sessionId: ctx.sessionId, context: { timestamp: Date.now(), responseLength: response.length } }),
  }, 2500, f);
  if (!r.ok) throw new Error(`agentads HTTP ${r.status}`);
  const j = await r.json().catch(() => null);
  if (!j || !j.filled || !j.ad) return null;
  const a = j.ad;
  return {
    provider: "agentads", live: true, label: a.label || "Sponsored",
    brand: a.brand || a.advertiser || "", headline: a.headline || "", body: a.description || "",
    cta: a.cta || a.ctaText || "Learn more", clickUrl: https(a.clickUrl), favicon: https(a.favicon),
    tracking: { trackingId: a.trackingId || "" },
  };
}

// ---------------------------------------------------------------- House
// Kevin's Dub partner links; utm_medium=impactwait keeps this traffic separate in Dub.
export const HOUSE = [
  { id: "wispr", brand: "Wispr Flow", headline: "Talk instead of type", body: "Voice dictation that works in every app.", cta: "Try free", url: "https://ref.wisprflow.ai/np-g1?utm_source=np&utm_medium=impactwait&utm_campaign=impactwait-wf", keywords: "write|writing|email|draft|essay|blog|post|copy|type|typing|dictat|voice|speech|slack|message|reply|letter|code|coding|prompt" },
  { id: "granola", brand: "Granola", headline: "AI meeting notes, no bot", body: "Notes from every call without a bot joining. First month free.", cta: "Try free", url: "https://go.granola.ai/np-g1?utm_source=np&utm_medium=impactwait&utm_campaign=impactwait-gr", keywords: "meeting|call|zoom|notes|note-taking|transcri|summar|agenda|standup|interview|client|sales call|1:1|one-on-one|minutes" },
];
export function house(ctx: Ctx): Ad {
  const text = `${ctx.query} ${ctx.response || ""}`.toLowerCase();
  let best: typeof HOUSE = [], top = 0;
  for (const h of HOUSE) {
    const s = h.keywords.split("|").filter((k) => text.includes(k)).length;
    if (s > top) { best = [h]; top = s; } else if (s === top) best.push(h);
  }
  const pool = top > 0 ? best : HOUSE;
  const h = pool[Math.floor(Math.random() * pool.length)];
  return { provider: "house", live: false, label: "Sponsored", brand: h.brand, headline: h.headline, body: h.body, cta: h.cta, clickUrl: h.url, tracking: { houseId: h.id } };
}

// ---------------------------------------------------------- Brand safety
// Kevin (2026-09-28): serve every paying network ad; the house ads are last resort only.
// The one hard line: sensitive categories (gambling, adult, drugs, weapons...) never show.
const SENSITIVE = /\b(casino|gambl\w*|betting|sportsbook|poker|slot machines?|lottery|payday loans?|adult|xxx|porn\w*|onlyfans|escort|hookup|sugar daddy|diet pills?|fat burn\w*|cbd|thc|cannabis|marijuana|vape|vaping|e-?cig\w*|tobacco|nicotine|firearms?|guns?|ammo|ammunition|fake id)\b/i;

export function safetyReason(ad: Ad): string | null {
  if (!ad.clickUrl) return "no https landing page";
  if (SENSITIVE.test([ad.brand, ad.headline, ad.body, ad.cta].join(" ")) || SENSITIVE.test(ad.clickUrl)) return "sensitive category";
  return null;
}

// Priority when more than one network fills (Kevin, 2026-09-27): Idlen, AdMesh, AgentAds.
export const RANK = ["idlen", "admesh", "agentads"] as const;
const IMPLS = { idlen, admesh, agentads };

export type Attempt = { provider: string; result: "filled" | "no fill" | "filtered" | "error" | "skipped"; ms: number; note?: string };
// All networks bid at once. The ad is shown during the model's "thinking" time,
// so we answer by `deadlineMs` with the best ad that has arrived; a network that
// is still auctioning is recorded as a timeout.
export async function runChain(ctx: Ctx, keys: Keys, f: typeof fetch = fetch, deadlineMs = 2800): Promise<{ ad: Ad; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const done = new Set<string>();
  const t0 = Date.now();
  const bids = RANK.map(async (name) => {
    const key = keys[name];
    if (!key) { attempts.push({ provider: name, result: "skipped", ms: 0, note: "no key" }); return null; }
    try {
      const raw = await IMPLS[name](ctx, key, f);
      const why = raw ? safetyReason(raw) : null;
      if (!done.has("__deadline")) attempts.push({ provider: name, result: !raw ? "no fill" : why ? "filtered" : "filled", ms: Date.now() - t0, ...(why ? { note: why } : {}) });
      return why ? null : raw;
    } catch (e) {
      if (!done.has("__deadline")) attempts.push({ provider: name, result: "error", ms: Date.now() - t0, note: (e as Error).name === "AbortError" ? "timeout" : String((e as Error).message || e) });
      return null;
    } finally {
      done.add(name);
    }
  });
  const settled: (Ad | null)[] = RANK.map(() => null);
  bids.forEach((p, i) => p.then((ad) => { settled[i] = ad; }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(bids), new Promise((r) => { timer = setTimeout(r, deadlineMs); })]);
  clearTimeout(timer);
  done.add("__deadline");
  for (const name of RANK) if (keys[name] && !done.has(name)) attempts.push({ provider: name, result: "error", ms: Date.now() - t0, note: "timeout" });
  const ad = settled.find(Boolean) || house(ctx);
  return { ad, attempts };
}

// Billable confirmations, fired server-side once the ad has been seen for 1s.
export async function confirmImpression(provider: string, tracking: Record<string, any>, keys: Keys, f: typeof fetch = fetch): Promise<number> {
  if (provider === "idlen" && tracking.impressionToken) {
    const r = await timed(`${IDLEN}/v1/impression`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impressionToken: tracking.impressionToken, adId: tracking.adId, publisherId: tracking.publisherId }) }, 8000, f);
    return r.status;
  }
  if (provider === "admesh" && tracking.exposureUrl) {
    const r = await timed(tracking.exposureUrl, { method: "GET", redirect: "manual" }, 8000, f);
    return r.status;
  }
  if (provider === "agentads" && tracking.trackingId && keys.agentads) {
    const r = await timed(`${AGENTADS}/v1/events`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys.agentads}`, "X-AgentAds-SDK": AA_HDR }, body: JSON.stringify({ type: "impression", trackingId: tracking.trackingId }) }, 8000, f);
    return r.status;
  }
  return 0;
}

export async function reportClick(provider: string, tracking: Record<string, any>, f: typeof fetch = fetch): Promise<number> {
  if (provider === "idlen" && tracking.adId) {
    const r = await timed(`${IDLEN}/v1/click`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adId: tracking.adId, publisherId: tracking.publisherId, requestId: tracking.requestId }) }, 8000, f);
    return r.status;
  }
  return 0; // AdMesh/AgentAds click URLs are already tracked redirects
}
