import test from 'node:test';
import assert from 'node:assert/strict';
import { worthKeeping, formatPage, parsePage, around, PAGE_SURFACE, isPageSurface } from '../src/memory/pages.ts';
import { memoryInput, MEMORY_SURFACES } from '../src/routes/memory.ts';
import { trim } from '../src/memory/store.ts';

const page = (over = {}) => ({ url: 'https://example.com/a', title: 'A', text: 'x'.repeat(900), ...over });

test('the reserved surface is not writable through the public API', () => {
  // The boundary that matters: a client that could write here would be planting
  // web-sourced text into a store the user believes holds their own reading.
  assert.ok(!MEMORY_SURFACES.includes(PAGE_SURFACE));
  assert.throws(() => memoryInput({ text: 'hi', surface: PAGE_SURFACE }), /recorded by the browser/);
  assert.ok(isPageSurface(PAGE_SURFACE));
});

test('only real reading is kept', () => {
  assert.ok(worthKeeping(page()));
  assert.ok(!worthKeeping(page({ text: 'too short' })), 'cookie walls and redirects say almost nothing');
  assert.ok(!worthKeeping(page({ url: 'http://localhost:5180/x' })), 'the user’s own dev server is not reading');
  assert.ok(!worthKeeping(page({ url: 'https://192.168.1.4/admin' })), 'private hosts stay private');
  assert.ok(!worthKeeping(page({ url: 'https://site.com/oauth/callback' })), 'on the way to somewhere else');
  assert.ok(!worthKeeping(page({ url: 'about:blank' })), 'not a page');
});

test('a stored page round-trips with its provenance', () => {
  const stored = formatPage({ url: 'https://pg.org/locks', title: 'Postgres Locking', text: 'Row locks are taken...' });
  assert.ok(stored.startsWith('[web] '), 'the marker says this is quoted, not said by the user');
  const back = parsePage(stored, '2026-09-14T00:00:00Z');
  assert.equal(back.url, 'https://pg.org/locks');
  assert.equal(back.title, 'Postgres Locking');
  assert.match(back.excerpt, /Row locks/);
});

test('a row that is not a page is skipped, not half-parsed', () => {
  assert.equal(parsePage('an ordinary memory about the user', '2026-09-14T00:00:00Z'), null);
});

test('the excerpt shows the match, not the top of the page', () => {
  // Otherwise every result looks like the opening paragraph of an article and
  // the user cannot tell which one they meant.
  const body = `${'lorem '.repeat(80)}the advisory lock is released on commit${' ipsum'.repeat(80)}`;
  const out = around(body, 'advisory lock');
  assert.match(out, /advisory lock/);
  assert.ok(out.startsWith('…'), 'trimmed from the left');
  assert.ok(out.length < 220);
});

test('a query that is not present still returns something readable', () => {
  const out = around('some page text here', 'absent');
  assert.equal(out, 'some page text here');
});

test('a title-less page falls back to its URL', () => {
  const back = parsePage(formatPage({ url: 'https://x.dev/p', title: '   ', text: 'body text' }), 'now');
  assert.equal(back.title, 'https://x.dev/p');
});

test('a page survives the exact round trip the store performs', () => {
  // The bug this guards: the store collapses every run of whitespace before
  // writing, so the newline-delimited format wrote fine and could not be read
  // back. The row matched the search and was dropped on the way out, which
  // looked exactly like nothing had ever been saved.
  const stored = trim(formatPage({
    url: 'https://www.postgresql.org/docs/current/explicit-locking.html',
    title: 'PostgreSQL: Explicit Locking',
    text: 'An advisory lock is released on commit\n\nunless taken at session level.',
  }));
  assert.ok(!stored.includes('\n'), 'the store leaves no newlines to delimit with');
  const back = parsePage(stored, '2026-09-14T00:00:00Z');
  assert.ok(back, 'must still parse after whitespace collapsing');
  assert.equal(back.url, 'https://www.postgresql.org/docs/current/explicit-locking.html');
  assert.equal(back.title, 'PostgreSQL: Explicit Locking');
  assert.match(back.excerpt, /advisory lock is released on commit/);
});

test('a title containing spaces and punctuation does not break the parse', () => {
  const back = parsePage(trim(formatPage({
    url: 'https://x.dev/a?b=1&c=2',
    title: 'Re: locks, latches — and why :: matters',
    text: 'body '.repeat(40),
  })), 'now');
  assert.equal(back.title, 'Re: locks, latches — and why :: matters');
  assert.equal(back.url, 'https://x.dev/a?b=1&c=2');
});
