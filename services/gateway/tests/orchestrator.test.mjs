import test from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent, capabilityFor } from '../src/routing/orchestrator.ts';

const intentOf = async (text, classify) => (await routeIntent(text, classify)).intent;

test('questions about now go to search', async () => {
  for (const text of [
    'what is the weather today',
    'latest React release notes',
    'price of bitcoin right now',
    'summarise https://example.com/post',
  ]) assert.equal(await intentOf(text), 'search', text);
});

test('programming questions go to code', async () => {
  for (const text of [
    'why does this throw\n```ts\nconst x: number = "a"\n```',
    'TypeError in src/app.ts:42',
    'help me refactor this function',
  ]) assert.equal(await intentOf(text), 'code', text);
});

test('ordinary questions stay chat and reach for no tools', async () => {
  for (const text of ['why is the sky blue', 'write me a haiku about rain']) {
    assert.equal(await intentOf(text), 'chat', text);
  }
  assert.deepEqual(capabilityFor('chat').tools, []);
});

test('the classifier is consulted only when the rules find nothing', async () => {
  let calls = 0;
  const classify = async () => { calls++; return 'search'; };
  await routeIntent('what is the weather today', classify);
  assert.equal(calls, 0, 'a rule match must not cost a model call');
  await routeIntent('ponder the nature of tuesday', classify);
  assert.equal(calls, 1, 'no rule matched, so ask');
});

test('a failing classifier degrades to chat rather than failing the turn', async () => {
  const classify = async () => { throw new Error('classifier is down'); };
  assert.equal(await intentOf('ponder the nature of tuesday', classify), 'chat');
});

test('a classifier returning nonsense is ignored', async () => {
  const classify = async () => 'nonsense';
  assert.equal(await intentOf('ponder the nature of tuesday', classify), 'chat');
});

test('current information wins over code when a turn is both', async () => {
  // "latest version" goes stale; the code part does not.
  assert.equal(await intentOf('what is the latest version of the react package'), 'search');
});

test('search stays narrow, because a false search costs a browser launch', async () => {
  for (const text of [
    'tell me about the history of the roman empire',
    'what does a package.json do',
  ]) assert.equal(await intentOf(text), 'chat', text);
});

test('empty input never routes to a tool', async () => {
  assert.equal(await intentOf('   '), 'chat');
});

test('search encourages the tool the gateway actually declares', async () => {
  assert.deepEqual(capabilityFor('search').tools, ['browse_web']);
});

test('search capability labels page content untrusted', async () => {
  // The browsing surface reads whatever a page says; the prompt has to be
  // explicit that this is data, not instruction.
  assert.match(capabilityFor('search').system, /untrusted/i);
});
