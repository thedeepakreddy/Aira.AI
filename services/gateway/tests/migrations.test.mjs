/**
 * The schema file the runner applies must match the schema files people edit.
 *
 * ALL.sql was maintained by hand and had already drifted from its parts. It is
 * the file `npm run migrate` sends to the database, so a stale copy means the
 * migration that runs is not the migration that was reviewed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, parts } from '../scripts/build-migrations.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

test('ALL.sql is up to date with the numbered migrations', () => {
  const onDisk = readFileSync(join(dir, 'ALL.sql'), 'utf8');
  assert.equal(onDisk, build(), 'run `npm run migrations:build` — ALL.sql has drifted from its parts');
});

test('every migration is in ALL.sql', () => {
  const all = readFileSync(join(dir, 'ALL.sql'), 'utf8');
  for (const name of parts()) {
    assert.ok(all.includes(name), `${name} is missing from ALL.sql`);
  }
  assert.ok(parts().length >= 3, 'the three memory migrations must be found');
});

test('every table the gateway queries is created by the schema', () => {
  // The store names these; the schema has to build them, or memory degrades to
  // local with no other symptom.
  const all = readFileSync(join(dir, 'ALL.sql'), 'utf8');
  const store = readFileSync(join(dir, '..', 'src', 'memory', 'store.ts'), 'utf8');
  const queried = new Set([...store.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]));
  assert.ok(queried.size >= 2, 'expected the store to name its tables');
  for (const table of queried) {
    assert.match(all, new RegExp(`create table if not exists public\\.${table}\\b`), `${table} is queried but never created`);
  }
});

test('re-running the schema is safe', () => {
  // The runner may be run twice; a bare `create table` would fail the second
  // time and leave the migration half applied.
  const all = readFileSync(join(dir, 'ALL.sql'), 'utf8');
  const creates = [...all.matchAll(/^create (table|index)([^\n]*)/gim)];
  assert.ok(creates.length > 0);
  for (const [line] of creates) {
    assert.match(line, /if not exists/i, `not idempotent: ${line.trim()}`);
  }
});

test('row-level security is on for every table', () => {
  // These hold one user's conversations and are reachable with the anon key if
  // RLS is ever left off.
  const all = readFileSync(join(dir, 'ALL.sql'), 'utf8');
  const created = [...all.matchAll(/create table if not exists public\.([a-z_]+)/g)].map((m) => m[1]);
  for (const table of created) {
    assert.match(all, new RegExp(`alter table public\\.${table} enable row level security`), `${table} has no RLS`);
  }
});
