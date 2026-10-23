// The web chat on Moonshot's Kimi (Kevin, 10-23: Kimi is the default; Claude runs only when no Moonshot
// key is set). Moonshot's API is OpenAI-compatible: one plain fetch, no SDK.
//
// Kimi K3 always thinks, and its reasoning bills as output, so effort is "low" and output is capped:
// a phone reply is a few short paragraphs. K3 fixes temperature, top_p, n and the penalties; sending
// any of them is an error, so they are left out.
import type { ChatFn } from "./chat.ts";
import { CHAT_SYSTEM } from "./chat.ts";

export const MOONSHOT_API = "https://api.moonshot.ai/v1";
export const KIMI_DEFAULT_MODEL = "kimi-k3";
const MAX_COMPLETION_TOKENS = 6000;

export function kimiChat(apiKey: string, model: string, f: typeof fetch = fetch): ChatFn {
  return async (turns) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const r = await f(`${MOONSHOT_API}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: CHAT_SYSTEM }, ...turns],
          reasoning_effort: "low",
          max_completion_tokens: MAX_COMPLETION_TOKENS,
        }),
        signal: ctrl.signal,
      });
      if (r.status === 429) { await r.body?.cancel(); return { error: "busy" }; }
      if (!r.ok) return { error: `api ${r.status} ${(await r.text()).slice(0, 200)}` };
      const j = await r.json().catch(() => null);
      const c = j?.choices?.[0];
      if (c?.finish_reason === "content_filter") return { refused: true };
      const text = typeof c?.message?.content === "string" ? c.message.content.trim() : "";
      return text ? { text } : { error: `empty reply (${c?.finish_reason || "no choice"})` };
    } catch (e) {
      return { error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
    } finally {
      clearTimeout(t);
    }
  };
}
