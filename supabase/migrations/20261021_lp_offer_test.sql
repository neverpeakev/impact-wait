-- Landing-page offer test (cash / prize / give): views and sign-ups, written only by the lp function.
create table if not exists impact_wait.lp_events (
  id bigint generated always as identity primary key,
  variant text not null check (variant in ('cash', 'prize', 'give')),
  kind text not null check (kind in ('view', 'signup', 'tools')),
  session_id text not null,
  utm jsonb not null default '{}'::jsonb,
  referrer text null,
  ip_hash text not null,
  ua text null,
  created_at timestamptz not null default now()
);
create index if not exists lp_events_ip_created on impact_wait.lp_events (ip_hash, created_at desc);
create index if not exists lp_events_variant_kind on impact_wait.lp_events (variant, kind, created_at);

create table if not exists impact_wait.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and length(email) <= 254),
  variant text not null check (variant in ('cash', 'prize', 'give')),   -- first page they signed up on
  variants text[] not null default '{}',                              -- every page they signed up on
  tools text[] not null default '{}',
  session_id text not null,
  utm jsonb not null default '{}'::jsonb,
  referrer text null,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table impact_wait.lp_events enable row level security;
alter table impact_wait.waitlist enable row level security;
revoke all on impact_wait.lp_events, impact_wait.waitlist from anon, authenticated;
revoke all on sequence impact_wait.lp_events_id_seq from anon, authenticated;

-- The test readout: unique visitors (sessions), sign-ups and conversion per page and source.
create or replace view impact_wait.lp_results with (security_invoker = true) as
  select variant,
         coalesce(utm->>'utm_source', '(direct)') as source,
         count(distinct session_id) filter (where kind = 'view') as visitors,
         count(distinct session_id) filter (where kind = 'signup') as signups,
         round(100.0 * count(distinct session_id) filter (where kind = 'signup')
               / nullif(count(distinct session_id) filter (where kind = 'view'), 0), 1) as conversion_pct
  from impact_wait.lp_events
  group by 1, 2;
revoke all on impact_wait.lp_results from anon, authenticated;
