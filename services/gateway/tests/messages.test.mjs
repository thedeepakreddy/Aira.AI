import test from 'node:test';
import assert from 'node:assert/strict';
import { humanize } from '../src/providers/messages.ts';
import { classifyFault } from '../src/providers/fault.ts';

/**
 * Captured from a live 402 while driving the packaged app, not composed here.
 *
 * OpenRouter reserves the whole `max_tokens` up front, so a balance that looks
 * fine still fails on a large request — and it says "requires more credits"
 * rather than any of the phrasings the other vendors use.
 */
const OPENROUTER_402 =
  '402 This request requires more credits, or fewer max_tokens. You requested up to 32000 '
  + 'tokens, but can only afford 652. To increase, visit https://openrouter.ai/settings/credits '
  + 'and upgrade to a paid account';

test('OpenRouter’s credit wording reads as an account problem, not a retry', () => {
  assert.match(humanize(OPENROUTER_402), /run out of credit or quota/);
  // The regression this guards: it fell through to the generic message, whose
  // advice is to try again — which cannot ever be right for an empty balance.
  assert.doesNotMatch(humanize(OPENROUTER_402), /try again/i);
  assert.equal(classifyFault(402, OPENROUTER_402), 'account');
});

test('the other vendors’ billing phrasings still match', () => {
  for (const raw of [
    'Your credit balance is too low to access the Anthropic API.',
    'You exceeded your current quota, please check your plan and billing details.',
    '{"error":{"type":"insufficient_quota"}}',
  ]) {
    assert.match(humanize(raw), /run out of credit or quota/, raw.slice(0, 40));
  }
});

test('an unrecognised failure still says something honest', () => {
  const message = humanize('ECONNRESET while reading from upstream');
  assert.match(message, /Something went wrong/);
  // No JSON envelope, no request id, no vendor console link.
  assert.doesNotMatch(message, /[{}]|request_id|http/i);
});
