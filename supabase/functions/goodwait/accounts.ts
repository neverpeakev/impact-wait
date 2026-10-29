// Vibedough accounts: the pieces the account routes in app.ts use. Validation for the W-9 and
// install codes, and the two emails the API sends itself (sign-in link, welcome).

// A signed-in person, as Supabase Auth's /auth/v1/user returns them.
export type AuthUser = { id: string; email: string; provider: string; meta: Record<string, unknown> };
export type SignInLink = { tokenHash: string; type: string; otp: string | null };
// The Supabase Auth calls the API makes: who a session belongs to, and a sign-in link for an email.
export interface AuthApi {
  getUser(accessToken: string): Promise<AuthUser | null>;
  // Creates the user when they don't exist yet. Null when Auth refused (bad address, rate limit).
  signInLink(email: string): Promise<SignInLink | null>;
}
export type Email = { to: string; subject: string; html: string; text: string; tag: string };
export type Mailer = (m: Email) => Promise<boolean>;

export type Account = { id: string; user_id: string; email: string; install_code: string; paypal_email: string | null; created_at: Date | string; welcome_sent_at: Date | string | null; web_only_at?: Date | string | null };
export type Install = { earner_id: string; kind: "install" | "web"; linked_at: Date | string | null; last_seen_at: Date | string | null };
// earners.ref of the account's own web-chat earner.
export const WEB_EARNER_REF = "web-app";
export type TaxFormSummary = { tin_type: "ssn" | "ein"; tin_last4: string; legal_name: string; signed_at: Date | string };
export type TaxForm = {
  legal_name: string; business_name: string | null; tax_class: string;
  line1: string; city: string; state: string; zip: string;
  tin_type: "ssn" | "ein"; tin: string; signed_name: string;
};

export const INSTALL_CODE_RE = /^VD-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;
// Accepts what people actually paste: any case, with or without the dashes or spaces.
export function normalizeInstallCode(raw: unknown): string | null {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^VD([A-Z0-9]{8})$/);
  if (!m) return null;
  const code = `VD-${m[1].slice(0, 4)}-${m[1].slice(4)}`;
  return INSTALL_CODE_RE.test(code) ? code : null;
}

const TAX_CLASSES = new Set(["individual", "c_corp", "s_corp", "partnership", "trust_estate", "llc_c", "llc_s", "llc_p", "other"]);
const STATES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY " +
  "AS GU MP PR VI AA AE AP").split(" "));
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// SSNs the SSA never issues: area 000, 666 or 900-999, group 00, serial 0000.
export function validSsn(d: string): boolean {
  if (!/^[0-9]{9}$/.test(d)) return false;
  const area = Number(d.slice(0, 3));
  return area !== 0 && area !== 666 && area < 900 && d.slice(3, 5) !== "00" && d.slice(5) !== "0000";
}
// EIN prefixes the IRS has never assigned.
const BAD_EIN_PREFIX = new Set(["00", "07", "08", "09", "17", "18", "19", "28", "29", "49", "69", "70", "78", "79", "89", "96", "97"]);
export function validEin(d: string): boolean {
  return /^[0-9]{9}$/.test(d) && !BAD_EIN_PREFIX.has(d.slice(0, 2));
}

// Returns the cleaned form, or the first problem in words a person can act on.
export function parseTaxForm(b: Record<string, unknown>): { form: TaxForm } | { error: string } {
  const legal_name = clean(b.legal_name, 120);
  if (legal_name.length < 2) return { error: "Enter your name as shown on your tax return." };
  const business_name = clean(b.business_name, 120) || null;
  const tax_class = String(b.tax_class ?? "");
  if (!TAX_CLASSES.has(tax_class)) return { error: "Pick a federal tax classification." };
  const line1 = clean(b.line1, 120);
  const city = clean(b.city, 60);
  const state = clean(b.state, 2).toUpperCase();
  const zip = clean(b.zip, 10);
  if (line1.length < 3 || city.length < 2) return { error: "Enter your street address and city." };
  if (!STATES.has(state)) return { error: "Pick your state." };
  if (!/^[0-9]{5}(-[0-9]{4})?$/.test(zip)) return { error: "Enter a 5-digit ZIP code." };
  const tin_type = b.tin_type === "ein" ? "ein" : b.tin_type === "ssn" ? "ssn" : null;
  if (!tin_type) return { error: "Choose SSN or EIN." };
  const tin = String(b.tin ?? "").replace(/[\s-]/g, "");
  if (tin_type === "ssn" ? !validSsn(tin) : !validEin(tin)) return { error: tin_type === "ssn" ? "That isn't a valid Social Security number." : "That isn't a valid EIN." };
  if (b.certify !== true) return { error: "Check the box to certify the form." };
  const signed_name = clean(b.signature, 120);
  if (signed_name.length < 2) return { error: "Type your full name to sign." };
  return { form: { legal_name, business_name, tax_class, line1, city, state, zip, tin_type, tin, signed_name } };
}

