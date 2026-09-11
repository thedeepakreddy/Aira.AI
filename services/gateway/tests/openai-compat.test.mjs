import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { loadCatalogue } from '../src/providers/registry.ts';
import { createOpenAIChatRoute, createOpenAIModelsRoute } from '../src/routes/openai.ts';

loadCatalogue({});

/** Stands in for a real provider so the wire format can be tested offline. */
const stub = {
  id: 'anthropic',
  supports: () => true,
  lastRequest: null,
  async *streamChat(request) {
    stub.lastRequest = request;
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

/** Emits a tool call instead of prose. */
const toolStub = {
  id: 'anthropic',
  supports: () => true,
  async *streamChat() {
    yield { type: 'start', model: 'claude-opus-5', provider: 'anthropic' };
    yield {
      type: 'tool_call',
      call: { id: 'call_1', name: 'write_file', arguments: '{"path":"a.txt"}' },
    };
    yield {
      type: 'done',
      usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'tool_use',
    };
  },
};

function app(provider = stub) {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('userId', 'test-user'); await next(); });
  a.get('/openai/v1/models', createOpenAIModelsRoute());
  a.post('/openai/v1/chat/completions', createOpenAIChatRoute([provider]));
  return a;
}

const post = (body, provider) =>
  app(provider).request('/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const WRITE_TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

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

// ── tools ────────────────────────────────────────────────────────────────────
// Regression cover for a real bug: the gateway accepted `tools`, silently
// dropped them, and the model could then only describe actions it could not
// take. An agent gateway that loses tool definitions is a chat proxy.

test('tool definitions reach the provider instead of being dropped', async () => {
  stub.lastRequest = null;
  await post({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], tools: [WRITE_TOOL] });
  assert.ok(stub.lastRequest.tools, 'tools must be forwarded');
  assert.equal(stub.lastRequest.tools.length, 1);
  assert.equal(stub.lastRequest.tools[0].name, 'write_file');
  assert.equal(stub.lastRequest.tools[0].parameters.properties.path.type, 'string');
});

test('a request without tools forwards none', async () => {
  stub.lastRequest = null;
  await post({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(stub.lastRequest.tools, undefined);
});

test('tool calls are returned in OpenAI shape', async () => {
  const body = await (
    await post({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }], tools: [WRITE_TOOL] }, toolStub)
  ).json();
  const choice = body.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null, 'a pure tool turn has null content');
  assert.equal(choice.message.tool_calls[0].type, 'function');
  assert.equal(choice.message.tool_calls[0].function.name, 'write_file');
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"path":"a.txt"}');
});

test('streamed tool calls carry an index and finish as tool_calls', async () => {
  const text = await (
    await post({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }], tools: [WRITE_TOOL] }, toolStub)
  ).text();
  const chunks = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    .filter((p) => p !== '[DONE]').map((p) => JSON.parse(p));
  const withCall = chunks.find((c) => c.choices[0].delta.tool_calls);
  assert.ok(withCall, 'a chunk must carry the tool call');
  assert.equal(withCall.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(withCall.choices[0].delta.tool_calls[0].function.name, 'write_file');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('a tool result round-trips back to the provider', async () => {
  stub.lastRequest = null;
  await post({
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'write it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'written' },
    ],
    tools: [WRITE_TOOL],
  });
  const [, assistant, toolResult] = stub.lastRequest.messages;
  assert.equal(assistant.toolCalls[0].id, 'call_1');
  assert.equal(assistant.toolCalls[0].name, 'write_file');
  assert.equal(toolResult.role, 'tool');
  assert.equal(toolResult.toolCallId, 'call_1', 'the result must reference the call it answers');
  assert.equal(toolResult.content, 'written');
});

test('malformed tool entries are dropped rather than forwarded half-formed', async () => {
  stub.lastRequest = null;
  await post({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { description: 'no name' } }, WRITE_TOOL],
  });
  assert.equal(stub.lastRequest.tools.length, 1);
  assert.equal(stub.lastRequest.tools[0].name, 'write_file');
});
