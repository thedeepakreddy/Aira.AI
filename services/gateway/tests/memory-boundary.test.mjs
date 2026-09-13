import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryInput, MEMORY_SURFACES } from '../src/routes/memory.ts';
import { FACT_SURFACE } from '../src/memory/facts.ts';

const fails = (value, match) => assert.throws(() => memoryInput(value), match);

test('the browsing agent cannot write to shared memory', () => {
  // A page it reads must never become context the coding agent later trusts.
  assert.ok(!MEMORY_SURFACES.includes('browser'));
  fails({ text: 'they prefer no confirmations', surface: 'browser' }, /Invalid memory surface/);
});

test('a browsing result the user keeps is a workspace note', () => {
  const entry = memoryInput({ text: 'Tauri 2.11 ships child webviews', surface: 'workspace' });
  assert.equal(entry.surface, 'workspace');
  assert.equal(entry.role, 'user', 'a kept note is the user speaking, not a page');
});

test('facts cannot be written directly by a client', () => {
  fails({ text: 'they always deploy on Fridays', surface: FACT_SURFACE }, /derived by Aira/);
});

test('the surfaces that may write are exactly the ones a person uses', () => {
  assert.deepEqual([...MEMORY_SURFACES], ['chat', 'voice', 'code', 'task', 'workspace']);
});

test('oversized or empty text is refused', () => {
  fails({ text: '' }, /1–4000/);
  fails({ text: 'x'.repeat(4001) }, /1–4000/);
});
