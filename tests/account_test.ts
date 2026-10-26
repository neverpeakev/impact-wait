// Vibedough accounts: sign-in email, account page, install-code linking, PayPal, W-9, the earnings gate.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { chatTitle, createApp, type Program } from "../supabase/functions/goodwait/app.ts";
import { type AuthApi, type Email, normalizeInstallCode, parseTaxForm, validEin, validSsn } from "../supabase/functions/goodwait/accounts.ts";
import { memStore } from "./memstore.ts";

const BASE = "https://x.supabase.co/functions/v1/goodwait";
// Fake session tokens that look like JWTs; each maps to one user.
const jwt = (who: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(who).replace(/=/g, "")}xxxxxxxx.signature123`;
const USERS: Record<string, { id: string; email: string; provider: string }> = {
  [jwt("ana")]: { id: "00000000-0000-0000-0000-00000000000a", email: "Ana@Example.com", provider: "google" },
  [jwt("bo")]: { id: "00000000-0000-0000-0000-00000000000b", email: "bo@example.com", provider: "email" },
};
const W9 = { legal_name: "Ana Lopez", tax_class: "individual", line1: "1 Main St", city: "El Segundo", state: "CA", zip: "90245", tin_type: "ssn", tin: "123-45-6789", certify: true, signature: "Ana Lopez" };

function mk(opts: { program?: Partial<Program>; linkFails?: boolean; mailOk?: boolean; chat?: boolean; chatPerDay?: number; chatCap?: number; replyCost?: number } = {}) {
  const store = memStore({}, opts.program);
  const mail: Email[] = [];
  const seen: { role: string; content: string }[][] = [];
  const auth: AuthApi = {
    async getUser(t) { const u = USERS[t]; return u ? { ...u, meta: {} } : null; },
    async signInLink(email) { return opts.linkFails ? null : { tokenHash: "th_" + email.length, type: "magiclink", otp: "123456" }; },
  };
  const app = createApp({ store, keys: {}, baseUrl: BASE, salt: "t", auth, appUrl: "https://vibedough.com/app",
    mailer: async (m) => { mail.push(m); return opts.mailOk ?? true; },
    chat: opts.chat ? async (turns) => (seen.push(turns.map((x) => ({ ...x }))), { text: `echo: ${turns[turns.length - 1].content}`,
      usage: { model: "claude-haiku-5-5", input_tokens: 1000, output_tokens: 400, cache_write_tokens: 0, cache_read_tokens: 0, cost_usd: opts.replyCost ?? 0.0003 } }) : undefined,
    chatPerDay: opts.chatPerDay, chatMonthlyCapUsd: opts.chatCap });
  const call = (path: string, init: RequestInit = {}, ip = "1.1.1.1") =>
    app(new Request(BASE + path, { ...init, headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(init.headers || {}) } }));
  const as = (who: string, path: string, body?: unknown) =>
    call(path, body === undefined ? { headers: { authorization: `Bearer ${jwt(who)}` } } : { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${jwt(who)}` } });
  const earner = async (ip = "1.1.1.1") => (await (await call("/earner", { method: "POST", body: "{}" }, ip)).json()).token as string;
  const link = (token: string, code: string, ip = "1.1.1.1") => call("/earner/link", { method: "POST", body: JSON.stringify({ code }), headers: { authorization: `Bearer ${token}` } }, ip);
  return { store, mail, call, as, earner, link, seen };
}

Deno.test("install codes: format, and pasted variants normalize", () => {
  assertEquals(normalizeInstallCode("vd-abcd-efgh"), "VD-ABCD-EFGH");
  assertEquals(normalizeInstallCode(" VD ABCD EFGH "), "VD-ABCD-EFGH");
  assertEquals(normalizeInstallCode("VDABCDEFGH"), "VD-ABCD-EFGH");
  assertEquals(normalizeInstallCode("VD-ABCD-EFG0"), null); // 0 is not in the alphabet
  assertEquals(normalizeInstallCode("XX-ABCD-EFGH"), null);
  assertEquals(normalizeInstallCode(undefined), null);
});

Deno.test("TIN checks reject numbers that are never issued", () => {
  assert(validSsn("123456789"));
  for (const bad of ["000123456", "666123456", "900123456", "123006789", "123450000", "12345678"]) assert(!validSsn(bad), bad);
  assert(validEin("123456789"));
  assert(!validEin("001234567"));
  assert(!validEin("071234567"));
});

