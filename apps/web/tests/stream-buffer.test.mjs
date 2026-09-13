import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamBuffer } from '../src/lib/stream-buffer.ts';

/** A clock the test drives, so no real time passes. */
function manualClock() {
  let queued = null;
  return {
    schedule: (run) => { queued = run; return 1; },
    cancel: () => { queued = null; },
    tick() { const run = queued; queued = null; run?.(); },
    get pending() { return queued !== null; },
  };
}

test('many deltas become one flush', () => {
  const clock = manualClock();
  const flushes = [];
  const buffer = createStreamBuffer(batch => flushes.push(batch), clock);
  for (const token of ['The ', 'launch ', 'window ', 'opens']) buffer.push('a', token);
  assert.equal(flushes.length, 0, 'nothing should render before the tick');
  clock.tick();
  assert.equal(flushes.length, 1, 'four tokens, one render');
  assert.equal(flushes[0].get('a'), 'The launch window opens');
});

test('concurrent agents keep their own text', () => {
  const clock = manualClock();
  const flushes = [];
  const buffer = createStreamBuffer(batch => flushes.push(batch), clock);
  buffer.push('research', 'find');
  buffer.push('review', 'check');
  buffer.push('research', 'ings');
  clock.tick();
  assert.equal(flushes[0].get('research'), 'findings');
  assert.equal(flushes[0].get('review'), 'check');
});

test('a flush delivers only what is new, so consumers can append', () => {
  const clock = manualClock();
  const flushes = [];
  const buffer = createStreamBuffer(batch => flushes.push(batch), clock);
  buffer.push('a', 'one');
  clock.tick();
  buffer.push('a', 'two');
  clock.tick();
  assert.deepEqual(flushes.map(b => b.get('a')), ['one', 'two']);
});

test('finish() delivers the tail, so an answer never loses its last words', () => {
  const clock = manualClock();
  const flushes = [];
  const buffer = createStreamBuffer(batch => flushes.push(batch), clock);
  buffer.push('a', 'final words');
  buffer.finish();
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].get('a'), 'final words');
  assert.equal(clock.pending, false, 'the timer must be cancelled, not left to fire twice');
});

test('finish() on an empty buffer renders nothing', () => {
  const clock = manualClock();
  let calls = 0;
  const buffer = createStreamBuffer(() => { calls++; }, clock);
  buffer.finish();
  assert.equal(calls, 0);
});

test('dispose() drops pending work rather than rendering after unmount', () => {
  const clock = manualClock();
  let calls = 0;
  const buffer = createStreamBuffer(() => { calls++; }, clock);
  buffer.push('a', 'text');
  buffer.dispose();
  clock.tick();
  assert.equal(calls, 0);
});

test('empty deltas never schedule a render', () => {
  const clock = manualClock();
  let calls = 0;
  const buffer = createStreamBuffer(() => { calls++; }, clock);
  buffer.push('a', '');
  assert.equal(clock.pending, false);
  clock.tick();
  assert.equal(calls, 0);
});
