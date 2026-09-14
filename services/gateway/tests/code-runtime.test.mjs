import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneable, writeStarter, seedWorkspace, buildConfig } from '../src/runtimes/code.ts';

test('only public https repositories may be cloned', () => {
  assert.ok(cloneable('https://github.com/user/repo.git'));
  // An ssh remote would need the server's key — one key for every user.
  assert.ok(!cloneable('git@github.com:user/repo.git'));
  // A path or file:// would let a request read the server's own disk.
  assert.ok(!cloneable('file:///etc/passwd'));
  assert.ok(!cloneable('/etc/passwd'));
  assert.ok(!cloneable('http://github.com/user/repo'), 'plaintext is refused too');
});

test('credentials in a URL are refused', () => {
  // They would be written into the workspace's git config and live as long as
  // the workspace does.
  assert.ok(!cloneable('https://user:token@github.com/user/repo.git'));
});

test('a workspace with no repository gets a starter, not an empty directory', async () => {
  // An empty directory is one the agent "fixes" by inventing a project.
  const dir = mkdtempSync(join(tmpdir(), 'aira-code-'));
  const project = await seedWorkspace(dir);
  assert.ok(existsSync(join(project, 'README.md')));
  assert.ok(existsSync(join(project, 'index.html')));
});

test('the starter says the workspace is disposable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aira-code-'));
  const project = await seedWorkspace(dir);
  const readme = readFileSync(join(project, 'README.md'), 'utf8');
  assert.match(readme, /committed and pushed/, 'someone must not discover this the hard way');
  assert.match(readme, /not on your machine/);
});

test('an unusable repository is refused before anything is spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aira-code-'));
  await assert.rejects(() => seedWorkspace(dir, 'git@github.com:x/y.git'), /public https/i);
});

test('seeding twice keeps the existing project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aira-code-'));
  const first = await seedWorkspace(dir);
  writeStarter(first);
  const again = await seedWorkspace(dir, 'https://github.com/some/repo.git');
  assert.equal(again, first, 'a restart must not re-clone over existing work');
});

test('the approval model does not relax when hosted', () => {
  // A hosted agent is not more trusted for being further away.
  const config = JSON.parse(buildConfig({ gatewayUrl: 'https://x', token: 't', model: 'm', catalogue: [] }));
  assert.equal(config.permission.edit, 'ask');
  assert.equal(config.permission.bash, 'ask');
  assert.equal(config.permission.read, 'allow');
});

test('reaching outside the project is denied, not asked', () => {
  // On a laptop the rest of the disk is the user's own; here it is other people's.
  const config = JSON.parse(buildConfig({ gatewayUrl: 'https://x', token: 't', model: 'm', catalogue: [] }));
  assert.equal(config.permission.external_directory, 'deny');
  assert.equal(config.permission.webfetch, 'deny');
});

test('every catalogue model is declared, so a route change strands no session', () => {
  const config = JSON.parse(buildConfig({
    gatewayUrl: 'https://x', token: 't', model: 'a', catalogue: ['a', 'b', 'c'],
  }));
  assert.deepEqual(Object.keys(config.provider.aira.models), ['a', 'b', 'c']);
  assert.equal(config.model, 'aira/a');
});
