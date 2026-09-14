-- Cross-surface memory for Aira.
--
-- Apply with `npm run migrate` from services/gateway, which runs this,
-- 002_memory_preferences.sql and 003_memory_facts.sql together via ALL.sql.
--
-- Without them the gateway falls back to local, per-process memory and says so
-- once in its log: `kind` then reports 'ephemeral' rather than claiming a
-- database it cannot reach. That keeps memory working; it does not make it
-- durable, and the fallback is gone on restart.
--
-- Only the gateway touches this table. It holds the service_role key, so RLS is
-- enabled with no policy: that denies every anon and authenticated client by
-- default, and service_role bypasses it. A user's turns must never be readable
-- from a browser bundle.

create table if not exists public.aira_memory (
  id          bigint generated always as identity primary key,
  user_id     text        not null,
  surface     text        not null,
  role        text        not null check (role in ('user', 'assistant')),
  text        text        not null,
  at          timestamptz not null default now()
);

-- Recall is always "the newest N for one user", which is exactly this index.
create index if not exists aira_memory_user_at_idx
  on public.aira_memory (user_id, at desc);

alter table public.aira_memory enable row level security;
