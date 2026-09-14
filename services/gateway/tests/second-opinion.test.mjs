import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDifference, pickSecond, excerpt, DIFFERENCE_PROMPT } from '../src/routing/second-opinion.ts';

const MODELS = [
  { id: 'claude-opus-5', provider: 'anthropic', tier: 'frontier' },
  { id: 'gpt-5.1', provider: 'openai', tier: 'frontier' },
  { id: 'llama3.1:8b', provider: 'ollama', tier: 'balanced' },
  { id: 'llama3.2:3b', provider: 'ollama', tier: 'fast' },
];

test('the second opinion comes from a different vendor', () => {
  // Two models from one vendor share training and tend to share mistakes,
  // which is the failure this feature exists to catch.
  assert.equal(pickSecond(MODELS, 'claude-opus-5'), 'gpt-5.1');
  assert.equal(pickSecond(MODELS, 'llama3.1:8b'), 'claude-opus-5');
});

test('the strongest tier answers first', () => {
  const local = [{ id: 'a:1', provider: 'ollama', tier: 'fast' }, { id: 'b:1', provider: 'ollama', tier: 'frontier' }];
  assert.equal(pickSecond(local, 'a:1'), 'b:1');
});

test('with nothing else configured there is no second opinion', () => {
  assert.equal(pickSecond([{ id: 'only', provider: 'ollama', tier: 'fast' }], 'only'), null);
  assert.equal(pickSecond([], 'anything'), null);
});

test('same vendor is used rather than refusing, when it is all there is', () => {
  const one = [{ id: 'a', provider: 'ollama', tier: 'fast' }, { id: 'b', provider: 'ollama', tier: 'balanced' }];
  assert.equal(pickSecond(one, 'a'), 'b');
});

test('the judge is asked to name the choice, never to rule on it', () => {
  // The measured reason: an 8B classifying AGREE/DIFFER called "retry" and
  // "do not retry" agreement. Describing is reliable where judging is not, so
  // no verdict vocabulary may creep back into this prompt.
  assert.match(DIFFERENCE_PROMPT, /name the choice/);
  assert.doesNotMatch(DIFFERENCE_PROMPT, /AGREE|DIFFER|verdict|judge/i);
});

test('the sentence is forced to open on the decision', () => {
  // Measured: without this the model compared style ("one is concise, one is
  // detailed"); with it, it named the crux.
  assert.match(DIFFERENCE_PROMPT, /starting "Whether to"/);
  assert.match(DIFFERENCE_PROMPT, /Ignore length, tone, formatting/);
});

test('one sentence, even when the model writes several', async () => {
  const complete = async () => 'They differ on caching. B also mentions indexes. And a third thought.';
  const out = await describeDifference('a', 'b', 'judge', complete);
  assert.equal(out, 'They differ on caching.');
});

test('losing the sentence never loses the answer it describes', async () => {
  const thrown = async () => { throw new Error('judge unreachable'); };
  assert.equal(await describeDifference('a', 'b', 'judge', thrown), null);
  const empty = async () => '   ';
  assert.equal(await describeDifference('a', 'b', 'judge', empty), null);
});

test('an empty side is not sent to the judge at all', async () => {
  let called = false;
  const complete = async () => { called = true; return 'x'; };
  assert.equal(await describeDifference('', 'b', 'judge', complete), null);
  assert.equal(called, false);
});

test('a long answer cannot push the other out of the judge context', () => {
  const long = 'x'.repeat(9_000);
  const cut = excerpt(long);
  assert.ok(cut.length <= 4_001, `got ${cut.length}`);
  assert.ok(cut.endsWith('…'));
  assert.equal(excerpt('short'), 'short');
});
