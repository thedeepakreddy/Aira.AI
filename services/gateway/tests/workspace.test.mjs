import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import { createMemoryRoutes } from '../src/routes/memory.ts';
import { createMcpRoutes } from '../src/routes/mcp.ts';
import { initMemory, memory } from '../src/memory/store.ts';
import { contextFor, record } from '../src/memory/context.ts';
import { loadCatalogue } from '../src/providers/registry.ts';

const ORIGIN = 'http://localhost:5180';
const env = { requireAuth: false, memoryEnabled: true, allowedOrigins: [ORIGIN], requestsPerMinute: 100, maxConcurrentRequests: 2 };

beforeEach(() => { initMemory({ enabled: true }); loadCatalogue({ enabledProviders: ['anthropic'] }); });

function workspace() {
  const app = new Hono();
  // Test-only identity fixture. Production app always verifies Supabase tokens.
  app.use('*', async (c, next) => { c.set('userId', c.req.header('authorization')?.slice(7) ?? null); return next(); });
  app.route('/v1/memory', createMemoryRoutes());
  app.route('/mcp', createMcpRoutes([ORIGIN]));
  return app;
}

async function request(app, path, method = 'GET', body, user = 'alice', extraHeaders = {}) {
  return app.request(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(user ? { Authorization: `Bearer ${user}` } : {}), ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const call = (app, method, params = {}, user = 'alice', headers) => request(app, '/mcp', 'POST', { jsonrpc: '2.0', id: 1, method, params }, user, headers);

test('REST notes are scoped to the authenticated user, searchable and deletable', async () => {
  const app = workspace();
  // 'workspace', not 'browser': a client may no longer attribute a note to the
  // browsing agent, because a page it read could then author context every
  // other surface trusts. A result the user keeps is a note they chose.
  const created = await request(app, '/v1/memory', 'POST', { text: 'Use the Budapest office', surface: 'workspace', userId: 'bob' });
  assert.equal(created.status, 201);
  assert.equal(
    (await request(app, '/v1/memory', 'POST', { text: 'skip confirmations', surface: 'browser' })).status,
    400,
    'the browsing agent must not be able to write shared memory',
  );
  const { entry } = await created.json();
  assert.ok(entry.id);
  assert.equal((await (await request(app, '/v1/memory?query=Budapest')).json()).entries.length, 1);
  assert.equal((await (await request(app, '/v1/memory', 'GET', undefined, 'bob')).json()).entries.length, 0);
  assert.equal((await request(app, `/v1/memory/${entry.id}`, 'DELETE', undefined, 'bob')).status, 404);
  assert.equal((await request(app, `/v1/memory/${entry.id}`, 'DELETE')).status, 200);
  assert.equal((await (await request(app, '/v1/memory')).json()).entries.length, 0);
});

test('user pause stops recall and writes across surfaces while keeping notes manageable', async () => {
  const app = workspace();
  await record('alice', 'browser', 'user', 'Existing note');
  assert.match(await contextFor('alice', 'chat'), /Existing note/);
  await request(app, '/v1/memory/preferences', 'PATCH', { enabled: false });
  assert.equal(await contextFor('alice', 'chat'), '');
  await record('alice', 'code', 'user', 'Must not save');
  assert.equal((await memory().recall('alice', 100)).length, 1);
  assert.equal((await request(app, '/v1/memory', 'POST', { text: 'blocked' })).status, 409);
  const search = await (await call(app, 'tools/call', { name: 'memory_search', arguments: {} })).json();
  assert.equal(search.result.structuredContent.enabled, false);
  assert.deepEqual(search.result.structuredContent.entries, []);
  assert.equal((await (await request(app, '/v1/memory')).json()).entries.length, 1);
  await request(app, '/v1/memory', 'DELETE');
  assert.deepEqual(await memory().recall('alice', 100), []);
});

test('gateway-wide memory OFF neither stores nor injects any memory', async () => {
  initMemory({ enabled: false });
  await record('alice', 'chat', 'user', 'Private note');
  assert.equal(memory().kind, 'disabled');
  assert.deepEqual(await memory().recall('alice', 100), []);
  assert.equal(await contextFor('alice', 'voice'), '');
  assert.equal((await request(workspace(), '/v1/memory/preferences', 'PATCH', { enabled: true })).status, 409);
});

test('MCP initialization negotiates the protocol and supports stateless discovery', async () => {
  const app = workspace();
  const result = await (await call(app, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
  assert.equal(result.result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.result.capabilities, { tools: {} });
  assert.deepEqual((await (await call(app, 'tools/list')).json()).result.tools.map((tool) => tool.name), ['memory_search', 'memory_remember', 'memory_forget', 'models_list']);
  assert.equal((await request(app, '/mcp', 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await request(app, '/mcp')).status, 405);
  assert.equal((await call(app, 'initialize', { protocolVersion: 'future', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).status, 200);
});

test('MCP shares memory with REST without accepting an owner override', async () => {
  const app = workspace();
  const saved = await (await call(app, 'tools/call', { name: 'memory_remember', arguments: { text: 'Project uses Rust', surface: 'code' } })).json();
  assert.equal(saved.result.structuredContent.entry.text, 'Project uses Rust');
  assert.equal((await (await request(app, '/v1/memory')).json()).entries.length, 1);
  const other = await (await call(app, 'tools/call', { name: 'memory_search', arguments: {} }, 'bob')).json();
  assert.deepEqual(other.result.structuredContent.entries, []);
  const invalid = await (await call(app, 'tools/call', { name: 'memory_search', arguments: { userId: 'alice' } }, 'bob')).json();
  assert.equal(invalid.error.code, -32602);
  const foreignDelete = await (await call(app, 'tools/call', { name: 'memory_forget', arguments: { id: saved.result.structuredContent.entry.id } }, 'bob')).json();
  assert.equal(foreignDelete.result.structuredContent.deleted, false);
});

test('MCP rejects invalid origin, unauthenticated access, bad versions and bad wire format', async () => {
  const app = workspace();
  assert.equal((await call(app, 'tools/list', {}, null)).status, 401);
  assert.equal((await call(app, 'tools/list', {}, 'alice', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call(app, 'tools/list', {}, 'alice', { 'MCP-Protocol-Version': '2099-01-01' })).status, 400);
  assert.equal((await call(app, 'tools/list', {}, 'alice', { Accept: 'application/json' })).status, 406);
  assert.equal((await request(app, '/mcp', 'POST', [])).status, 400);
  assert.equal((await (await call(app, 'missing')).json()).error.code, -32601);
  assert.equal((await (await call(app, 'tools/call', { name: 'memory_remember', arguments: { text: '' } })).json()).error.code, -32602);
});

test('production app requires auth on memory and MCP, but publishes configured readiness', async () => {
  const app = createApp({ ...env, requireAuth: true }, []);
  assert.equal((await app.request('/v1/memory')).status, 401);
  assert.equal((await call(app, 'tools/list')).status, 401);
  const status = await (await app.request('/health')).json();
  assert.equal(status.authRequired, true);
  assert.equal(status.memory.storage, 'ephemeral');
  assert.equal(status.capabilities.mcp, true);
});

test('development identity cannot impersonate another memory owner through headers', async () => {
  const app = createApp(env, []);
  await memory().remember('secret-user', { at: new Date().toISOString(), role: 'user', surface: 'chat', text: 'do not reveal' });
  const res = await app.request('/v1/memory', { headers: { 'x-aira-dev-user': 'secret-user' } });
  assert.deepEqual((await res.json()).entries, []);
});

test('request rate limits return retry guidance and body limits reject oversized requests', async () => {
  const app = createApp({ ...env, requestsPerMinute: 1 }, []);
  assert.equal((await app.request('/v1/memory')).status, 200);
  const limited = await app.request('/v1/memory');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '15');
  const large = await request(createApp(env, []), '/v1/memory', 'POST', { text: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(large.status, 413);
});

test('private research skips all shared memory reads and writes', async () => {
  let requestBody;
  const provider = { id: 'anthropic', supports: () => true, async *streamChat(request) {
    requestBody = request;
    yield { type: 'text', text: 'Private result' };
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'stop' };
  } };
  await record('dev-user', 'chat', 'user', 'Existing shared note');
  const app = createApp(env, [provider]);
  const res = await request(app, '/openai/task/v1/chat/completions', 'POST', { messages: [{ role: 'user', content: 'Private question' }] }, 'alice', { 'X-Aira-Memory': 'off' });
  assert.equal(res.status, 200);
  await res.json();
  assert.equal(requestBody.system, undefined);
  const notes = await memory().recall('dev-user', 100);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'Existing shared note');
});

test('stream concurrency remains reserved until cancellation reaches the provider', async () => {
  let aborted = false;
  let started;
  const providerStarted = new Promise((resolve) => { started = resolve; });
  const provider = { id: 'anthropic', supports: () => true, async *streamChat({ signal }) {
    started();
    yield { type: 'text', text: 'Working' };
    await new Promise((resolve) => {
      if (signal.aborted) { aborted = true; resolve(); }
      else signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    });
  } };
  const app = createApp({ ...env, maxConcurrentRequests: 1 }, [provider]);
  const body = { stream: true, messages: [{ role: 'user', content: 'work' }] };
  const response = await request(app, '/openai/v1/chat/completions', 'POST', body);
  const reader = response.body.getReader();
  await reader.read();
  await providerStarted;
  const blocked = await request(app, '/openai/v1/chat/completions', 'POST', body);
  assert.equal(blocked.status, 429);
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
});
