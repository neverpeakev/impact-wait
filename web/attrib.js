// Vibedough attribution + funnel steps, shared by the landing pages and /app.
// window.VDA = { source(), track(kind, variant?), creator }
//
// - First touch wins: the first visit's creator code (?via=), UTM tags, landing page and referring
//   site are kept in localStorage for 30 days and sent with the sign-up, so the account records
//   where the person really came from. Nothing personal is stored, only where they came from.
// - track() records a funnel step (cta, install_copy) to the same lp endpoint as page views.
// - Microsoft Clarity loads only when CLARITY_ID is set, on every page that includes this file
//   (including /app, so sign-up and install are no longer a blind spot).
(() => {
  const ENDPOINT = "https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/lp";
  const KEY = "vd_attrib";
  const DAYS = 30;
  // Set to the Clarity project ID for vibedough.com to turn on recordings and heatmaps.
  const CLARITY_ID = "";
  // Creators with a tracked link. code -> how their name shows on the page. Add one per deal.
  // Codes that aren't listed still count for attribution; they just don't get a banner.
  const CREATORS = {
    // "examplecode": "Example Creator",
  };
  const CODE_RE = /^[a-z0-9_-]{2,32}$/;
  const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) {} };

  const q = new URLSearchParams(location.search);
  const via = (q.get("via") || "").toLowerCase();
  const variant = document.body && document.body.dataset.variant || (location.pathname.startsWith("/app") ? "app" : "");
  const now = Date.now();

  // First touch: keep an existing, fresh record; otherwise start one from this visit.
  let rec = read();
  if (!rec || !rec.first_seen || now - Date.parse(rec.first_seen) > DAYS * 864e5) {
    rec = { first_seen: new Date(now).toISOString() };
    if (CODE_RE.test(via)) rec.via = via;
    UTM.forEach((k) => { const v = q.get(k); if (v) rec[k] = v.slice(0, 120); });
    if (variant && variant !== "app") { rec.landing = location.pathname; rec.variant = variant; }
    try {
      const r = document.referrer ? new URL(document.referrer) : null;
      if (r && r.origin !== location.origin) rec.ref_host = r.hostname;
    } catch (_) {}
    write(rec);
  } else if (!rec.via && CODE_RE.test(via)) {
    // A creator link after an organic first visit still gets the credit.
    rec.via = via; write(rec);
  }

  let session = "";
  try { session = sessionStorage.getItem("kn_s") || ""; } catch (_) {}
  if (!session) {
    session = "s_" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    try { sessionStorage.setItem("kn_s", session); } catch (_) {}
  }

  function source() { const r = read(); return r ? { ...r } : null; }
  function track(kind, v) {
    const r = read() || {};
    const utm = {}; UTM.forEach((k) => { if (r[k]) utm[k] = r[k]; }); if (r.via) utm.via = r.via;
    fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
      body: JSON.stringify({ kind, variant: v || variant || "app", session, utm }) }).catch(() => {});
  }

  // Creator banner: "Invited by <name>" for listed codes only (never prints raw URL text).
  const creator = rec.via && Object.prototype.hasOwnProperty.call(CREATORS, rec.via) ? CREATORS[rec.via] : "";
  if (creator && variant && variant !== "app") {
    const show = () => {
      const host = document.querySelector("[data-invite]");
      if (!host) return;
      host.textContent = `Invited by ${creator}`;
      host.hidden = false;
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", show) : show();
  }

  if (CLARITY_ID) {
    (function (c, l, a, r, i) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      const t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      const y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
    if (variant) window.clarity("set", "variant", variant);
    if (rec.via) window.clarity("set", "via", rec.via);
    if (rec.utm_source) window.clarity("set", "utm_source", rec.utm_source);
  }

  window.VDA = { source, track, creator };
})();
