// The Kimi chat path: request shape (what K3 accepts and what it rejects) and reply handling.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { kimiChat, MOONSHOT_API } from "../supabase/functions/goodwait/kimi.ts";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("kimi: OpenAI-style request with low reasoning effort, a capped reply, and no fixed sampling fields", async () => {
  let sent: { url: string; init: RequestInit } | null = null;
  const chat = kimiChat("sk-test", "kimi-k3", async (url, init) => { sent = { url: String(url), init: init! }; return reply({ choices: [{ message: { content: " Use Supabase. " }, finish_reason: "stop" }] }); });
  assertEquals(await chat([{ role: "user", content: "where should I host postgres?" }]), { text: "Use Supabase." });
  assertEquals(sent!.url, `${MOONSHOT_API}/chat/completions`);
  assertEquals((sent!.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  const b = JSON.parse(String(sent!.init.body));
  assertEquals(b.model, "kimi-k3");
  assertEquals(b.reasoning_effort, "low");
  assert(b.max_completion_tokens > 0 && b.max_completion_tokens <= 8000);
  assertEquals(b.messages[0].role, "system");
  assertEquals(b.messages[1], { role: "user", content: "where should I host postgres?" });
  for (const k of ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty"]) assert(!(k in b), `${k} must not be sent to K3`);
});

Deno.test("kimi: rate limit, errors, filtered and empty replies", async () => {
  const turns = [{ role: "user" as const, content: "hi" }];
  assertEquals(await kimiChat("k", "kimi-k3", async () => reply({}, 429))(turns), { error: "busy" });
  const bad = await kimiChat("k", "kimi-k3", async () => reply({ error: { message: "invalid key" } }, 401))(turns);
  assert("error" in bad && bad.error.startsWith("api 401"));
  assertEquals(await kimiChat("k", "kimi-k3", async () => reply({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }))(turns), { refused: true });
  const empty = await kimiChat("k", "kimi-k3", async () => reply({ choices: [{ message: { content: "" }, finish_reason: "length" }] }))(turns);
  assertEquals(empty, { error: "empty reply (length)" });
  const down = await kimiChat("k", "kimi-k3", async () => { throw new Error("connection reset"); })(turns);
  assertEquals(down, { error: "connection reset" });
});
