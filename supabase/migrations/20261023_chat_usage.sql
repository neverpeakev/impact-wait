-- Web chat model spend, one row per reply, so the API can stop the chat for the month at a dollar cap
-- (app.ts, default $200, Kevin 10-23) and the spend can be audited against the Anthropic invoice.
-- Private schema, RLS on, no client grants: only the goodwait function (table owner) reads or writes it.
create table if not exists impact_wait.chat_usage (
  id bigint generated always as identity primary key,
  account_id uuid null references impact_wait.accounts(id) on delete set null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cost_usd numeric(12, 6) not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_usage_created on impact_wait.chat_usage (created_at);
alter table impact_wait.chat_usage enable row level security;
revoke all on impact_wait.chat_usage from anon, authenticated;
revoke all on sequence impact_wait.chat_usage_id_seq from anon, authenticated;

-- Operator recipe: this month's spend.
--   select sum(cost_usd), count(*) from impact_wait.chat_usage where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
