// Minimal OpenAI-compatible server: one model, streams a reply after a 4s "thinking" delay.
import http from "node:http";
const DELAY = Number(process.env.DELAY_MS || 4000);
http.createServer(async (req, res) => {
  if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-slow", object: "model", owned_by: "test" }] })); }
  if (req.url.endsWith("/chat/completions")) {
    let body = ""; for await (const c of req) body += c;
    const j = JSON.parse(body || "{}");
    const last = (j.messages || []).filter((m) => m.role === "user").pop();
    const text = `Mock answer to: ${typeof last?.content === "string" ? last.content : "?"}`;
    if (!j.stream) { await new Promise((r) => setTimeout(r, 300)); res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "mock-slow", choices: [{ index: 0, message: { role: "assistant", content: "Mock title" }, finish_reason: "stop" }] })); }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    await new Promise((r) => setTimeout(r, DELAY));
    for (const w of text.split(" ")) { res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock-slow", choices: [{ index: 0, delta: { content: w + " " }, finish_reason: null }] })}\n\n`); await new Promise((r) => setTimeout(r, 40)); }
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock-slow", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.statusCode = 404; res.end();
}).listen(9100, () => console.log("mock openai on 9100"));