Deno.test("W-9 form: cleans input and names the first problem", () => {
  const ok = parseTaxForm(W9);
  assert("form" in ok);
  assertEquals(ok.form.tin, "123456789");
  assertEquals(ok.form.state, "CA");
  assertEquals((parseTaxForm({ ...W9, certify: false }) as { error: string }).error, "Check the box to certify the form.");
  assertEquals((parseTaxForm({ ...W9, zip: "9024" }) as { error: string }).error, "Enter a 5-digit ZIP code.");
  assertEquals((parseTaxForm({ ...W9, state: "ZZ" }) as { error: string }).error, "Pick your state.");
  assertEquals((parseTaxForm({ ...W9, tin: "666-12-3456" }) as { error: string }).error, "That isn't a valid Social Security number.");
  assertEquals((parseTaxForm({ ...W9, tax_class: "pirate" }) as { error: string }).error, "Pick a federal tax classification.");
});

Deno.test("sign-in email: branded link to the app with the token hash, plus the code", async () => {
  const t = mk();
  const r = await t.call("/auth/email", { method: "POST", body: JSON.stringify({ email: "New@Person.dev" }) });
  assertEquals(r.status, 200);
  assertEquals(t.mail.length, 1);
  const m = t.mail[0];
  assertEquals(m.to, "new@person.dev");
  assertEquals(m.tag, "signin");
  assert(m.html.includes("https://vibedough.com/app?th=th_14&amp;tt=magiclink"), "link carries the token hash");
  assert(m.text.includes("123456"), "the 6-digit code is in the email too");
  assertEquals((await t.call("/auth/email", { method: "POST", body: JSON.stringify({ email: "nope" }) })).status, 400);
});

Deno.test("sign-in email: capped per address and per network", async () => {
  const t = mk();
  const send = (email: string, ip = "1.1.1.1") => t.call("/auth/email", { method: "POST", body: JSON.stringify({ email }) }, ip);
  for (let i = 0; i < 5; i++) assertEquals((await send("a@b.co", `9.9.9.${i}`)).status, 200);
  assertEquals((await send("a@b.co", "9.9.9.99")).status, 429);
  for (let i = 0; i < 20; i++) await send(`p${i}@b.co`, "2.2.2.2");
  assertEquals((await send("fresh@b.co", "2.2.2.2")).status, 429);
});

Deno.test("sign-in email: a failed send or refused link is an error, not a silent ok", async () => {
  assertEquals((await mk({ mailOk: false }).call("/auth/email", { method: "POST", body: JSON.stringify({ email: "a@b.co" }) })).status, 502);
  assertEquals((await mk({ linkFails: true }).call("/auth/email", { method: "POST", body: JSON.stringify({ email: "a@b.co" }) })).status, 502);
});

Deno.test("account: needs a valid session", async () => {
  const t = mk();
  assertEquals((await t.call("/account/me")).status, 401);
  assertEquals((await t.call("/account/me", { headers: { authorization: "Bearer junk" } })).status, 401);
  assertEquals((await t.as("nobody", "/account/me")).status, 401);
});

Deno.test("account: first visit creates it with an install code and sends one welcome email", async () => {
  const t = mk();
  const j = await (await t.as("ana", "/account/me")).json();
  assertEquals(j.email, "ana@example.com");
  assertMatch(j.install_code, /^VD-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert(j.install_command.includes(j.install_code));
  assertEquals(j.installed, false);
  assertEquals(j.installs, 0);
  assertEquals(j.payout_ready, false);
  assertEquals(j.earnings_locked, true);
  assertEquals(j.earnings, null);
  const again = await (await t.as("ana", "/account/me")).json();
  assertEquals(again.install_code, j.install_code, "the code is stable");
  const welcomes = t.mail.filter((m) => m.tag === "welcome");
  assertEquals(welcomes.length, 1, "welcome goes out once");
  assert(welcomes[0].html.includes(j.install_code) && welcomes[0].text.includes(`/earn link ${j.install_code}`));
  assertEquals(t.store.accounts.size, 1);
});

Deno.test("link: an install joins the account with its code; the account sees it as installed", async () => {
  const t = mk();
  const { install_code } = await (await t.as("ana", "/account/me")).json();
  const token = await t.earner();
  const r = await t.link(token, install_code.toLowerCase().replace(/-/g, " "));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).email, "a***@example.com");
  const j = await (await t.as("ana", "/account/me")).json();
  assertEquals(j.installs, 1);
  assertEquals(j.installed, true);
  assert(j.last_seen_at);
  const me = await (await t.call("/earner/me", { headers: { authorization: `Bearer ${token}` } })).json();
  assertEquals(me.account_linked, true);
  // Linking again is fine; linking to someone else's account is not.
  assertEquals((await t.link(token, install_code)).status, 200);
  const bo = await (await t.as("bo", "/account/me")).json();
  assertEquals((await t.link(token, bo.install_code)).status, 409);
});

