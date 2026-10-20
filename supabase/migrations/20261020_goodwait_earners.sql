-- Goodwait earners: people paid a share of the ad revenue from their own waits.
-- Additive only: new tables, two nullable/defaulted columns on ads. Nothing existing changes.
--
-- Money rule: an earner is only ever owed money from SETTLED network revenue. Credited
-- waits are counted live; dollars are assigned when an operator records what a network
-- actually paid for a period and runs impact_wait.settle(), which splits the user share
-- pro rata by credited waits in that period.

create table if not exists impact_wait.earners (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,             -- sha256 of the gw_ token; the token itself is never stored
  status text not null default 'active' check (status in ('active', 'paused', 'banned')),
  payout_email text null,
  ref text null,                               -- where the install came from (a campaign or partner key)
  ip_hash text null,                           -- daily-rotating hash, same as ads.ip_hash
  created_at timestamptz not null default now()
);
create index if not exists earners_ip_created on impact_wait.earners (ip_hash, created_at desc);

-- Program terms, a single row. est_ecpm_usd null = no dollar estimate shown (counts only).
create table if not exists impact_wait.program (
  id int primary key default 1 check (id = 1),
  user_share_pct numeric(5,2) not null default 50 check (user_share_pct between 0 and 100),
  est_ecpm_usd numeric(10,4) null check (est_ecpm_usd is null or est_ecpm_usd >= 0),
  min_payout_usd numeric(10,2) not null default 10 check (min_payout_usd >= 0),
  daily_cap int not null default 200 check (daily_cap >= 0),
  min_gap_seconds int not null default 15 check (min_gap_seconds >= 0),
  max_earners_per_ip_day int not null default 3 check (max_earners_per_ip_day >= 0),
  updated_at timestamptz not null default now()
);
insert into impact_wait.program (id) values (1) on conflict (id) do nothing;

-- One row per settled period per network.
create table if not exists impact_wait.settlements (
  id uuid primary key default gen_random_uuid(),
  network text not null,
  period_start timestamptz not null,
  period_end timestamptz not null check (period_end > period_start),
  actual_usd numeric(12,4) not null check (actual_usd >= 0),  -- what the network actually paid for the period
  user_share_pct numeric(5,2) not null,
  credited_waits int not null,
  note text null,
  created_at timestamptz not null default now()
);

create table if not exists impact_wait.earner_payouts (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references impact_wait.settlements(id),
  earner_id uuid not null references impact_wait.earners(id),
  credited_waits int not null,
  amount_usd numeric(12,4) not null check (amount_usd >= 0),
  status text not null default 'owed' check (status in ('owed', 'paid', 'void')),
  paid_at timestamptz null,
  method text null,
  note text null,
  created_at timestamptz not null default now(),
  unique (settlement_id, earner_id)
);
create index if not exists earner_payouts_earner on impact_wait.earner_payouts (earner_id, status);

alter table impact_wait.ads add column if not exists earner_id uuid null references impact_wait.earners(id);
alter table impact_wait.ads add column if not exists credited boolean not null default false;
alter table impact_wait.ads add column if not exists settlement_id uuid null references impact_wait.settlements(id);
create index if not exists ads_earner_credited on impact_wait.ads (earner_id, impression_at desc) where credited;
create index if not exists ads_unsettled_credited on impact_wait.ads (provider, impression_at) where credited and settlement_id is null;

-- Split a network's actual revenue for [p_start, p_end) among earners, pro rata by credited waits.
-- Each credited wait is settled once: rerunning for an overlapping period settles only what is left.
create or replace function impact_wait.settle(p_network text, p_start timestamptz, p_end timestamptz, p_actual_usd numeric, p_note text default null)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_share numeric;
  v_total int;
begin
  select user_share_pct into v_share from impact_wait.program where id = 1;
  select count(*) into v_total from impact_wait.ads
    where credited and settlement_id is null and provider = p_network and impression_at >= p_start and impression_at < p_end;
  insert into impact_wait.settlements (network, period_start, period_end, actual_usd, user_share_pct, credited_waits, note)
    values (p_network, p_start, p_end, p_actual_usd, v_share, v_total, p_note) returning id into v_id;
  if v_total > 0 then
    insert into impact_wait.earner_payouts (settlement_id, earner_id, credited_waits, amount_usd)
      select v_id, earner_id, count(*), round(p_actual_usd * (v_share / 100) * count(*) / v_total, 4)
      from impact_wait.ads
      where credited and settlement_id is null and provider = p_network and impression_at >= p_start and impression_at < p_end
      group by earner_id;
    update impact_wait.ads set settlement_id = v_id
      where credited and settlement_id is null and provider = p_network and impression_at >= p_start and impression_at < p_end;
  end if;
  return v_id;
end $$;
revoke all on function impact_wait.settle(text, timestamptz, timestamptz, numeric, text) from public, anon, authenticated;

-- Who is owed what, for paying out (amounts at or above the minimum, with a payout email).
create or replace view impact_wait.payouts_due with (security_invoker = true) as
  select e.id as earner_id, e.payout_email, sum(p.amount_usd) as owed_usd, count(*) as settlements
  from impact_wait.earner_payouts p join impact_wait.earners e on e.id = p.earner_id
  where p.status = 'owed' and e.status = 'active'
  group by e.id, e.payout_email
  having sum(p.amount_usd) >= (select min_payout_usd from impact_wait.program where id = 1);

revoke all on impact_wait.earners, impact_wait.program, impact_wait.settlements, impact_wait.earner_payouts, impact_wait.payouts_due from anon, authenticated;

-- Operator recipes:
--   select impact_wait.settle('velocity', '2026-11-01', '2026-12-01', 123.45, 'Velocity Nov statement');
--   select * from impact_wait.payouts_due;
--   update impact_wait.earner_payouts set status = 'paid', paid_at = now(), method = 'paypal', note = '<txn id>'
--     where earner_id = '<id>' and status = 'owed';
--   update impact_wait.earners set status = 'banned' where id = '<id>';  -- stops future credit
