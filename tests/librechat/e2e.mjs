// Real Chromium + real LibreChat (production build, MongoDB) + mock OpenAI-compatible model
// that "thinks" 4s (port 9200) + LIVE Goodwait API.
// localhost is sandboxed by the API (house ad, never counted). One counted-path check runs on a
// non-dev hostname (iw-libre.example -> 127.0.0.1); its site key is printed so the rows can be cleaned.
import { execSync, spawn } from "node:child_process";
import { chromium } from "playwright";

const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait";
const USER = { email: "qa@example.com", password: "Test-pass-12345" };
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env = {}) {
  try { execSync("for p in $(ps -eo pid,args | awk '/node api\\/server\\/index.js/ && !/awk/ {print $1}'); do kill $p; done"); } catch {}
  await sleep(1500);
  const child = spawn(process.env.LIBRECHAT_START || "./start.sh", Object.entries(env).map(([k, v]) => `${k}=${v}`), { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 60; i++) { try { if ((await (await fetch("http://127.0.0.1:3080/health")).text()).includes("OK")) return; } catch {} await sleep(1000); }
  throw new Error("LibreChat did not start");
}

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP iw-libre.example 127.0.0.1"] });
async function session({ base = "http://localhost:3080", viewport = { width: 1280, height: 860 }, dark = false, optOut = false, fakeAd = false } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? "dark" : "light" });
  if (dark || optOut) await ctx.addInitScript(([d, o]) => { if (d) localStorage.setItem("color-theme", "dark"); if (o) localStorage.setItem("showGoodwait", "false"); }, [dark, optOut]);
  const page = await ctx.newPage();
  const log = { ad: [], adResp: [], ev: [], errors: [] };
  page.on("pageerror", (e) => log.errors.push(String(e)));
  if (fakeAd) {
    await page.route(`${API}/ad`, (r) => { log.ad.push({ body: JSON.parse(r.request().postData() || "{}"), t: Date.now() }); r.fulfill({ json: { id: "00000000-0000-0000-0000-000000000001", ad: { provider: "house", label: "Sponsored", brand: "FakeBrand", headline: "Fake", body: "x", cta: "Go", clickUrl: `${API}/click?id=00000000-0000-0000-0000-000000000001` }, impact: { sponsored_waits: 1 } } }); });
    await page.route(`${API}/event`, (r) => { log.ev.push({ resp: { ok: true }, t: Date.now() }); r.fulfill({ json: { ok: true, counted: false } }); });
  } else {
    page.on("request", (r) => { if (r.url() === `${API}/ad`) log.ad.push({ body: JSON.parse(r.postData() || "{}"), t: Date.now() }); });
    page.on("response", async (r) => {
      if (r.url() === `${API}/ad`) log.adResp.push(await r.json().catch(() => null));
      if (r.url() === `${API}/event`) log.ev.push({ resp: await r.json().catch(() => null), t: Date.now() });
    });
  }
  await page.goto(base + "/login");
  await page.fill("#email", USER.email); await page.fill("#password", USER.password); await page.keyboard.press("Enter");
  await page.waitForURL(/\/c\//, { timeout: 20000 });
  await page.locator("textarea").first().waitFor();
  return { ctx, page, log };
}
async function send(page, text) { const ta = page.locator("textarea").first(); await ta.click(); await ta.fill(text); await page.keyboard.press("Enter"); }
const iwState = (page) => page.evaluate(() => { const e = document.querySelector("good-wait"); return e ? { hidden: e.hidden, site: e.getAttribute("site"), theme: e.getAttribute("theme"), text: e.shadowRoot.textContent, links: [...e.shadowRoot.querySelectorAll("a")].map((a) => ({ href: a.href, target: a.target })) } : null; });
const replyDone = (page, q) => page.getByText(`Mock answer to: ${q}`).first().waitFor({ timeout: 20000 });