// ------------------------------------------------------------------ email

const BRAND = "Vibedough";
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One layout for every email: linen page, ink type, one cobalt button. Inline styles only,
// because that is all most mail clients keep.
function layout(o: { preheader: string; heading: string; bodyHtml: string; cta?: { label: string; url: string }; footHtml?: string }) {
  const btn = o.cta
    ? `<tr><td style="padding:8px 0 24px"><a href="${escHtml(o.cta.url)}" style="display:inline-block;background:#2B50C8;color:#ffffff;font:600 16px/1 Helvetica,Arial,sans-serif;text-decoration:none;padding:15px 24px;border-radius:10px">${escHtml(o.cta.label)}</a></td></tr>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escHtml(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#EEF2F8">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escHtml(o.preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#EEF2F8"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px">
<tr><td style="padding:0 0 20px;font:400 22px/1 Georgia,'Times New Roman',serif;color:#14213D">vibedough</td></tr>
<tr><td style="background:#ffffff;border-radius:14px;padding:32px 28px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tr><td style="font:400 28px/1.15 Georgia,'Times New Roman',serif;color:#14213D;padding:0 0 14px">${escHtml(o.heading)}</td></tr>
<tr><td style="font:400 16px/1.6 Helvetica,Arial,sans-serif;color:#4A5878;padding:0 0 18px">${o.bodyHtml}</td></tr>
${btn}
${o.footHtml ? `<tr><td style="font:400 14px/1.6 Helvetica,Arial,sans-serif;color:#4A5878">${o.footHtml}</td></tr>` : ""}
</table></td></tr>
<tr><td style="padding:20px 4px 0;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#7F8BAA">${BRAND} pays you a share of the ad revenue while Claude Code thinks. A Never Peak project, El Segundo, CA.</td></tr>
</table></td></tr></table></body></html>`;
}

export function signInEmail(to: string, url: string, otp: string | null): Email {
  const code = otp ? `<p style="margin:0">Or enter this code on the page you came from: <b style="font:700 20px/1 'Courier New',monospace;color:#14213D;letter-spacing:2px">${escHtml(otp)}</b></p>` : "";
  return {
    to, tag: "signin",
    subject: `Your ${BRAND} sign-in link`,
    html: layout({
      preheader: "One tap and you're in. The link works once and expires in an hour.",
      heading: "Sign in to Vibedough",
      bodyHtml: "Tap the button to sign in. The link works once and expires in an hour.",
      cta: { label: "Sign in", url },
      footHtml: `${code}<p style="margin:12px 0 0">Didn't ask for this? Ignore it and nothing happens.</p>`,
    }),
    text: `Sign in to ${BRAND}\n\nOpen this link to sign in (works once, expires in an hour):\n${url}\n${otp ? `\nOr enter this code: ${otp}\n` : ""}\nDidn't ask for this? Ignore it and nothing happens.\n`,
  };
}

export function welcomeEmail(to: string, installCode: string, appUrl: string, installCommand: string): Email {
  return {
    to, tag: "welcome",
    subject: `Welcome to ${BRAND}. Here's your install code`,
    html: layout({
      preheader: `Your install code is ${installCode}. Paste one line on your computer and you start earning.`,
      heading: "You're in. One step left.",
      bodyHtml: `Your account is ready. To start earning, add ${BRAND} to Claude Code on your computer with this one line in your terminal:` +
        `<div style="margin:14px 0 6px;background:#0E1730;color:#D7DEEE;border-radius:10px;padding:14px 16px;font:400 13px/1.55 'Courier New',monospace;word-break:break-all">${escHtml(installCommand)}</div>` +
        `<p style="margin:12px 0 0">Then start Claude Code (or run <b>/reload-plugins</b> if it's already open). Your install code: <b style="font:700 16px/1 'Courier New',monospace;color:#14213D">${escHtml(installCode)}</b>. Already installed? Type <b>/earn link ${escHtml(installCode)}</b> in Claude Code.</p>`,
      cta: { label: "Open your dashboard", url: appUrl },
      footHtml: "<p style=\"margin:0\">Then add your PayPal email and a W-9 in the dashboard so we can pay you. Half of the ad revenue from your views is yours, settled monthly from what advertisers actually paid.</p>" +
        "<p style=\"margin:12px 0 0\">Questions? Just reply to this email.</p>",
    }),
    text: `Welcome to ${BRAND}.\n\nTo start earning, run this one line in your terminal:\n\n${installCommand}\n\nThen start Claude Code (or run /reload-plugins if it's already open).\nYour install code: ${installCode}\nAlready installed? Type in Claude Code: /earn link ${installCode}\n\nDashboard: ${appUrl}\n\nThen add your PayPal email and a W-9 in the dashboard so we can pay you.\nQuestions? Just reply to this email.\n`,
  };
}

export function installCommand(code: string): string {
  return `claude plugin install vibedough --marketplace neverpeakev/vibedough-claude-code --config accountCode=${code}`;
}
