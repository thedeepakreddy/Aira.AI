import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../src/lib/sse.ts';

async function decode(chunks) {
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  const data = [];
  for await (const event of parseSSE(body)) data.push(event);
  return data;
}
const bytes = text => new TextEncoder().encode(text);

test('SSE handles every byte boundary in UTF-8 and CRLF', async () => {
  const encoded = bytes(': heartbeat\r\ndata: Aira 👋\r\n\r\ndata: done\r\n\r\n');
  assert.deepEqual(await decode([...encoded].map(byte => new Uint8Array([byte]))), ['Aira 👋', 'done']);
});

test('SSE joins data lines within one event without trimming content', async () => {
  assert.deepEqual(await decode([bytes('event: message\ndata:  first \ndata: second\n\ndata\n\n')]), [' first \nsecond', '']);
});

test('SSE supports CR line endings and ignores incomplete final events', async () => {
  assert.deepEqual(await decode([bytes('data: good\r\rdata: unfinished')]), ['good']);
});

test('stopping an SSE consumer cancels the underlying stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes('data: hello\n\n')); },
    cancel() { cancelled = true; },
  });
  for await (const event of parseSSE(body)) { assert.equal(event, 'hello'); break; }
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
