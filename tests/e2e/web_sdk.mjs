// Real-browser test of the vibedough.com web chat's Velocity Web SDK path (web/app.html).
// Serves web/ on localhost, so the page puts the SDK in devMode (Velocity's mock ads: nothing billed).
// The Vibedough API is stubbed (a signed-in, chat-only account); Velocity's CDN, /init and /v2/load are
// real requests (the ?vlc=raw run stubs the gateway). Checks: SDK script loads with SRI, init succeeds, an ad loads into the chat slot,
// the SDK fires the impression, the view is reported once to /account/impression, the line is a
// keyboard-reachable link the SDK opens, and ?vlc=raw still takes the old gateway path.
// Run: cd tests/e2e && npm i && npx playwright install chromium && node web_sdk.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(new URL(import.meta.url).pathname);
const WEB = path.join(here, "../../web");
const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait";
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const file = u.pathname === "/app" ? "app.html" : u.pathname === "/auth.js" ? "auth.js" : null;
  if (!file) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(fs.readFileSync(path.join(WEB, file)));
});
await new Promise((r) => server.listen(8124, r));
const BASE = "http://localhost:8124";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCT = { email: "selftest@example.com", installed: false, web_only: true, installs: 0, chat_open: true, ad_user_id: "selftest-user", install_code: "VD-TEST-0000", install_command: "echo test", views_today: 0, earnings: null, paypal_email: null, payout_ready: false, w9: { on_file: false }, last_seen_at: null };

async function run(query) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const impressions = [], vlc = [], errors = [];
  await ctx.route(`${API}/**`, async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^\/functions\/v1\/goodwait/, "");
    if (p === "/account/me") return route.fulfill({ json: ACCT });
    if (p === "/account/chats") return route.fulfill({ json: { chats: [] } });
    if (p === "/account/chat") { await sleep(2500); return route.fulfill({ json: { reply: "Use Vite with esbuild.", chat_id: "c1", title: "Vite" } }); }
    if (p === "/account/impression") { impressions.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, counted: true, credited: true } }); }
    return route.fulfill({ json: {} });
  });
  // The raw run must never put a real ad or impression on the account: stub the gateway (no fill).
  if (query.includes("vlc=raw")) await ctx.route(/^https:\/\/gw\.vlcapi\.net\//, (r) => r.fulfill({ status: r.request().url().endsWith("/init") ? 200 : 204, json: r.request().url().endsWith("/init") ? { sessionId: "selftest-session" } : undefined }));
  // Count Velocity calls without changing them.
  ctx.on("request", (r) => { if (/vlcapi\.net/.test(r.url())) vlc.push(r.url().replace(/\?.*$/, "")); });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("vd_session", JSON.stringify({ access_token: "test", refresh_token: "test", expires_at: Math.floor(Date.now() / 1000) + 86400, email: "selftest@example.com" })));
  let popup = null;
  ctx.on("page", (p) => { popup = p; });
  await page.goto(`${BASE}/app${query}`);
  await page.waitForSelector("#q", { timeout: 10000 });
  await page.fill("#q", "How do I speed up my React app build with Vite?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sponsor", { timeout: 10000 }).catch(() => {});
  await sleep(2500);
  const state = await page.evaluate(() => ({ diag: window.__vdVelocity || null, sponsor: document.querySelector(".sponsor")?.textContent || "", role: document.querySelector(".sponsor")?.getAttribute("role") || "", href: document.querySelector(".sponsor")?.getAttribute("href") }));
  let opened = "";
  if (query === "" && state.sponsor) {
    await page.focus(".sponsor");
    await page.keyboard.press("Enter");
    await sleep(1500);
    opened = popup ? popup.url() : "";
  }
  await browser.close();
  return { impressions, vlc, errors, state, opened };
}

// SDK path (default).
const a = await run("");
check("no page errors", a.errors.length === 0, a.errors.join(" | "));
check("SDK script loaded from Velocity's CDN (SRI ok)", a.vlc.some((u) => u.includes("cdn.vlcapi.net/web-sdk/v-0.11.0/")), a.vlc.join(", "));
check("SDK init ok, devMode on localhost", a.state.diag && a.state.diag.mode === "sdk" && a.state.diag.init === "ok" && a.state.diag.dev === true, JSON.stringify(a.state.diag));
check("reports the vibedough-web-chat unit", a.state.diag && a.state.diag.unit === "aae252cd6ea3");
check("an ad rendered in the chat", /Sponsored/i.test(a.state.sponsor), a.state.sponsor);
check("the SDK fired the impression", !!a.state.diag && a.state.diag.loads.some((l) => l.event === "impression"), JSON.stringify(a.state.diag && a.state.diag.loads));
check("the view was reported once to /account/impression", a.impressions.length === 1 && /^sdk-[0-9a-f]{12}$/.test(a.impressions[0].request_id) && a.impressions[0].network === "velocity", JSON.stringify(a.impressions));
check("no direct gateway /v2/load call from our code in devMode", !a.vlc.some((u) => u.endsWith("gw.vlcapi.net/v2/load")), a.vlc.join(", "));
check("the line is a link-role element without an href", a.state.role === "link" && a.state.href === null, `${a.state.role} ${a.state.href}`);
check("Enter on the line opens the ad via the SDK", !!a.opened, a.opened);

// Raw fallback flag still takes the old path.
const b = await run("?vlc=raw");
check("?vlc=raw: no page errors", b.errors.length === 0, b.errors.join(" | "));
check("?vlc=raw: calls the gateway directly, never loads the SDK", b.vlc.some((u) => u.endsWith("gw.vlcapi.net/init")) && !b.vlc.some((u) => u.includes("cdn.vlcapi.net")), b.vlc.join(", "));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
