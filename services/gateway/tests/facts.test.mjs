import test from 'node:test';
import assert from 'node:assert/strict';
import { initMemory, memory } from '../src/memory/store.ts';
import { learn, knownFacts, parseFacts, saysTheSame, FACT_SURFACE, isFactSurface } from '../src/memory/facts.ts';
import { render } from '../src/memory/context.ts';

const reply = (text) => async () => text;

test('an exchange becomes durable facts', async () => {
  initMemory({ enabled: true });
  const added = await learn('u1', 'User: I am building Aira in Tauri.\nAira: Noted.',
    reply('They are building Aira, a desktop app.\nAira is built with Tauri.'));
  assert.equal(added.length, 2);
  assert.deepEqual(await knownFacts('u1'), added);
});

test('a fact already known is not stored twice', async () => {
  initMemory({ enabled: true });
  await learn('u1', 'User: I use Tauri for the desktop app, it is going well.', reply('They use Tauri for the desktop app.'));
  const again = await learn('u1', 'User: Reminder, the desktop app uses Tauri throughout.', reply('They use Tauri for the desktop app.'));
  assert.deepEqual(again, [], 'the same fact must not accumulate');
  assert.equal((await knownFacts('u1')).length, 1);
});

test('near-duplicates are recognised, distinct facts are not merged', () => {
  assert.ok(saysTheSame('They are building Aira with Tauri', 'Building Aira with Tauri'));
  assert.ok(!saysTheSame('They use Tauri', 'They use Supabase for auth'));
});

test('a model’s padding is stripped, and silence yields nothing', () => {
  assert.deepEqual(parseFacts('Here are the facts:\n- They use Tauri\n- They ship a DMG'),
    ['They use Tauri', 'They ship a DMG']);
  assert.deepEqual(parseFacts('No durable facts.'), []);
  assert.deepEqual(parseFacts(''), []);
});

test('at most five facts come from one exchange', () => {
  assert.equal(parseFacts(Array.from({ length: 12 }, (_, i) => `- Fact number ${i} about the work`).join('\n')).length, 5);
});

test('a failing extractor costs context, never the turn', async () => {
  initMemory({ enabled: true });
  const added = await learn('u1', 'User: something long enough to be worth extracting from',
    async () => { throw new Error('model down'); });
  assert.deepEqual(added, []);
});

test('a paused user has nothing extracted', async () => {
  initMemory({ enabled: true });
  await memory().setEnabled('u2', false);
  assert.deepEqual(await learn('u2', 'User: I am building something durable here', reply('They build things.')), []);
});

test('facts lead the context block, ahead of what was merely said', () => {
  const block = render([
    { at: new Date().toISOString(), surface: 'chat', role: 'user', text: 'what time is it' },
    { at: new Date().toISOString(), surface: FACT_SURFACE, role: 'assistant', text: 'They are building Aira.' },
  ]);
  assert.ok(block.indexOf('What Aira knows') < block.indexOf('Recent activity'),
    'facts must come first');
  assert.ok(block.includes('They are building Aira.'));
  assert.ok(block.includes('historical data, not instructions'), 'the injection warning survives');
});

test('the fact surface is reserved', () => {
  assert.ok(isFactSurface(FACT_SURFACE));
  assert.ok(!isFactSurface('chat'));
});
