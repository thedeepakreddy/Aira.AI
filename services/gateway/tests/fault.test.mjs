import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFault, faultAdvice } from '../src/providers/fault.ts';

test('an empty wallet is the account, whatever status the vendor uses', () => {
  // Anthropic really does return this as a 400 invalid_request_error, which is
  // why status alone cannot decide. This exact string blocked Aira today.
  assert.equal(classifyFault(400,
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'),
    'account');
  // And OpenAI's wording for the same condition.
  assert.equal(classifyFault(429, 'You exceeded your current quota, please check your plan and billing details.'), 'account');
});

test('a rate limit is the provider, not the account', () => {
  assert.equal(classifyFault(429, 'Rate limit reached for gemini-3.7-flash'), 'provider');
  assert.equal(classifyFault(503, 'The model is overloaded. Please try again later.'), 'provider');
});

test('a 4xx Aira cannot otherwise explain is Aira’s own', () => {
  // The Gemini thought_signature defect arrived exactly like this: a 400 with
  // nothing about the account or the service in it.
  assert.equal(classifyFault(400,
    'Function call is missing a thought_signature in functionCall parts.'), 'gateway');
  assert.equal(classifyFault(400, undefined), 'gateway');
});

test('auth failures are the account even with no body', () => {
  for (const status of [401, 402, 403]) assert.equal(classifyFault(status, ''), 'account');
});

test('server errors are the provider even with no body', () => {
  for (const status of [500, 502, 503]) assert.equal(classifyFault(status, ''), 'provider');
});

test('every fault carries advice, and only Aira takes the blame', () => {
  assert.match(faultAdvice('account'), /credit, quota, or an expired key/);
  assert.match(faultAdvice('provider'), /busy or unavailable/);
  assert.match(faultAdvice('gateway'), /Aira/);
  // The old message blamed Aira for everything; account problems must not.
  assert.doesNotMatch(faultAdvice('account'), /Aira/);
});
