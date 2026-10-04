"use client";
// React wrapper for <good-wait>. Usage:
//   import { Goodwait } from "goodwait/react";
//   <Goodwait site="your-app" active={isLoading} query={lastUserMessage} />
import { createElement, useEffect, useRef } from "react";

export function Goodwait({ site, active, query, response, endpoint, linger, theme, className, style, onAd, onImpression }) {
  const ref = useRef(null);
  useEffect(() => { if (typeof window !== "undefined") import("./goodwait.js"); }, []);
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
    el.addEventListener("goodwait:ad", a);
    el.addEventListener("goodwait:impression", i);
    return () => { el.removeEventListener("goodwait:ad", a); el.removeEventListener("goodwait:impression", i); };
  }, [onAd, onImpression]);
  const attrs = { ref, site, class: className, style };
  if (endpoint) attrs.endpoint = endpoint;
  if (linger != null) attrs.linger = String(linger);
  if (theme) attrs.theme = theme;
  return createElement("good-wait", attrs);
}
export default Goodwait;
