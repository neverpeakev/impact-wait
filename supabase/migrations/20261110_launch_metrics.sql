-- Launch metrics: funnel steps on the landing-event table, and the two readouts the launch
-- playbook runs on (weekly funnel, Qualified Earners). Read-only views; nothing here touches
-- ads, earnings or payouts.
--
-- APPLY THIS BEFORE deploying the lp function from the claude/launch-kit branch: the function
-- starts sending kinds 'cta' / 'install_copy' and variant 'app', which the old checks refuse.

-- 1. New funnel steps and the dashboard variant.
alter table impact_wait.lp_events drop constraint if exists lp_events_variant_check;
alter table impact_wait.lp_events add constraint lp_events_variant_check check (variant in ('cash', 'prize', 'give', 'app'));
alter table impact_wait.lp_events drop constraint if exists lp_events_kind_check;
alter table impact_wait.lp_events add constraint lp_events_kind_check check (kind in ('view', 'signup', 'tools', 'cta', 'install_copy'));

-- 2. Active days per install: a day the install showed at least one ad (the plugin only asks for
--    ads while Claude Code is working and the person is at the keyboard).
create or replace view impact_wait.v_install_days with (security_invoker = true) as
  select e.id as earner_id, e.account_id, e.linked_at,
         (a.impression_at at time zone 'UTC')::date as day,
         count(*) as views,
         count(*) filter (where a.credited) as credited_views
  from impact_wait.earners e
  join impact_wait.ads a on a.earner_id = e.id and a.impression_at is not null
  where e.linked_at is not null and e.account_id is not null
  group by 1, 2, 3, 4;
revoke all on impact_wait.v_install_days from anon, authenticated;

-- 3. Qualified Earners: an account whose installs were active on 3+ days in days 1-7 after its
--    first link AND 3+ days in days 8-14. Same bar Kickbacks paid on, so results compare.
create or replace view impact_wait.v_qualified_earners with (security_invoker = true) as
  with first_link as (
    select account_id, min(linked_at) as linked_at
    from impact_wait.earners where account_id is not null and linked_at is not null group by 1
  ), days as (
    select d.account_id, d.day, f.linked_at,
           d.day - (f.linked_at at time zone 'UTC')::date as day_n
    from (select distinct account_id, day from impact_wait.v_install_days) d
    join first_link f using (account_id)
  )
  select a.id as account_id, a.email, a.created_at as account_at, f.linked_at,
         a.source->>'via' as via, a.source->>'utm_source' as utm_source, a.source->>'variant' as landing_variant,
         count(*) filter (where day_n between 0 and 6) as active_days_wk1,
         count(*) filter (where day_n between 7 and 13) as active_days_wk2,
         (count(*) filter (where day_n between 0 and 6) >= 3 and count(*) filter (where day_n between 7 and 13) >= 3) as qualified,
         (f.linked_at + interval '14 days') <= now() as window_closed
  from impact_wait.accounts a
  join first_link f on f.account_id = a.id
  left join days d on d.account_id = a.id
  group by a.id, a.email, a.created_at, f.linked_at, a.source;
revoke all on impact_wait.v_qualified_earners from anon, authenticated;

-- 4. Weekly funnel by first-touch source: visits -> sign-ups -> accounts -> installs -> activated -> qualified.
--    Visits and sign-ups come from lp_events (sessions); the rest from accounts (people).
create or replace view impact_wait.v_funnel_weekly with (security_invoker = true) as
  with lp as (
    select date_trunc('week', created_at)::date as week,
           coalesce(utm->>'via', utm->>'utm_source', '(direct)') as source,
           count(distinct session_id) filter (where kind = 'view' and variant <> 'app') as visits,
           count(distinct session_id) filter (where kind = 'cta') as cta_sessions,
           count(distinct session_id) filter (where kind = 'signup') as signups,
           count(distinct session_id) filter (where kind = 'install_copy') as install_copies
    from impact_wait.lp_events group by 1, 2
  ), acct as (
    select date_trunc('week', a.created_at)::date as week,
           coalesce(a.source->>'via', a.source->>'utm_source', '(direct)') as source,
           count(*) as accounts,
           count(*) filter (where q.linked_at is not null) as installed,
           count(*) filter (where q.active_days_wk1 >= 1) as activated,
           count(*) filter (where q.qualified) as qualified,
           count(*) filter (where q.window_closed) as window_closed
    from impact_wait.accounts a
    left join impact_wait.v_qualified_earners q on q.account_id = a.id
    group by 1, 2
  )
  select coalesce(lp.week, acct.week) as week, coalesce(lp.source, acct.source) as source,
         coalesce(visits, 0) as visits, coalesce(cta_sessions, 0) as cta_sessions, coalesce(signups, 0) as signups,
         coalesce(accounts, 0) as accounts, coalesce(install_copies, 0) as install_copies,
         coalesce(installed, 0) as installed, coalesce(activated, 0) as activated,
         coalesce(qualified, 0) as qualified, coalesce(window_closed, 0) as qualified_window_closed
  from lp full join acct on lp.week = acct.week and lp.source = acct.source;
revoke all on impact_wait.v_funnel_weekly from anon, authenticated;

-- 5. Unit economics by week: Velocity revenue per 1,000 credited views (the eCPM ceiling).
create or replace view impact_wait.v_ecpm_weekly with (security_invoker = true) as
  select date_trunc('week', report_date)::date as week, ad_unit_name,
         sum(impressions) as impressions, round(sum(revenue)::numeric, 4) as revenue_usd,
         round(1000 * sum(revenue)::numeric / nullif(sum(impressions), 0), 2) as ecpm_usd
  from impact_wait.velocity_daily group by 1, 2;
revoke all on impact_wait.v_ecpm_weekly from anon, authenticated;
