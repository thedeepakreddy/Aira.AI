import test from 'node:test';
import assert from 'node:assert/strict';

/** The storage helpers, exercised the way the panel uses them. */
const BOARD_KEY = 'aira.agent-board.v1';
function makeStore() {
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
    removeItem: k => data.delete(k),
    _raw: data,
  };
}
globalThis.localStorage = makeStore();

const { loadBoard, saveBoard } = await import('../src/lib/agent-board.ts');

test('a board round-trips for the account that saved it', () => {
  saveBoard('user-1', { sent: 'plan the launch', at: 1, results: [{ id: 'a/research', name: 'Research', text: 'found things', error: '' }] });
  const back = loadBoard('user-1');
  assert.equal(back.sent, 'plan the launch');
  assert.equal(back.results[0].text, 'found things');
});

test('one account cannot read another account’s board', () => {
  saveBoard('user-1', { sent: 'mine', at: 1, results: [] });
  assert.equal(loadBoard('user-2'), null);
});

test('a signed-out session stores and loads nothing', () => {
  saveBoard(null, { sent: 'x', at: 1, results: [] });
  assert.equal(loadBoard(null), null);
  assert.equal([...localStorage._raw.keys()].filter(k => k.includes('null')).length, 0);
});

test('a corrupted entry yields null rather than throwing', () => {
  localStorage.setItem(`${BOARD_KEY}.user-3`, '{not json');
  assert.equal(loadBoard('user-3'), null);
  localStorage.setItem(`${BOARD_KEY}.user-3`, JSON.stringify({ sent: 5 }));
  assert.equal(loadBoard('user-3'), null);
});

test('oversized content is bounded, so one board cannot wedge a render', () => {
  saveBoard('user-4', {
    sent: 'x'.repeat(20_000), at: 1,
    results: Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: 'A', text: 'y'.repeat(200_000), error: '' })),
  });
  const back = loadBoard('user-4');
  assert.ok(back.sent.length <= 8_000, 'goal is capped');
  assert.ok(back.results.length <= 12, 'result count is capped');
  assert.ok(back.results[0].text.length <= 100_000, 'result text is capped');
});

test('a storage that throws never breaks a run', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
  const original = globalThis.localStorage;
  globalThis.localStorage = broken;
  assert.doesNotThrow(() => saveBoard('user-5', { sent: 'x', at: 1, results: [] }));
  assert.equal(loadBoard('user-5'), null);
  globalThis.localStorage = original;
});
