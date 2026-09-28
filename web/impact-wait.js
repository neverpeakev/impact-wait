/*! ImpactWait v0.1.0 | MIT | Turn AI "thinking..." time into sponsored, cause-funding moments.
 *
 * <impact-wait site="your-app" active query="the user's prompt"></impact-wait>
 *
 * Put it where your chat shows "thinking...". Set `active` while the model is
 * generating and `query` to the user's last message. It fetches one sponsored
 * line, shows it, and reports the view only after it has been at least 50% on
 * screen for 1 second. Remove `active` when the reply is done; it lingers
 * briefly, then hides. No cookies, no user IDs, no ad keys in the browser.
 */
(() => {
  const DEFAULT_ENDPOINT = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/impact-wait";
  const HOME = "https://impact-wait.vercel.app";
  if (typeof window === "undefined" || !window.customElements || customElements.get("impact-wait")) return;

  const CSS = `
:host { display:block; font:13px/1.35 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; --iw-bg:#fff; --iw-fg:#111; --iw-muted:#666; --iw-line:rgba(0,0,0,.12); --iw-tag:#f1f1f1; --iw-accent:#0b6bcb; --iw-good:#12805c; }
:host([theme="dark"]) { --iw-bg:#232323; --iw-fg:#ececec; --iw-muted:#a8a8a8; --iw-line:rgba(255,255,255,.14); --iw-tag:#333; --iw-accent:#6cb4ff; --iw-good:#3ecf8e; }
@media (prefers-color-scheme: dark) { :host(:not([theme="light"])) { --iw-bg:#232323; --iw-fg:#ececec; --iw-muted:#a8a8a8; --iw-line:rgba(255,255,255,.14); --iw-tag:#333; --iw-accent:#6cb4ff; --iw-good:#3ecf8e; } }
:host([hidden]) { display:none; }
.card { box-sizing:border-box; border:1px solid var(--iw-line); border-radius:12px; background:var(--iw-bg); color:var(--iw-fg); padding:8px 10px; opacity:0; transform:translateY(3px); transition:opacity .18s ease, transform .18s ease; }
.card.on { opacity:1; transform:none; }
.row { display:flex; align-items:center; gap:8px; min-width:0; }
.tag { flex:none; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--iw-muted); background:var(--iw-tag); border-radius:6px; padding:3px 6px; }
.fav { flex:none; width:16px; height:16px; border-radius:4px; object-fit:contain; }
.copy { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:inherit; text-decoration:none; }
.copy b { font-weight:650; } .copy span { color:var(--iw-muted); margin-left:6px; }
.copy:hover b { text-decoration:underline; }
.cta { flex:none; color:var(--iw-accent); font-weight:600; text-decoration:none; }
.cta:hover { text-decoration:underline; }
.impact { display:flex; justify-content:space-between; gap:8px; margin-top:5px; font-size:11px; color:var(--iw-muted); }
.impact .dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--iw-good); margin-right:6px; vertical-align:1px; }
.impact a { color:var(--iw-muted); text-decoration:none; white-space:nowrap; } .impact a:hover { text-decoration:underline; }
@media (prefers-reduced-motion: reduce) { .card { transition:none; } }`;

  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const safe = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : "");

  class ImpactWait extends HTMLElement {
    static get observedAttributes() { return ["active", "query"]; }
    constructor() {
      super();
      this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `<style>${CSS}</style><div class="card" role="complementary" aria-label="Sponsored" part="card"></div>`;
      this._card = this._root.querySelector(".card");
      this._cycle = 0;
      this._ad = null;
      // No attributes in the constructor: document.createElement() (React, Vue...) throws if one is added here.
    }
    get endpoint() { return (this.getAttribute("endpoint") || DEFAULT_ENDPOINT).replace(/\/+$/, ""); }
    get site() { return (this.getAttribute("site") || "").toLowerCase(); }
    get lingerMs() { const v = Number(this.getAttribute("linger")); return Number.isFinite(v) && v >= 0 ? v : 4000; }
    get query() { return this._query != null ? this._query : (this.getAttribute("query") || ""); }
    set query(v) { this._query = v == null ? null : String(v); }
    get response() { return this._response || ""; }
    set response(v) { this._response = v == null ? "" : String(v); }
    get active() { return this.hasAttribute("active"); }
    set active(v) { if (v) this.setAttribute("active", ""); else this.removeAttribute("active"); }

    connectedCallback() {
      if (!this._ad) this.hidden = true;
      // Properties set before this script loaded (e.g. by React) shadow our accessors; re-apply them.
      for (const k of ["query", "response", "active"]) {
        if (Object.prototype.hasOwnProperty.call(this, k)) { const v = this[k]; delete this[k]; this[k] = v; }
      }
      if (this.active) this._start();
    }
    disconnectedCallback() { this._on = false; this._stopObserving(); clearTimeout(this._hideT); }
    attributeChangedCallback(name, oldV, newV) {
      if (name !== "active" || (oldV === null) === (newV === null)) return;
      if (newV !== null) this._start(); else this._end();
    }

    async _start() {
      if (this._on) return; // attributeChanged + connected can both fire on upgrade
      this._on = true;
      const my = ++this._cycle;
      clearTimeout(this._hideT);
      // Let the caller set `query` in the same tick as `active`.
      await Promise.resolve();
      const query = this.query.trim();
      if (!this.site || !query) { this._emit("impactwait:skip", { reason: !this.site ? "no site" : "no query" }); return; }
      let data;
      try {
        const r = await fetch(`${this.endpoint}/ad`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ site: this.site, query: query.slice(0, 2000), response: this.response.slice(0, 1500), sessionId: this._session() }) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        data = await r.json();
      } catch (e) {
        this._emit("impactwait:error", { error: String(e && e.message || e) });
        return;
      }
      if (my !== this._cycle || !data || !data.ad) return;
      this._render(data);
      if (!this.active) { clearTimeout(this._hideT); this._hideT = setTimeout(() => this._hide(), Math.min(this.lingerMs, 3000)); }
    }
    _end() { this._on = false; clearTimeout(this._hideT); this._hideT = setTimeout(() => this._hide(), this.lingerMs); }

    _session() {
      try { let s = sessionStorage.getItem("impactwait:s"); if (!s) { s = "iw_" + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("impactwait:s", s); } return s; } catch (_) { return "iw_" + Date.now().toString(36); }
    }

    _render({ id, ad, impact, sandbox }) {
      this._ad = { id, ad, impact, seen: false };
      const c = this._card;
      c.textContent = "";
      const row = el("div", "row");
      row.append(el("span", "tag", ad.label || "Sponsored"));
      if (safe(ad.favicon)) { const img = el("img", "fav"); img.alt = ""; img.src = ad.favicon; img.onerror = () => img.remove(); row.append(img); }
      const head = ad.brand && ad.headline && !ad.headline.toLowerCase().includes(ad.brand.toLowerCase()) ? `${ad.brand} \u00b7 ${ad.headline}` : (ad.headline || ad.brand || "");
      const copy = link("copy", ad.clickUrl); copy.append(el("b", "", head)); if (ad.body) copy.append(el("span", "", ad.body));
      copy.title = [head, ad.body].filter(Boolean).join(" - ");
      row.append(copy, link("cta", ad.clickUrl, (ad.cta || "Learn more") + " \u2192"));
      const foot = el("div", "impact");
      const msg = el("span"); msg.append(el("i", "dot")); msg.append(document.createTextNode(sandbox ? "Test mode on this host - views are not counted" : impactLine(impact)));
      const home = document.createElement("a");
      home.href = `${HOME}/?ref=${encodeURIComponent(this.site)}`; home.target = "_blank"; home.rel = "noopener"; home.textContent = "Powered by ImpactWait";
      foot.append(msg, home);
      c.append(row, foot);
      this.hidden = false;
      requestAnimationFrame(() => c.classList.add("on"));
      this._emit("impactwait:ad", { provider: ad.provider, id });
      this._observe();
    }

    // Billable view: >=50% visible, tab visible, for 1s continuously.
    _observe() {
      this._stopObserving();
      const arm = () => { clearTimeout(this._viewT); this._viewT = setTimeout(() => this._impression(), 1000); };
      const disarm = () => clearTimeout(this._viewT);
      let inView = false;
      const check = () => (inView && document.visibilityState === "visible" ? arm() : disarm());
      if ("IntersectionObserver" in window) {
        this._io = new IntersectionObserver((es) => { inView = es.some((e) => e.intersectionRatio >= 0.5); check(); }, { threshold: [0, 0.5, 1] });
        this._io.observe(this._card);
      } else { inView = true; check(); }
      this._vis = () => check();
      document.addEventListener("visibilitychange", this._vis);
    }
    _stopObserving() {
      clearTimeout(this._viewT);
      if (this._io) { this._io.disconnect(); this._io = null; }
      if (this._vis) { document.removeEventListener("visibilitychange", this._vis); this._vis = null; }
    }
    async _impression() {
      const a = this._ad;
      if (!a || a.seen) return;
      a.seen = true;
      this._stopObserving();
      try {
        await fetch(`${this.endpoint}/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: a.id, type: "impression" }), keepalive: true });
        this._emit("impactwait:impression", { id: a.id, provider: a.ad.provider });
      } catch (_) { /* best effort */ }
    }
    _hide() {
      this._stopObserving();
      this._card.classList.remove("on");
      this.hidden = true;
      this._ad = null;
    }
    _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }
  }

  function impactLine(i) {
    if (!i) return "Sponsored waits help fund this app";
    const waits = `${fmt(i.sponsored_waits)} sponsored ${Number(i.sponsored_waits) === 1 ? "wait" : "waits"} so far`;
    if (i.cause_name && i.pledge_pct) {
      const funded = i.units_funded ? ` \u00b7 ${fmt(i.units_funded)} ${i.unit_label || "funded"} so far` : ` \u00b7 ${waits}`;
      return `${i.pledge_pct}% of this ad's revenue goes to ${i.cause_name}${funded}`;
    }
    return waits;
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function link(cls, href, text) {
    const a = el("a", cls, text);
    if (safe(href)) { a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer sponsored"; }
    return a;
  }

  customElements.define("impact-wait", ImpactWait);
  window.ImpactWait = ImpactWait;
})();
