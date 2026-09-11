import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, screenPath } from '../src/lib/routes.ts';
import { historyKey, parseHistory, saveConversation } from '../src/lib/workspace-state.ts';
import { readTextAttachment, messageContent, MAX_ATTACHMENT_BYTES } from '../src/lib/attachments.ts';

test('every panel round-trips through all URL modes', () => {
  for (const view of ['auto', 'mobile', 'desktop']) for (const screen of ['home', 'chat', 'voice', 'cli', 'tasks', 'browse', 'connections', 'login']) {
    assert.deepEqual(parseRoute(screenPath(view, screen)), { view, screen });
  }
  assert.deepEqual(parseRoute('/missing'), { view: 'auto', screen: 'home' });
});

test('account histories do not share a storage key', () => {
  assert.notEqual(historyKey('user-a'), historyKey('user-b'));
  assert.notEqual(historyKey('user-a'), historyKey(null));
});

test('text attachment contents reach the model and survive saved history', async () => {
  const attachment = await readTextAttachment(new File(['export const answer = 42;'], 'answer.ts'));
  const message = { role: 'user', text: 'Review this', attachment };
  assert.match(messageContent(message), /export const answer = 42/);
  const history = saveConversation([], 'id', [message], 1);
  assert.deepEqual(parseHistory(JSON.stringify(history)), history);
});

test('unsupported, oversized and binary attachments fail before a model request', async () => {
  await assert.rejects(readTextAttachment(new File(['pdf'], 'report.pdf')), /text and code/);
  await assert.rejects(readTextAttachment(new File(['x'.repeat(MAX_ATTACHMENT_BYTES + 1)], 'large.txt')), /48 KB/);
  await assert.rejects(readTextAttachment(new File(['a\0b'], 'binary.txt')), /binary/);
  await assert.rejects(readTextAttachment(new File([new Uint8Array([255])], 'bad.txt')), /UTF-8/);
});

test('malformed attachment history cannot crash the renderer', () => {
  assert.deepEqual(parseHistory(JSON.stringify([{ id: 'a', title: 'test', updatedAt: 1, messages: [{ role: 'user', text: 'x', attachment: { name: 12 } }] }])), []);
});
