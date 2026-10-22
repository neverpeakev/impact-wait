// Builds the offer-test landing pages: web/try/{cash,win,give}.html from one template.
// Only the offer changes between pages; brand, layout and form are identical so the test
// measures the offer and nothing else. Run: node scripts/build-lp.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const BRAND = "Vibedough";
const ENDPOINT = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/lp";
const AUTH = "https://mvnfgrydpdwaatkcsrdd.supabase.co/auth/v1";
// Public anon key (ships in every Supabase site's JS; RLS is what protects data).
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12bmZncnlkcGR3YWF0a2NzcmRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4NTIyMzUsImV4cCI6MjA3MjQyODIzNX0.vPKEZnj8ACjfXpO7ueUvcKT1wBO0-JM-UwcOEvmqXRk";
// Account step (password after email). Off until branded email (custom SMTP + site URL) is set;
// ?acct=1 turns it on for one visit so it can be tested on the live pages.
const ACCOUNTS_DEFAULT = false;

const VARIANTS = {
  cash: {
    file: "cash",
    title: `${BRAND} - get paid while Claude Code thinks`,
    desc: "One quiet sponsored line under the spinner while your agent works. You keep half the ad revenue, paid to PayPal.",
    h1: "Get paid while Claude Code thinks.",
    sub: `${BRAND} adds one quiet sponsored line under the spinner while your agent works. You keep half the ad revenue, paid out to PayPal.`,
    micro: "Free. Launching first in Claude Code.",
    meter: (n) => `${BRAND.toLowerCase()}  $${(n * 0.0024).toFixed(2)} owed  ·  ${n} paid views today`,
    step3: ["Get paid", "Your balance sits in the status line. Cash out to PayPal once you reach $10."],
    offerHead: "Half of the ad revenue is yours.",
    offer: [
      ["Real money, not points", "Your share comes from what advertisers actually paid, settled every month. No estimates dressed up as earnings."],
      ["PayPal at $10", "Add your PayPal email once. When your balance reaches $10, it goes out."],
      ["Fair by design", "Views count once, while you're at the keyboard, with a daily cap. Bots and farms get nothing, so the pot stays real."],
    ],
    faqMoney: ["How much will I make?", "It depends on how long your agent works and what advertisers pay that month. We won't promise a number we can't back up. Your real balance is always one glance away in the status line."],
  },
  prize: {
    file: "win",
    title: `${BRAND} - win $1,000 while Claude Code thinks`,
    desc: "One quiet sponsored line under the spinner while your agent works. Every paid view is a free entry in our $1,000 launch draw.",
    h1: "Every time Claude Code thinks, you're entered to win.",
    sub: `${BRAND} adds one quiet sponsored line under the spinner while your agent works. Every paid view is a free entry in our $1,000 launch draw.`,
    micro: "Free to join. No purchase necessary.",
    meter: (n) => `${BRAND.toLowerCase()}  ${n} draw entries  ·  $1,000 launch draw`,
    step3: ["Win", "Every paid view is one entry. One winner takes $1,000."],
    offerHead: "One $1,000 draw. Every view is an entry.",
    offer: [
      ["We put up the prize", "The $1,000 comes from us, not from you. Entering never costs you anything."],
      ["Entries you earn by working", "You don't buy anything or click anything. Your agent thinks, an ad shows, you get an entry."],
      ["Fair by design", "Views count once, while you're at the keyboard, with a daily cap. There's a free way to enter without the app, and official rules go up before the draw opens."],
    ],
    faqMoney: ["What's the prize?", "One winner gets $1,000. Entries come from paid views, plus a free way to enter that doesn't need the app. Official rules, dates and eligibility are published before the draw opens. No purchase necessary to enter or win."],
  },
  give: {
    file: "give",
    title: `${BRAND} - fund good causes while Claude Code thinks`,
    desc: "One quiet sponsored line under the spinner while your agent works. Half the ad revenue goes to a cause you pick.",
    h1: "Every time Claude Code thinks, a good cause gets paid.",
    sub: `${BRAND} adds one quiet sponsored line under the spinner while your agent works. Half the ad revenue goes to a cause you pick.`,
    micro: "Free. Launching first in Claude Code.",
    meter: (n) => `${BRAND.toLowerCase()}  $${(n * 0.0024).toFixed(2)} raised for your cause  ·  ${n} views today`,
    step3: ["Give", "Half of what your waits earn goes to the cause you pick. Your running total sits in the status line."],
    offerHead: "Half of the ad revenue goes to good.",
    offer: [
      ["You pick the cause", "Choose when you sign up: education, clean water or climate. Switch any time."],
      ["Out in the open", "We publish what's been donated, cause by cause, every month."],
      ["Safe to install at work", "No cash changes hands, so it's an easy yes for teams. Your company's agents can fund something good while they work."],
    ],
    faqMoney: ["Which causes?", "We're starting with a short list across education, clean water and climate, and adding more based on what people pick. Tell us what you'd want after you sign up."],
  },
};

