// Installs the Goodwait filter into a local Open WebUI via its admin API.
import { readFileSync } from "node:fs";
const B = process.env.OWUI || "http://127.0.0.1:8080";
const signin = await fetch(`${B}/api/v1/auths/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "", password: "" }) });
const { token } = await signin.json();
if (!token) throw new Error("no token " + signin.status);
const H = { "content-type": "application/json", authorization: `Bearer ${token}` };
const content = readFileSync(new URL("../goodwait_filter.py", import.meta.url), "utf8");
const existing = await fetch(`${B}/api/v1/functions/id/goodwait`, { headers: H });
const form = { id: "goodwait", name: "Goodwait", content, meta: { description: "Sponsored line while the model thinks; funds a good cause." } };
let r = existing.ok && (await existing.json())
  ? await fetch(`${B}/api/v1/functions/id/goodwait/update`, { method: "POST", headers: H, body: JSON.stringify(form) })
  : await fetch(`${B}/api/v1/functions/create`, { method: "POST", headers: H, body: JSON.stringify(form) });
console.log("create/update", r.status, (await r.text()).slice(0, 200));
let f = await (await fetch(`${B}/api/v1/functions/id/goodwait`, { headers: H })).json();
if (!f.is_active) console.log("toggle", (await fetch(`${B}/api/v1/functions/id/goodwait/toggle`, { method: "POST", headers: H })).status);
if (!f.is_global) console.log("global", (await fetch(`${B}/api/v1/functions/id/goodwait/toggle/global`, { method: "POST", headers: H })).status);
r = await fetch(`${B}/api/v1/functions/id/goodwait/valves/update`, { method: "POST", headers: H, body: JSON.stringify({ site: process.env.SITE || "iw-selftest", priority: 0, theme: "auto", enabled: true }) });
console.log("valves", r.status, await r.text());
f = await (await fetch(`${B}/api/v1/functions/id/goodwait`, { headers: H })).json();
console.log("state", { active: f.is_active, global: f.is_global, type: f.type });
