import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { loadCatalogue } from '../src/providers/registry.ts';
import { createOpenAIChatRoute, createOpenAIModelsRoute } from '../src/routes/openai.ts';

loadCatalogue(undefined);

/** Stands in for a real provider so the wire format can be tested offline. */
const stub = {
  id: 'anthropic',
  supports: () => true,
  async *streamChat() {
    yield { type: 'start', model: 'claude-opus-5', provider: 'anthropic' };
    yield { type: 'text', text: 'Hello' };
    yield { type: 'text', text: ' world' };
    yield {
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
    };
  },
};

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('userId', 'test-user'); await next(); });
  a.get('/openai/v1/models', createOpenAIModelsRoute());
  a.post('/openai/v1/chat/completions', createOpenAIChatRoute([stub]));
  return a;
}

const post = (body) =>
  app().request('/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('model list uses OpenAI list shape', async () => {
  const body = await (await app().request('/openai/v1/models')).json();
  assert.equal(body.object, 'list');
  assert.ok(body.data.length > 0);
  for (const m of body.data) {
    assert.equal(m.object, 'model');
    assert.equal(typeof m.id, 'string');
  }
});

test('non-streaming reply carries content and usage', async () => {
  const body = await (await post({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello world');
  assert.equal(body.choices[0].finish_reason, 'stop');
  // Cache reads are still prompt tokens as far as an OpenAI client is concerned.
  assert.equal(body.usage.prompt_tokens, 15);
  assert.equal(body.usage.completion_tokens, 2);
  assert.equal(body.usage.total_tokens, 17);
});

test('streaming emits chunks and terminates with [DONE]', async () => {
  const text = await (await post({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
  const payloads = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());

  assert.equal(payloads.at(-1), '[DONE]', 'clients hang without the [DONE] sentinel');

  const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), 'Hello world');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1).usage.total_tokens, 17);
  for (const c of chunks) assert.equal(c.object, 'chat.completion.chunk');
});

test('a system message becomes system context, not a turn', async () => {
  const res = await post({
    model: 'claude-opus-5',
    messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 200);
});

test('array-style content parts are flattened', async () => {
  const res = await post({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.equal(res.status, 200);
});

test('a system-only conversation is rejected', async () => {
  const res = await post({ model: 'claude-opus-5', messages: [{ role: 'system', content: 'x' }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, 'invalid_request_error');
});

test('empty messages are rejected in OpenAI error shape', async () => {
  const res = await post({ model: 'claude-opus-5', messages: [] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, 'invalid_request_error');
});
