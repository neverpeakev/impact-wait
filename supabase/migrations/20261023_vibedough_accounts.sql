-- Vibedough accounts: a web sign-in (Supabase Auth: magic link or SSO) that owns one or more
-- Claude Code installs (earners), a PayPal email and a W-9.
-- Additive only: new tables, new nullable columns on earners, two new program terms.
--
-- How an install joins an account: every account gets a unique install code (VD-XXXX-XXXX).
-- The person runs `/earn link VD-XXXX-XXXX` in Claude Code; the plugin sends the code with its
-- own earner token, and the API sets earners.account_id. Earnings stay per earner (nothing about
-- settlement changes); the account view adds up its linked earners.
--
-- Security: everything stays in the private impact_wait schema, which the REST API does not
-- expose. RLS is on for every new table, with own-row read policies for signed-in users as
-- defense in depth, and no grants to anon/authenticated. The goodwait function connects as the
-- table owner. TINs are encrypted with pgcrypto under a key kept in Vault; only the last 4 digits
-- are stored in the clear.

-- VD- plus 8 characters from an alphabet without look-alikes (no I, L, O, 0, 1), shown as VD-XXXX-XXXX.
create or replace function impact_wait.new_install_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'VD-' || substr(c, 1, 4) || '-' || substr(c, 5, 4)
  from (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 31), 1), '') as c
        from generate_series(1, 8)) s
$$;
revoke all on function impact_wait.new_install_code() from public, anon, authenticated;

create table if not exists impact_wait.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  install_code text not null unique default impact_wait.new_install_code() check (install_code ~ '^VD-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'),
  provider text null,                          -- how they first signed in: email, google, github, facebook, twitter
  source jsonb null,                           -- landing variant and utm at sign-up
  paypal_email text null,
  welcome_sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One W-9 per account (the latest replaces the earlier one). The TIN is encrypted; last 4 kept for display.
create table if not exists impact_wait.tax_forms (
  account_id uuid primary key references impact_wait.accounts(id) on delete cascade,
  form text not null default 'w9' check (form in ('w9')),
  legal_name text not null,
  business_name text null,
  tax_class text not null check (tax_class in ('individual', 'c_corp', 's_corp', 'partnership', 'trust_estate', 'llc_c', 'llc_s', 'llc_p', 'other')),
  address_line1 text not null,
  city text not null,
  state text not null,
  zip text not null,
  tin_type text not null check (tin_type in ('ssn', 'ein')),
  tin_last4 text not null check (tin_last4 ~ '^[0-9]{4}$'),
  tin_enc bytea not null,
  signed_name text not null,
  signed_at timestamptz not null default now(),
  ip_hash text null,
  user_agent text null,
  updated_at timestamptz not null default now()
);

alter table impact_wait.earners add column if not exists account_id uuid null references impact_wait.accounts(id) on delete set null;
alter table impact_wait.earners add column if not exists linked_at timestamptz null;
alter table impact_wait.earners add column if not exists last_seen_at timestamptz null;
create index if not exists earners_account on impact_wait.earners (account_id) where account_id is not null;

-- Rate limits the API keeps for itself: sign-in emails per address and per network, failed link attempts.
create table if not exists impact_wait.rate_events (
  id bigint generated always as identity primary key,
  kind text not null,
  key text not null,                           -- a hash, never a raw email or address
  created_at timestamptz not null default now()
);
create index if not exists rate_events_lookup on impact_wait.rate_events (kind, key, created_at desc);

-- Program terms: whether the account page hides earnings until PayPal and a W-9 are on file,
-- whether cash payouts wait for a W-9 on linked installs, and how many installs one account may link.
alter table impact_wait.program add column if not exists earnings_need_payout_info boolean not null default true;
alter table impact_wait.program add column if not exists cash_needs_tax_form boolean not null default true;
alter table impact_wait.program add column if not exists max_installs_per_account int not null default 5 check (max_installs_per_account >= 1);

-- TIN encryption key, generated inside the database so it never travels anywhere else.
-- The Resend key for the API's own email (impact_wait_resend_key) was copied into Vault the same way,
-- from the key the other products on this project already use; the function reads it from Vault.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'impact_wait_tax_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'impact_wait_tax_key', 'Encrypts TINs in impact_wait.tax_forms');
  end if;
end $$;

