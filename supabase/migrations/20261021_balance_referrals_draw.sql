-- One balance, three exits (cash, donate, launch-draw entries), referrals, payout holds, public ledger.
--
-- Money model:
--   credits  = impact_wait.earner_payouts (kind earnings | referral), written only by settle() from
--              what a network actually paid. Status 'owed' = in the balance; 'void' = reversed.
--   debits   = impact_wait.redemptions (kind cash | donate). Cash is recorded when actually sent;
--              a donation is pending until remitted to the cause, then paid.
--   balance  = owed credits - non-void redemptions.
-- Draw entries are free: earned by paid views or the free alternate entry. They never spend balance.

-- Program terms
alter table impact_wait.program add column if not exists referral_pct numeric(5,2) not null default 10 check (referral_pct between 0 and 50);
alter table impact_wait.program add column if not exists hold_days int not null default 30 check (hold_days >= 0);

-- Earners: referral code, who referred them, default exit
-- 8 characters from an alphabet without look-alikes (no i, l, o, 0, 1).
create or replace function impact_wait.new_referral_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 31), 1), '')
  from generate_series(1, 8)
$$;
revoke all on function impact_wait.new_referral_code() from public, anon, authenticated;
alter table impact_wait.earners add column if not exists referral_code text null unique check (referral_code ~ '^[a-z2-9]{8}$');
update impact_wait.earners set referral_code = impact_wait.new_referral_code() where referral_code is null;
alter table impact_wait.earners alter column referral_code set default impact_wait.new_referral_code();
alter table impact_wait.earners alter column referral_code set not null;
alter table impact_wait.earners add column if not exists referred_by uuid null references impact_wait.earners(id);
alter table impact_wait.earners add column if not exists auto_exit text not null default 'cash' check (auto_exit in ('cash', 'donate'));
alter table impact_wait.earners add constraint earners_no_self_referral check (referred_by is null or referred_by <> id);
create index if not exists earners_referred_by on impact_wait.earners (referred_by) where referred_by is not null;

