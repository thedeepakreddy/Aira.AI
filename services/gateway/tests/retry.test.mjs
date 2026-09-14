import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetry, MAX_ATTEMPTS } from '../src/routes/openai.ts';
import { ProviderError } from '../src/providers/types.ts';

const fresh = { attempt: 1, emitted: false, aborted: false };
/** Verbatim from the log: seven of these ended turns that never got retried. */
const overloaded = new ProviderError('The model provider is having trouble.', true, 503, 'Upstream error from Nvidia: Service temporarily overloaded', 'provider');

test('a transient upstream failure before any output is retried', () => {
  assert.equal(shouldRetry(overloaded, fresh), true);
});

test('nothing is retried once output has reached the client', () => {
  // The regression that would matter most: a retry here appends a second
  // answer to a partly delivered first one.
  assert.equal(shouldRetry(overloaded, { ...fresh, emitted: true }), false);
});

test('an empty account is never retried', () => {
  const broke = new ProviderError('out of credit', true, 402, 'requires more credits', 'account');
  assert.equal(shouldRetry(broke, fresh), false, 'asking again cannot add credit, and bills for trying');
});

test('a non-retryable failure is not retried', () => {
  const bad = new ProviderError('context too long', false, 400, undefined, 'provider');
  assert.equal(shouldRetry(bad, fresh), false);
});

test('an aborted request stops immediately', () => {
  assert.equal(shouldRetry(overloaded, { ...fresh, aborted: true }), false);
});

test('attempts are bounded', () => {
  assert.equal(shouldRetry(overloaded, { ...fresh, attempt: MAX_ATTEMPTS - 1 }), true);
  assert.equal(shouldRetry(overloaded, { ...fresh, attempt: MAX_ATTEMPTS }), false);
});

test('a non-ProviderError is not retried', () => {
  assert.equal(shouldRetry(new Error('boom'), fresh), false);
});
