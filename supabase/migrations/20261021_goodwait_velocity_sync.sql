-- Velocity reporting pulled into the database by the goodwait-velocity-sync function.
-- Additive only. Credentials stay in Vault (impact_wait_velocity_client_id / _client_secret);
-- pg_cron authenticates to the function with impact_wait_cron_key, read from Vault at call time
-- so the key never sits in the job's text.

create table if not exists impact_wait.velocity_daily (
  report_date date not null,
  ad_unit_key text not null check (ad_unit_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  ad_unit_name text null,
  revenue numeric(14,6) not null default 0 check (revenue >= 0),
  impressions int not null default 0 check (impressions >= 0),
  clicks int not null default 0 check (clicks >= 0),
  pulled_at timestamptz not null default now(),
  primary key (report_date, ad_unit_key)
);

-- One row per sync attempt, for watching that the pull keeps working.
create table if not exists impact_wait.sync_runs (
  id bigint generated always as identity primary key,
  job text not null,
  ok boolean not null,
  rows int not null default 0,
  note text null,
  ran_at timestamptz not null default now()
);
create index if not exists sync_runs_job_ran on impact_wait.sync_runs (job, ran_at desc);

alter table impact_wait.velocity_daily enable row level security;
alter table impact_wait.sync_runs enable row level security;
revoke all on impact_wait.velocity_daily, impact_wait.sync_runs from anon, authenticated;
revoke all on sequence impact_wait.sync_runs_id_seq from anon, authenticated;

-- Every 6 hours at :19 (Velocity refreshes its data about once a day; 7-day lookback absorbs restatements).
select cron.unschedule('goodwait-velocity-sync') where exists (select 1 from cron.job where jobname = 'goodwait-velocity-sync');
select cron.schedule('goodwait-velocity-sync', '19 */6 * * *', $job$
  select net.http_post(
    url := 'https://mvnfgrydpdwaatkcsrdd.supabase.co/functions/v1/goodwait-velocity-sync',
    body := '{"days": 7}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json',
      'x-goodwait-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'impact_wait_cron_key')),
    timeout_milliseconds := 30000);
$job$);
