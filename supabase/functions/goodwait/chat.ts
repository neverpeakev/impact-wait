// The Vibedough web chat (the phone experience): one Claude reply per message, short and plain.
// Loaded only when /account/chat is first called, so the SDK never slows a cold start of the ad routes.
import type Anthropic from "npm:@anthropic-ai/sdk@1.1.0";

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type ChatReply = { text: string } | { refused: true } | { error: string };
export type ChatFn = (turns: ChatTurn[]) => Promise<ChatReply>;

const SYSTEM = "You are the assistant inside Vibedough, a chat app people use on their phones to plan, debug and talk through code and side projects. " +
  "Answer in a few short paragraphs or a tight list; people are reading on a small screen. Use code blocks only for code. " +
  "If a question needs a long build, give the plan and the first step, and offer to continue.";

export function claudeChat(apiKey: string, model: string): ChatFn {
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
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      };
      const r = await client.beta.messages.create(params as unknown as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.BetaMessage;
      if (r.stop_reason === "refusal") return { refused: true };
      const text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return text ? { text } : { error: "empty reply" };
    } catch (e) {
      const { default: AnthropicSdk } = await import("npm:@anthropic-ai/sdk@1.1.0");
      if (e instanceof AnthropicSdk.RateLimitError) return { error: "busy" };
      if (e instanceof AnthropicSdk.APIError) return { error: `api ${e.status}` };
      return { error: (e as Error).message };
    }
  };
}
