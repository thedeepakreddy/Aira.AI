import test from 'node:test';
import assert from 'node:assert/strict';
import { initMemory, memory } from '../src/memory/store.ts';

/** A Supabase client that answers every table the way PostgREST does when the
 *  migrations were never applied. */
function missingSchemaClient() {
  const error = { code: 'PGRST205', message: "Could not find the table 'public.aira_memory' in the schema cache" };
  const result = { data: null, error };
  const chain = {
    select: () => chain, eq: () => chain, gte: () => chain, ilike: () => chain,
    order: () => chain, limit: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result), insert: () => chain, upsert: () => Promise.resolve(result),
    delete: () => chain, then: (resolve) => resolve(result),
  };
  return { from: () => chain };
}

test('a missing schema degrades to local memory instead of failing every call', async () => {
  initMemory({ enabled: true, client: missingSchemaClient() });
  const store = memory();
  assert.equal(store.kind, 'supabase', 'it starts out believing it has a database');

  // The write that used to throw now lands locally.
  const saved = await store.remember('user-1', {
    at: new Date().toISOString(), surface: 'workspace', role: 'user', text: 'remember this',
  });
  assert.equal(saved.text, 'remember this');

  // And it says so, rather than continuing to claim Supabase.
  assert.equal(store.kind, 'ephemeral', 'kind must report what it is actually doing');

  const back = await store.recall('user-1', 10);
  assert.equal(back.length, 1, 'what was written can be read back');
  assert.equal(back[0].text, 'remember this');
});

test('one user cannot read another user’s fallback memory', async () => {
  initMemory({ enabled: true, client: missingSchemaClient() });
  const store = memory();
  await store.remember('user-1', { at: new Date().toISOString(), surface: 'chat', role: 'user', text: 'mine' });
  assert.deepEqual(await store.recall('user-2', 10), [], 'isolation must survive the fallback');
});
