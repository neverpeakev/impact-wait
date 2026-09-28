// web/impact-wait.js is the single source of truth for the web component.
// This regenerates the copies: the API's /embed.js payload and the npm entry.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
const src = readFileSync("web/impact-wait.js", "utf8");
if (/[^\x00-\x7f]/.test(src)) throw new Error("impact-wait.js must be ASCII-only");
writeFileSync("supabase/functions/impact-wait/embed.ts", `// GENERATED from web/impact-wait.js by scripts/build-embed.mjs - do not edit.\nexport const EMBED_JS = ${JSON.stringify(src)};\n`);
copyFileSync("web/impact-wait.js", "impact-wait.js");
copyFileSync("plugins/openwebui/impact_wait_filter.py", "web/openwebui/impact_wait_filter.py");
console.log("embed.ts + impact-wait.js written,", src.length, "bytes");