-- Credits: earnings or a referral cut
alter table impact_wait.earner_payouts add column if not exists kind text not null default 'earnings' check (kind in ('earnings', 'referral'));
alter table impact_wait.earner_payouts add column if not exists from_earner_id uuid null references impact_wait.earners(id);
alter table impact_wait.earner_payouts drop constraint if exists earner_payouts_settlement_id_earner_id_key;
create unique index if not exists earner_payouts_unique on impact_wait.earner_payouts (settlement_id, earner_id, kind, coalesce(from_earner_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Causes people can donate to
create table if not exists impact_wait.causes (
  slug text primary key check (slug ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  url text not null check (url ~ '^https://'),
  active boolean not null default true
);
insert into impact_wait.causes (slug, name, url) values ('charity-water', 'charity: water', 'https://www.charitywater.org') on conflict (slug) do nothing;

-- Debits
create table if not exists impact_wait.redemptions (
  id uuid primary key default gen_random_uuid(),
  earner_id uuid not null references impact_wait.earners(id),
  kind text not null check (kind in ('cash', 'donate')),
  amount_usd numeric(12,4) not null check (amount_usd > 0),
  cause text null references impact_wait.causes(slug),
  status text not null default 'pending' check (status in ('pending', 'paid', 'void')),
  method text null,
  reference text null,
  created_at timestamptz not null default now(),
  paid_at timestamptz null,
  check ((kind = 'donate') = (cause is not null))
);
create index if not exists redemptions_earner on impact_wait.redemptions (earner_id, status);

-- Balance per earner
create or replace view impact_wait.balances with (security_invoker = true) as
  select e.id as earner_id,
         coalesce((select sum(p.amount_usd) from impact_wait.earner_payouts p where p.earner_id = e.id and p.status in ('owed', 'paid')), 0) as credited_usd,
         coalesce((select sum(r.amount_usd) from impact_wait.redemptions r where r.earner_id = e.id and r.status <> 'void'), 0) as redeemed_usd,
         coalesce((select sum(p.amount_usd) from impact_wait.earner_payouts p where p.earner_id = e.id and p.status in ('owed', 'paid')), 0)
           - coalesce((select sum(r.amount_usd) from impact_wait.redemptions r where r.earner_id = e.id and r.status <> 'void'), 0) as balance_usd
  from impact_wait.earners e;

-- Settle a network's actual revenue for [p_start, p_end): user share pro rata by credited views,
-- plus each referrer's cut (referral_pct of their friend's share) paid out of the house half.
-- Earners set to donate get their new credits queued as a pending donation in the same step.
create or replace function impact_wait.settle(p_network text, p_start timestamptz, p_end timestamptz, p_actual_usd numeric, p_note text default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_share numeric;
  v_ref numeric;
  v_total int;
begin
  select user_share_pct, referral_pct into v_share, v_ref from impact_wait.program where id = 1;
  if v_share + v_share * v_ref / 100 > 100 then
    raise exception 'user share plus referral cut exceeds revenue';
  end if;
  select count(*) into v_total from impact_wait.ads
    where credited and settlement_id is null and provider = p_network and impression_at >= p_start and impression_at < p_end;
  insert into impact_wait.settlements (network, period_start, period_end, actual_usd, user_share_pct, credited_waits, note)
    values (p_network, p_start, p_end, p_actual_usd, v_share, v_total, p_note) returning id into v_id;
  if v_total > 0 then
    insert into impact_wait.earner_payouts (settlement_id, earner_id, credited_waits, amount_usd, kind)
      select v_id, earner_id, count(*), round(p_actual_usd * (v_share / 100) * count(*) / v_total, 4), 'earnings'
      from impact_wait.ads
      where credited and settlement_id is null and provider = p_network and impression_at >= p_start and impression_at < p_end
      group by earner_id;
    -- Referral cut: only on earnings (never on another referral cut), only to an active referrer.
    insert into impact_wait.earner_payouts (settlement_id, earner_id, credited_waits, amount_usd, kind, from_earner_id)
      select v_id, f.referred_by, 0, round(p.amount_usd * v_ref / 100, 4), 'referral', p.earner_id
      from impact_wait.earner_payouts p
      join impact_wait.earners f on f.id = p.earner_id
      join impact_wait.earners r on r.id = f.referred_by and r.status = 'active'
      where p.settlement_id = v_id and p.kind = 'earnings' and round(p.amount_usd * v_ref / 100, 4) > 0;
    update impact_wait.ads set settlement_id = v_id
      where credited and settlement_id is null and provider = p_network and impression_at >= p_start and impression_at < p_end;
    insert into impact_wait.redemptions (earner_id, kind, amount_usd, cause, status, method)
      select p.earner_id, 'donate', sum(p.amount_usd), 'charity-water', 'pending', 'auto'
      from impact_wait.earner_payouts p join impact_wait.earners e on e.id = p.earner_id
      where p.settlement_id = v_id and e.auto_exit = 'donate'
      group by p.earner_id
      having sum(p.amount_usd) > 0;
  end if;
  return v_id;
end $$;
revoke all on function impact_wait.settle(text, timestamptz, timestamptz, numeric, text) from public, anon, authenticated;

-- Who can be paid cash now: balance at or above the minimum, a PayPal email, cash as their exit,
-- and past the hold (account and first credited view both older than hold_days).
drop view if exists impact_wait.payouts_due;
create view impact_wait.payouts_due with (security_invoker = true) as
  select e.id as earner_id, e.payout_email, b.balance_usd as owed_usd
  from impact_wait.earners e
  join impact_wait.balances b on b.earner_id = e.id
  cross join impact_wait.program pr
  where pr.id = 1 and e.status = 'active' and e.auto_exit = 'cash' and e.payout_email is not null
    and b.balance_usd >= pr.min_payout_usd
    and e.created_at < now() - make_interval(days => pr.hold_days)
    and (select min(a.impression_at) from impact_wait.ads a where a.earner_id = e.id and a.credited) < now() - make_interval(days => pr.hold_days);

-- Record a cash payout that was actually sent. Refuses more than the balance.
create or replace function impact_wait.record_cash_payout(p_earner uuid, p_amount numeric, p_method text, p_reference text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_bal numeric; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_earner::text));
  select balance_usd into v_bal from impact_wait.balances where earner_id = p_earner;
  if v_bal is null or p_amount <= 0 or p_amount > v_bal then
    raise exception 'amount % exceeds balance %', p_amount, coalesce(v_bal, 0);
  end if;
  insert into impact_wait.redemptions (earner_id, kind, amount_usd, status, method, reference, paid_at)
    values (p_earner, 'cash', p_amount, 'paid', p_method, p_reference, now()) returning id into v_id;
  return v_id;
end $$;
revoke all on function impact_wait.record_cash_payout(uuid, numeric, text, text) from public, anon, authenticated;

-- Donations waiting to be sent, per cause; mark them sent with the receipt reference.
create or replace view impact_wait.donations_due with (security_invoker = true) as
  select cause, sum(amount_usd) as amount_usd, count(*) as donations, min(created_at) as oldest
  from impact_wait.redemptions where kind = 'donate' and status = 'pending' group by cause;

create or replace function impact_wait.mark_donations_sent(p_cause text, p_reference text)
returns numeric
language plpgsql
set search_path = ''
as $$
declare v numeric;
begin
  update impact_wait.redemptions set status = 'paid', reference = p_reference, paid_at = now()
    where kind = 'donate' and status = 'pending' and cause = p_cause;
  select coalesce(sum(amount_usd), 0) into v from impact_wait.redemptions where kind = 'donate' and cause = p_cause and reference = p_reference;
  return v;
end $$;
revoke all on function impact_wait.mark_donations_sent(text, text) from public, anon, authenticated;

-- Launch draw. Never open without approved official rules (enforced by the check below).
create table if not exists impact_wait.draws (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  prize_usd numeric(10,2) not null check (prize_usd > 0),
  opens_at timestamptz not null,
  closes_at timestamptz not null check (closes_at > opens_at),
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'drawn', 'void')),
  rules_url text null check (rules_url is null or rules_url ~ '^https://'),
  rules_approved_at timestamptz null,
  rules_approved_by text null,
  seed_commit text null check (seed_commit is null or seed_commit ~ '^[0-9a-f]{64}$'),
  seed_reveal text null,
  winner_key text null,
  winner_entries int null,
  total_entries int null,
  drawn_at timestamptz null,
  created_at timestamptz not null default now(),
  check (status in ('draft', 'void') or (rules_url is not null and rules_approved_at is not null and seed_commit is not null))
);
insert into impact_wait.draws (name, prize_usd, opens_at, closes_at)
  select 'Launch draw', 1000, now() + interval '30 days', now() + interval '58 days'
  where not exists (select 1 from impact_wait.draws);

