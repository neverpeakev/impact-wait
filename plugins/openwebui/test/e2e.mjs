// Real Chromium + real Open WebUI (0.11.x) + mock OpenAI model (4s "thinking") + LIVE Goodwait API.
// Prereqs: mock-openai.mjs on :9100, Open WebUI on :8080 (WEBUI_AUTH=False), filter installed via install.mjs (site iw-selftest).
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const B = "http://127.0.0.1:8080";
const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS", n); } else { fail++; console.log("FAIL", n, x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tok = (await (await fetch(`${B}/api/v1/auths/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "", password: "" }) })).json()).token;
if (!tok) throw new Error("Open WebUI sign-in failed");
const H = { "content-type": "application/json", authorization: `Bearer ${tok}` };
const api = (path, body) => fetch(`${B}/api/v1${path}`, { method: body ? "POST" : "GET", headers: H, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const browser = await chromium.launch();
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const log = { ad: [], adResp: [], ev: [], errors: [] };
  page.on("request", async (r) => { if (r.url() === `${API}/ad`) { const e = { body: JSON.parse(r.postData() || "{}"), t: Date.now() }; log.ad.push(e); e.origin = (await r.allHeaders().catch(() => ({}))).origin; } });
  page.on("response", async (r) => {
    if (r.url() === `${API}/ad`) log.adResp.push(await r.json().catch(() => null));
    if (r.url() === `${API}/event`) log.ev.push({ resp: await r.json().catch(() => null), t: Date.now() });
  });
  page.on("pageerror", (e) => log.errors.push(String(e)));
  await page.goto(B + "/");
  await page.locator("#chat-input").waitFor();
  await page.getByText("Okay, Let's Go!").click({ timeout: 3000 }).catch(() => {});
  return { ctx, page, log };
}
async function send(page, text) { await page.locator("#chat-input").click(); await page.keyboard.type(text); await page.keyboard.press("Enter"); }
const ourFrames = (page) => page.evaluate(() => [...document.querySelectorAll("iframe")].filter((f) => (f.getAttribute("srcdoc") || "").includes("data-good-wait-embed")).map((f) => ({ h: f.getBoundingClientRect().height, sandbox: f.getAttribute("sandbox") })));
const cardIn = async (page) => { for (const f of page.frames()) { const t = await f.evaluate(() => { const el = document.querySelector("good-wait"); return el && !el.hidden ? el.shadowRoot.textContent : null; }).catch(() => null); if (t) return { frame: f, text: t }; } return null; };

// 1. Main flow
{
  const { ctx, page, log } = await newPage();
  const q = "help me write an email to my team about the offsite";
  await send(page, q);
  const sentAt = Date.now();
  let card = null;
  for (let i = 0; i < 30 && !card; i++) { await sleep(100); card = await cardIn(page); }
  ok("sponsored line shows while the model is still thinking", !!card && /sponsored/i.test(card.text) && !(await page.getByText("Mock answer to:").isVisible()), card && card.text);
  ok("ad request comes from the user's browser with site key + message", log.ad.length === 1 && log.ad[0].body.site === "iw-selftest" && log.ad[0].body.query === q, JSON.stringify(log.ad));
  ok("request origin is the sandboxed embed (null), not the server", log.ad[0]?.origin === "null", log.ad[0]?.origin);
  await sleep(300);
  const fr = await ourFrames(page);
  ok("embed is sandboxed without same-origin", fr.length === 1 && !/allow-same-origin/.test(fr[0].sandbox || ""), JSON.stringify(fr));
  ok("embed auto-sizes to the card (no big blank gap)", fr.length === 1 && fr[0].h > 30 && fr[0].h < 90, JSON.stringify(fr));
  if (card) {
    const links = await card.frame.evaluate(() => [...document.querySelector("good-wait").shadowRoot.querySelectorAll("a")].map((a) => ({ href: a.href, target: a.target })));
    ok("ad links go through the click redirect and open in a new tab", links.filter((l) => l.href.startsWith(`${API}/click?id=`) && l.target === "_blank").length === 2, JSON.stringify(links));
    ok("no network tokens in the browser", !/idl_pk_|Bearer|impressionToken|exposure/i.test(JSON.stringify(log.adResp)));
  }
  await page.getByText("Mock answer to:").waitFor({ timeout: 15000 });
  const ev = log.ev[0];
  ok("impression counted once, only after >=1s on screen", log.ev.length === 1 && ev.resp?.counted === true && ev.t - sentAt >= 1000, JSON.stringify(log.ev));
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(150); gone = (await ourFrames(page)).length === 0; }
  ok("embed removed when the reply finishes", gone);
  const chatId = page.url().split("/c/")[1];
  const chat = chatId ? await api(`/chats/${chatId}`) : null;
  const msgs = chat ? Object.values(chat.chat?.history?.messages || {}) : [];
  const stored = JSON.stringify(msgs.map((m) => m.embeds || []));
  ok("nothing sponsored is saved in the chat history", !!chatId && msgs.length >= 2 && !stored.includes("good-wait"), stored.slice(0, 200));
  ok("model never saw the ad (reply content untouched)", msgs.some((m) => m.role === "assistant" && m.content.trim() === `Mock answer to: ${q}`));
  // reopen the chat: no ad, no request
  const before = log.ad.length;
  await page.reload(); await page.getByText("Mock answer to:").waitFor({ timeout: 15000 }); await sleep(2500);
  ok("reopening the chat shows no ad and makes no request", log.ad.length === before && (await ourFrames(page)).length === 0);
  ok("no page errors", log.errors.length === 0, JSON.stringify(log.errors));
  await page.screenshot({ path: "final.png" });
  await ctx.close();
}

