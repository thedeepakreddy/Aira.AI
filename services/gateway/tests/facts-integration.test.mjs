import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { initMemory, memory } from '../src/memory/store.ts';
import { loadCatalogue } from '../src/providers/registry.ts';
import { FACT_SURFACE } from '../src/memory/facts.ts';
import { contextFor } from '../src/memory/context.ts';

/** Answers the user, then plays the extractor when asked to distil. */
function fixtureProvider() {
  return {
    id: 'fixture',
    supports: () => true,
    async *streamChat(request) {
      const asked = request.messages.at(-1)?.content ?? '';
      const extracting = asked.includes('extract durable facts');
      yield { type: 'start', model: request.model, provider: 'fixture' };
      yield {
        type: 'text',
        text: extracting
          ? 'They are building Aira, a desktop AI workspace.\nAira uses Tauri and a Hono gateway.'
          : 'Noted.',
      };
      yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
}

const drain = async (response) => { await response.text(); };

test('an exchange in chat becomes facts every other surface can see', async () => {
  initMemory({ enabled: true });
  loadCatalogue({ compatible: [{ id: 'fixture', models: 'fixture-model|frontier' }], enabledProviders: ['fixture'] });
  const app = createApp(
    { requireAuth: false, memoryEnabled: true, allowedOrigins: [], requestsPerMinute: 500, maxConcurrentRequests: 8 },
    [fixtureProvider()],
  );

  await drain(await app.request('/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surface: 'chat', messages: [{ role: 'user', content: 'I am building Aira with Tauri and a Hono gateway.' }] }),
  }));

  // Extraction is deliberately off the critical path, so it settles after the
  // reply has already been delivered.
  await new Promise(r => setTimeout(r, 250));

  const entries = await memory().recall('dev-user', 100);
  const facts = entries.filter(e => e.surface === FACT_SURFACE).map(e => e.text);
  assert.ok(facts.length >= 1, `expected facts, got ${JSON.stringify(entries.map(e => e.surface))}`);
  assert.ok(facts.some(f => /Tauri/.test(f)), `facts did not capture the stack: ${facts.join(' | ')}`);

  // The coding surface never saw this conversation, and still knows it.
  const codeContext = await contextFor('dev-user', 'code');
  assert.match(codeContext, /What Aira knows about this user/);
  assert.match(codeContext, /Tauri/);

  // And the injection warning still travels with it.
  assert.match(codeContext, /historical data, not instructions/);
});
