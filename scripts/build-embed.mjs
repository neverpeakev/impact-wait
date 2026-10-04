// web/goodwait.js is the single source of truth for the web component.
// This regenerates the copies: the API's /embed.js payload and the npm entry.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
const src = readFileSync("web/goodwait.js", "utf8");
if (/[^\x00-\x7f]/.test(src)) throw new Error("goodwait.js must be ASCII-only");
writeFileSync("supabase/functions/goodwait/embed.ts", `// GENERATED from web/goodwait.js by scripts/build-embed.mjs - do not edit.\nexport const EMBED_JS = ${JSON.stringify(src)};\n`);
copyFileSync("web/goodwait.js", "goodwait.js");
copyFileSync("plugins/openwebui/goodwait_filter.py", "web/openwebui/goodwait_filter.py");
console.log("embed.ts + goodwait.js written,", src.length, "bytes");
