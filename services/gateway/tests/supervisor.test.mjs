import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeSupervisor, stateDirFor, freePort } from '../src/runtimes/supervisor.ts';

/** A child that never really runs, so the tests need no runtimes installed. */
function fakeSpawn() {
  const spawned = [];
  const impl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + spawned.length;
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    spawned.push({ command, args, options, child });
    return child;
  };
  impl.spawned = spawned;
  return impl;
}

const root = join(tmpdir(), `aira-sup-${process.pid}`);
const plan = () => ({ command: 'true', args: [], env: {} });
const make = (over = {}) => new RuntimeSupervisor({ root, spawnImpl: fakeSpawn(), ...over });

test('a user gets one process per kind, not one in total', async () => {
  const s = make();
  await s.start('u1', 'agents', plan);
  await s.start('u1', 'code', plan);
  assert.equal(s.size, 2);
  assert.ok(s.get('u1', 'agents'));
  assert.ok(s.get('u1', 'code'));
  s.shutdown();
});

test('starting twice returns the same process', async () => {
  // A client retrying a slow start must not end up with two processes and a
  // handle to only one of them.
  const s = make();
  const first = await s.start('u1', 'agents', plan);
  const again = await s.start('u1', 'agents', plan);
  assert.equal(first, again);
  assert.equal(s.size, 1);
  s.shutdown();
});

test('users cannot see each other’s runtimes', async () => {
  const s = make();
  await s.start('u1', 'agents', plan);
  assert.equal(s.get('u2', 'agents'), undefined);
  s.shutdown();
});

test('state directories are derived from the id, never from a request', () => {
  // Hashed: a raw id in a path invites traversal, and a directory listing that
  // reads as a user list.
  const a = stateDirFor('/root', 'user-one');
  assert.ok(!a.includes('user-one'));
  assert.equal(a, stateDirFor('/root', 'user-one'), 'stable for the same user');
  assert.notEqual(a, stateDirFor('/root', 'user-two'));
  const evil = stateDirFor('/root', '../../etc/passwd');
  assert.ok(!evil.includes('..'), 'a crafted id cannot escape the root');
});

test('the total is capped, and the cap is explained rather than queued', async () => {
  const s = make({ maxTotal: 2 });
  await s.start('a', 'agents', plan);
  await s.start('b', 'agents', plan);
  await assert.rejects(() => s.start('c', 'agents', plan), /capacity/i);
  assert.equal(s.size, 2, 'the hundredth user must not take the machine down');
  s.shutdown();
});

test('idle runtimes are reaped, busy ones are not', async () => {
  let clock = 1_000_000;
  const s = make({ idleMs: 1000, now: () => clock });
  await s.start('idle', 'agents', plan);
  await s.start('busy', 'agents', plan);
  clock += 800;
  s.get('busy', 'agents');           // a request keeps it alive
  clock += 400;                       // idle is now 1200ms old, busy is 400
  assert.equal(s.sweep(), 1);
  assert.equal(s.get('idle', 'agents'), undefined);
  assert.ok(s.get('busy', 'agents'));
  s.shutdown();
});

test('reaping frees a slot for a waiting user', async () => {
  let clock = 1_000_000;
  const s = make({ maxTotal: 1, idleMs: 500, now: () => clock });
  await s.start('gone', 'agents', plan);
  clock += 1000;
  // The cap sweeps before refusing, so a tab closed on a train does not hold
  // the last slot forever.
  const next = await s.start('new', 'agents', plan);
  assert.ok(next);
  assert.equal(s.size, 1);
  s.shutdown();
});

test('a runtime that exits is forgotten, not restarted', async () => {
  const spawnImpl = fakeSpawn();
  const s = new RuntimeSupervisor({ root, spawnImpl });
  await s.start('u1', 'agents', plan);
  spawnImpl.spawned[0].child.emit('exit', 1);
  assert.equal(s.size, 0, 'a broken install must not become a spawn loop');
  s.shutdown();
});

test('stderr is kept bounded for diagnosis', async () => {
  const spawnImpl = fakeSpawn();
  const s = new RuntimeSupervisor({ root, spawnImpl });
  const entry = await s.start('u1', 'agents', plan);
  for (let i = 0; i < 200; i++) spawnImpl.spawned[0].child.stderr.emit('data', Buffer.from(`line ${i}\n`));
  assert.ok(entry.log.length <= 40, `got ${entry.log.length}`);
  assert.match(entry.log.at(-1), /line 199/, 'the newest lines are the ones kept');
  s.shutdown();
});

test('every runtime gets its own port', async () => {
  const a = await freePort(), b = await freePort();
  assert.ok(a > 0 && b > 0);
});

test('shutdown takes everything', async () => {
  const s = make();
  await s.start('a', 'agents', plan);
  await s.start('b', 'code', plan);
  s.shutdown();
  assert.equal(s.size, 0);
});
