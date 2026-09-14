import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog } from '../src/lib/applog.ts';

test('a written line round-trips back into an entry', () => {
  const [entry] = parseLog(['1789340000\tcode\terror\tThis model is unavailable: no credit']);
  assert.equal(entry.surface, 'code');
  assert.equal(entry.level, 'error');
  assert.equal(entry.at, 1789340000000);
  assert.match(entry.message, /no credit/);
});

test('a message containing tabs keeps all of itself', () => {
  // The writer flattens newlines but not tabs, so the reader must rejoin.
  const [entry] = parseLog(['1789340000\tui\terror\tboom\tat foo()\tat bar()']);
  assert.equal(entry.message, 'boom\tat foo()\tat bar()');
});

test('an unknown level is treated as an error rather than trusted', () => {
  const [entry] = parseLog(['1789340000\tcode\tbanana\tsomething']);
  assert.equal(entry.level, 'error');
});

test('junk lines are dropped, not rendered', () => {
  assert.deepEqual(parseLog(['', 'not a log line', '\t\t\t']), []);
});

test('order is preserved so the tail reads chronologically', () => {
  const entries = parseLog([
    '1789340001\tcode\tinfo\tfirst',
    '1789340002\tcode\terror\tsecond',
  ]);
  assert.deepEqual(entries.map(e => e.message), ['first', 'second']);
});