// 1. Default config on localhost (sandbox)
await startServer();
{
  const { ctx, page, log } = await session();
  await sleep(1500);
  ok("no ad request on page load", log.ad.length === 0);
  const q = "help me write an email to my team about the offsite";
  await send(page, q); const sentAt = Date.now();
  let st = null;
  for (let i = 0; i < 40; i++) { await sleep(100); st = await iwState(page); if (st && !st.hidden && st.text) break; }
  const replyVisible = await page.getByText(`Mock answer to: ${q}`).first().isVisible().catch(() => false);
  ok("sponsored line visible while the model is still thinking", !!st && !st.hidden && /sponsored/i.test(st.text) && !replyVisible, JSON.stringify(st));
  ok("one /ad request; site derived from host; query = user message", log.ad.length === 1 && log.ad[0].body.site === "localhost" && log.ad[0].body.query === q, JSON.stringify(log.ad));
  ok("localhost is sandboxed: house ad + 'Test mode' note", log.adResp[0]?.sandbox === true && st?.text.includes("Test mode on this host - views are not counted"), JSON.stringify(log.adResp[0]));
  ok("ad links go through click redirect, open in new tab (not clicked)", st?.links.filter((l) => l.href.startsWith(`${API}/click?id=`) && l.target === "_blank").length === 2, JSON.stringify(st?.links));
  ok("no network tokens in the browser", !/idl_pk_|Bearer|impressionToken|exposure/i.test(JSON.stringify(log.adResp)));
  await page.screenshot({ path: "shot-light.png" });
  await replyDone(page, q);
  await sleep(300);
  ok("impression reported once, >=1s after send; sandbox => not counted", log.ev.length === 1 && log.ev[0].resp?.counted === false && log.ev[0].resp?.sandbox === true && log.ev[0].t - sentAt >= 1000, JSON.stringify(log.ev));
  let hidden = false; for (let i = 0; i < 60 && !hidden; i++) { await sleep(150); hidden = (await iwState(page))?.hidden !== false; }
  ok("hides after the reply finishes", hidden);
  const q2 = "any tips for a first marathon";
  await send(page, q2);
  let st2 = null; for (let i = 0; i < 40; i++) { await sleep(100); st2 = await iwState(page); if (st2 && !st2.hidden && st2.text) break; }
  ok("second message gets a fresh ad", log.ad.length === 2 && log.ad[1].body.query === q2 && st2 && !st2.hidden, JSON.stringify(log.ad.map((a) => a.body.query)));
  await replyDone(page, q2);
  ok("zero page errors", log.errors.length === 0, JSON.stringify(log.errors));
  await ctx.close();
}
// 2. Per-user opt-out (Settings > Chat > "Show Sponsored Line While Waiting")
{
  const { ctx, page, log } = await session({ optOut: true });
  const q = "user opted out check"; await send(page, q); await replyDone(page, q);
  ok("user opt-out: nothing rendered, no ad request", log.ad.length === 0 && !(await iwState(page)));
  await ctx.close();
}
// 2b. The toggle exists in Settings
{
  const { ctx, page } = await session();
  await page.goto("http://localhost:3080/c/new?settings=chat").catch(() => {});
  await page.getByText("Show Sponsored Line While Waiting").first().waitFor({ timeout: 4000 }).catch(() => {});
  let found = await page.getByText("Show Sponsored Line While Waiting").first().isVisible().catch(() => false);
  if (!found) {
    // open Settings through the account menu
    await page.locator("[data-testid='nav-user'], button[aria-label*='ccount' i]").first().click().catch(() => {});
    await page.getByText(/^Settings$/).first().click().catch(() => {});
    await page.getByRole("tab", { name: /Chat/ }).first().click().catch(() => {});
    await page.getByText("Show Sponsored Line While Waiting").first().waitFor({ timeout: 5000 }).catch(() => {});
    found = await page.getByText("Show Sponsored Line While Waiting").first().isVisible().catch(() => false);
  }
  await page.screenshot({ path: "shot-settings.png" });
  ok("Settings shows the per-user toggle", found);
  await ctx.close();
}
// 3. Dark mode + phone width
{
  const { ctx, page } = await session({ dark: true, viewport: { width: 390, height: 780 } });
  const q = "cheap laptop for college"; await send(page, q);
  let st = null; for (let i = 0; i < 40; i++) { await sleep(100); st = await iwState(page); if (st && !st.hidden && st.text) break; }
  const box = await page.locator("good-wait").boundingBox();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("dark: theme attribute follows LibreChat theme", st?.theme === "dark", st?.theme);
  ok("390px: fits, no horizontal scroll", box && box.x >= 0 && box.x + box.width <= 390 && over <= 0, JSON.stringify({ box, over }));
  await page.screenshot({ path: "shot-dark-mobile.png" });
  await replyDone(page, q);
  await ctx.close();
}
// 4. GOODWAIT_SITE is used when set (API faked, nothing hits the live counter)
await startServer({ GOODWAIT_SITE: "Lincoln-High" });
{
  const { ctx, page, log } = await session({ fakeAd: true });
  const q = "site key check"; await send(page, q); await replyDone(page, q);
  ok("GOODWAIT_SITE sets the site key", log.ad.length === 1 && log.ad[0].body.site === "lincoln-high", JSON.stringify(log.ad));
  await ctx.close();
}
// 5. GOODWAIT=off disables it for everyone
await startServer({ GOODWAIT: "off" });
{
  const { ctx, page, log } = await session();
  const q = "operator off check"; await send(page, q); await replyDone(page, q);
  ok("GOODWAIT=off: nothing rendered, no ad request", log.ad.length === 0 && !(await iwState(page)));
  await ctx.close();
}
// 6. Counted path on a real (non-dev) hostname
await startServer({ DOMAIN_CLIENT: "http://iw-libre.example:3080", DOMAIN_SERVER: "http://iw-libre.example:3080" });
if (process.env.COUNTED !== "0") {
  const { ctx, page, log } = await session({ base: "http://iw-libre.example:3080" });
  const q = "help me plan a team offsite agenda"; await send(page, q); await replyDone(page, q); await sleep(500);
  console.log("COUNTED-PATH SITE KEY:", log.ad[0]?.body.site);
  ok("real hostname: site key iw-libre-example, view counted by the server", log.ad[0]?.body.site === "iw-libre-example" && !log.adResp[0]?.sandbox && log.ev.length === 1 && log.ev[0].resp?.counted === true, JSON.stringify({ ad: log.ad, ev: log.ev }));
  await ctx.close();
}
await startServer();
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
