// Real-browser tests for ImpactWait against the LIVE deployed API.
// Uses site key "iw-selftest"; rows are cleaned up afterwards.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
const here = path.dirname(new URL(import.meta.url).pathname);
const WEB = path.join(here, "../../web");
const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/impact-wait";
const routes = { "/": "index.html", "/demo": "demo.html", "/impact-wait.js": "impact-wait.js" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let file = routes[u.pathname] ? path.join(WEB, routes[u.pathname]) : null;
  if (u.pathname === "/react.html") { res.setHeader("content-type", "text/html"); return res.end('<!doctype html><div id="root"></div><script type="module" src="/react-app.js"></script>'); }
  if (u.pathname === "/react-app.js") file = path.join(here, "react-app.js");
  if (u.pathname === "/made.html") { res.setHeader("content-type", "text/html"); return res.end(fs.readFileSync(path.join(here, "made.html"))); }
  if (u.pathname === "/plain.html") { res.setHeader("content-type", "text/html"); return res.end(fs.readFileSync(path.join(here, "plain.html"))); }
  if (!file) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html");
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(8123, r));
// A non-dev hostname, so the API treats this like a real site (localhost is sandboxed and never counted).
const BASE = "http://iw-selftest.example:8123";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP iw-selftest.example 127.0.0.1"] });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
// Never let tests click through to the real Dub/advertiser links.
await ctx.route(/^https:\/\/(ref\.wisprflow\.ai|go\.granola\.ai)\//, (r) => r.fulfill({ status: 200, body: "stub" }));

function watch(page) {
  const log = [];
  page.on("request", (q) => { if (q.url().startsWith(API)) log.push({ url: q.url(), body: q.postData() }); });
  page.on("response", async (r) => { if (r.url().startsWith(API)) { const e = log.find((l) => l.url === r.url() && !l.status); if (e) { e.status = r.status(); try { e.json = await r.json(); } catch {} } } });
  return log;
}
const shadowText = (page, sel = "impact-wait") => page.evaluate((s) => { const el = document.querySelector(s); return el && !el.hidden ? el.shadowRoot.querySelector(".card").innerText : ""; }, sel);

// ---- created by script after the element is defined (React/Vue path: document.createElement)
{
  fs.writeFileSync(path.join(here, "made.html"), `<!doctype html><body><script src="/impact-wait.js"></script></body>`);
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(BASE + "/made.html");
  await p.waitForFunction(() => !!customElements.get("impact-wait"));
  const res = await p.evaluate(() => { try { const el = document.createElement("impact-wait"); el.setAttribute("site", "iw-selftest"); el.id = "made"; document.body.prepend(el); el.query = "draft a blog post"; el.active = true; return "ok:" + el.hidden; } catch (e) { return "threw:" + e.message; } });
  check("createElement after define: no throw, starts hidden", res === "ok:true", res);
  await p.waitForFunction(() => !document.getElementById("made").hidden, null, { timeout: 8000 }).catch(() => {});
  check("createElement after define: renders an ad", !(await p.evaluate(() => document.getElementById("made").hidden)) && errs.length === 0, JSON.stringify(errs));
  await p.close();
}

// ---- plain HTML embed
fs.writeFileSync(path.join(here, "plain.html"), `<!doctype html><body style="margin:0">
<div id="top" style="padding:20px"><impact-wait id="iw" site="iw-selftest" linger="1200"></impact-wait></div>
<div style="height:3000px"></div>
<div style="padding:20px"><impact-wait id="low" site="iw-selftest" linger="1200"></impact-wait></div>
<script src="/impact-wait.js"></script></body>`);
{
  const p = await ctx.newPage(); const log = watch(p);
  await p.goto(BASE + "/plain.html");
  await p.evaluate(() => { const iw = document.getElementById("iw"); iw.query = "help me write an email to my team"; iw.active = true; });
  await p.waitForFunction(() => !document.getElementById("iw").hidden, null, { timeout: 8000 });
  const txt = await shadowText(p, "#iw");
  check("plain: sponsored line renders with label, ad and impact footer", !/Â|â/.test(txt) && /SPONSORED|Sponsored/i.test(txt) && /Wispr Flow|Granola/.test(txt) && /sponsored waits? so far/.test(txt) && /Powered by ImpactWait/.test(txt), JSON.stringify(txt));
  const home = await p.evaluate(() => document.getElementById("iw").shadowRoot.querySelector(".impact a").href);
  check("plain: 'Powered by' links to the counter with ?ref=site", home === "https://impact-wait.vercel.app/?ref=iw-selftest", home);
  const adReq = log.find((l) => l.url.endsWith("/ad"));
  check("plain: one /ad request with site + query, HTTP 200", log.filter((l) => l.url.endsWith("/ad")).length === 1 && adReq.status === 200 && JSON.parse(adReq.body).query.includes("email"), JSON.stringify(adReq && { status: adReq.status, body: adReq.body }));
  check("plain: no tracking tokens reach the browser", adReq.json && !JSON.stringify(adReq.json).includes("tracking") && /\/click\?id=/.test(adReq.json.ad.clickUrl), adReq.json && adReq.json.ad.clickUrl);
  await sleep(700);
  check("plain: no impression before 1s visible", !log.some((l) => l.url.endsWith("/event")));
  await sleep(900);
  const ev = log.filter((l) => l.url.endsWith("/event"));
  check("plain: exactly one impression after 1s visible, counted by server", ev.length === 1 && ev[0].json && ev[0].json.counted === true, JSON.stringify(ev.map((e) => e.json)));
  const ctaHref = await p.evaluate(() => document.getElementById("iw").shadowRoot.querySelector(".cta").href);
  // Follow the server redirect by hand (never actually visiting the advertiser, so no real Dub clicks).
  const red = await fetch(ctaHref, { redirect: "manual" });
  const loc = red.headers.get("location") || "";
  check("plain: CTA goes through the server click redirect to the advertiser", /\/impact-wait\/click\?id=/.test(ctaHref) && red.status === 302 && /^https:\/\/(ref\.wisprflow\.ai|go\.granola\.ai)\/np-g1\?utm_source=np&utm_medium=impactwait/.test(loc), `${red.status} ${loc}`);
  const tgt = await p.evaluate(() => { const a = document.getElementById("iw").shadowRoot.querySelector(".cta"); return [a.target, a.rel]; });
  check("plain: CTA opens in a new tab, marked sponsored", tgt[0] === "_blank" && /sponsored/.test(tgt[1]) && /noopener/.test(tgt[1]), tgt.join(" "));
  await p.evaluate(() => { document.getElementById("iw").active = false; });
  await sleep(600);
  check("plain: still visible during linger", !(await p.evaluate(() => document.getElementById("iw").hidden)));
  await sleep(1000);
  check("plain: hides after linger", await p.evaluate(() => document.getElementById("iw").hidden));

  // Below the fold: no impression while off screen, one after scrolling into view.
  log.length = 0;
  await p.evaluate(() => { const iw = document.getElementById("low"); iw.query = "meeting notes summary"; iw.active = true; });
  await p.waitForFunction(() => !document.getElementById("low").hidden, null, { timeout: 8000 });
  await sleep(1800);
  check("offscreen: no impression while below the fold", !log.some((l) => l.url.endsWith("/event")));
  await p.evaluate(() => document.getElementById("low").scrollIntoView());
  await sleep(1600);
  check("offscreen: impression once scrolled into view for 1s", log.filter((l) => l.url.endsWith("/event")).length === 1);

  // Hidden tab: no impression.
  log.length = 0;
  await p.evaluate(() => { document.getElementById("low").active = false; window.scrollTo(0, 0); });
  await sleep(1400);
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); const iw = document.getElementById("iw"); iw.query = "best postgres host"; iw.active = true; });
  await p.waitForFunction(() => !document.getElementById("iw").hidden, null, { timeout: 8000 });
  await sleep(1800);
  check("hidden tab: no impression", !log.some((l) => l.url.endsWith("/event")));
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await sleep(1500);
  check("hidden tab: impression once the tab is visible again", log.filter((l) => l.url.endsWith("/event")).length === 1);
  await p.evaluate(() => { document.getElementById("iw").active = false; });

  // No site / no query: no request.
  await p.waitForFunction(() => document.getElementById("iw").hidden, null, { timeout: 5000 });
  log.length = 0;
  await p.evaluate(() => { const iw = document.getElementById("iw"); iw.query = ""; iw.active = true; });
  await sleep(800);
  check("no query: no request, nothing shown", !log.length && (await p.evaluate(() => document.getElementById("iw").hidden)));
  await p.evaluate(() => { document.getElementById("iw").active = false; });

  // Dark theme + narrow width
  await p.setViewportSize({ width: 360, height: 700 });
  await p.evaluate(() => { const iw = document.getElementById("iw"); iw.setAttribute("theme", "dark"); iw.query = "write an email"; iw.active = true; });
  await p.waitForFunction(() => !document.getElementById("iw").hidden, null, { timeout: 8000 });
  await sleep(400);
  const m = await p.evaluate(() => { const c = document.getElementById("iw").shadowRoot.querySelector(".card"); return { w: c.getBoundingClientRect().width, sw: document.documentElement.scrollWidth, bg: getComputedStyle(c).backgroundColor }; });
  check("narrow 360px: fits without horizontal scroll", m.w <= 340 && m.sw <= 360, JSON.stringify(m));
  check("dark theme applies", m.bg === "rgb(35, 35, 35)", m.bg);
  await p.screenshot({ path: path.join(here, "shot-plain-dark-narrow.png") });
  await p.close();
}

