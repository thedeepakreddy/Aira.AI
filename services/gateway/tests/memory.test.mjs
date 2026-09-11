import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initMemory, memory, trim } from '../src/memory/store.ts';
import { contextFor, record, render, withContext } from '../src/memory/context.ts';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

test('the current surface is left out of its own context', () => {
  const block = render(
    [
      { at: at(5), surface: 'chat', role: 'user', text: 'Deploying to Fly today.' },
      { at: at(3), surface: 'voice', role: 'user', text: 'Remind me about the gateway.' },
    ].filter((e) => e.surface !== 'chat'),
    NOW,
  );
  // Chat already carries its own history in the request. Repeating it as
  // "memory" would double it and skew what the model treats as important.
  assert.ok(!block.includes('Deploying to Fly'));
  assert.ok(block.includes('Remind me about the gateway'));
});

test('agents and conversation surfaces are named in a way a model can use', () => {
  const block = render([{ at: at(2), surface: 'code', role: 'assistant', text: 'Edited env.ts.' }], NOW);
  assert.match(block, /the coding agent/);
  assert.doesNotMatch(block, /\bcode\b,/);
});

test('context is capped so it cannot grow into the answer', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    at: at(60 - i),
    surface: 'voice',
    role: 'user',
    text: `Turn number ${i} `.repeat(40),
  }));
  const block = render(many, NOW);
  // Unbounded recall would inflate the cost of every request and, on a small
  // model, crowd out the question being asked.
  assert.ok(block.length < 2000, `block was ${block.length} characters`);
  assert.ok(block.split('\n').length <= 13);
});

test('the newest turns are the ones that survive the budget', () => {
  const block = render(
    [
      { at: at(90), surface: 'voice', role: 'user', text: 'OLDEST' },
      { at: at(1), surface: 'voice', role: 'user', text: 'NEWEST' },
    ],
    NOW,
  );
  assert.ok(block.includes('NEWEST'));
  // Read in chronological order, newest last.
  assert.ok(block.indexOf('OLDEST') < block.indexOf('NEWEST'));
});

test('a single turn cannot become a transcript', () => {
  const long = trim('word '.repeat(500));
  assert.ok(long.length <= 400);
  assert.ok(long.endsWith('…'));
});

test('memory crosses surfaces, which is the whole point', async () => {
  initMemory({ enabled: true });
  await record('user-1', 'voice', 'user', 'My deploy target is Fly.');
  const forChat = await contextFor('user-1', 'chat');
  assert.match(forChat, /Fly/);
  const forVoice = await contextFor('user-1', 'voice');
  assert.equal(forVoice, '', 'voice should not be told its own turns');
});

test('one user never sees another user memory', async () => {
  initMemory({ enabled: true });
  await record('user-a', 'chat', 'user', 'Secret to A.');
  const forB = await contextFor('user-b', 'voice');
  assert.equal(forB, '');
});

test('an anonymous request records nothing and recalls nothing', async () => {
  initMemory({ enabled: true });
  await record(null, 'chat', 'user', 'should not persist');
  assert.equal(await contextFor(null, 'chat'), '');
});

test('a store that throws degrades the answer rather than losing it', async () => {
  initMemory({ enabled: true });
  const store = memory();
  const broken = { ...store, recall: async () => { throw new Error('database on fire'); } };
  const original = Object.getPrototypeOf(store).recall;
  Object.getPrototypeOf(store).recall = broken.recall;
  try {
    // Losing context makes an answer worse; losing the answer is worse still.
    assert.equal(await contextFor('user-1', 'chat'), '');
  } finally {
    Object.getPrototypeOf(store).recall = original;
  }
});

test('the memory block goes before the caller system prompt, not instead of it', () => {
  const merged = withContext('You are Aira.', 'CONTEXT');
  assert.ok(merged.includes('You are Aira.'));
  assert.ok(merged.indexOf('CONTEXT') < merged.indexOf('You are Aira.'));
  assert.equal(withContext('You are Aira.', ''), 'You are Aira.');
});
