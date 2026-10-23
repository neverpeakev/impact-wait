// The Vibedough web chat (the phone experience): one Claude reply per message, short and plain.
// Loaded only when /account/chat is first called, so the SDK never slows a cold start of the ad routes.
import type Anthropic from "npm:@anthropic-ai/sdk@1.1.0";

export type ChatTurn = { role: "user" | "assistant"; content: string };
// usage is present whenever the API answered (a refusal is billed too), so spend can be counted.
export type ChatUsage = { model: string; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; cost_usd: number };
export type ChatReply = ({ text: string } | { refused: true } | { error: string }) & { usage?: ChatUsage };
export type ChatFn = (turns: ChatTurn[]) => Promise<ChatReply>;

// The only model the web chat runs on (Kevin, 10-23): Claude Haiku 5.5. Not configurable, so a
// stray setting can't move the chat onto a pricier model.
export const CHAT_MODEL = "claude-haiku-5-5";
// Haiku 5.5 list prices, USD per million tokens: up to 100K input tokens per request, and above it.
// Cache writes bill at 1.25x input, cache reads at 0.1x.
const PRICE = { small: { input: 0.10, output: 0.50 }, large: { input: 0.50, output: 2.50 } };
export function chatCost(u: { input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number }): number {
  const prompt = u.input_tokens + u.cache_write_tokens + u.cache_read_tokens;
  const p = prompt > 100_000 ? PRICE.large : PRICE.small;
  const usd = (u.input_tokens * p.input + u.cache_write_tokens * p.input * 1.25 + u.cache_read_tokens * p.input * 0.1 + u.output_tokens * p.output) / 1e6;
  return Math.ceil(usd * 1e6) / 1e6; // round up to the millionth of a dollar: the cap never undercounts
}

const SYSTEM = "You are the assistant inside Vibedough, a chat app people use on their phones to plan, debug and talk through code and side projects. " +
  "Answer in a few short paragraphs or a tight list; people are reading on a small screen. Use code blocks only for code. " +
  "If a question needs a long build, give the plan and the first step, and offer to continue.";

// Models that accept fallbacks: "default".
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function claudeChat(apiKey: string): ChatFn {
  const model = CHAT_MODEL;
  let client: Anthropic | null = null;
  return async (turns) => {
    if (!client) {
      const { default: AnthropicSdk } = await import("npm:@anthropic-ai/sdk@1.1.0");
      client = new AnthropicSdk({ apiKey, maxRetries: 1, timeout: 60_000 });
    }
    try {
      const params = {
        model,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: { effort: "low" },
        messages: turns,
        // On a policy decline, the API re-runs the request on the recommended fallback model.
        // Only some models take it (Haiku has no server-side fallback), so it is sent only for those.
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      };
      const r = await client.beta.messages.create(params as unknown as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.BetaMessage;
      const tokens = {
        input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0,
        cache_write_tokens: r.usage?.cache_creation_input_tokens ?? 0, cache_read_tokens: r.usage?.cache_read_input_tokens ?? 0,
      };
      const usage: ChatUsage = { model: r.model || model, ...tokens, cost_usd: chatCost(tokens) };
      if (r.stop_reason === "refusal") return { refused: true, usage };
      const text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return text ? { text, usage } : { error: "empty reply", usage };
    } catch (e) {
      const { default: AnthropicSdk } = await import("npm:@anthropic-ai/sdk@1.1.0");
      if (e instanceof AnthropicSdk.RateLimitError) return { error: "busy" };
      if (e instanceof AnthropicSdk.APIError) return { error: `api ${e.status}` };
      return { error: (e as Error).message };
    }
  };
}
