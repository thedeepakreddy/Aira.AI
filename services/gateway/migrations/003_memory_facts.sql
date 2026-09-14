-- Semantic memory, and faster recall for it.
--
-- Applied after 001 and 002 by `npm run migrate`.
--
-- Facts live in the same table as episodes, under the reserved surface
-- '__facts', so they inherit the row-level isolation and the service_role-only
-- access already established rather than needing a second table with a second
-- set of rules to get wrong. What they do not inherit is expiry: an episode is
-- worth a month, a fact is worth keeping.

-- Recall asks for "this user's facts" on most requests, and the existing
-- (user_id, at desc) index makes that a scan over their episodes first. This
-- partial index covers only fact rows, so it stays small however much
-- conversation accumulates around it.
create index if not exists aira_memory_facts_idx
  on public.aira_memory (user_id, at desc)
  where surface = '__facts';

-- Retention is enforced by the gateway, which exempts facts. This comment
-- exists so a future scheduled deletion job does not quietly undo that:
-- any physical-deletion policy must carry the same exemption.
comment on table public.aira_memory is
  'Aira cross-surface memory. Rows with surface = ''__facts'' are derived, durable facts and must be exempt from any retention or deletion policy applied to conversational rows.';

-- ── Vector recall (optional) ────────────────────────────────────────────────
--
-- Recall matches text with ILIKE today, which finds "launch" and never matches
-- "release" to it. pgvector fixes that, and is left commented because it is
-- not free to turn on: every stored row needs an embedding, which means an
-- embeddings provider configured on the gateway and a backfill for existing
-- rows. Enable it when that is in place rather than creating a column nothing
-- populates.
--
-- create extension if not exists vector;
-- alter table public.aira_memory add column if not exists embedding vector(768);
-- create index if not exists aira_memory_embedding_idx
--   on public.aira_memory using hnsw (embedding vector_cosine_ops);
