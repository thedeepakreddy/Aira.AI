import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { loadCatalogue } from '../src/providers/registry.ts';
import { createOpenAIChatRoute, createOpenAIModelsRoute } from '../src/routes/openai.ts';

loadCatalogue({ enabledProviders: ['anthropic'] });

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
  const text = await (await post({ model: 'claude-opus-5', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] })).text();
  const payloads = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());

  assert.equal(payloads.at(-1), '[DONE]', 'clients hang without the [DONE] sentinel');

  const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), 'Hello world');
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1).choices, []);
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

test('malformed tool entries are rejected before invoking a provider', async () => {
  stub.lastRequest = null;
  const response = await post({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { description: 'no name' } }, WRITE_TOOL],
  });
  assert.equal(response.status, 400);
  assert.equal(stub.lastRequest, null);
});

test('explicit unavailable model never silently falls back', async () => {
  stub.lastRequest = null;
  const response = await post({ model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.status, 400);
  assert.equal(stub.lastRequest, null);
});

test('tool choice, parallel execution and strict schema are preserved', async () => {
  await post({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ ...WRITE_TOOL, function: { ...WRITE_TOOL.function, strict: true } }],
    tool_choice: { type: 'function', function: { name: 'write_file' } }, parallel_tool_calls: false,
    temperature: 0.3, top_p: 0.8,
  });
  assert.deepEqual(stub.lastRequest.toolChoice, { name: 'write_file' });
  assert.equal(stub.lastRequest.parallelToolCalls, false);
  assert.equal(stub.lastRequest.tools[0].strict, true);
  assert.equal(stub.lastRequest.temperature, 0.3);
  assert.equal(stub.lastRequest.topP, 0.8);
});

test('invalid roles, tool references, modalities and token limits fail before provider work', async () => {
  const bodies = [
    null,
    { messages: [null] },
    { messages: [{ role: 'root', content: 'hi' }] },
    { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'abc', format: 'wav' } }] }] },
    { messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'result' }] },
    { messages: [{ role: 'user', content: 'hi' }], max_tokens: -1 },
    { messages: [{ role: 'user', content: 'hi' }], tool_choice: 'required' },
    { messages: [{ role: 'user', content: 'hi' }], tools: [WRITE_TOOL], tool_choice: { type: 'function', function: { name: 'other' } } },
    { messages: [{ role: 'user', content: 'hi' }], n: 2 },
    { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_schema' } },
  ];
  for (const body of bodies) {
    stub.lastRequest = null;
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal(stub.lastRequest, null);
  }
});

test('provider error events are surfaced instead of a successful stop chunk', async () => {
  const failure = { id: 'anthropic', supports: () => true, async *streamChat() {
    yield { type: 'error', message: 'Unavailable for this request.', retryable: false };
  } };
  const response = await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }, failure);
  const text = await response.text();
  assert.match(text, /Unavailable for this request/);
  assert.doesNotMatch(text, /"finish_reason":"stop"/);
  assert.match(text, /\[DONE\]/);
  assert.equal((await post({ messages: [{ role: 'user', content: 'hi' }] }, failure)).status, 500);
});

test('truncated streams are failures for both streaming and regular clients', async () => {
  const truncated = { id: 'anthropic', supports: () => true, async *streamChat() { yield { type: 'text', text: 'partial' }; } };
  assert.equal((await post({ messages: [{ role: 'user', content: 'hi' }] }, truncated)).status, 502);
  const text = await (await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }, truncated)).text();
  assert.match(text, /ended before completing/);
  assert.doesNotMatch(text, /"finish_reason":"stop"/);
});

test('usage chunks are emitted only on request', async () => {
  const text = await (await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
  assert.doesNotMatch(text, /"usage"/);
});

test('browser research preserves screenshot placement and its structured-output contract', async () => {
  const schema = { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false };
  const res = await post({ model: 'claude-opus-5', messages: [{ role: 'user', content: [
    { type: 'text', text: 'First image:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } },
    { type: 'text', text: 'Second image:' }, { type: 'image_url', image_url: { url: 'https://example.com/second.png' } },
  ] }], response_format: { type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema } }, reasoning_effort: 'low', stop: ['END'] });
  assert.equal(res.status, 200);
  assert.deepEqual(stub.lastRequest.messages[0].contentParts.map((part) => part.type), ['text', 'image', 'text', 'image']);
  assert.equal(stub.lastRequest.messages[0].contentParts[1].url, 'data:image/png;base64,YQ==');
  assert.deepEqual(stub.lastRequest.responseFormat.json_schema.schema, schema);
  assert.equal(stub.lastRequest.reasoningEffort, 'low');
  assert.deepEqual(stub.lastRequest.stop, ['END']);
});
