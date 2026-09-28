"use client";
// React wrapper for <impact-wait>. Usage:
//   import { ImpactWait } from "impact-wait/react";
//   <ImpactWait site="your-app" active={isLoading} query={lastUserMessage} />
import { createElement, useEffect, useRef } from "react";

export function ImpactWait({ site, active, query, response, endpoint, linger, theme, className, style, onAd, onImpression }) {
  const ref = useRef(null);
  useEffect(() => { if (typeof window !== "undefined") import("./impact-wait.js"); }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.query = query || "";
    el.response = response || "";
    if (active) el.setAttribute("active", ""); else el.removeAttribute("active");
  }, [active, query, response]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const a = (e) => onAd && onAd(e.detail);
    const i = (e) => onImpression && onImpression(e.detail);
    el.addEventListener("impactwait:ad", a);
    el.addEventListener("impactwait:impression", i);
    return () => { el.removeEventListener("impactwait:ad", a); el.removeEventListener("impactwait:impression", i); };
  }, [onAd, onImpression]);
  const attrs = { ref, site, class: className, style };
  if (endpoint) attrs.endpoint = endpoint;
  if (linger != null) attrs.linger = String(linger);
  if (theme) attrs.theme = theme;
  return createElement("impact-wait", attrs);
}
export default ImpactWait;