const ADS = [
  ["Lumen DB", "Postgres that sleeps when you do.", "Try it"],
  ["Shipyard", "A preview deploy for every branch.", "Start free"],
  ["Tracewell", "Find the slow query before your users do.", "See demo"],
  ["Inkpad", "Docs your whole team actually updates.", "Try it"],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(key, v) {
  const meters = [3, 4, 5, 6, 7].map((n) => v.meter(n + 14));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.title)}</title>
<meta name="description" content="${esc(v.desc)}">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(v.desc)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{
  --linen:#EEF2F8; --linen-2:#E3E9F3; --ink:#14213D; --ink-soft:#4A5878; --cobalt:#2B50C8; --cobalt-deep:#1F3DA0;
  --brass:#B8892B; --term:#0E1730; --term-line:#24325A; --term-text:#D7DEEE; --term-dim:#7F8BAA; --ok:#1F7A55; --err:#B3261E;
  --radius:10px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--linen);color:var(--ink);font:400 17px/1.6 "Public Sans",system-ui,sans-serif}
a{color:var(--cobalt)}
:focus-visible{outline:3px solid var(--cobalt);outline-offset:2px;border-radius:4px}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
header.top{display:flex;align-items:center;justify-content:space-between;padding:22px 0}
.logo{display:flex;align-items:center;gap:10px;font:400 24px/1 "Young Serif",Georgia,serif;color:var(--ink);text-decoration:none}
.logo svg{width:30px;height:30px}
.top-cta{font-weight:600;font-size:15px;text-decoration:none;color:var(--ink);border-bottom:2px solid var(--brass);padding-bottom:2px}

.hero{display:grid;grid-template-columns:1.02fr 1fr;gap:56px;align-items:center;padding:40px 0 72px}
h1{font:400 clamp(38px,5.2vw,60px)/1.06 "Young Serif",Georgia,serif;letter-spacing:-.01em;margin:0 0 20px;max-width:15ch}
.sub{font-size:19px;color:var(--ink-soft);max-width:46ch;margin:0 0 28px}

