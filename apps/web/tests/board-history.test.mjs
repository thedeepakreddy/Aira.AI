import { test } from 'node:test';
import assert from 'node:assert/strict';

/** localStorage stand-in, since the module talks to it directly. */
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const { recordBoard, loadBoardHistory, forgetBoard, BOARD_HISTORY } = await import('../src/lib/agent-board.ts');
const board = (sent, at, text = 'answer') => ({ sent, at, results: [{ id: 'research', name: 'Research', text, error: '' }] });

test('a finished board is filed, newest first', () => {
  store.clear();
  recordBoard('u1', board('first', 1));
  recordBoard('u1', board('second', 2));
  assert.deepEqual(loadBoardHistory('u1').map(b => b.sent), ['second', 'first']);
});

test('re-running the same goal replaces its entry rather than stacking', () => {
  store.clear();
  recordBoard('u1', board('same goal', 1));
  recordBoard('u1', board('same goal', 2, 'a better answer'));
  const all = loadBoardHistory('u1');
  assert.equal(all.length, 1, 'near-identical rows are what make a history unreadable');
  assert.equal(all[0].text ?? all[0].results[0].text, 'a better answer');
});

test('an empty board is not filed at all', () => {
  store.clear();
  recordBoard('u1', { sent: '', at: 1, results: [] });
  recordBoard('u1', { sent: 'asked but nothing came back', at: 2, results: [] });
  assert.deepEqual(loadBoardHistory('u1'), []);
});

test('history is bounded', () => {
  store.clear();
  for (let i = 0; i < BOARD_HISTORY + 12; i++) recordBoard('u1', board(`goal ${i}`, i));
  assert.equal(loadBoardHistory('u1').length, BOARD_HISTORY);
});

test('one account never sees another’s boards', () => {
  store.clear();
  recordBoard('u1', board('mine', 1));
  assert.deepEqual(loadBoardHistory('u2'), []);
  assert.deepEqual(loadBoardHistory(null), [], 'signed out sees nothing');
});

test('deleting removes just that board', () => {
  store.clear();
  recordBoard('u1', board('keep', 1));
  recordBoard('u1', board('drop', 2));
  assert.deepEqual(forgetBoard('u1', 2).map(b => b.sent), ['keep']);
});

test('a corrupted entry is skipped, not rendered', () => {
  store.clear();
  localStorage.setItem('aira.agent-board.v1.history.u1', JSON.stringify([{ nonsense: true }, board('real', 9)]));
  assert.deepEqual(loadBoardHistory('u1').map(b => b.sent), ['real']);
});
