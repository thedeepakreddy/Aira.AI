import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';

function providerFor(chunks, id = 'openai') {
  let sent;
  const provider = new OpenAICompatibleProvider({ id, apiKey: 'offline-test-key',
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  return { provider, sent: () => sent };
}
const request = { model: 'test-model', surface: 'code', messages: [{ role: 'user', content: 'hi' }] };

test('adapter forwards tool controls and assembles fragmented arguments correctly', async () => {
  const mock = providerFor([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
  ]);
  const events = await Array.fromAsync(mock.provider.streamChat({ ...request, tools: [{ name: 'read_file', parameters: { type: 'object' }, strict: true }], toolChoice: { name: 'read_file' }, parallelToolCalls: false }));
  assert.deepEqual(events.find((event) => event.type === 'tool_call').call, { id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' });
  assert.deepEqual(events.at(-1).usage, { inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 });
  assert.equal(mock.sent().tools[0].function.strict, true);
  assert.equal(mock.sent().tool_choice.function.name, 'read_file');
  assert.equal(mock.sent().parallel_tool_calls, false);
  assert.equal(mock.sent().max_completion_tokens, 16000);
});

test('compatible providers use max_tokens while direct OpenAI uses max_completion_tokens', async () => {
  const mock = providerFor([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }], 'gemini');
  await Array.fromAsync(mock.provider.streamChat(request));
  assert.equal(mock.sent().max_tokens, 16000);
  assert.equal(mock.sent().max_completion_tokens, undefined);
});

test('adapter rejects truncated streams and incomplete tool arguments before tool execution', async () => {
  const truncated = providerFor([{ choices: [{ delta: { content: 'partial' } }] }]);
  await assert.rejects(async () => Array.fromAsync(truncated.provider.streamChat(request)), /ended before completing/);
  const invalidTool = providerFor([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'write_file', arguments: '{"x":' } }] }, finish_reason: 'length' }] }]);
  await assert.rejects(async () => Array.fromAsync(invalidTool.provider.streamChat(request)), /incomplete tool arguments/);
});

test('OpenAI adapter preserves screenshot parts and the browser action schema', async () => {
  const mock = providerFor([{ choices: [{ delta: { content: '{"done":true}' }, finish_reason: 'stop' }] }]);
  const contentParts = [{ type: 'text', text: 'Screenshot' }, { type: 'image', url: 'data:image/png;base64,YQ==', detail: 'high' }];
  const format = { type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false } } };
  await Array.fromAsync(mock.provider.streamChat({ ...request, messages: [{ role: 'user', content: 'Screenshot', contentParts }], responseFormat: format, reasoningEffort: 'low' }));
  assert.deepEqual(mock.sent().messages[0].content, [{ type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }]);
  assert.deepEqual(mock.sent().response_format, format);
  assert.equal(mock.sent().reasoning_effort, 'low');
});

test('Anthropic adapter translates vision, strict tools, tool choice and JSON schema without beta flags', async () => {
  let sent;
  let headers;
  const events = [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"done":true}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const provider = new AnthropicProvider('offline-test-key', async (_url, init) => {
    sent = JSON.parse(init.body);
    headers = new Headers(init.headers);
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const schema = { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false };
  const output = await Array.fromAsync(provider.streamChat({ ...request, model: 'claude-opus-5', messages: [{ role: 'user', content: 'Screenshot', contentParts: [
    { type: 'text', text: 'Screenshot' }, { type: 'image', url: 'data:image/png;base64,YQ==' }, { type: 'image', url: 'https://example.com/x.png' },
  ] }], tools: [{ name: 'read_file', strict: true, parameters: { type: 'object' } }], toolChoice: 'required', parallelToolCalls: false,
    responseFormat: { type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema } }, reasoningEffort: 'low', stop: ['END'],
  }));
  assert.equal(output.at(-1).type, 'done');
  assert.deepEqual(sent.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } });
  assert.equal(sent.messages[0].content[2].source.url, 'https://example.com/x.png');
  assert.deepEqual(sent.output_config, { format: { type: 'json_schema', schema }, effort: 'low' });
  assert.deepEqual(sent.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.equal(sent.tools[0].strict, true);
  assert.deepEqual(sent.stop_sequences, ['END']);
  assert.equal(headers.has('anthropic-beta'), false);
  assert.equal(sent.fallbacks, undefined);
});