form.join{display:flex;gap:10px;max-width:480px}
form.join input[type=email]{flex:1;min-width:0;font:inherit;font-size:17px;padding:14px 16px;border:1.5px solid #B9C4DA;border-radius:var(--radius);background:#fff;color:var(--ink)}
form.join input[type=email]:focus{border-color:var(--cobalt);outline:none;box-shadow:0 0 0 3px rgba(43,80,200,.18)}
button.go{font:600 17px/1 "Public Sans",sans-serif;padding:0 22px;min-height:52px;border:0;border-radius:var(--radius);background:var(--cobalt);color:#fff;cursor:pointer;white-space:nowrap}
button.go:hover{background:var(--cobalt-deep)}
button.go[disabled]{opacity:.7;cursor:progress}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.micro{font-size:14px;color:var(--ink-soft);margin:10px 0 0}
.msg{font-size:15px;margin:8px 0 0}
.msg:empty{margin:0}
.msg.err{color:var(--err)}
.done{max-width:480px}
.done h3{font:400 24px/1.2 "Young Serif",Georgia,serif;margin:0 0 6px}
.done p{margin:0 0 14px;color:var(--ink-soft)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;padding:0;border:0}
.chips legend{font-size:15px;font-weight:600;margin-bottom:8px;padding:0}
.chips label{display:inline-flex;align-items:center;gap:6px;font-size:15px;background:#fff;border:1.5px solid #B9C4DA;border-radius:999px;padding:7px 13px;cursor:pointer}
.chips input{accent-color:var(--cobalt)}
.chips label:has(input:checked){border-color:var(--cobalt);background:#E6ECFB}
.pwrow{display:flex;gap:10px;max-width:480px;margin-top:12px}
.pwrow .field{position:relative;flex:1;min-width:0}
.pwrow input{width:100%;font:inherit;font-size:17px;padding:14px 64px 14px 16px;border:1.5px solid #B9C4DA;border-radius:var(--radius);background:#fff;color:var(--ink)}
.pwrow input:focus{border-color:var(--cobalt);outline:none;box-shadow:0 0 0 3px rgba(43,80,200,.18)}
.pwrow .show{position:absolute;right:8px;top:50%;transform:translateY(-50%);font:600 14px/1 "Public Sans",sans-serif;background:none;border:0;color:var(--cobalt);padding:8px;cursor:pointer}
form.join input[readonly]{background:var(--linen-2);color:var(--ink-soft)}
.pwlabel{display:block;font-weight:600;font-size:15px;margin-top:16px}
.linkbtn{background:none;border:0;padding:0;font:inherit;font-size:14px;color:var(--ink-soft);text-decoration:underline;cursor:pointer}
@media (max-width:520px){.pwrow{flex-direction:column}}
button.save{font:600 15px/1 "Public Sans",sans-serif;padding:10px 16px;border-radius:var(--radius);border:1.5px solid var(--ink);background:transparent;color:var(--ink);cursor:pointer}

/* The one bold thing: a terminal mid-thought. */
.term{background:var(--term);color:var(--term-text);border-radius:14px;font:400 14.5px/1.65 "JetBrains Mono",ui-monospace,monospace;box-shadow:0 30px 60px -28px rgba(14,23,48,.55);overflow:hidden}
.term .bar{display:flex;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--term-line);color:var(--term-dim);font-size:12.5px}
.term .body{padding:18px 18px 20px;min-height:270px}
.term .p{color:#fff}
.term .p b{color:#9DB4FF;font-weight:600}
.term .think{color:#F0C46B;margin-top:14px}
.term .dim{color:var(--term-dim)}
.band{margin-top:14px;border:1px solid var(--term-line);border-radius:8px;padding:10px 12px}
.band .ad{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;transition:opacity .35s}
.band .tag{font-size:11.5px;color:var(--term-dim);border:1px solid var(--term-line);border-radius:4px;padding:0 6px}
.band .brand{color:#fff;font-weight:600}
.band .cta{color:#9DB4FF;margin-left:auto}
.band .meter{margin-top:8px;color:var(--brass);font-weight:600;font-size:13.5px}
.caption{font-size:13px;color:var(--ink-soft);margin:10px 4px 0}

section{padding:72px 0;border-top:1px solid #D5DDEA}
h2{font:400 clamp(30px,3.6vw,40px)/1.15 "Young Serif",Georgia,serif;margin:0 0 32px;max-width:22ch}
ol.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:40px;counter-reset:s}
ol.steps li{counter-increment:s}
ol.steps li::before{content:counter(s);display:grid;place-items:center;width:38px;height:38px;border-radius:50%;border:1.5px solid var(--ink);font:400 18px/1 "Young Serif",serif;margin-bottom:16px}
ol.steps h3,.offer h3{font-size:19px;font-weight:700;margin:0 0 6px}
ol.steps p,.offer p{margin:0;color:var(--ink-soft)}
.offer{display:grid;grid-template-columns:repeat(3,1fr);gap:40px}

.privacy{display:grid;grid-template-columns:1fr 1fr;gap:48px}
.privacy ul{margin:0;padding:0;list-style:none}
.privacy li{padding:10px 0 10px 30px;position:relative;border-bottom:1px solid #D5DDEA}
.privacy li::before{position:absolute;left:0;top:10px;font-weight:700}
.sees li::before{content:"✓";color:var(--ok)}
.never li::before{content:"✕";color:var(--err)}
.privacy h3{font-size:19px;margin:0 0 6px}

.faq details{border-bottom:1px solid #D5DDEA;padding:18px 0;max-width:760px}
.faq summary{font-weight:600;font-size:18px;cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:16px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font:400 24px/1 "Young Serif",serif;color:var(--cobalt)}
.faq details[open] summary::after{content:"−"}
.faq details p{margin:10px 0 0;color:var(--ink-soft);max-width:66ch}

.final{text-align:left}
.final h2{max-width:none}
footer{padding:40px 0 56px;border-top:1px solid #D5DDEA;color:var(--ink-soft);font-size:15px}
footer .def{font:400 18px/1.5 "Young Serif",Georgia,serif;color:var(--ink);margin:0 0 8px;max-width:60ch}

@media (max-width:900px){
  .hero{grid-template-columns:1fr;gap:36px;padding-top:16px}
  ol.steps,.offer,.privacy{grid-template-columns:1fr;gap:28px}
  section{padding:56px 0}
}
@media (max-width:520px){
  body{font-size:16px}
  .wrap{padding:0 16px}
  form.join{flex-direction:column}
  button.go{width:100%}
  .term{font-size:12.5px}
  .term .body{min-height:250px;padding:14px}
  .band .cta{margin-left:0}
  .top-cta{display:none}
}
@media (prefers-reduced-motion:reduce){ .band .ad{transition:none} }
</style>
</head>
<body data-variant="${key}">
<div class="wrap">
  <header class="top">
    <a class="logo" href="#" aria-label="${BRAND}">
      <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M12.5 12.5 8.5 4.5l6.2 5.2Z" fill="#14213D"/><path d="M19.5 12.5l4-8-6.2 5.2Z" fill="#14213D"/><path d="M9.5 13.5c1.6-1.4 4-2 6.5-2s4.9.6 6.5 2c3 2.6 4.6 6.2 4 9.3-.6 3.2-4.6 5.2-10.5 5.2S6.1 26 5.5 22.8c-.6-3.1 1-6.7 4-9.3Z" fill="#2B50C8"/><ellipse cx="16" cy="11.2" rx="3.2" ry="2.1" fill="#B8892B"/></svg>
      ${BRAND.toLowerCase()}
    </a>
    <a class="top-cta" href="#join-final">Get early access</a>
  </header>

  <main>
    <div class="hero">
      <div>
        <h1>${esc(v.h1)}</h1>
        <p class="sub">${esc(v.sub)}</p>
        <div class="joinbox" id="join-hero">${formHtml("hero", v)}</div>
      </div>
      <div>
        <div class="term" role="img" aria-label="Claude Code thinking, with one sponsored line and your ${key === "cash" ? "balance" : key === "prize" ? "entries" : "donation total"} underneath">
          <div class="bar"><span>~/payments</span><span>claude</span></div>
          <div class="body" aria-hidden="true">
            <div class="p"><b>&gt;</b> refactor the payments module to use the new ledger API</div>
            <div class="think"><span class="spin">✻</span> Thinking… <span class="dim">(<span class="secs">47</span>s · ↓ <span class="tok">2.1</span>k tokens)</span></div>
            <div class="dim" style="margin-top:6px">  ⎿ Reading src/payments/ledger.ts</div>
            <div class="band">
              <div class="ad"><span class="tag">Sponsored</span><span class="brand">${esc(ADS[0][0])}</span><span class="line">${esc(ADS[0][1])}</span><span class="cta">${esc(ADS[0][2])}</span></div>
              <div class="meter">${esc(meters[0])}</div>
            </div>
          </div>
        </div>
        <p class="caption">What it looks like. Advertisers and numbers here are examples.</p>
      </div>
    </div>

    <section aria-labelledby="how">
      <h2 id="how">Three steps, then you never think about it.</h2>
      <ol class="steps">
        <li><h3>Install</h3><p>Add ${BRAND} to Claude Code with one command. No account forms, no browser extension.</p></li>
        <li><h3>Work like normal</h3><p>While the agent thinks, one sponsored line shows under the spinner. It rotates every 15 seconds while you're at the keyboard and stops when you step away.</p></li>
        <li><h3>${esc(v.step3[0])}</h3><p>${esc(v.step3[1])}</p></li>
      </ol>
    </section>

    <section aria-labelledby="offer">
      <h2 id="offer">${esc(v.offerHead)}</h2>
      <div class="offer">
        ${v.offer.map(([h, p]) => `<div><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join("\n        ")}
      </div>
    </section>

    <section aria-labelledby="privacy">
      <h2 id="privacy">Your code stays yours.</h2>
      <div class="privacy">
        <div class="sees"><h3>What ${BRAND} sees</h3><ul>
          <li>The first 500 characters of your prompt, so the ad fits what you're working on.</li>
          <li>Whether you're at the keyboard, so views only count when a person is there.</li>
        </ul></div>
        <div class="never"><h3>What it never sees</h3><ul>
          <li>Your files or your code.</li>
          <li>Tool output, terminal output or anything the agent writes.</li>
          <li>Anything at all from subagents running in the background.</li>
        </ul></div>
      </div>
    </section>

    <section class="faq" aria-labelledby="faq">
      <h2 id="faq">Questions</h2>
      <details><summary>${esc(v.faqMoney[0])}</summary><p>${esc(v.faqMoney[1])}</p></details>
      <details><summary>Does it slow Claude Code down?</summary><p>No. The ad loads alongside the agent's work and never holds up a reply. If an ad is slow to arrive, you simply don't see one.</p></details>
      <details><summary>Do I have to click the ads?</summary><p>No, and please don't click ones you don't care about. Views count, clicks don't.</p></details>
      <details><summary>Can I turn it off?</summary><p>Yes, with one command, any time. Turn it back on the same way.</p></details>
      <details><summary>What about Cursor, Codex and the others?</summary><p>Claude Code comes first. Tell us which tools you use after you sign up, and that decides what's next.</p></details>
    </section>

    <section class="final" aria-labelledby="final">
      <h2 id="final">Your agent is going to think either way.</h2>
      <div class="joinbox" id="join-final">${formHtml("final", v)}</div>
    </section>
  </main>

  <footer>
    <p class="def">vibedough (n.): the money you make while your agent does the work.</p>
    <p>A Never Peak project. We'll only email you about ${BRAND}.</p>
  </footer>
</div>

<script>
(() => {
  const ENDPOINT = ${JSON.stringify(ENDPOINT)};
  const VARIANT = ${JSON.stringify(key)};
  const ADS = ${JSON.stringify(ADS)};
  const METERS = ${JSON.stringify(meters)};
  const AUTH = ${JSON.stringify(AUTH)}, ANON = ${JSON.stringify(ANON)};
  const ACCOUNTS = ${JSON.stringify(ACCOUNTS_DEFAULT)} || new URLSearchParams(location.search).get("acct") === "1";

  let session = "";
  try { session = sessionStorage.getItem("kn_s") || ""; } catch (_) {}
  if (!session) {
    session = "s_" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    try { sessionStorage.setItem("kn_s", session); } catch (_) {}
  }
  const q = new URLSearchParams(location.search);
  const utm = {};
  ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","gclid","fbclid","msclkid","ttclid","rdt_cid"].forEach((k) => { const v = q.get(k); if (v) utm[k] = v; });
  const ref = document.referrer && !document.referrer.startsWith(location.origin) ? document.referrer : "";

  const send = (body) => fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant: VARIANT, session, utm, ref, ...body }), keepalive: true });
  send({ kind: "view" }).catch(() => {});

  // The terminal: one orchestrated loop. Static for reduced motion.
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!still) {
    const spin = document.querySelector(".spin"), secs = document.querySelector(".secs"), tok = document.querySelector(".tok");
    const ad = document.querySelector(".band .ad"), meter = document.querySelector(".band .meter");
    const frames = ["✻","✽","✶","✳","✢","·"]; let f = 0, s = 47, t = 2.1, i = 0;
    setInterval(() => { spin.textContent = frames[f = (f + 1) % frames.length]; }, 160);
    setInterval(() => { secs.textContent = ++s; t += 0.07; tok.textContent = t.toFixed(1); }, 1000);
    setInterval(() => {
      i = (i + 1) % ADS.length;
      ad.style.opacity = 0;
      setTimeout(() => {
        const [b, l, c] = ADS[i];
        ad.querySelector(".brand").textContent = b; ad.querySelector(".line").textContent = l; ad.querySelector(".cta").textContent = c;
        meter.textContent = METERS[Math.min(i + 1, METERS.length - 1)] ;
        ad.style.opacity = 1;
      }, 350);
    }, 4000);
  }

  let email = "";
  function showDone() {
    document.querySelectorAll(".joinbox").forEach((box) => {
      box.innerHTML = '<div class="done" role="status"><h3>You\\'re on the list.</h3><p>We\\'ll email you when ${BRAND} opens. One more thing, if you have a second:</p>' +
        '<form class="tools"><fieldset class="chips"><legend>Where do you use AI to code?</legend>' +
        [["claude-code","Claude Code"],["cursor","Cursor"],["codex","Codex"],["copilot","Copilot"],["chatgpt","ChatGPT"],["claude","Claude.ai"],["gemini","Gemini"],["other","Other"]]
          .map(([v, l]) => '<label><input type="checkbox" name="t" value="' + v + '"> ' + l + '</label>').join("") +
        '</fieldset><button class="save" type="submit">Save</button> <span class="msg"></span></form></div>';
    });
    document.querySelectorAll("form.tools").forEach((form) => form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const tools = [...form.querySelectorAll("input:checked")].map((x) => x.value);
      const msg = form.querySelector(".msg");
      try { const r = await send({ kind: "tools", email, tools }); msg.textContent = r.ok ? "Saved." : "That didn't save. Try once more."; }
      catch (_) { msg.textContent = "That didn't save. Check your connection and try again."; }
    }));
  }

  // Account step: the password field appears under the email they just gave.
  function showPassword(form) {
    const box = form.parentElement;
    const input = form.querySelector("input[type=email]");
    input.readOnly = true;
    form.querySelector("button.go").hidden = true;
    const id = "pw-" + (box.id || "x");
    const wrap = document.createElement("form");
    wrap.className = "pwform"; wrap.noValidate = true;
    wrap.innerHTML = '<label class="pwlabel" for="' + id + '">Create a password</label>' +
      '<div class="pwrow"><div class="field"><input id="' + id + '" type="password" minlength="10" required autocomplete="new-password" aria-describedby="' + id + '-hint">' +
      '<button type="button" class="show" aria-controls="' + id + '">Show</button></div>' +
      '<button class="go" type="submit">Create account</button></div>' +
      '<p class="msg" role="alert" aria-live="polite"></p>' +
      '<p class="micro" id="' + id + '-hint">At least 10 characters. We\\'ll email you a link to confirm your account. <button type="button" class="linkbtn skip">Skip for now</button></p>';
    form.after(wrap);
    box.querySelectorAll(":scope > .msg, :scope > .micro").forEach((n) => (n.hidden = true));
    const pw = wrap.querySelector("input"), show = wrap.querySelector(".show"), msg = wrap.querySelector(".msg"), btn = wrap.querySelector("button.go");
    pw.focus();
    show.addEventListener("click", () => { const on = pw.type === "password"; pw.type = on ? "text" : "password"; show.textContent = on ? "Hide" : "Show"; });
    wrap.querySelector(".skip").addEventListener("click", showDone);
    wrap.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = ""; msg.classList.remove("err");
      if (pw.value.length < 10) { msg.textContent = "Use at least 10 characters."; msg.classList.add("err"); pw.focus(); return; }
      btn.disabled = true; btn.textContent = "Creating…";
      try {
        const r = await fetch(AUTH + "/signup?redirect_to=" + encodeURIComponent(location.origin + "/try/welcome"), {
          method: "POST",
          headers: { "content-type": "application/json", apikey: ANON, authorization: "Bearer " + ANON },
          body: JSON.stringify({ email, password: pw.value, data: { product: ${JSON.stringify(BRAND.toLowerCase())}, variant: VARIANT, utm } }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const code = j.error_code || j.code || "";
          throw new Error(code === "weak_password" ? "That password is too easy to guess. Try a longer one."
            : code === "over_email_send_rate_limit" || r.status === 429 ? "Too many sign-ups right now. Try again in a few minutes."
            : j.msg || j.error_description || "We couldn't create your account. Try again in a minute.");
        }
        pw.value = "";
        document.querySelectorAll(".joinbox").forEach((b) => {
          b.innerHTML = '<div class="done" role="status"><h3>Check your inbox.</h3><p>We sent a link to <b></b>. Click it to finish creating your account.</p>' +
            '<p class="micro">No email in a few minutes? Check spam, or <button type="button" class="linkbtn again">use a different email</button>.</p></div>';
          b.querySelector("b").textContent = email;
          b.querySelector(".again").addEventListener("click", () => location.reload());
        });
      } catch (err) {
        msg.textContent = err.message && err.message !== "Failed to fetch" ? err.message : "Couldn't reach us. Check your connection and try again.";
        msg.classList.add("err");
        btn.disabled = false; btn.textContent = "Create account";
      }
    });
  }

  document.querySelectorAll("form.join").forEach((form) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("input[type=email]"), btn = form.querySelector("button.go"), msg = form.parentElement.querySelector(".msg");
    msg.textContent = ""; msg.classList.remove("err");
    if (!input.checkValidity()) { msg.textContent = "Enter a valid email address."; msg.classList.add("err"); input.focus(); return; }
    btn.disabled = true; btn.textContent = "Joining…";
    try {
      const r = await send({ kind: "signup", email: input.value, hp: form.querySelector(".hp input").value });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Something went wrong on our side. Try again in a minute.");
      email = input.value.trim().toLowerCase();
      if (ACCOUNTS) showPassword(form); else showDone();
    } catch (err) {
      msg.textContent = err.message && err.message !== "Failed to fetch" ? err.message : "Couldn't reach us. Check your connection and try again.";
      msg.classList.add("err");
      btn.disabled = false; btn.textContent = "Get early access";
    }
  }));
})();
</script>
</body>
</html>
`;
}

function formHtml(where, v) {
  return `<form class="join" novalidate>
          <label class="hp" aria-hidden="true">Leave this empty<input tabindex="-1" autocomplete="off" name="website"></label>
          <label for="email-${where}" class="hp">Email address</label>
          <input id="email-${where}" type="email" name="email" required autocomplete="email" placeholder="you@company.com" aria-describedby="micro-${where}">
          <button class="go" type="submit">Get early access</button>
        </form>
        <p class="msg" role="alert" aria-live="polite"></p>
        <p class="micro" id="micro-${where}">${esc(v.micro)}</p>`;
}


// Where the confirmation link lands. Supabase puts the result in the URL fragment.
function welcomePage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${BRAND} - account confirmed</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Public+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--linen:#EEF2F8;--ink:#14213D;--ink-soft:#4A5878;--cobalt:#2B50C8;--err:#B3261E}
body{margin:0;background:var(--linen);color:var(--ink);font:400 17px/1.6 "Public Sans",system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:72px 24px}
h1{font:400 clamp(34px,5vw,48px)/1.1 "Young Serif",Georgia,serif;margin:0 0 16px}
p{color:var(--ink-soft);margin:0 0 14px}
a{color:var(--cobalt);font-weight:600}
.err h1{color:var(--err)}
</style>
</head>
<body>
<main id="m" aria-live="polite">
  <h1>Confirming your account…</h1>
</main>
<script>
(() => {
  const h = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search);
  const m = document.getElementById("m");
  const err = h.get("error_description") || q.get("error_description");
  // Never leave tokens sitting in the address bar or history.
  history.replaceState(null, "", location.pathname);
  if (err) {
    m.className = "err";
    m.innerHTML = "<h1>That link didn't work.</h1><p></p><p>Links expire after a while and work once. Sign up again from the page you came from and we'll send a fresh one.</p>";
    m.querySelector("p").textContent = err.replace(/\\+/g, " ") + ".";
  } else if (h.get("access_token") || h.get("type") === "signup") {
    m.innerHTML = "<h1>You're in.</h1><p>Your ${BRAND} account is confirmed. We'll email you the one-line install for Claude Code as soon as it opens.</p>";
  } else {
    m.innerHTML = "<h1>Nothing to confirm here.</h1><p>Open the link from the email we sent you to confirm your account.</p>";
  }
})();
</script>
</body>
</html>
`;
}

// Public payout ledger: live totals from the API, no identities. Honest when empty.
const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait";
function ledgerPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${BRAND} - public payout ledger</title>
<meta name="description" content="Every dollar ${BRAND} has credited, paid out and donated, live.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Young+Serif&family=Public+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--linen:#EEF2F8;--ink:#14213D;--ink-soft:#4A5878;--cobalt:#2B50C8;--brass:#B8892B;--rule:#D5DDEA}
*{box-sizing:border-box}
body{margin:0;background:var(--linen);color:var(--ink);font:400 17px/1.6 "Public Sans",system-ui,sans-serif}
main{max-width:880px;margin:0 auto;padding:56px 24px 72px}
a{color:var(--cobalt)}
h1{font:400 clamp(34px,5vw,52px)/1.08 "Young Serif",Georgia,serif;margin:0 0 12px}
.lead{color:var(--ink-soft);max-width:60ch;margin:0 0 40px}
dl{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0 0 40px;border-top:1px solid var(--rule)}
dl div{padding:22px 20px 22px 0;border-bottom:1px solid var(--rule)}
dt{font-size:15px;color:var(--ink-soft);margin-bottom:4px}
dd{margin:0;font:400 clamp(28px,4vw,40px)/1.1 "Young Serif",Georgia,serif;font-variant-numeric:tabular-nums}
dd.brass{color:var(--brass)}
.note{font-size:15px;color:var(--ink-soft);max-width:66ch}
h2{font:400 26px/1.2 "Young Serif",Georgia,serif;margin:40px 0 12px}
ul{padding-left:20px;max-width:66ch}
li{margin:6px 0}
@media (max-width:640px){dl{grid-template-columns:1fr 1fr}main{padding:40px 16px 56px}}
</style>
</head>
<body>
<main>
  <h1>Every dollar, in the open.</h1>
  <p class="lead">What ${BRAND} has credited to the people who use it, paid out, and donated. Totals only, never names. Updated live from the same database that pays people.</p>
  <dl aria-live="polite">
    <div><dt>Credited to users</dt><dd class="brass" id="credited">-</dd></div>
    <div><dt>Paid out to PayPal</dt><dd id="paid">-</dd></div>
    <div><dt>People paid</dt><dd id="people">-</dd></div>
    <div><dt>Donated to <span id="cause">charity: water</span></dt><dd id="donated">-</dd></div>
    <div><dt>Donations on the way</dt><dd id="pending">-</dd></div>
    <div><dt>Last activity</dt><dd id="last" style="font-size:22px">-</dd></div>
  </dl>
  <p class="note" id="status">Loading the ledger…</p>

  <h2>How the numbers work</h2>
  <ul>
    <li>Money is credited only after an ad network actually pays for a month, never from estimates.</li>
    <li>Half of that goes to the people whose views earned it. Referral cuts come out of our half, never theirs.</li>
    <li>Cash goes to PayPal once someone has $10, after a 30-day hold on their first cash-out.</li>
    <li>Donations go out monthly, and are marked paid here once sent.</li>
    <li>The Claude Code mod is <a href="https://github.com/neverpeakev/knippel-claude-code">open source</a>, so you can check exactly what it sends.</li>
  </ul>
</main>
<script>
(() => {
  const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  const status = document.getElementById("status");
  fetch(${JSON.stringify(API)} + "/ledger", { headers: { accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then((l) => {
      set("credited", usd(l.credited_to_users_usd)); set("paid", usd(l.paid_out_usd)); set("people", Number(l.people_paid || 0).toLocaleString("en-US"));
      set("donated", usd(l.donated_usd)); set("pending", usd(l.donation_pending_usd)); if (l.cause) set("cause", l.cause);
      set("last", l.last_activity_at ? new Date(l.last_activity_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "None yet");
      status.textContent = Number(l.credited_to_users_usd) > 0 ? "Live from the payout database." : "Nothing credited yet. The first numbers appear after the first month's ad revenue is settled.";
    })
    .catch(() => {
      ["credited","paid","people","donated","pending","last"].forEach((id) => set(id, "-"));
      status.textContent = "The ledger goes live with the first settlement.";
    });
})();
</script>
</body>
</html>
`;
}

mkdirSync(new URL("../web/try/", import.meta.url), { recursive: true });
writeFileSync(new URL("../web/try/ledger.html", import.meta.url), ledgerPage());
console.log("web/try/ledger.html");
writeFileSync(new URL("../web/try/welcome.html", import.meta.url), welcomePage());
console.log("web/try/welcome.html");
for (const [key, v] of Object.entries(VARIANTS)) {
  writeFileSync(new URL(`../web/try/${v.file}.html`, import.meta.url), page(key, v));
  console.log(`web/try/${v.file}.html (${key})`);
}
