/**
 * Finding out what the memory store really is, and noticing when that changes.
 *
 * Two failures this covers, both of which hid the same thing — a gateway
 * configured for Supabase with no schema behind it, reporting durable memory
 * it did not have:
 *
 * It claimed Supabase until something failed. /health said `storage: supabase`
 * on a fresh boot because nothing had looked yet, so a deploy check passed and
 * the first person to rely on memory found out the hard way.
 *
 * And it never looked again. Degrading was permanent for the life of the
 * process, so applying the migrations to a running gateway changed nothing
 * visible and the symptom outlived the fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initMemory, memory } from '../src/memory/store.ts';

const MISSING = { code: 'PGRST205', message: "Could not find the table 'public.aira_memory' in the schema cache" };
const BLIP = { code: '57014', message: 'canceling statement due to statement timeout' };

/**
 * A client whose answer can change mid-test, which is the whole point: the
 * schema appearing under a running gateway is the case that was broken.
 */
function client(state) {
  const answer = () => (state.error ? { data: null, error: state.error } : { data: state.rows ?? [], error: null });
  const one = () => (state.error ? { data: null, error: state.error } : { data: state.row ?? null, error: null });
  const chain = {
    select: () => chain, eq: () => chain, gte: () => chain, ilike: () => chain, or: () => chain,
    order: () => chain, insert: () => chain, delete: () => chain,
    limit: () => Promise.resolve(answer()),
    maybeSingle: () => Promise.resolve(one()),
    single: () => Promise.resolve(one()),
    upsert: () => Promise.resolve(answer()),
    then: (resolve) => resolve(answer()),
  };
  return { from: () => chain };
}

test('a missing schema is found at boot, before anything claims otherwise', async () => {
  const state = { error: MISSING };
  initMemory({ enabled: true, client: client(state) });
  const store = memory();

  assert.equal(await store.verify(), 'ephemeral');
  assert.equal(store.kind, 'ephemeral', '/health must not advertise a database that is not there');
});

test('a working schema verifies as durable', async () => {
  initMemory({ enabled: true, client: client({ error: null }) });
  assert.equal(await memory().verify(), 'supabase');
});

test('a blip at boot is not treated as a missing schema', async () => {
  // A gateway that starts during a five second Supabase hiccup must not spend
  // the rest of its life on local memory.
  initMemory({ enabled: true, client: client({ error: BLIP }) });
  const store = memory();
  assert.equal(await store.verify(), 'supabase', 'only a missing schema degrades');
});

test('the schema appearing under a running gateway is picked up', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const state = { error: MISSING };
  initMemory({ enabled: true, client: client(state) });
  const store = memory();

  await store.verify();
  assert.equal(store.kind, 'ephemeral');

  // Someone runs the migrations.
  state.error = null;
  state.row = { id: 1, at: new Date().toISOString(), surface: 'chat', role: 'user', text: 'hello' };

  // Not immediately: re-probing on every request would cost a round trip per
  // call for as long as the schema is genuinely absent.
  await store.recall('u', 5);
  assert.equal(store.kind, 'ephemeral', 'it does not re-probe on every call');

  t.mock.timers.tick(5 * 60_000 + 1);
  await store.recall('u', 5);
  assert.equal(store.kind, 'supabase', 'the repair is noticed without a restart');
});

test('a schema that is still missing costs one round trip per window, not per call', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let queries = 0;
  const probe = { from: () => { queries += 1; const c = {
    select: () => c, eq: () => c, gte: () => c, ilike: () => c, or: () => c, order: () => c,
    insert: () => c, delete: () => c,
    limit: () => Promise.resolve({ data: null, error: MISSING }),
    maybeSingle: () => Promise.resolve({ data: null, error: MISSING }),
    single: () => Promise.resolve({ data: null, error: MISSING }),
    upsert: () => Promise.resolve({ data: null, error: MISSING }),
    then: (r) => r({ data: null, error: MISSING }),
  }; return c; } };

  initMemory({ enabled: true, client: probe });
  const store = memory();
  await store.verify();
  const afterBoot = queries;

  for (let i = 0; i < 20; i++) await store.recall('u', 5);
  assert.equal(queries, afterBoot, '20 calls inside the window reached the database 0 times');

  t.mock.timers.tick(5 * 60_000 + 1);
  await store.recall('u', 5);
  assert.equal(queries, afterBoot + 1, 'exactly one probe once the window passed');
});

test('what was written while degraded is still readable', async () => {
  // Recovery must not lose the local entries by switching away from them
  // mid-session without saying so.
  const state = { error: MISSING };
  initMemory({ enabled: true, client: client(state) });
  const store = memory();
  await store.verify();

  await store.remember('u', { at: new Date().toISOString(), surface: 'chat', role: 'user', text: 'written while down' });
  const back = await store.recall('u', 10);
  assert.equal(back.at(-1).text, 'written while down');
});