Deno.test("link: an install not seen for 30 days no longer counts as installed", async () => {
  const t = mk();
  const { install_code } = await (await t.as("ana", "/account/me")).json();
  const token = await t.earner();
  await t.link(token, install_code);
  for (const e of t.store.earners.values()) e.last_seen_at = new Date(Date.now() - 31 * 86400e3);
  assertEquals((await (await t.as("ana", "/account/me")).json()).installed, false);
});

Deno.test("link: wrong codes are refused and capped per network", async () => {
  const t = mk();
  const token = await t.earner();
  assertEquals((await t.link(token, "VD-AAAA-AAAA")).status, 404);
  assertEquals((await t.link(token, "garbage")).status, 404);
  for (let i = 0; i < 8; i++) await t.link(token, "VD-BBBB-BBBB");
  assertEquals((await t.link(token, "VD-CCCC-CCCC")).status, 429);
  assertEquals((await t.call("/earner/link", { method: "POST", body: JSON.stringify({ code: "VD-AAAA-AAAA" }) })).status, 401);
});

Deno.test("link: at most max_installs_per_account installs", async () => {
  const t = mk({ program: { max_installs_per_account: 2 } });
  const { install_code } = await (await t.as("ana", "/account/me")).json();
  assertEquals((await t.link(await t.earner("3.0.0.1"), install_code)).status, 200);
  assertEquals((await t.link(await t.earner("3.0.0.2"), install_code)).status, 200);
  assertEquals((await t.link(await t.earner("3.0.0.3"), install_code)).status, 409);
});

Deno.test("rotating the code: the old one stops working, the new one links", async () => {
  const t = mk();
  const { install_code: old } = await (await t.as("ana", "/account/me")).json();
  const r = await (await t.as("ana", "/account/code", {})).json();
  assert(r.install_code !== old);
  const token = await t.earner();
  assertEquals((await t.link(token, old)).status, 404);
  assertEquals((await t.link(token, r.install_code)).status, 200);
});

Deno.test("PayPal: set once on the account, copied to linked installs (now and later)", async () => {
  const t = mk();
  const { install_code } = await (await t.as("ana", "/account/me")).json();
  const first = await t.earner("4.0.0.1");
  await t.link(first, install_code);
  assertEquals((await t.as("ana", "/account/paypal", { email: "nope" })).status, 400);
  const r = await (await t.as("ana", "/account/paypal", { email: "Ana.Pay@Example.com" })).json();
  assertEquals(r.paypal_email, "a***@example.com");
  const second = await t.earner("4.0.0.2");
  await t.link(second, install_code);
  for (const e of t.store.earners.values()) assertEquals(e.payout_email, "ana.pay@example.com");
});

Deno.test("W-9: saved with only the last 4 kept in the clear; bad forms refused", async () => {
  const t = mk();
  await t.as("ana", "/account/me");
  assertEquals((await t.as("ana", "/account/w9", { ...W9, certify: false })).status, 400);
  const r = await (await t.as("ana", "/account/w9", W9)).json();
  assertEquals(r, { ok: true, tin_type: "ssn", tin_last4: "6789" });
  const stored = [...t.store.taxForms.values()][0];
  assert(!JSON.stringify(stored).includes("123456789"), "the full TIN is never stored in the clear");
  const j = await (await t.as("ana", "/account/me")).json();
  assertEquals(j.w9.on_file, true);
  assertEquals(j.w9.tin_last4, "6789");
});

