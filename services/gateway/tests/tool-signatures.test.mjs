import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberToolCallMetadata, recallToolCallMetadata,
  clearToolCallMetadata, toolCallMetadataSize,
} from '../src/providers/signatures.ts';

test('a tool call\'s provider metadata survives the round trip', () => {
  clearToolCallMetadata();
  const signature = { google: { thought_signature: 'EuwBCukBARFNMg' } };
  rememberToolCallMetadata('call_1', signature);
  assert.deepEqual(recallToolCallMetadata('call_1'), signature);
});

test('an unknown call yields nothing rather than throwing', () => {
  clearToolCallMetadata();
  assert.equal(recallToolCallMetadata('never-seen'), undefined);
  assert.equal(recallToolCallMetadata(''), undefined);
});

test('nothing is stored when the provider sends no metadata', () => {
  clearToolCallMetadata();
  rememberToolCallMetadata('call_1', undefined);
  rememberToolCallMetadata('call_2', null);
  rememberToolCallMetadata('', { google: {} });
  assert.equal(toolCallMetadataSize(), 0);
});

test('the store is bounded, so a long-lived gateway cannot leak', () => {
  clearToolCallMetadata();
  for (let i = 0; i < 2_500; i++) rememberToolCallMetadata(`call_${i}`, { i });
  assert.ok(toolCallMetadataSize() <= 2_000, `grew to ${toolCallMetadataSize()}`);
  // Eviction is least-recent-first, so the newest calls — the ones an active
  // turn is about to hand back — are the ones still present.
  assert.deepEqual(recallToolCallMetadata('call_2499'), { i: 2499 });
  assert.equal(recallToolCallMetadata('call_0'), undefined);
});

test('re-reading a call keeps it from being evicted mid-conversation', () => {
  clearToolCallMetadata();
  rememberToolCallMetadata('keep', { kept: true });
  for (let i = 0; i < 1_999; i++) rememberToolCallMetadata(`filler_${i}`, { i });
  rememberToolCallMetadata('keep', { kept: true });
  for (let i = 0; i < 500; i++) rememberToolCallMetadata(`more_${i}`, { i });
  assert.deepEqual(recallToolCallMetadata('keep'), { kept: true });
});
