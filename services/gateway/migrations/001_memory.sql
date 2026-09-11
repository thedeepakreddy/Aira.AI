-- Cross-surface memory for Aira.
--
-- Run this and 002_memory_preferences.sql in the Supabase SQL editor. When
-- Supabase is configured, missing migrations cause explicit memory errors;
-- the gateway does not silently switch to a different persistence store.
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
