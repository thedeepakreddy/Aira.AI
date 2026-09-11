/** Run with AIRA_BROWSER_PYTHON pointing at the installed browser-use environment. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import { initMemory, memory } from '../src/memory/store.ts';
import { record } from '../src/memory/context.ts';
import { loadCatalogue } from '../src/providers/registry.ts';

const executable = process.env.AIRA_BROWSER_PYTHON;
assert.ok(executable, 'Set AIRA_BROWSER_PYTHON to your browser-use virtual environment Python executable.');
initMemory({ enabled: true });
await record('dev-user', 'workspace', 'user', 'Existing shared note must stay private.');
loadCatalogue({ compatible: [{ id: 'fixture', models: 'aira-offline-model|balanced' }], enabledProviders: ['fixture'] });
let received;
const provider = {
  id: 'fixture', supports: (model) => model === 'aira-offline-model',
  async *streamChat(request) {
    received = request;
    yield { type: 'text', text: '{"done":true,"summary":"AIRA_BROWSER_CLIENT_PASSED"}' };
    yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};
const app = createApp({ requireAuth: false, memoryEnabled: true, allowedOrigins: [], requestsPerMinute: 100, maxConcurrentRequests: 4 }, [provider]);
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((resolve) => server.once('listening', resolve));
try {
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(executable, [fileURLToPath(new URL('./browser-client.fixture.py', import.meta.url)), baseURL], {
    env: { PATH: process.env.PATH, ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_LOGGING_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
  const exitCode = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timeout);
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /AIRA_BROWSER_CLIENT_PASSED/);
  assert.equal(received.messages[0].contentParts[1].type, 'image');
  assert.equal(received.responseFormat.type, 'json_schema');
  assert.equal(received.responseFormat.json_schema.strict, true);
  assert.equal(received.frequencyPenalty, undefined);
  assert.equal(received.maxTokens, 4096);
  assert.equal(received.system, undefined);
  assert.equal((await memory().recall('dev-user', 100)).length, 1);
  process.stdout.write(JSON.stringify({ ok: true, screenshotPreserved: true, schemaParsed: true, privateMemory: true }) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
