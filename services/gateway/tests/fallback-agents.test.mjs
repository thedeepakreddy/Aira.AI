/**
 * The fallback on the endpoint the agents actually use.
 *
 * `/openai/v1/chat/completions` is what OpenCode and the OpenClaw fleet talk
 * to, which makes it the surface where an outage costs the most. A person whose
 * chat errors asks again; an agent twenty tool calls into a task loses the task.
 *
 * It is also the one endpoint with two recoveries stacked — retry the same
 * vendor, then try another — so these check that they compose rather than
 * fight: the retry gets its attempts first, and only its giving up hands over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createOpenAIChatRoute, MAX_ATTEMPTS } from '../src/routes/openai.ts';
import { loadCatalogue } from '../src/providers/registry.ts';
import { ProviderError } from '../src/providers/types.ts';
import { addEventSink } from '../src/usage/events.ts';

loadCatalogue({
  anthropic: 'alpha-code|balanced|200000|1|5',
  openai: 'beta-code|balanced|200000|1|5',
  openrouter: 'gamma-code|balanced|200000|0|0',
});

const usageEvents = [];
addEventSink((event) => { usageEvents.push(event); });

const done = {
  type: 'done',
  usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: 'end_turn',
};

function fake(id, prefix, behaviour) {
  const calls = [];
  return {
    id,
    calls,
    supports: (model) => model.startsWith(prefix),
    async *streamChat(request) {
      calls.push(request.model);
      yield* behaviour(calls.length, request);
    },
  };
}

const noCredit = () => new ProviderError('Your credit balance is too low.', false, 400, 'vendor text', 'account');
const overloaded = () => new ProviderError('Service temporarily overloaded.', true, 529, 'vendor text', 'provider');

async function ask(providers, body) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'agent'); await next(); });
  app.post('/openai/v1/chat/completions', createOpenAIChatRoute(providers, 'code'));
  const response = await app.request('/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aira-memory': 'off' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'write a function' }], model: 'alpha-code', ...body }),
  });
  return { response, text: await response.text() };
}

test('a streaming agent turn survives a vendor with no credit', async () => {
  usageEvents.length = 0;
  const broke = fake('anthropic', 'alpha', function* () { throw noCredit(); });
  const working = fake('openai', 'beta', function* () {
    yield { type: 'text', text: 'const answer = 42;' };
    yield done;
  });

  const { text } = await ask([broke, working], { stream: true });

  assert.deepEqual(broke.calls, ['alpha-code'], 'no credit is not retried at the same vendor');
  assert.deepEqual(working.calls, ['beta-code']);
  assert.match(text, /const answer = 42;/);
  assert.doesNotMatch(text, /credit balance/);
  assert.match(text, /"model":"beta-code"/, 'the chunks name who is answering');
  assert.match(text, /\[DONE\]/);
});

test('the retry gets its attempts before another vendor is asked', async () => {
  usageEvents.length = 0;
  // Overloaded clears in a second, so trying the same vendor again is the
  // cheaper fix and must be exhausted first.
  const flaky = fake('anthropic', 'alpha', function* () { throw overloaded(); });
  const working = fake('openai', 'beta', function* () { yield { type: 'text', text: 'ok' }; yield done; });

  const { text } = await ask([flaky, working], { stream: true });

  assert.equal(flaky.calls.length, MAX_ATTEMPTS, 'the retry is not skipped in favour of a hand-over');
  assert.deepEqual(working.calls, ['beta-code']);
  assert.match(text, /ok/);
});

test('a vendor that recovers on its own retry is never handed over', async () => {
  usageEvents.length = 0;
  const recovers = fake('anthropic', 'alpha', function* (call) {
    if (call === 1) throw overloaded();
    yield { type: 'text', text: 'second time lucky' };
    yield done;
  });
  const other = fake('openai', 'beta', function* () { yield { type: 'text', text: 'unused' }; yield done; });

  const { text } = await ask([recovers, other], { stream: true });

  assert.equal(recovers.calls.length, 2);
  assert.deepEqual(other.calls, [], 'nothing to fall back from');
  assert.match(text, /second time lucky/);
});

test('an agent mid-answer is not handed to a second vendor', async () => {
  usageEvents.length = 0;
  // Half a file written twice is worse than half a file and an error.
  const halfway = fake('anthropic', 'alpha', function* () {
    yield { type: 'text', text: 'function half(' };
    throw overloaded();
  });
  const other = fake('openai', 'beta', function* () { yield { type: 'text', text: 'SECOND' }; yield done; });

  const { text } = await ask([halfway, other], { stream: true });

  assert.equal(halfway.calls.length, 1, 'emitted output stops the retry too');
  assert.deepEqual(other.calls, []);
  assert.match(text, /function half\(/);
  assert.doesNotMatch(text, /SECOND/);
});

test('a non-streaming turn falls back too', async () => {
  usageEvents.length = 0;
  const broke = fake('anthropic', 'alpha', function* () { throw noCredit(); });
  const working = fake('openai', 'beta', function* () { yield { type: 'text', text: 'done' }; yield done; });

  const { response, text } = await ask([broke, working], {});

  assert.equal(response.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.model, 'beta-code', 'the reply names the vendor that answered');
  assert.equal(body.choices[0].message.content, 'done');
});

test('every attempt is metered, so the bill is not understated', async () => {
  usageEvents.length = 0;
  const broke = fake('anthropic', 'alpha', function* () { throw noCredit(); });
  const working = fake('openai', 'beta', function* () { yield { type: 'text', text: 'ok' }; yield done; });

  await ask([broke, working], { stream: true });

  const requests = usageEvents.filter((e) => e.kind === 'model_request');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].payload.provider, 'anthropic');
  assert.equal(requests[0].payload.ok, false);
  assert.equal(requests[1].payload.provider, 'openai');
  assert.equal(requests[1].payload.model, 'beta-code');
  assert.match(requests[1].payload.routedBy, /fallback from alpha-code/);
});

test('when nobody can answer, the agent is told how many were asked', async () => {
  usageEvents.length = 0;
  const dead = (id, prefix) => fake(id, prefix, function* () { throw noCredit(); });
  const providers = [dead('anthropic', 'alpha'), dead('openai', 'beta'), dead('openrouter', 'gamma')];

  const { text } = await ask(providers, { stream: true });

  assert.deepEqual(providers.map((p) => p.calls.length), [1, 1, 1]);
  assert.match(text, /tried 2 other providers without success/);
});
