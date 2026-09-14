import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolError } from '../src/lib/opencode.ts';

test('a path refused for being outside the project says what to do about it', () => {
  // Verbatim shape from the log: fourteen of these failed silently in one run.
  const out = describeToolError({ error: 'permission=external_directory pattern=/Users/x/App/* action=deny' });
  assert.match(out, /Outside your project folder/);
  assert.match(out, /reconnect/i, 'the remedy is not "try again"');
});

test('an ordinary failure keeps its own first line', () => {
  const out = describeToolError({ error: 'ENOENT: no such file or directory\n  at open()' });
  assert.equal(out, 'ENOENT: no such file or directory');
});

test('a wall of output is clipped rather than filling the log', () => {
  const out = describeToolError({ output: 'x'.repeat(400) });
  assert.ok(out.length <= 201, `got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('a tool that did not fail contributes nothing', () => {
  assert.equal(describeToolError({ status: 'completed' }), undefined);
  assert.equal(describeToolError({ error: '   ' }), undefined);
  assert.equal(describeToolError(undefined), undefined);
  assert.equal(describeToolError(null), undefined);
});

test('a non-string error is still readable', () => {
  const out = describeToolError({ error: { code: 'EACCES', path: '/etc/hosts' } });
  assert.match(out, /EACCES/);
});
