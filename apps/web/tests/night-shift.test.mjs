import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const ns = await import('../src/lib/night-shift.ts');

test('the fleet may run unattended only when the model is genuinely free', () => {
  assert.equal(ns.mayRunFleet({ inputPerMTok: 0, outputPerMTok: 0 }), true, 'a local model');
  assert.equal(ns.mayRunFleet({ inputPerMTok: 0.71, outputPerMTok: 3.5 }), false);
  // The one that matters: unpriced means "not verified", not "free". Treating
  // it as free is how an unattended loop quietly spends all night.
  assert.equal(ns.mayRunFleet(undefined), false);
  // A model free on input but not output is not free.
  assert.equal(ns.mayRunFleet({ inputPerMTok: 0, outputPerMTok: 2 }), false);
});

test('the agent limit follows directly from that', () => {
  assert.equal(ns.agentLimit({ inputPerMTok: 0, outputPerMTok: 0 }), Infinity);
  assert.equal(ns.agentLimit(undefined), 1);
});

test('turning a schedule on does not fire it immediately', () => {
  const now = Date.now();
  const shift = { prompt: 'review the repo', agents: ['a'], everyMinutes: 60, lastRunAt: now };
  assert.equal(ns.isDue(shift, now), false, 'set up to happen later, not now');
  assert.equal(ns.isDue(shift, now + 59 * 60_000), false);
  assert.equal(ns.isDue(shift, now + 60 * 60_000), true);
});

test('a schedule round-trips, per account', () => {
  store.clear();
  const shift = { prompt: 'nightly review', agents: ['research', 'review'], everyMinutes: 1440, lastRunAt: 5 };
  ns.save('u1', shift);
  assert.deepEqual(ns.load('u1'), shift);
  assert.equal(ns.load('u2'), null, 'one account never sees another’s');
  assert.equal(ns.load(null), null);
});

test('nonsense on disk is refused rather than run', () => {
  store.clear();
  for (const bad of [
    { prompt: '', agents: ['a'], everyMinutes: 60, lastRunAt: 0 },
    { prompt: 'x', agents: [], everyMinutes: 60, lastRunAt: 0 },
    { prompt: 'x', agents: ['a'], everyMinutes: 5, lastRunAt: 0 },   // too frequent to be unattended
    { nonsense: true },
  ]) {
    localStorage.setItem('aira.night-shift.v1.u1', JSON.stringify(bad));
    assert.equal(ns.load('u1'), null, JSON.stringify(bad).slice(0, 40));
  }
});

test('turning it off clears it', () => {
  store.clear();
  ns.save('u1', { prompt: 'x', agents: ['a'], everyMinutes: 60, lastRunAt: 0 });
  ns.save('u1', null);
  assert.equal(ns.load('u1'), null);
});

test('intervals read as English', () => {
  assert.equal(ns.describeInterval(1440), 'once a day');
  assert.equal(ns.describeInterval(60), 'every hour');
  assert.equal(ns.describeInterval(2880), 'every 2 days');
});
