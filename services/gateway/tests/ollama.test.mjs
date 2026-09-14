import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOllama, discoverEmbeddings, parseParams, tierFor, isEmbedding, labelFor } from '../src/providers/ollama.ts';

/** The real shape, taken from this machine's /api/tags. */
const TAGS = {
  models: [
    { name: 'llama3.2:3b', size: 2.0e9, details: { parameter_size: '3.2B' } },
    { name: 'llama3.1:8b', size: 4.9e9, details: { parameter_size: '8.0B' } },
    { name: 'nomic-embed-text:latest', size: 0.3e9, details: { parameter_size: '137M' } },
    { name: 'qwen2.5-coder:7b', size: 4.7e9, details: { parameter_size: '7.6B' } },
  ],
};
const ok = (body) => async () => ({ ok: true, json: async () => body });

test('discovers what is on the machine, as chat models', async () => {
  const specs = await discoverOllama('http://x', ok(TAGS));
  assert.deepEqual(specs.map(s => s.id), ['llama3.1:8b', 'llama3.2:3b', 'qwen2.5-coder:7b']);
  assert.ok(specs.every(s => s.provider === 'ollama'));
});

test('embedding models are kept out of the chat catalogue', async () => {
  // They answer on a different endpoint; listing one offers a broken choice.
  const specs = await discoverOllama('http://x', ok(TAGS));
  assert.ok(!specs.some(s => s.id.includes('embed')));
  assert.deepEqual(await discoverEmbeddings('http://x', ok(TAGS)), ['nomic-embed-text:latest']);
});

test('local models are priced at zero, not left unpriced', async () => {
  // Unpriced means "not verified" everywhere else and shows a floor. Here the
  // zero is a fact, and the meter should say so.
  const [first] = await discoverOllama('http://x', ok(TAGS));
  assert.deepEqual(first.pricing, { inputPerMTok: 0, outputPerMTok: 0 });
});

test('tier follows size, since locally the currency is seconds', async () => {
  const specs = await discoverOllama('http://x', ok(TAGS));
  const byId = Object.fromEntries(specs.map(s => [s.id, s.tier]));
  assert.equal(byId['llama3.2:3b'], 'fast');
  assert.equal(byId['qwen2.5-coder:7b'], 'balanced');
  assert.equal(tierFor(70, undefined), 'frontier');
});

test('size falls back to bytes when the label is missing or odd', () => {
  assert.equal(parseParams('7.6B'), 7.6);
  assert.equal(parseParams('137M'), 0.137);
  assert.equal(parseParams('unknown'), null);
  assert.equal(parseParams(undefined), null);
  assert.equal(tierFor(null, 4.7e9), 'balanced', 'a 4.7GB file is roughly 8B');
});

test('labels read like the rest of the picker', () => {
  assert.equal(labelFor('qwen2.5-coder:7b'), 'Qwen2.5 Coder 7B');
  assert.equal(labelFor('nomic-embed-text:latest'), 'Nomic Embed Text', 'a :latest tag says nothing');
});

test('every failure is an empty list, never a thrown boot', async () => {
  const cases = [
    async () => { throw new Error('ECONNREFUSED'); },        // not installed
    async () => ({ ok: false, json: async () => ({}) }),      // wrong service
    async () => ({ ok: true, json: async () => ({}) }),       // no models key
    async () => ({ ok: true, json: async () => ({ models: 'nonsense' }) }),
  ];
  for (const impl of cases) assert.deepEqual(await discoverOllama('http://x', impl), []);
});

test('embedding detection does not catch ordinary models', () => {
  assert.ok(isEmbedding('nomic-embed-text'));
  assert.ok(isEmbedding('bge-m3'));
  assert.ok(!isEmbedding('qwen2.5-coder:7b'));
  assert.ok(!isEmbedding('llama3.1:8b'));
});