// ---- React wrapper
{
  const p = await ctx.newPage(); const log = watch(p);
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(BASE + "/react.html");
  await p.waitForFunction(() => typeof window.__go === "function");
  await p.evaluate(() => window.__go("Best Postgres host for a small SaaS?"));
  await p.waitForFunction(() => (window.__events || []).some((e) => e[0] === "ad"), null, { timeout: 8000 });
  await p.waitForFunction(() => (window.__events || []).some((e) => e[0] === "imp"), null, { timeout: 5000 }).catch(() => {});
  const evs = await p.evaluate(() => window.__events.map((e) => e[0]));
  check("react: onAd and onImpression fire", evs.includes("ad") && evs.includes("imp"), JSON.stringify(evs));
  check("react: exactly one /ad request per activation", log.filter((l) => l.url.endsWith("/ad")).length === 1, String(log.filter((l) => l.url.endsWith("/ad")).length));
  await p.evaluate(() => window.__stop());
  await sleep(1900);
  check("react: hides after active=false + linger", await p.evaluate(() => document.querySelector("impact-wait").hidden));
  check("react: no page errors", errs.length === 0, errs.join(" | "));
  await p.close();
}

// ---- Demo page
{
  const p = await ctx.newPage(); const log = watch(p);
  await p.goto(BASE + "/demo");
  await p.click("#chips button:nth-child(2)");
  await p.waitForFunction(() => !document.getElementById("iw").hidden, null, { timeout: 8000 });
  await sleep(1500);
  const txt = await shadowText(p, "#iw");
  check("demo: sponsored line shows while 'thinking'", /Wispr Flow|Granola/.test(txt), txt.replace(/\n/g, " | "));
  const adBody = JSON.parse(log.find((l) => l.url.endsWith("/ad")).body);
  check("demo: uses site key 'demo' and the chip text as query", adBody.site === "demo" && /email/.test(adBody.query));
  await p.screenshot({ path: path.join(here, "shot-demo.png") });
  await sleep(7000);
  check("demo: reply shown and slot hidden after linger", (await p.locator(".msg.ai").count()) === 1 && (await p.evaluate(() => document.getElementById("slot").hidden)));
  await p.close();
}

// ---- Counter page matches the API
{
  const p = await ctx.newPage();
  await p.goto(BASE + "/?ref=iw-selftest");
  await p.waitForFunction(() => /\d/.test(document.getElementById("waits").textContent), null, { timeout: 8000 });
  await sleep(1200);
  const api = await (await fetch(API + "/stats")).json();
  const shown = await p.evaluate(() => document.getElementById("waits").textContent.replace(/,/g, ""));
  check("counter: big number equals live API total", Number(shown) === api.total.sponsored_waits, `page ${shown} api ${api.total.sponsored_waits}`);
  check("counter: ref banner + leaderboard include the site", (await p.textContent("#ref")).includes("iw-selftest") && (await p.textContent("#board")).includes("iw-selftest"));
  check("counter: cause section is honest while no partner is set", /announcing soon/.test(await p.textContent("#cause")));
  await p.screenshot({ path: path.join(here, "shot-counter.png"), fullPage: true });
  await p.setViewportSize({ width: 360, height: 800 });
  check("counter: no horizontal scroll at 360px", (await p.evaluate(() => document.documentElement.scrollWidth)) <= 360);
  await p.close();
}

await browser.close(); server.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
