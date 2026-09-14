import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, resolveInside, serveStatic, withBase, PREVIEW_BASE } from '../src/runtimes/preview.ts';

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aira-prev-'));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return dir;
}

test('a project with a dev script is run, not served as files', () => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
  const plan = planFor(dir, 4000);
  assert.equal(plan.kind, 'dev-server');
  assert.deepEqual(plan.args.slice(0, 2), ['run', 'dev']);
});

test('vite is told where it is mounted', () => {
  // Without it, its asset URLs are absolute and every one misses.
  const dir = project({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --host' } }) });
  const plan = planFor(dir, 4000);
  assert.ok(plan.args.includes('--base'));
  assert.ok(plan.args.includes(`${PREVIEW_BASE}/`));
});

test('dev is preferred over start', () => {
  // `start` is as often a production server as a dev one, and the point is the
  // loop where a change shows up.
  const dir = project({ 'package.json': JSON.stringify({ scripts: { start: 'node server.js', dev: 'vite' } }) });
  assert.deepEqual(planFor(dir, 1).args.slice(0, 2), ['run', 'dev']);
});

test('plain files are served statically rather than built', () => {
  const dir = project({ 'index.html': '<h1>hi</h1>' });
  assert.equal(planFor(dir, 1).kind, 'static');
});

test('a malformed package.json still gets a preview', () => {
  // The files are there; serving them beats refusing.
  const dir = project({ 'package.json': '{ not json', 'index.html': '<h1>hi</h1>' });
  assert.equal(planFor(dir, 1).kind, 'static');
});

test('a preview cannot read outside its own project', () => {
  // The boundary that stops one user's preview reading the server's disk.
  const dir = project({ 'index.html': 'x' });
  assert.equal(resolveInside(dir, '/../../etc/passwd'), null);
  assert.equal(resolveInside(dir, '/..%2f..%2fetc/passwd'), null, 'an encoded traversal must not slip past');
  assert.equal(resolveInside(dir, '/a\0b'), null);
  assert.ok(resolveInside(dir, '/index.html'));
});

test('a sibling directory with the same prefix is not inside', () => {
  // "/root-evil" passes a naive startsWith check against "/root".
  assert.equal(resolveInside('/srv/app', '/../app-evil/secret'), null);
});

test('a directory serves its index, and unknown routes fall back to the app', () => {
  const dir = project({ 'index.html': '<h1>app</h1>', 'sub/index.html': '<h1>sub</h1>' });
  assert.match(serveStatic(dir, '/sub')?.body.toString(), /sub/);
  // A single-page app's routes are not files; without this every one 404s.
  assert.match(serveStatic(dir, '/some/client/route')?.body.toString(), /app/);
});

test('a real file always wins over the fallback', () => {
  const dir = project({ 'index.html': '<h1>app</h1>', 'app.js': 'console.log(1)' });
  const hit = serveStatic(dir, '/app.js');
  assert.match(hit.body.toString(), /console\.log/);
  assert.match(hit.type, /javascript/);
});

test('html is pointed at the path it is mounted under', () => {
  const out = withBase('<html><head><title>x</title></head><body></body></html>', PREVIEW_BASE);
  assert.match(out, new RegExp(`<base href="${PREVIEW_BASE}/">`));
  assert.ok(out.indexOf('<base') < out.indexOf('<title>'), 'must precede every asset reference');
});

test('a project that set its own base keeps it', () => {
  const html = '<html><head><base href="/mine/"><title>x</title></head></html>';
  assert.equal(withBase(html, PREVIEW_BASE), html);
});

test('html with no head still gets a base', () => {
  assert.match(withBase('<h1>hand written</h1>', PREVIEW_BASE), /^<base href=/);
});

test('a doctype stays first, or the page renders in quirks mode', () => {
  // The first real preview came back with <base> ahead of the doctype, which
  // means the document has no doctype at all as far as the parser cares.
  const out = withBase('<!doctype html>\n<title>x</title>', PREVIEW_BASE);
  assert.ok(/^<!doctype html>/i.test(out), `doctype must lead, got: ${out.slice(0, 40)}`);
  assert.match(out, /<base href=/);
  assert.ok(out.indexOf('<base') < out.indexOf('<title>'));
});