-- Saves (or replaces) an account's W-9, encrypting the TIN with the Vault key.
create or replace function impact_wait.save_tax_form(p_account uuid, p_legal_name text, p_business_name text, p_tax_class text,
  p_line1 text, p_city text, p_state text, p_zip text, p_tin_type text, p_tin text, p_signed_name text, p_ip_hash text, p_user_agent text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_tin !~ '^[0-9]{9}$' then raise exception 'tin must be 9 digits'; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'impact_wait_tax_key';
  if v_key is null then raise exception 'tax key missing'; end if;
  insert into impact_wait.tax_forms (account_id, legal_name, business_name, tax_class, address_line1, city, state, zip, tin_type, tin_last4, tin_enc, signed_name, signed_at, ip_hash, user_agent, updated_at)
    values (p_account, p_legal_name, p_business_name, p_tax_class, p_line1, p_city, p_state, p_zip, p_tin_type, right(p_tin, 4),
            extensions.pgp_sym_encrypt(p_tin, v_key), p_signed_name, now(), p_ip_hash, p_user_agent, now())
  on conflict (account_id) do update set legal_name = excluded.legal_name, business_name = excluded.business_name, tax_class = excluded.tax_class,
    address_line1 = excluded.address_line1, city = excluded.city, state = excluded.state, zip = excluded.zip, tin_type = excluded.tin_type,
    tin_last4 = excluded.tin_last4, tin_enc = excluded.tin_enc, signed_name = excluded.signed_name, signed_at = now(),
    ip_hash = excluded.ip_hash, user_agent = excluded.user_agent, updated_at = now();
  return right(p_tin, 4);
end $$;
revoke all on function impact_wait.save_tax_form(uuid, text, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;

-- Operator only, for filing 1099s: the full TIN for one account.
create or replace function impact_wait.reveal_tin(p_account uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select extensions.pgp_sym_decrypt(t.tin_enc, (select decrypted_secret from vault.decrypted_secrets where name = 'impact_wait_tax_key'))
  from impact_wait.tax_forms t where t.account_id = p_account
$$;
revoke all on function impact_wait.reveal_tin(uuid) from public, anon, authenticated;

-- Cash payouts: unchanged for installs with no account. A linked install also needs its account's
-- W-9 on file when program.cash_needs_tax_form is on.
-- account_id is added at the end, so the view is replaced in place (nothing depends on it).
create or replace view impact_wait.payouts_due with (security_invoker = true) as
  select e.id as earner_id, e.payout_email, b.balance_usd as owed_usd, e.account_id
  from impact_wait.earners e
  join impact_wait.balances b on b.earner_id = e.id
  cross join impact_wait.program pr
  where pr.id = 1 and e.status = 'active' and e.auto_exit = 'cash' and e.payout_email is not null
    and b.balance_usd >= pr.min_payout_usd
    and e.created_at < now() - make_interval(days => pr.hold_days)
    and (select min(a.impression_at) from impact_wait.ads a where a.earner_id = e.id and a.credited) < now() - make_interval(days => pr.hold_days)
    and (e.account_id is null or not pr.cash_needs_tax_form or exists (select 1 from impact_wait.tax_forms t where t.account_id = e.account_id));

alter table impact_wait.accounts enable row level security;
alter table impact_wait.tax_forms enable row level security;
alter table impact_wait.rate_events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'impact_wait' and tablename = 'accounts' and policyname = 'accounts_own_read') then
    create policy accounts_own_read on impact_wait.accounts for select to authenticated using (user_id = (select auth.uid()));
  end if;
end $$;
-- tax_forms and rate_events: no policies at all, so no client role can ever read them.
revoke all on impact_wait.accounts, impact_wait.tax_forms, impact_wait.rate_events, impact_wait.payouts_due from anon, authenticated;
revoke all on sequence impact_wait.rate_events_id_seq from anon, authenticated;

-- Operator recipes:
--   select email, install_code, paypal_email, created_at from impact_wait.accounts order by created_at desc;
--   select a.email, e.id, e.linked_at, e.last_seen_at from impact_wait.earners e join impact_wait.accounts a on a.id = e.account_id;
--   select impact_wait.reveal_tin('<account id>');                      -- 1099 filing only
--   update impact_wait.program set earnings_need_payout_info = false;  -- show earnings before PayPal + W-9
-- Nightly cleanup of the rate-limit log (applied with this migration):
--   select cron.schedule('impact_wait_rate_events_cleanup', '17 4 * * *', $$delete from impact_wait.rate_events where created_at < now() - interval '2 days'$$);
