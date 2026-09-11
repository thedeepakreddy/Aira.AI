import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OpenCodeClient } from '../src/lib/opencode.ts';

/**
 * These fixtures are real events captured from a live OpenCode server during an
 * agent run, not hand-written guesses. That matters: two separate bugs here came
 * from trusting the OpenAPI spec's field names over what the server actually
 * sends, and hand-written fixtures would have encoded the same mistake.
 */
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures-opencode-events.json', import.meta.url), 'utf8'),
);

/** Feeds raw events through the client's normaliser and collects the output. */
async function normalise(events) {
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  globalThis.fetch = async () => ({ body });
  const client = new OpenCodeClient(1234, 'pw');
  const out = [];
  for await (const e of client.events(new AbortController().signal)) out.push(e);
  return out;
}

test('a permission request keeps its action and the files it affects', async () => {
  const [event] = await normalise([fixtures['permission.asked']]);
  assert.equal(event.kind, 'permission');
  // The live event says `permission` + `patterns`; the spec documents `action`
  // + `resources`. Reading only the documented names produced a blank prompt.
  assert.equal(event.request.action, 'edit');
  assert.ok(event.request.resources.length > 0, 'the prompt must name what it will touch');
  assert.match(event.request.resources[0], /calc\.py$/);
  assert.ok(event.request.id.startsWith('per_'));
});

test('a permission reply is matched to the request it answers', async () => {
  const asked = fixtures['permission.asked'];
  const [event] = await normalise([fixtures['permission.replied']]);
  assert.equal(event.kind, 'permission-resolved');
  // The reply names it `requestID` while the ask names it `id`; mismatching
  // them left prompts showing their buttons after being answered.
  assert.equal(event.id, asked.properties.id, 'reply must resolve the original request');
  assert.equal(event.reply, 'always');
});

test('tool activity reports what is happening, and to what', async () => {
  const [event] = await normalise([fixtures['tool:running']]);
  assert.equal(event.kind, 'tool');
  assert.equal(event.activity.tool, 'write');
  assert.equal(event.activity.status, 'running');
  assert.match(event.activity.target, /calc\.py$/, 'the target makes a long step legible');
  assert.ok(event.activity.partID, 'needs an id so updates replace rather than stack');
});

test('the same tool call keeps one id across its lifecycle', async () => {
  const events = await normalise([
    fixtures['tool:pending'],
    fixtures['tool:running'],
    fixtures['tool:completed'],
  ]);
  const ids = new Set(events.map((e) => e.activity.partID));
  assert.equal(ids.size, 1, 'one call must not render as three lines');
  assert.deepEqual(
    events.map((e) => e.activity.status),
    ['pending', 'running', 'completed'],
  );
});

test('streamed text carries its delta', async () => {
  const [event] = await normalise([fixtures['message.part.delta']]);
  assert.equal(event.kind, 'text');
  assert.equal(typeof event.delta, 'string');
});

test('unrecognised events surface rather than vanish', async () => {
  const [event] = await normalise([{ type: 'something.new', properties: {} }]);
  assert.equal(event.kind, 'other');
  assert.equal(event.type, 'something.new');
});

test('malformed frames do not kill the stream', async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {not json}\n\n'));
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(fixtures['message.part.delta'])}\n\n`));
      c.close();
    },
  });
  globalThis.fetch = async () => ({ body });
  const client = new OpenCodeClient(1234, 'pw');
  const out = [];
  for await (const e of client.events(new AbortController().signal)) out.push(e);
  assert.equal(out.length, 1, 'the good frame still arrives');
  assert.equal(out[0].kind, 'text');
});
