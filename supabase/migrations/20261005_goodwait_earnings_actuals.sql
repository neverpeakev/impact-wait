-- Goodwait: actual publisher earnings as reported by each ad network's dashboard.
-- One row per report; the newest row per (network, site_key) is the current actual.
-- site_key null = the whole account (all sites). Additive; nothing existing changes.
-- Applied to project mvnfgrydpdwaatkcsrdd on 2026-10-05 via the Supabase MCP (migration goodwait_earnings_actuals).
create table if not exists impact_wait.earnings (
  id uuid primary key default gen_random_uuid(),
  network text not null,
  site_key text null references impact_wait.sites(site_key),
  earned_usd numeric(12,4) not null check (earned_usd >= 0),
  paid_waits integer null check (paid_waits is null or paid_waits >= 0),
  clicks integer null check (clicks is null or clicks >= 0),
  as_of timestamptz not null default now(),
  source text not null default 'dashboard',
  note text null,
  created_at timestamptz not null default now()
);
create index if not exists earnings_network_site_asof on impact_wait.earnings (network, site_key, as_of desc);

-- Record a dashboard figure (example):
-- insert into impact_wait.earnings (network, site_key, earned_usd, paid_waits, clicks, as_of, source)
-- values ('idlen', 'claude-code', 0.63, 30, 1, now(), 'idlen dashboard');