Deno.test("earnings: hidden until PayPal and W-9 are both on file, then summed across installs", async () => {
  const t = mk();
  const { install_code } = await (await t.as("ana", "/account/me")).json();
  const a = await t.earner("5.0.0.1"), b = await t.earner("5.0.0.2");
  await t.link(a, install_code); await t.link(b, install_code);
  const ids = [...t.store.earners.values()].map((e) => e.id);
  t.store.payouts.push({ earner_id: ids[0], amount_usd: 1.25, status: "owed", kind: "earnings" }, { earner_id: ids[1], amount_usd: 2.5, status: "owed", kind: "earnings" });
  await t.as("ana", "/account/paypal", { email: "ana@pay.com" });
  let j = await (await t.as("ana", "/account/me")).json();
  assertEquals(j.earnings_locked, true, "PayPal alone is not enough");
  assertEquals(j.earnings, null);
  await t.as("ana", "/account/w9", W9);
  j = await (await t.as("ana", "/account/me")).json();
  assertEquals(j.payout_ready, true);
  assertEquals(j.earnings_locked, false);
  assertEquals(j.earnings.balance_usd, 3.75);
  assertEquals(j.earnings.min_payout_usd, 10);
});

Deno.test("earnings: shown right away when the program turns the gate off", async () => {
  const t = mk({ program: { earnings_need_payout_info: false } });
  const j = await (await t.as("bo", "/account/me")).json();
  assertEquals(j.earnings_locked, false);
  assertEquals(j.earnings.balance_usd, 0);
});

Deno.test("accounts off: routes answer 503 when no Auth is wired", async () => {
  const app = createApp({ store: memStore(), keys: {}, baseUrl: BASE, salt: "t" });
  const r = await app(new Request(BASE + "/account/me", { headers: { authorization: `Bearer ${jwt("ana")}` } }));
  assertEquals(r.status, 503);
});

Deno.test("web chat: the account page says whether the chat is open (ads only run while it is)", async () => {
  assertEquals((await (await mk().as("ana", "/account/me")).json()).chat_open, false);
  assertEquals((await (await mk({ chat: true }).as("ana", "/account/me")).json()).chat_open, true);
});

Deno.test("web chat: 503 until a model is wired, then replies; capped per account per day", async () => {
  assertEquals((await mk().as("ana", "/account/chat", { messages: [{ role: "user", content: "hi" }] })).status, 503);
  const t = mk({ chat: true, chatPerDay: 2 });
  assertEquals((await t.call("/account/chat", { method: "POST", body: "{}" })).status, 401);
  assertEquals((await t.as("ana", "/account/chat", { messages: [] })).status, 400);
  assertEquals((await t.as("ana", "/account/chat", { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] })).status, 400, "last turn must be the user's");
  const r = await (await t.as("ana", "/account/chat", { messages: [{ role: "assistant", content: "stray" }, { role: "user", content: "hi" }] })).json();
  assertEquals(r.reply, "echo: hi");
  assertEquals((await t.as("ana", "/account/chat", { messages: [{ role: "user", content: "again" }] })).status, 200);
  assertEquals((await t.as("ana", "/account/chat", { messages: [{ role: "user", content: "third" }] })).status, 429);
});

Deno.test("web chat views: credited to the account's own web earner, which is not an install", async () => {
  const t = mk();
  const { install_code } = await (await t.as("ana", "/account/me")).json();
  const view = (who: string, rid: string) => t.as(who, "/account/impression", { network: "velocity", request_id: rid });
  await view("ana", "aaaaaaaa-0000-0000-0000-000000000001");
  await view("ana", "aaaaaaaa-0000-0000-0000-000000000002");
  const rows = [...t.store.ads.values()].filter((a) => a.provider === "velocity");
  assertEquals(rows.length, 2);
  assertEquals(rows[0].earner_id, rows[1].earner_id, "one web earner per account");
  assertEquals(t.store.earners.get(rows[0].earner_id as string).ref, "web-app");
  const j = await (await t.as("ana", "/account/me")).json();
  assertEquals(j.installs, 0, "the web earner is not an install");
  assertEquals(j.installed, false);
  // It doesn't use up an install slot either.
  const t2 = mk({ program: { max_installs_per_account: 1 } });
  const { install_code: c2 } = await (await t2.as("bo", "/account/me")).json();
  await t2.as("bo", "/account/impression", { network: "velocity", request_id: "bbbbbbbb-0000-0000-0000-000000000001" });
  assertEquals((await t2.link(await t2.earner(), c2)).status, 200);
  assert(install_code);
  // The web app never gets a house ad: that route is gone.
  assertEquals((await t.as("ana", "/account/ad", { query: "x" })).status, 404);
});

