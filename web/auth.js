// Vibedough sign-in: one small script shared by the landing pages and /app.
// Supabase Auth over plain REST (no client library), so it costs a few KB, not a few hundred.
// window.VD = { session, api, openSignIn, signOut, finishFromUrl }
(() => {
  const AUTH = "https://mvnfgrydpdwaatkcsrdd.supabase.co/auth/v1";
  const API = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait";
  // Public anon key (ships in every Supabase site's JS; the API checks every session itself).
  const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12bmZncnlkcGR3YWF0a2NzcmRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4NTIyMzUsImV4cCI6MjA3MjQyODIzNX0.vPKEZnj8ACjfXpO7ueUvcKT1wBO0-JM-UwcOEvmqXRk";
  const KEY = "vd_session";
  const APP = location.origin + "/app";
  const PROVIDERS = [["google", "Google"], ["github", "GitHub"], ["twitter", "X"], ["facebook", "Facebook"]];
  const ICONS = {
    google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.7-4.9h-4v3.1A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.3 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.8l4-3Z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z"/></svg>',
    github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z"/></svg>',
    twitter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.2 2.3h3.4l-7.4 8.4 8.7 11.5h-6.8l-5.3-7-6.1 7H1.3l7.9-9L.9 2.3h7l4.8 6.4 5.5-6.4Zm-1.2 17.9h1.9L7 4.2H5Z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1877F2" d="M24 12a12 12 0 1 0-13.9 11.9v-8.4H7.1V12h3V9.4c0-3 1.8-4.7 4.6-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.4l-.5 3.5h-2.9v8.4A12 12 0 0 0 24 12Z"/></svg>',
  };

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; } };
  const write = (s) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (_) {} };
  const keep = (j) => {
    if (!j || !j.access_token) return null;
    const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Number(j.expires_at) || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), email: (j.user && j.user.email) || "" };
    write(s);
    return s;
  };
  const authPost = (path, body) => fetch(AUTH + path, { method: "POST", headers: { "content-type": "application/json", apikey: ANON }, body: JSON.stringify(body) });

  // A live session or null; refreshes a token that expires within a minute.
  async function session() {
    const s = read();
    if (!s) return null;
    if (s.expires_at - 60 > Date.now() / 1000) return s;
    if (!s.refresh_token) { write(null); return null; }
    try {
      const r = await authPost("/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
      if (!r.ok) { if (r.status < 500) write(null); return null; }
      return keep(await r.json());
    } catch (_) { return null; }
  }

  // The Vibedough API with the session attached. A 401 clears the session.
  async function api(path, body) {
    const s = await session();
    if (!s) return { status: 401, data: { error: "sign in first" } };
    const init = { headers: { authorization: "Bearer " + s.access_token } };
    if (body !== undefined) { init.method = "POST"; init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const r = await fetch(API + path, init);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) write(null);
    return { status: r.status, data };
  }

  function signOut() {
    const s = read();
    write(null);
    if (s) fetch(AUTH + "/logout", { method: "POST", headers: { apikey: ANON, authorization: "Bearer " + s.access_token }, keepalive: true }).catch(() => {});
  }

  // Finishes a sign-in that arrived in the URL: an email link (?th=) or an SSO redirect (#access_token=).
  // Always strips the tokens from the address bar. Returns { session } or { error } or null.
  async function finishFromUrl() {
    const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.slice(1));
    const th = q.get("th"), tt = q.get("tt") || "magiclink";
    const err = h.get("error_description") || q.get("error_description");
    if (th || h.get("access_token") || err) history.replaceState(null, "", location.pathname);
    if (err) return { error: err.replace(/\+/g, " ") };
    if (h.get("access_token")) {
      const s = keep({ access_token: h.get("access_token"), refresh_token: h.get("refresh_token"), expires_at: h.get("expires_at"), expires_in: h.get("expires_in") });
      return s ? { session: s } : null;
    }
    if (th) {
      try {
        const r = await authPost("/verify", { type: tt, token_hash: th });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { error: "That link has expired or was already used. Send yourself a new one." };
        return { session: keep(j) };
      } catch (_) { return { error: "Couldn't reach us. Check your connection and open the link again." }; }
    }
    return null;
  }

  let providers = null;
  const loadProviders = () => providers || (providers = fetch(AUTH + "/settings", { headers: { apikey: ANON } })
    .then((r) => r.json()).then((j) => PROVIDERS.filter(([k]) => j.external && j.external[k])).catch(() => []));

  const CSS = `
.vd-scrim{position:fixed;inset:0;background:rgba(14,23,48,.55);display:grid;place-items:center;padding:16px;z-index:1000;opacity:0;transition:opacity .15s}
.vd-scrim.on{opacity:1}
.vd-card{background:#fff;color:#14213D;border-radius:16px;width:100%;max-width:400px;padding:28px 24px 22px;box-shadow:0 30px 60px -20px rgba(14,23,48,.5);font:400 16px/1.5 "Public Sans",system-ui,sans-serif;position:relative;transform:translateY(8px);transition:transform .15s}
.vd-scrim.on .vd-card{transform:none}
.vd-card h2{font:400 28px/1.15 "Young Serif",Georgia,serif;margin:0 0 6px}
.vd-card p{margin:0 0 18px;color:#4A5878;font-size:15px}
.vd-x{position:absolute;top:10px;right:10px;width:40px;height:40px;border:0;background:none;font-size:22px;color:#4A5878;cursor:pointer;border-radius:8px}
.vd-sso{display:grid;gap:10px;margin-bottom:16px}
.vd-sso:empty{display:none}
.vd-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:50px;border-radius:10px;font:600 16px/1 "Public Sans",sans-serif;cursor:pointer;border:1.5px solid #B9C4DA;background:#fff;color:#14213D;text-decoration:none}
.vd-btn:hover{border-color:#14213D}
.vd-btn svg{width:20px;height:20px}
.vd-btn.go{background:#2B50C8;border-color:#2B50C8;color:#fff}
.vd-btn.go:hover{background:#1F3DA0}
.vd-btn[disabled]{opacity:.7;cursor:progress}
.vd-or{display:flex;align-items:center;gap:12px;color:#7F8BAA;font-size:13px;margin:4px 0 14px}
.vd-or::before,.vd-or::after{content:"";flex:1;height:1px;background:#D5DDEA}
.vd-sso:empty+.vd-or{display:none}
.vd-in{width:100%;font:inherit;font-size:17px;padding:13px 14px;border:1.5px solid #B9C4DA;border-radius:10px;margin-bottom:10px;color:#14213D;background:#fff}
.vd-in:focus{outline:none;border-color:#2B50C8;box-shadow:0 0 0 3px rgba(43,80,200,.18)}
.vd-code{letter-spacing:.3em;text-align:center;font:600 22px/1 "JetBrains Mono",ui-monospace,monospace}
.vd-msg{min-height:1.4em;font-size:14px;margin:8px 0 0;color:#4A5878}
.vd-msg.err{color:#B3261E}
.vd-fine{font-size:12.5px;color:#7F8BAA;margin:14px 0 0}
.vd-link{background:none;border:0;padding:0;font:inherit;color:#2B50C8;font-weight:600;cursor:pointer;text-decoration:underline}
:focus-visible{outline:3px solid #2B50C8;outline-offset:2px}
@media (prefers-reduced-motion:reduce){.vd-scrim,.vd-card{transition:none}}`;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Renders the sign-in card into `host` (the popup, or the /app page itself).
  function mountSignIn(host, o = {}) {
    if (!document.getElementById("vd-css")) { const st = document.createElement("style"); st.id = "vd-css"; st.textContent = CSS; document.head.appendChild(st); }
    host.innerHTML = `<h2 id="vd-h">${esc(o.title || "Start earning")}</h2><p>${esc(o.sub || "Free. One tap to create your account, then one line to install.")}</p>
      <div class="vd-sso"></div><div class="vd-or">or</div>
      <form class="vd-email" novalidate><label class="vd-sr" for="vd-e" style="position:absolute;left:-9999px">Email</label>
        <input id="vd-e" class="vd-in" type="email" autocomplete="email" inputmode="email" placeholder="you@company.com" required value="${esc(o.email || "")}">
        <button class="vd-btn go" type="submit">Email me a sign-in link</button><p class="vd-msg" role="alert" aria-live="polite"></p></form>
      <p class="vd-fine">By continuing you agree to get emails about your account. We never post anything for you.</p>`;
    const sso = host.querySelector(".vd-sso");
    loadProviders().then((list) => {
      sso.innerHTML = list.map(([k, label]) => `<a class="vd-btn" href="${AUTH}/authorize?provider=${k}&redirect_to=${encodeURIComponent(APP)}">${ICONS[k]}Continue with ${label}</a>`).join("");
    });
    const form = host.querySelector(".vd-email"), input = form.querySelector("input"), btn = form.querySelector("button"), msg = form.querySelector(".vd-msg");
    const fail = (t) => { msg.textContent = t; msg.className = "vd-msg err"; };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = ""; msg.className = "vd-msg";
      const email = input.value.trim().toLowerCase();
      if (!input.checkValidity() || !email) { fail("Enter a valid email address."); input.focus(); return; }
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        if (o.onEmail) o.onEmail(email);
        const r = await fetch(API + "/auth/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "We couldn't send your link. Try again in a minute.");
        showCode(host, email, o);
      } catch (err) {
        fail(err.message && err.message !== "Failed to fetch" ? err.message : "Couldn't reach us. Check your connection and try again.");
        btn.disabled = false; btn.textContent = "Email me a sign-in link";
      }
    });
    // Came from a form that already has their email: send the link straight away.
    if (o.autoSend && o.email) form.requestSubmit();
    else if (o.focus !== false) setTimeout(() => (sso.querySelector("a") || input).focus(), 30);
  }

  // After the email goes out: open the link on any device, or type the 6-digit code here.
  function showCode(host, email, o) {
    host.querySelector("#vd-h").textContent = "Check your inbox";
    host.querySelector("#vd-h").nextElementSibling.innerHTML = `We sent a link to <b>${esc(email)}</b>. Tap it on any device, or enter the 6-digit code from the email here.`;
    host.querySelectorAll(".vd-sso,.vd-or,.vd-email,.vd-fine").forEach((n) => n.remove());
    const f = document.createElement("form");
    f.noValidate = true;
    f.innerHTML = `<input class="vd-in vd-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="6-digit code">
      <button class="vd-btn go" type="submit">Sign in</button><p class="vd-msg" role="alert" aria-live="polite"></p>
      <p class="vd-fine">No email? Check spam, or <button type="button" class="vd-link">use a different email</button>.</p>`;
    host.appendChild(f);
    const code = f.querySelector("input"), btn = f.querySelector("button.go"), msg = f.querySelector(".vd-msg");
    code.focus();
    f.querySelector(".vd-link").addEventListener("click", () => mountSignIn(host, o));
    const submit = async () => {
      const t = code.value.replace(/\D/g, "");
      if (t.length !== 6) { msg.textContent = "Enter the 6 digits from the email."; msg.className = "vd-msg err"; return; }
      btn.disabled = true; btn.textContent = "Signing in…";
      try {
        const r = await authPost("/verify", { type: "email", email, token: t });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error("That code didn't work. Check it, or use the link in the email.");
        keep(j);
        (o.onSignedIn || (() => (location.href = APP)))();
      } catch (err) {
        msg.textContent = err.message && err.message !== "Failed to fetch" ? err.message : "Couldn't reach us. Try again.";
        msg.className = "vd-msg err";
        btn.disabled = false; btn.textContent = "Sign in";
      }
    };
    f.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    code.addEventListener("input", () => { if (code.value.replace(/\D/g, "").length === 6) submit(); });
  }

  // The popup. Closes on Esc, the X, or a tap outside; gives focus back where it came from.
  function openSignIn(o = {}) {
    const back = document.activeElement;
    const scrim = document.createElement("div");
    scrim.className = "vd-scrim";
    scrim.innerHTML = '<div class="vd-card" role="dialog" aria-modal="true" aria-labelledby="vd-h"><button class="vd-x" type="button" aria-label="Close">×</button><div class="vd-body"></div></div>';
    document.body.appendChild(scrim);
    mountSignIn(scrim.querySelector(".vd-body"), o);
    requestAnimationFrame(() => scrim.classList.add("on"));
    const close = () => { scrim.remove(); document.removeEventListener("keydown", key); if (back && back.focus) back.focus(); };
    const key = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", key);
    scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
    scrim.querySelector(".vd-x").addEventListener("click", close);
    return close;
  }

  window.VD = { session, api, openSignIn, mountSignIn, signOut, finishFromUrl, API };
})();
