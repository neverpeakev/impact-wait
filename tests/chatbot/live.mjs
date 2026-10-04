// Real Chromium + real Vercel chatbot build (mock LLM) + LIVE Goodwait API.
// On localhost the API runs in sandbox mode: house ad only, nothing counted, no site registered.
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3100";
const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BEFORE = await (await fetch(`${API}/stats`)).json();
const browser = await chromium.launch();

async function session({ chatDelayMs = 0, colorScheme = "light", viewport = { width: 1280, height: 860 } } = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme, viewport });
  const page = await ctx.newPage();
  const log = { adReqs: [], adResps: [], events: [], consoleErrors: [] };
  page.on("console", (m) => { if (m.type() === "error") log.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => log.consoleErrors.push(String(e)));
  await page.route(`${API}/ad`, async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    log.adReqs.push({ ...body, t: Date.now() });
    const r = await route.fetch();
    const j = await r.json();
    log.adResps.push(j);
    await route.fulfill({ response: r, json: j });
  });
  await page.route(`${API}/event`, async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    log.events.push({ body: JSON.parse(route.request().postData() || "{}"), resp: j, t: Date.now() });
    await route.fulfill({ response: r, json: j });
  });
  if (chatDelayMs) {
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await sleep(chatDelayMs);
      await route.continue();
    });
  }
  return { ctx, page, log };
}

async function send(page, text) {
  await page.getByTestId("multimodal-input").fill(text);
  await page.getByTestId("send-button").click();
}

// 1. Zero-config, shown while thinking, impression counted, then hides.
{
  const { ctx, page, log } = await session({ chatDelayMs: 4000 });
  await page.goto("/");
  await page.waitForSelector("[data-testid='multimodal-input']");
  await sleep(1500);
  ok("no ad request on page load", log.adReqs.length === 0, JSON.stringify(log.adReqs));
  const q = "what running shoes are best for flat feet";
  const t0 = Date.now();
  await send(page, q);
  await page.getByTestId("message-assistant-loading").waitFor({ timeout: 5000 });
  const iw = page.getByTestId("good-wait");
  await iw.locator(".card.on").waitFor({ timeout: 6000 }).catch(() => {});
  const thinkingStill = await page.getByTestId("message-assistant-loading").isVisible();
  ok("ad visible while 'thinking' is still on screen", thinkingStill && (await iw.isVisible()), `thinking=${thinkingStill}`);
  const req = log.adReqs[0] || {};
  ok("zero-config site key derived from domain (localhost)", req.site === "localhost", JSON.stringify(req.site));
  ok("query = user's message", req.query === q, JSON.stringify(req.query));
  ok("one ad request per message", log.adReqs.length === 1, String(log.adReqs.length));
  const text = await iw.evaluate((el) => el.shadowRoot.textContent);
  ok("labeled Sponsored", /sponsored/i.test(text), text.slice(0, 120));
  ok("sandbox: API flags localhost as test mode", log.adResps[0]?.sandbox === true && log.adResps[0]?.ad?.provider === "house", JSON.stringify(log.adResps[0]));
  ok("shows 'Test mode' note + Powered by Goodwait", text.includes("Test mode on this host - views are not counted") && text.includes("Powered by Goodwait"), text);
  const hrefs = await iw.evaluate((el) => [...el.shadowRoot.querySelectorAll("a")].map((a) => a.href));
  ok("ad links go through Goodwait click redirect", hrefs.filter((h) => h.startsWith(`${API}/click?id=`)).length === 2, JSON.stringify(hrefs));
  ok("self-promo link carries ?ref=localhost", hrefs.some((h) => h.endsWith("/?ref=localhost")), JSON.stringify(hrefs));
  const tok = JSON.stringify(log.adResps);
  ok("no network tokens in browser payload", !/idl_pk_|Bearer|api[_-]?key/i.test(tok));
  await page.waitForFunction(() => document.querySelectorAll("[data-role='assistant']").length > 0 && !document.querySelector("[data-testid='message-assistant-loading']"), null, { timeout: 15000 });
  const ev = log.events[0];
  ok("impression reported once, >=1s after render; sandbox => not counted", log.events.length === 1 && ev.resp.counted === false && ev.resp.sandbox === true && ev.t - t0 >= 1000, JSON.stringify(log.events));
  // reply finished -> linger 4s -> hidden
  await page.waitForFunction(() => document.querySelector("[data-testid='good-wait']")?.hidden === true, null, { timeout: 9000 }).catch(() => {});
  ok("hides after reply finishes (linger)", await iw.evaluate((el) => el.hidden));
  // 2nd message -> new ad with new query
  await send(page, "any tips for a first marathon");
  await page.waitForFunction(() => document.querySelector("[data-testid='good-wait']")?.hidden === false, null, { timeout: 8000 }).catch(() => {});
  ok("second message gets a fresh ad", log.adReqs.length === 2 && log.adReqs[1].query === "any tips for a first marathon" && (await iw.isVisible()), JSON.stringify(log.adReqs.map((r) => r.query)));
  ok("no console errors", log.consoleErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e)).length === 0, JSON.stringify(log.consoleErrors));
  await page.screenshot({ path: "shot-light.png" });
  await ctx.close();
}

// 2. Fast reply (no artificial delay): still renders, doesn't get stuck on screen.
{
  const { ctx, page, log } = await session();
  await page.goto("/");
  await page.waitForSelector("[data-testid='multimodal-input']");
  await send(page, "hello there");
  await sleep(1200);
  ok("fast reply: ad request still made", log.adReqs.length === 1);
  await page.waitForFunction(() => document.querySelector("[data-testid='good-wait']")?.hidden === true, null, { timeout: 12000 }).catch(() => {});
  ok("fast reply: ad does not stay stuck on screen", await page.getByTestId("good-wait").evaluate((el) => el.hidden));
  await ctx.close();
}

// 3. Dark mode + phone width.
{
  const { ctx, page } = await session({ chatDelayMs: 3000, colorScheme: "dark", viewport: { width: 390, height: 780 } });
  await page.goto("/");
  await page.waitForSelector("[data-testid='multimodal-input']");
  await send(page, "cheap laptop for college");
  const iw = page.getByTestId("good-wait");
  await iw.locator(".card.on").waitFor({ timeout: 7000 }).catch(() => {});
  ok("dark: theme attr follows app theme", (await iw.getAttribute("theme")) === "dark", await iw.getAttribute("theme"));
  const box = await iw.boundingBox();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("phone width: fits, no horizontal scroll", box && box.x >= 0 && box.x + box.width <= 390 && over <= 0, JSON.stringify({ box, over }));
  await page.screenshot({ path: "shot-dark-mobile.png" });
  await ctx.close();
}

// 4. Nothing from this run reached the public counter.
{
  const after = await (await fetch(`${API}/stats`)).json();
  ok("public counter unchanged by local-dev traffic", after.total.sponsored_waits === BEFORE.total.sponsored_waits && after.total.clicks === BEFORE.total.clicks, JSON.stringify([BEFORE.total, after.total]));
  const loc = await (await fetch(`${API}/stats?site=localhost`)).json();
  ok("no public 'localhost' site was created", loc.site === null, JSON.stringify(loc.site));
}

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
