import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Goodwait } from "../../react.js";
function App() {
  const [active, setActive] = useState(false);
  const [q, setQ] = useState("");
  window.__go = (text) => { setQ(text); setActive(true); };
  window.__stop = () => setActive(false);
  window.__events = window.__events || [];
  return <div style={{ padding: 20 }}><Goodwait site="iw-selftest" active={active} query={q} linger={1500} onAd={(d) => window.__events.push(["ad", d])} onImpression={(d) => window.__events.push(["imp", d])} /></div>;
}
createRoot(document.getElementById("root")).render(<App />);
