import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFleet } from '../src/lib/openclaw.ts';

/** A gateway that reveals one more member on each read, as the real one does. */
function registering(names, { failFirst = 0 } = {}) {
  let read = 0;
  const calls = [];
  return {
    calls,
    agents: async () => {
      read += 1;
      calls.push(read);
      if (read <= failFirst) throw new Error('not up yet');
      const visible = Math.min(read - failFirst, names.length);
      return names.slice(0, visible).map(id => ({ id: `openclaw/${id}`, name: id }));
    },
  };
}

const FLEET = ['lead', 'research', 'plan', 'write', 'review', 'analyse'];

test('waits for the whole fleet rather than stopping at the first member', async () => {
  const gateway = registering(FLEET);
  const found = await collectFleet(gateway, 6, () => true, 0);
  assert.equal(found.length, 6, 'a board that settles for one card is the bug this guards');
  assert.deepEqual(found.map(a => a.name), FLEET);
});

test('survives reads that fail while the gateway is still coming up', async () => {
  const gateway = registering(FLEET, { failFirst: 3 });
  const found = await collectFleet(gateway, 6, () => true, 0);
  assert.equal(found.length, 6);
});

test('without a declared size, waits for the list to stop growing', async () => {
  const gateway = registering(FLEET);
  const found = await collectFleet(gateway, 0, () => true, 0);
  assert.equal(found.length, 6, 'the fallback must reach the same place as the declared count');
});

test('never returns fewer than it has already seen', async () => {
  // A gateway that briefly reports a short list mid-startup must not shrink the board.
  let read = 0;
  const flapping = {
    agents: async () => {
      read += 1;
      const n = read === 3 ? 1 : Math.min(read, 6);
      return FLEET.slice(0, n).map(id => ({ id: `openclaw/${id}`, name: id }));
    },
  };
  const found = await collectFleet(flapping, 6, () => true, 0);
  assert.equal(found.length, 6);
});

test('gives up when the panel unmounts mid-wait', async () => {
  const gateway = registering(FLEET);
  let alive = true;
  const found = await collectFleet(gateway, 6, () => { const was = alive; alive = false; return was; }, 0);
  assert.ok(found.length < 6, 'an unmounted panel must stop polling');
});