Deno.test("welcome email: a failed send is retried on the next visit, then never again", async () => {
  const t = mk({ mailOk: false });
  await t.as("ana", "/account/me");
  await t.as("ana", "/account/me");
  assertEquals(t.mail.filter((m) => m.tag === "welcome").length, 2, "retried after the failure");
  assertEquals([...t.store.accounts.values()][0].welcome_sent_at, null);
});

Deno.test("web chat Velocity view: counted once per request id and credited to the account's web earner", async () => {
  const t = mk();
  const view = (who: string, body: unknown, headers: Record<string, string> = {}) =>
    t.call("/account/impression", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${jwt(who)}`, ...headers } });
  const ok = { network: "velocity", request_id: "6a9e9ccd-f98f-467e-8992-e91680f8a249", ad_id: "f63945d0c0ae-0" };
  assertEquals((await t.call("/account/impression", { method: "POST", body: JSON.stringify(ok) })).status, 401, "needs a session");
  assertEquals((await view("ana", { ...ok, network: "idlen" })).status, 400, "only client-fetched networks");
  assertEquals((await view("ana", { ...ok, request_id: "x" })).status, 400);
  const r = await (await view("ana", ok)).json();
  assertEquals(r, { ok: true, counted: true, credited: true });
  const row = [...t.store.ads.values()].find((a) => a.provider === "velocity")!;
  assertEquals(row.site_key, "vibedough-app");
  assertEquals(row.tracking.requestId, ok.request_id);
  const web = t.store.earners.get(row.earner_id as string);
  assertEquals(web.ref, "web-app");
  assertEquals(web.account_id, [...t.store.accounts.values()][0].id);
  assertEquals((await (await view("ana", ok)).json()).duplicate, true, "the same request id never counts twice");
  // Local development counts nothing.
  const dev = await (await view("bo", { ...ok, request_id: "11111111-2222-3333-4444-555555555555" }, { origin: "http://localhost:8000" })).json();
  assertEquals(dev.sandbox, true);
  // The account page hands the web chat an opaque id for the network, never the email.
  const me = await (await t.as("ana", "/account/me")).json();
  assertMatch(me.ad_user_id, /^[0-9a-f]{32}$/);
  assert(!me.ad_user_id.includes("ana"));
});

Deno.test("web chat: stops for the month at the dollar cap, and ads stop with it", async () => {
  const t = mk({ chat: true, chatCap: 1, replyCost: 0.4 });
  const say = (text: string) => t.as("ana", "/account/chat", { messages: [{ role: "user", content: text }] });
  assertEquals((await say("one")).status, 200);
  assertEquals((await say("two")).status, 200); // $0.80 spent
  assertEquals((await (await t.as("ana", "/account/me")).json()).chat_open, true);
  assertEquals((await say("three")).status, 200); // $1.20: over the cap from here on
  const r = await say("four");
  assertEquals(r.status, 503);
  assertMatch((await r.json()).error, /paused until the 1st/);
  assertEquals((await (await t.as("ana", "/account/me")).json()).chat_open, false, "no sponsored lines while the chat is paused");
});

Deno.test("chat cost: Haiku 5.5 list prices, long prompts at the higher tier, rounded up", async () => {
  const { chatCost, CHAT_MODEL } = await import("../supabase/functions/goodwait/chat.ts");
  assertEquals(CHAT_MODEL, "claude-haiku-5-5");
  assertEquals(chatCost({ input_tokens: 1_000_000, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 }), 0.5); // over 100K: $0.50/M
  assertEquals(chatCost({ input_tokens: 10_000, output_tokens: 1_000, cache_write_tokens: 0, cache_read_tokens: 0 }), 0.0015); // $0.001 + $0.0005
  assertEquals(chatCost({ input_tokens: 0, output_tokens: 0, cache_write_tokens: 8_000, cache_read_tokens: 10_000 }), 0.0011); // 8K x 0.125 + 10K x 0.01
  assertEquals(chatCost({ input_tokens: 1, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 }), 0.000001, "never rounds down to free");
});

Deno.test("saved chats: a reply is saved to the account; reopening resumes with the saved context", async () => {
  const t = mk({ chat: true });
  const r1 = await (await t.as("ana", "/account/chat", { message: "  Help me   plan a Next.js app  " })).json();
  assertEquals(r1.reply, "echo: Help me   plan a Next.js app");
  assertMatch(r1.chat_id, /^[0-9a-f-]{36}$/);
  assertEquals(r1.title, "Help me plan a Next.js app");
  const r2 = await (await t.as("ana", "/account/chat", { message: "Now add auth", chat_id: r1.chat_id })).json();
  assertEquals(r2.chat_id, r1.chat_id);
  // The model saw the saved history, not anything the browser sent.
  assertEquals(t.seen[1], [
    { role: "user", content: "Help me   plan a Next.js app" },
    { role: "assistant", content: "echo: Help me   plan a Next.js app" },
    { role: "user", content: "Now add auth" },
  ]);
  const list = await (await t.as("ana", "/account/chats")).json();
  assertEquals(list.chats.length, 1);
  assertEquals(list.chats[0].id, r1.chat_id);
  const open = await (await t.as("ana", `/account/chats/${r1.chat_id}`)).json();
  assertEquals(open.chat.title, "Help me plan a Next.js app");
  assertEquals(open.messages.map((m: { role: string }) => m.role), ["user", "assistant", "user", "assistant"]);
  assertEquals(open.messages[3].content, "echo: Now add auth");
});

Deno.test("saved chats: newest first, and one account never sees or writes another's chats", async () => {
  const t = mk({ chat: true });
  const a = await (await t.as("ana", "/account/chat", { message: "first" })).json();
  const b = await (await t.as("ana", "/account/chat", { message: "second" })).json();
  assertEquals((await (await t.as("ana", "/account/chats")).json()).chats.map((c: { title: string }) => c.title), ["second", "first"]);
  await t.as("ana", "/account/chat", { message: "more", chat_id: a.chat_id });
  assertEquals((await (await t.as("ana", "/account/chats")).json()).chats.map((c: { title: string }) => c.title), ["first", "second"]);
  assertEquals((await (await t.as("bo", "/account/chats")).json()).chats, []);
  assertEquals((await t.as("bo", `/account/chats/${a.chat_id}`)).status, 404);
  assertEquals((await t.as("bo", "/account/chat", { message: "sneak", chat_id: b.chat_id })).status, 404);
  assertEquals((await t.as("bo", "/account/chats/delete", { id: a.chat_id })).status, 404);
  assertEquals((await t.as("ana", "/account/chats/not-a-uuid")).status, 404);
  assertEquals((await t.call("/account/chats")).status, 401);
});

Deno.test("saved chats: delete removes the chat and its messages", async () => {
  const t = mk({ chat: true });
  const a = await (await t.as("ana", "/account/chat", { message: "delete me" })).json();
  assertEquals(await (await t.as("ana", "/account/chats/delete", { id: a.chat_id })).json(), { ok: true });
  assertEquals((await (await t.as("ana", "/account/chats")).json()).chats, []);
  assertEquals((await t.as("ana", `/account/chats/${a.chat_id}`)).status, 404);
  assertEquals((await t.as("ana", "/account/chat", { message: "again", chat_id: a.chat_id })).status, 404);
});

Deno.test("saved chats: a failed reply saves nothing; older pages sending messages[] still get answers, unsaved", async () => {
  const t = mk({ chat: true, chatPerDay: 1 });
  await t.as("ana", "/account/chat", { message: "one" });
  assertEquals((await t.as("ana", "/account/chat", { message: "two" })).status, 429);
  assertEquals((await (await t.as("ana", "/account/chats")).json()).chats.length, 1);
  const t2 = mk({ chat: true });
  const legacy = await (await t2.as("ana", "/account/chat", { messages: [{ role: "user", content: "hi" }] })).json();
  assertEquals(legacy, { reply: "echo: hi" });
  assertEquals((await (await t2.as("ana", "/account/chats")).json()).chats, []);
  assertEquals((await t2.as("ana", "/account/chat", { message: "   " })).status, 400);
});

Deno.test("web-only: skipping the install shows on the account and can be undone", async () => {
  const t = mk();
  assertEquals((await (await t.as("ana", "/account/me")).json()).web_only, false);
  assertEquals(await (await t.as("ana", "/account/web-only", { on: true })).json(), { ok: true, web_only: true });
  assertEquals((await (await t.as("ana", "/account/me")).json()).web_only, true);
  await t.as("ana", "/account/web-only", { on: false });
  assertEquals((await (await t.as("ana", "/account/me")).json()).web_only, false);
});

Deno.test("chat titles: first message on one line, trimmed to 60 characters", () => {
  assertEquals(chatTitle("  a\n b  "), "a b");
  assertEquals(chatTitle("x".repeat(80)), "x".repeat(57) + "...");
  assertEquals(chatTitle("   "), "New chat");
});
