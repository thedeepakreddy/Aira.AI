import test from 'node:test';
import assert from 'node:assert/strict';
import { worthFallingBack, nextModel, exhaustedMessage, MAX_PROVIDERS } from '../src/routing/fallback.ts';

/** Catalogue order is provider order, as the registry builds it. */
const CATALOGUE = [
  { id: 'claude-opus-5',   provider: 'anthropic',  tier: 'frontier' },
  { id: 'claude-sonnet-5', provider: 'anthropic',  tier: 'balanced' },
  { id: 'gpt-5.1',         provider: 'openai',     tier: 'frontier' },
  { id: 'gpt-5-mini',      provider: 'openai',     tier: 'balanced' },
  { id: 'nemotron:free',   provider: 'openrouter', tier: 'frontier' },
  { id: 'gemini-3.7',      provider: 'gemini',     tier: 'frontier' },
  { id: 'llama3.1:8b',     provider: 'ollama',     tier: 'balanced' },
];

test('an empty account is the strongest reason to ask someone else', () => {
  // The retry deliberately refuses this case — asking the same vendor again
  // cannot add credit. A different vendor answers immediately.
  assert.equal(worthFallingBack('account', false, 1), true);
});

test('a struggling vendor is worth leaving too', () => {
  assert.equal(worthFallingBack('provider', false, 1), true);
});

test('our own fault is not', () => {
  // A different vendor does not fix a bug in the gateway.
  assert.equal(worthFallingBack('gateway', false, 1), false);
  assert.equal(worthFallingBack(undefined, false, 1), false);
});

test('nothing falls back once the answer has started', () => {
  // Same rule as the retry: a second attempt appends a second answer.
  assert.equal(worthFallingBack('account', true, 1), false);
  assert.equal(worthFallingBack('provider', true, 1), false);
});

test('the number of vendors tried is capped', () => {
  assert.equal(worthFallingBack('provider', false, MAX_PROVIDERS - 1), true);
  assert.equal(worthFallingBack('provider', false, MAX_PROVIDERS), false);
});

test('the next model is a different vendor at the same tier', () => {
  const next = nextModel(CATALOGUE, 'frontier', ['claude-opus-5']);
  assert.equal(next.id, 'gpt-5.1');
  assert.notEqual(next.provider, 'anthropic');
  assert.equal(next.tier, 'frontier');
});

test('a tier is never crossed', () => {
  // A frontier question answered by a fast model is a quiet downgrade, not a
  // rescue.
  const balanced = nextModel(CATALOGUE, 'balanced', ['claude-sonnet-5']);
  assert.equal(balanced.tier, 'balanced');
  assert.equal(balanced.id, 'gpt-5-mini');
});

test('a vendor already tried is not tried again under another name', () => {
  // Two Anthropic models failing the same way is one vendor failing twice.
  const next = nextModel(CATALOGUE, 'frontier', ['claude-opus-5', 'gpt-5.1']);
  assert.equal(next.provider, 'openrouter');
});

test('an exhausted tier returns nothing rather than reaching further', () => {
  const tried = ['claude-opus-5', 'gpt-5.1', 'nemotron:free', 'gemini-3.7'];
  assert.equal(nextModel(CATALOGUE, 'frontier', tried), null);
});

test('the order follows the catalogue, so the sequence is predictable', () => {
  const order = [];
  let tried = ['claude-opus-5'];
  for (let i = 0; i < 3; i++) {
    const next = nextModel(CATALOGUE, 'frontier', tried);
    if (!next) break;
    order.push(next.provider);
    tried = [...tried, next.id];
  }
  assert.deepEqual(order, ['openai', 'openrouter', 'gemini']);
});

test('the message says how hard Aira tried', () => {
  // A user who can see three vendors were asked knows it is not their
  // connection.
  assert.equal(exhaustedMessage(['a'], 'It failed.'), 'It failed.', 'one vendor needs no explanation');
  assert.match(exhaustedMessage(['a', 'b'], 'It failed.'), /1 other provider without success/);
  assert.match(exhaustedMessage(['a', 'b', 'c'], 'It failed.'), /2 other providers without success/);
});