-- The free alternate way to enter (no purchase, no ad views): one entry per email per draw per day.
create table if not exists impact_wait.draw_free_entries (
  id bigint generated always as identity primary key,
  draw_id uuid not null references impact_wait.draws(id),
  email text not null check (email = lower(email) and length(email) <= 254),
  entry_day date not null default (now() at time zone 'utc')::date,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  unique (draw_id, email, entry_day)
);

-- Entries per entrant for a draw: one per credited view in the window, plus free entries.
create or replace view impact_wait.draw_entries with (security_invoker = true) as
  select d.id as draw_id, 'earner:' || a.earner_id::text as entrant_key, count(*)::int as entries
  from impact_wait.draws d
  join impact_wait.ads a on a.credited and a.earner_id is not null and a.impression_at >= d.opens_at and a.impression_at < d.closes_at
  join impact_wait.earners e on e.id = a.earner_id and e.status = 'active'
  group by d.id, a.earner_id
  union all
  select f.draw_id, 'email:' || f.email, count(*)::int
  from impact_wait.draw_free_entries f group by f.draw_id, f.email;

-- Pick the winner of a closed draw with the seed whose sha256 was committed before it opened.
-- Deterministic: anyone with the entry list and the revealed seed can re-run it.
create or replace function impact_wait.draw_pick(p_draw uuid, p_seed text)
returns text
language plpgsql
set search_path = ''
as $$
declare d record; v_total bigint; v_target bigint; v_acc bigint := 0; r record;
begin
  select * into d from impact_wait.draws where id = p_draw for update;
  if d.status <> 'closed' then raise exception 'draw must be closed (is %)', d.status; end if;
  if encode(extensions.digest(p_seed, 'sha256'), 'hex') <> d.seed_commit then raise exception 'seed does not match the commitment'; end if;
  select coalesce(sum(entries), 0) into v_total from impact_wait.draw_entries where draw_id = p_draw;
  if v_total = 0 then raise exception 'no entries'; end if;
  v_target := (('x' || substr(encode(extensions.digest(p_seed || ':' || p_draw::text, 'sha256'), 'hex'), 1, 15))::bit(60)::bigint) % v_total;
  for r in select entrant_key, entries from impact_wait.draw_entries where draw_id = p_draw order by entrant_key loop
    v_acc := v_acc + r.entries;
    if v_target < v_acc then
      update impact_wait.draws set status = 'drawn', seed_reveal = p_seed, winner_key = r.entrant_key,
        winner_entries = r.entries, total_entries = v_total, drawn_at = now() where id = p_draw;
      return r.entrant_key;
    end if;
  end loop;
  raise exception 'unreachable';
end $$;
revoke all on function impact_wait.draw_pick(uuid, text) from public, anon, authenticated;

-- Public ledger: totals only, no identities.
create or replace view impact_wait.public_ledger with (security_invoker = true) as
  select
    coalesce((select sum(amount_usd) from impact_wait.earner_payouts where status in ('owed', 'paid')), 0) as credited_to_users_usd,
    coalesce((select sum(amount_usd) from impact_wait.redemptions where kind = 'cash' and status = 'paid'), 0) as paid_out_usd,
    coalesce((select sum(amount_usd) from impact_wait.redemptions where kind = 'donate' and status = 'paid'), 0) as donated_usd,
    coalesce((select sum(amount_usd) from impact_wait.redemptions where kind = 'donate' and status = 'pending'), 0) as donation_pending_usd,
    (select count(distinct earner_id) from impact_wait.redemptions where kind = 'cash' and status = 'paid') as people_paid,
    (select max(coalesce(paid_at, created_at)) from impact_wait.redemptions) as last_activity_at;

alter table impact_wait.causes enable row level security;
alter table impact_wait.redemptions enable row level security;
alter table impact_wait.draws enable row level security;
alter table impact_wait.draw_free_entries enable row level security;
revoke all on impact_wait.causes, impact_wait.redemptions, impact_wait.draws, impact_wait.draw_free_entries,
  impact_wait.balances, impact_wait.donations_due, impact_wait.draw_entries, impact_wait.public_ledger, impact_wait.payouts_due
  from anon, authenticated;
revoke all on sequence impact_wait.draw_free_entries_id_seq from anon, authenticated;
