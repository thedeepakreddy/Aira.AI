/**
 * The fallback as the chat route actually runs it.
 *
 * `fallback.test.mjs` covers the policy; this covers the wiring, which is where
 * the interesting mistakes are — an error forwarded before the decision was
 * made, usage attributed to the wrong vendor, a second answer appended to a
 * half-delivered first one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createChatRoute } from '../src/routes/chat.ts';
import { loadCatalogue } from '../src/providers/registry.ts';
import { ProviderError } from '../src/providers/types.ts';
import { addEventSink } from '../src/usage/events.ts';

// Memory is a separate concern and would reach for a store this test has no
// business starting.
const MEMORY_OFF = { 'content-type': 'application/json', 'x-aira-memory': 'off' };

loadCatalogue({
  anthropic: 'alpha-big|frontier|200000|1|5',
  openai: 'beta-big|frontier|200000|1|5, beta-small|fast|100000|1|1',
  openrouter: 'gamma-big|frontier|200000|0|0',
});

const usageEvents = [];
addEventSink((event) => { usageEvents.push(event); });

/**
 * A provider that does what the test needs and records that it was asked.
 *
 * `script` is a list of events, or a thrown ProviderError.
 */
function fake(id, prefix, behaviour) {
  const calls = [];
  return {
    id,
    calls,
    supports: (model) => model.startsWith(prefix),
    async *streamChat(request) {
      calls.push(request.model);
      yield { type: 'start', model: request.model, provider: id };
      yield* behaviour(request);
    },
  };
}

const done = {
  type: 'done',
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  stopReason: 'end_turn',
};

async function ask(providers, body) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'tester'); await next(); });
  app.post('/v1/chat', createChatRoute(providers));
  const response = await app.request('/v1/chat', {
    method: 'POST',
    headers: MEMORY_OFF,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], ...body }),
  });
  return response.text();
}

test('a provider with no credit is replaced by one that has some', async () => {
  usageEvents.length = 0;
  const broke = fake('anthropic', 'alpha', function* () {
    throw new ProviderError('Your credit balance is too low.', false, 400, 'raw vendor text', 'account');
  });
  const working = fake('openai', 'beta', function* () {
    yield { type: 'text', text: 'Hello from the backup.' };
    yield done;
  });

  const stream = await ask([broke, working], { model: 'alpha-big' });

  assert.deepEqual(broke.calls, ['alpha-big']);
  assert.deepEqual(working.calls, ['beta-big'], 'the backup answers at the same tier');
  assert.match(stream, /Hello from the backup\./);
  assert.doesNotMatch(stream, /credit balance/, 'the user never sees the failure that was rescued');
  // The client learns which model actually answered, because `start` arrives
  // twice and the second one wins.
  assert.match(stream, /"model":"beta-big"/);
  // And is told it was a substitution rather than left to notice the label
  // changed, which reads as a bug when someone finally does.
  assert.match(stream, /"type":"fallback","from":"alpha-big","to":"beta-big"/);
});

test('an ordinary turn says nothing about fallbacks', async () => {
  usageEvents.length = 0;
  const working = fake('anthropic', 'alpha', function* () {
    yield { type: 'text', text: 'no drama' };
    yield done;
  });

  const stream = await ask([working], { model: 'alpha-big' });

  assert.doesNotMatch(stream, /fallback/, 'nothing stood in, so nothing is claimed to have');
});

test('both attempts are billed, not just the one that worked', async () => {
  usageEvents.length = 0;
  const broke = fake('anthropic', 'alpha', function* () {
    throw new ProviderError('Overloaded.', true, 529, 'raw', 'provider');
  });
  const working = fake('openai', 'beta', function* () {
    yield { type: 'text', text: 'ok' };
    yield done;
  });

  await ask([broke, working], { model: 'alpha-big' });

  const requests = usageEvents.filter((e) => e.kind === 'model_request');
  assert.equal(requests.length, 2, 'a turn that cost two requests must report two');
  assert.equal(requests[0].payload.provider, 'anthropic');
  assert.equal(requests[0].payload.ok, false);
  assert.equal(requests[0].payload.model, 'alpha-big', 'the failure is not attributed to the rescuer');
  assert.equal(requests[1].payload.provider, 'openai');
  assert.equal(requests[1].payload.ok, true);
  assert.match(requests[1].payload.routedBy, /fallback from alpha-big/);
});

