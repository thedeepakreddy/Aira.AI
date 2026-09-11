-- Apply after 001_memory.sql in every environment before this gateway revision.
create table if not exists public.aira_memory_preferences (
  user_id text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.aira_memory_preferences enable row level security;
revoke all on public.aira_memory_preferences from anon, authenticated;
revoke all on public.aira_memory from anon, authenticated;

-- Recall is restricted to the last 30 days. Schedule this deletion with your
-- database maintenance scheduler if physical retention must also be 30 days:
-- delete from public.aira_memory where at < now() - interval '30 days';
