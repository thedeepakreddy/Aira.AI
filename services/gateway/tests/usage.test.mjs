import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, summarise, clearUsage } from '../src/usage/recent.ts';

const event = (userId, over = {}) => ({
  kind: 'model_request', at: new Date().toISOString(), userId, conversationId: null,
  surface: over.surface ?? 'task',
  payload: { provider: 'p', model: 'm', inputTokens: 10, outputTokens: 20, costUsd: 0.01, ok: true, ...over },
});

test('usage totals only what that user spent', () => {
  clearUsage();
  recordUsage(event('a')); recordUsage(event('a')); recordUsage(event('b'));
  assert.equal(summarise('a').requests, 2);
  assert.equal(summarise('b').requests, 1);
  assert.equal(summarise('nobody').requests, 0);
});

test('a total is marked incomplete when any price is unknown', () => {
  clearUsage();
  recordUsage(event('a'));
  assert.equal(summarise('a').complete, true);
  // An unpriced model must not silently vanish from the total.
  recordUsage(event('a', { costUsd: null }));
  const s = summarise('a');
  assert.equal(s.complete, false, 'the total is a floor, and must say so');
  assert.equal(s.requests, 2);
  assert.ok(Math.abs(s.costUsd - 0.01) < 1e-9, 'the known cost still counts');
});

test('surfaces are totalled separately and can be filtered', () => {
  clearUsage();
  recordUsage(event('a', { surface: 'task' }));
  recordUsage(event('a', { surface: 'chat' }));
  assert.equal(summarise('a', 'task').requests, 1);
  assert.equal(summarise('a').bySurface.chat.requests, 1);
});

test('failures are counted, not hidden', () => {
  clearUsage();
  recordUsage(event('a', { ok: false }));
  assert.equal(summarise('a').failed, 1);
});

test('the store is bounded, so a long-running gateway cannot grow forever', () => {
  clearUsage();
  for (let i = 0; i < 1_200; i++) recordUsage(event('a'));
  assert.ok(summarise('a').requests <= 500, `kept ${summarise('a').requests}`);
});

test('non-model events are ignored', () => {
  clearUsage();
  recordUsage({ kind: 'agent_action', at: new Date().toISOString(), userId: 'a', conversationId: null, surface: 'mcp', payload: {} });
  assert.equal(summarise('a').requests, 0);
});