test('nothing is retried once the answer has started', async () => {
  usageEvents.length = 0;
  const halfway = fake('anthropic', 'alpha', function* () {
    yield { type: 'text', text: 'Once upon a' };
    throw new ProviderError('The stream dropped.', true, 502, 'raw', 'provider');
  });
  const other = fake('openai', 'beta', function* () { yield { type: 'text', text: 'SECOND ANSWER' }; yield done; });

  const stream = await ask([halfway, other], { model: 'alpha-big' });

  assert.deepEqual(other.calls, [], 'a second answer appended to a first is worse than an error');
  assert.match(stream, /Once upon a/);
  assert.match(stream, /The stream dropped\./);
});

test('a mistake in the request is not shopped around', async () => {
  usageEvents.length = 0;
  // Every provider would say the same thing, so four of them turns one clear
  // error into four slow ones.
  const broke = fake('anthropic', 'alpha', function* () {
    throw new ProviderError('That prompt is over the context window.', false, 400, 'raw', 'gateway');
  });
  const other = fake('openai', 'beta', function* () { yield { type: 'text', text: 'no' }; yield done; });

  const stream = await ask([broke, other], { model: 'alpha-big' });

  assert.deepEqual(other.calls, []);
  assert.match(stream, /over the context window/);
});

test('an error arriving as an event falls back like a thrown one', async () => {
  // The route used to forward these straight through, which would have shown
  // the user a failure Aira was about to recover from.
  usageEvents.length = 0;
  const broke = fake('anthropic', 'alpha', function* () {
    yield { type: 'error', message: 'Rate limited.', retryable: true, fault: 'provider' };
  });
  const working = fake('openai', 'beta', function* () { yield { type: 'text', text: 'rescued' }; yield done; });

  const stream = await ask([broke, working], { model: 'alpha-big' });

  assert.deepEqual(working.calls, ['beta-big']);
  assert.match(stream, /rescued/);
  assert.doesNotMatch(stream, /Rate limited/);
});

test('when everyone fails the user is told how many were asked', async () => {
  usageEvents.length = 0;
  const dead = (id, prefix) => fake(id, prefix, function* () {
    throw new ProviderError('No credit.', false, 400, 'raw', 'account');
  });
  const a = dead('anthropic', 'alpha');
  const b = dead('openai', 'beta');
  const g = dead('openrouter', 'gamma');

  const stream = await ask([a, b, g], { model: 'alpha-big' });

  assert.deepEqual(a.calls, ['alpha-big']);
  assert.deepEqual(b.calls, ['beta-big']);
  assert.deepEqual(g.calls, ['gamma-big']);
  assert.match(stream, /tried 2 other providers without success/);
  assert.equal(usageEvents.filter((e) => e.kind === 'model_request').length, 3);
});

test('a tier is never crossed to find a working provider', async () => {
  usageEvents.length = 0;
  // beta-small is reachable and would answer, but it is a fast model and the
  // question was routed to a frontier one.
  const broke = fake('anthropic', 'alpha', function* () {
    throw new ProviderError('No credit.', false, 400, 'raw', 'account');
  });
  const openai = fake('openai', 'beta', function* () {
    throw new ProviderError('No credit.', false, 400, 'raw', 'account');
  });

  await ask([broke, openai], { model: 'alpha-big' });

  assert.deepEqual(openai.calls, ['beta-big'], 'beta-small is a downgrade, not a rescue');
});
