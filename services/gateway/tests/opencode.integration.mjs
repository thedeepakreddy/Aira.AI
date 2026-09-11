/** Optional real-client check. No provider credentials or paid model calls.
 * Run: node --experimental-strip-types tests/opencode.integration.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.ts';
import { initMemory } from '../src/memory/store.ts';
import { record } from '../src/memory/context.ts';
import { loadCatalogue } from '../src/providers/registry.ts';
import { addEventSink } from '../src/usage/events.ts';

const fixture = await mkdtemp(join(tmpdir(), 'aira-opencode-contract-'));
for (const directory of ['config', 'data', 'cache', 'state', 'project']) await mkdir(join(fixture, directory));
initMemory({ enabled: true });
await record('dev-user', 'workspace', 'user', 'Offline contract test note.');
loadCatalogue({ compatible: [{ id: 'fixture', models: 'aira-offline-model|frontier' }], enabledProviders: ['fixture'] });
let modelRequests = 0;
let memoryToolCalls = 0;
addEventSink((event) => { if (event.kind === 'agent_action' && event.payload.tool === 'memory_search' && event.payload.ok) memoryToolCalls++; });
const provider = {
  id: 'fixture', supports: (model) => model === 'aira-offline-model',
  async *streamChat(request) {
    modelRequests++;
    const tool = request.tools?.find((entry) => entry.name.includes('memory_search'));
    yield { type: 'start', model: request.model, provider: 'fixture' };
    const calling = tool && !request.messages.some((message) => message.role === 'tool');
    if (calling) yield { type: 'tool_call', call: { id: `call_${modelRequests}`, name: tool.name, arguments: '{"query":"Offline"}' } };
    else yield { type: 'text', text: 'AIRA_OFFLINE_CLIENT_PASSED: Shared memory returned the test note.' };
    yield { type: 'done', stopReason: calling ? 'tool_calls' : 'stop', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};
const app = createApp({ requireAuth: false, memoryEnabled: true, allowedOrigins: [], requestsPerMinute: 200, maxConcurrentRequests: 8 }, [provider]);
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((resolve) => server.once('listening', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const config = {
  autoupdate: false, share: 'disabled', enabled_providers: ['aira'],
  provider: { aira: { npm: '@ai-sdk/openai-compatible', name: 'Aira offline fixture', options: { baseURL: `${baseURL}/openai/v1`, apiKey: 'offline-fixture' }, models: { 'aira-offline-model': { name: 'Offline fixture' } } } },
  model: 'aira/aira-offline-model', small_model: 'aira/aira-offline-model',
  mcp: { aira_memory: { type: 'remote', url: `${baseURL}/mcp`, headers: { Authorization: 'Bearer offline-fixture' }, oauth: false } },
  permission: { '*': 'deny', 'aira_memory_memory_search': 'allow', 'aira_memory*': 'allow' },
};
try {
  const child = spawn('opencode', ['run', '--pure', '--format', 'json', '--model', 'aira/aira-offline-model', 'Use aira_memory memory_search to look up Offline, then report the result.'], {
    cwd: join(fixture, 'project'),
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir(), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'data'), XDG_CACHE_HOME: join(fixture, 'cache'), XDG_STATE_HOME: join(fixture, 'state'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: 'true', OTEL_SDK_DISABLED: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60_000);
  const exitCode = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timeout);
  assert.equal(exitCode, 0, stderr.slice(-4000));
  assert.ok(modelRequests >= 2, `Expected a tool round-trip; got ${modelRequests} model requests. ${stdout.slice(-4000)} ${stderr.slice(-2000)}`);
  assert.ok(memoryToolCalls >= 1, `OpenCode did not execute MCP memory_search. ${stdout.slice(-4000)} ${stderr.slice(-2000)}`);
  assert.match(stdout, /AIRA_OFFLINE_CLIENT_PASSED/);
  process.stdout.write(JSON.stringify({ ok: true, modelRequests, memoryToolCalls, fixture }) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
