-- Saved web chats (Kevin, 10-25): a signed-in person's chats belong to their account, so they can
-- leave and come back, see a list of past chats and pick one up where they left off. The server
-- rebuilds the model's context from these rows; the browser never supplies history.
-- Deleting a chat deletes its messages (cascade), not a soft delete.
-- Private schema, RLS on, no client grants: only the goodwait function (table owner) reads or writes.
create table if not exists impact_wait.chats (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references impact_wait.accounts(id) on delete cascade,
  title text not null default 'New chat' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chats_account_updated on impact_wait.chats (account_id, updated_at desc);

create table if not exists impact_wait.chat_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references impact_wait.chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_chat on impact_wait.chat_messages (chat_id, id);

alter table impact_wait.chats enable row level security;
alter table impact_wait.chat_messages enable row level security;
revoke all on impact_wait.chats, impact_wait.chat_messages from anon, authenticated;
revoke all on sequence impact_wait.chat_messages_id_seq from anon, authenticated;

-- "No Claude Code? Just use the chat": set when someone skips the install step on a computer, so the
-- account page opens on the chat instead of the install line. Cleared again if they ask for the line.
alter table impact_wait.accounts add column if not exists web_only_at timestamptz null;