// 2. Other embeds on the same reply are kept.
{
  const other = readFileSync(new URL("./other_embed_filter.py", import.meta.url), "utf8");
  await api("/functions/create", { id: "zz_other_embed", name: "Other embed (test)", content: other, meta: { description: "test" } });
  const f = await api("/functions/id/zz_other_embed");
  if (!f.is_active) await api("/functions/id/zz_other_embed/toggle", {});
  if (!f.is_global) await api("/functions/id/zz_other_embed/toggle/global", {});
  const { ctx, page } = await newPage();
  await send(page, "other embed check");
  await page.getByText("Mock answer to:").waitFor({ timeout: 15000 });
  await sleep(2500);
  const frames = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("srcdoc") || ""));
  ok("another tool's embed survives; only ours is removed", frames.some((s) => s.includes("OTHER-EMBED-KEEP")) && !frames.some((s) => s.includes("data-good-wait-embed")), JSON.stringify(frames.map((s) => s.slice(0, 60))));
  await fetch(`${B}/api/v1/functions/id/zz_other_embed/delete`, { method: "DELETE", headers: H });
  await ctx.close();
}

// 3. A user who turns it off sees nothing.
{
  await api("/functions/id/goodwait/valves/user/update", { show_sponsored_line: false });
  const { ctx, page, log } = await newPage();
  await send(page, "user opted out check");
  await sleep(2500);
  ok("user valve off: no embed, no ad request", (await ourFrames(page)).length === 0 && log.ad.length === 0);
  await page.getByText("Mock answer to:").waitFor({ timeout: 15000 });
  await api("/functions/id/goodwait/valves/user/update", { show_sponsored_line: true });
  await ctx.close();
}

// 4. A stale embed (reply never finished) never activates when the chat is reopened later.
{
  const { execFileSync } = await import("node:child_process");
  const html = execFileSync("python3", ["-c", `
import importlib.util as u
s=u.spec_from_file_location('f','../goodwait_filter.py');m=u.module_from_spec(s);s.loader.exec_module(m)
import time
print(m.embed_html('iw-selftest','stale test',m.DEFAULT_ENDPOINT,'auto',now=time.time()-3600))`], { cwd: new URL(".", import.meta.url).pathname }).toString();
  const ctx = await browser.newContext(); const page = await ctx.newPage(); let reqs = 0;
  page.on("request", (r) => { if (r.url() === `${API}/ad`) reqs++; });
  await page.setContent(html); await sleep(2500);
  ok("stale embed (1h old) makes no ad request", reqs === 0);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
