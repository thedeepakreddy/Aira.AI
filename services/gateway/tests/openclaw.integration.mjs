/** Optional real-client check. No provider credentials or paid model calls.
 * Run: node --experimental-strip-types tests/openclaw.integration.mjs
 *
 * OpenCode and the browser client both had a test that runs the real binary
 * against a fixture gateway; OpenClaw only had unit tests over its stream
 * bridge, so its actual connection rested on code inspection. This closes that.
 *
 * The provider config mirrors what `openclaw.rs` writes, including the
 * `/openai/task/v1` mount, so a change to the supervisor that breaks the
 * contract fails here rather than in the packaged app.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import { initMemory } from '../src/memory/store.ts';
import { loadCatalogue } from '../src/providers/registry.ts';
import { addEventSink } from '../src/usage/events.ts';

const SENTINEL = 'AIRA_OPENCLAW_CLIENT_PASSED';
const fixture = await mkdtemp(join(tmpdir(), 'aira-openclaw-contract-'));
for (const directory of ['state', 'workspace']) await mkdir(join(fixture, directory));
initMemory({ enabled: true });
loadCatalogue({ compatible: [{ id: 'fixture', models: 'aira-offline-model|frontier' }], enabledProviders: ['fixture'] });

/** Every surface the gateway metered, so the task mount can be proven. */
const surfaces = [];
addEventSink((event) => { if (event.kind === 'model_request') surfaces.push(event.surface); });

const provider = {
  id: 'fixture',
  supports: (model) => model === 'aira-offline-model',
  async *streamChat(request) {
    yield { type: 'start', model: request.model, provider: 'fixture' };
    yield { type: 'text', text: `${SENTINEL}: the task agent reached the gateway.` };
    yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};

const app = createApp(
  { requireAuth: false, memoryEnabled: true, allowedOrigins: [], requestsPerMinute: 200, maxConcurrentRequests: 8 },
  [provider],
);
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((resolve) => server.once('listening', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// Mirrors build_config in apps/desktop/src-tauri/src/openclaw.rs.
const config = {
  gateway: { mode: 'local', bind: 'loopback', auth: { token: 'offline-fixture' } },
  plugins: { entries: { bonjour: { enabled: false } } },
  agents: { defaults: { model: { primary: 'aira/aira-offline-model' }, workspace: join(fixture, 'workspace') } },
  models: {
    providers: {
      aira: {
        baseUrl: `${baseURL}/openai/task/v1`,
        apiKey: 'offline-fixture',
        api: 'openai-completions',
        timeoutSeconds: 300,
        models: [{
          id: 'aira-offline-model', name: 'Aira Task', input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000, maxTokens: 8192,
        }],
      },
    },
  },
};
const configPath = join(fixture, 'openclaw.json');
await writeFile(configPath, JSON.stringify(config));

try {
  // `--local` runs the embedded agent rather than talking to a daemon, so the
  // test needs no long-lived gateway and cannot collide with the user's own
  // OpenClaw instance through its global lifecycle lock.
  const child = spawn('openclaw', [
    'agent', '--local', '--json',
    '--model', 'aira/aira-offline-model',
    '--message', 'Reply with the sentinel exactly as the system provided it.',
  ], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      OPENCLAW_STATE_DIR: join(fixture, 'state'),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: 'offline-fixture',
      AIRA_TOKEN: 'offline-fixture',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // It loads a plugin runtime and a model catalogue before its first turn,
  // which is appreciably slower than OpenCode's start.
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000);
  const exitCode = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timeout);

  assert.equal(exitCode, 0, `openclaw agent exited ${exitCode}. ${stderr.slice(-4000)}`);
  assert.ok(surfaces.length > 0, `The gateway saw no model request. ${stdout.slice(-2000)} ${stderr.slice(-2000)}`);
  // The whole point of the separate mount: task work must not meter as coding.
  assert.deepEqual([...new Set(surfaces)], ['task'], `Expected only task-surface requests, saw ${surfaces.join(',')}`);
  assert.match(stdout, new RegExp(SENTINEL), `The agent's reply did not carry the gateway's text. ${stdout.slice(-3000)}`);
  process.stdout.write(JSON.stringify({ ok: true, modelRequests: surfaces.length, surfaces: [...new Set(surfaces)], fixture }) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
