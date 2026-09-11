import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.AIRA_TEST_URL || 'http://127.0.0.1:5191';
const output = resolve('artifacts/agent-ui-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(12_000);
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));

// An isolated test account and an in-memory native bridge. No real credentials,
// filesystem tools, agents, or paid providers are contacted by this test.
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === new URL(base).origin) {
    if (url.pathname === '/src/lib/supabase.ts') return route.fulfill({ contentType: 'application/javascript', body: `
      const session = {access_token:'test-token',user:{id:'test-agent-user',email:'test@example.invalid'}};
      export const supabase=null, isAuthConfigured=true;
      export async function getAccessToken(){return session.access_token}
      export async function getSession(){return session}
      export function onAuthChange(handler){queueMicrotask(()=>handler(session));return()=>{}}
      export async function signIn(){return null}
      export async function signUp(){return null}
      export async function signOut(){}
    ` });
    return route.continue();
  }
  if (url.pathname === '/v1/models') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [{ id: 'test-code', label: 'Test code model', provider: 'local-test', tier: 'frontier', contextWindow: 128000 }], routing: { code: 'test-code', task: 'test-code', chat: 'test-code' } }), headers: { 'Access-Control-Allow-Origin': '*' } });
  return route.abort();
});

await context.addInitScript(() => {
  const state = window.__agentTest = {
    codeRunning: false, clawRunning: false, directory: '/tmp/aira-ui-project', model: 'test-code',
    session: 'session-test', history: [], permissions: [], questions: [], codeBusy: false,
    firstPermissionFails: true, firstQuestionFails: true, calls: [], controllers: new Set(), callbacks: {}, listeners: {}, nextID: 1,
    clawPending: new Map(), clawLong: false,
  };
  const codeStatus = () => ({ running: state.codeRunning, port: state.codeRunning ? 19443 : null, password: state.codeRunning ? 'test' : null, binary: '/test/opencode', directory: state.directory, model: state.model });
  const clawStatus = () => ({ running: state.clawRunning, port: state.clawRunning ? 19444 : null, token: state.clawRunning ? 'test' : null, binary: '/test/openclaw', model: state.model });
  state.emit = (type, properties) => {
    for (const controller of state.controllers) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
  };
  const emitNative = (event, payload) => {
    const callbackID = state.listeners[event];
    if (callbackID) state.callbacks[callbackID]?.({ event, id: callbackID, payload });
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = state.nextID++; state.callbacks[id] = callback; return id; },
    unregisterCallback(id) { delete state.callbacks[id]; },
    async invoke(command, args = {}) {
      state.calls.push({ command, args });
      if (command === 'opencode_status') return codeStatus();
      if (command === 'openclaw_status') return clawStatus();
      if (command === 'opencode_start') { state.codeRunning = true; state.directory = args.directory; state.model = args.model; return codeStatus(); }
      if (command === 'openclaw_start') { state.clawRunning = true; state.model = args.model; return clawStatus(); }
      if (command === 'opencode_stop') { state.codeRunning = false; return; }
      if (command === 'openclaw_stop' || command === 'openclaw_cancel') {
        state.clawRunning = false;
        for (const reject of state.clawPending.values()) reject(new Error('Runtime stopped'));
        state.clawPending.clear(); return;
      }
      if (command === 'opencode_log' || command === 'openclaw_log') return [];
      if (command === 'plugin:dialog|open') return state.directory;
      if (command === 'plugin:event|listen') { state.listeners[args.event] = args.handler; return args.handler; }
      if (command === 'plugin:event|unlisten') { delete state.listeners[args.event]; return; }
      if (command === 'openclaw_agents') return [{ id: 'openclaw/main', name: 'main' }, { id: 'openclaw/reviewer', name: 'reviewer' }];
      if (command === 'openclaw_stream') {
        return new Promise((resolve, reject) => {
          state.clawPending.set(args.run, reject);
          setTimeout(() => emitNative(`openclaw://delta/${args.run}`, '**Complete output**\n\n'), 30);
          setTimeout(() => emitNative(`openclaw://delta/${args.run}`, 'This is a full response with a visible final sentence, beyond the old truncated preview.'), 80);
          if (!state.clawLong) setTimeout(() => { state.clawPending.delete(args.run); resolve(); }, 250);
        });
      }
      if (command === 'browser_status') return { running: false, port: null, token: null, chrome: null, binary: null };
      throw new Error(`Unexpected native command: ${command}`);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };

  const original = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.href);
    if (url.port !== '19443') return original(input, init);
    const path = url.pathname;
    const json = value => Response.json(value);
    if (path === '/global/health') return json({ healthy: true, version: '1.18.30' });
    if (path === '/event') {
      let current;
      return new Response(new ReadableStream({
        start(controller) {
          current = controller; state.controllers.add(controller);
          init.signal?.addEventListener('abort', () => { if (state.controllers.delete(controller)) controller.close(); }, { once: true });
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'));
        }, cancel() { state.controllers.delete(current); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path === '/session' && init.method === 'POST') return json({ id: state.session, directory: state.directory });
    if (path === '/session') return json([{ id: state.session, directory: state.directory, time: { updated: 1 } }]);
    if (path === '/session/status') return json({ [state.session]: { type: state.codeBusy ? 'busy' : 'idle' } });
    if (path === '/permission') return json(state.permissions);
    if (path === '/question') return json(state.questions);
    if (path.endsWith('/message')) return json(state.history);
    if (path.endsWith('/prompt_async')) {
      const text = JSON.parse(init.body).parts[0].text;
      state.history.push({ info: { role: 'user' }, parts: [{ type: 'text', text }] });
      state.codeBusy = true;
      const request = { id: 'permission-1', sessionID: state.session, permission: 'edit', patterns: ['src/main.ts'] };
      state.permissions = [request];
      queueMicrotask(() => { state.emit('session.status', { sessionID: state.session, status: { type: 'busy' } }); state.emit('permission.asked', request); });
      return new Response(null, { status: 204 });
    }
    if (path.includes('/permission/') && path.endsWith('/reply')) {
      if (state.firstPermissionFails) { state.firstPermissionFails = false; return new Response('Temporary delivery failure', { status: 503 }); }
      state.permissions = [];
      state.emit('permission.replied', { sessionID: state.session, requestID: 'permission-1', reply: JSON.parse(init.body).reply });
      const question = { id: 'question-1', sessionID: state.session, questions: [{ header: 'Approach', question: 'Which approach should I use?', options: [{ label: 'Focused fix', description: 'Keep the change small' }, { label: 'Refactor', description: 'Restructure the module' }], custom: true }] };
      state.questions = [question];
      state.emit('question.asked', question);
      return json(true);
    }
    if (path.includes('/question/') && path.endsWith('/reply')) {
      if (state.firstQuestionFails) { state.firstQuestionFails = false; return new Response('Temporary answer failure', { status: 503 }); }
      state.questions = [];
      const answers = JSON.parse(init.body).answers;
      state.emit('question.replied', { sessionID: state.session, requestID: 'question-1', answers });
      state.emit('message.part.delta', { sessionID: state.session, messageID: 'message-2', partID: 'part-2', field: 'text', delta: 'The **focused fix** is ready.' });
      state.history.push({ info: { role: 'assistant' }, parts: [{ id: 'part-2', type: 'text', text: 'The **focused fix** is ready.' }] });
      state.codeBusy = false;
      setTimeout(() => state.emit('session.idle', { sessionID: state.session }), 50);
      return json(true);
    }
    if (path.endsWith('/abort')) { state.codeBusy = false; state.permissions = []; state.questions = []; return json(true); }
    throw new Error(`Unexpected coding endpoint: ${path}`);
  };
});

try {
  await page.goto(base + '/cli');
  await page.getByRole('button', { name: 'Choose project' }).click();
  await page.getByRole('button', { name: 'Connect coding agent', exact: true }).click();
  await page.locator('.agent-workbench .workbench-status').filter({ hasText: 'Ready' }).waitFor();
  await page.getByRole('textbox', { name: 'Task for coding agent' }).fill('Fix the example issue');
  await page.getByRole('button', { name: 'Send task', exact: true }).click();
  await page.getByText('Approve edit', { exact: true }).waitFor();
  await page.evaluate(() => window.__agentTest.emit('message.part.delta', { sessionID: 'another-project', partID: 'private', field: 'text', delta: 'SHOULD NEVER APPEAR' }));
  assert.equal(await page.getByText('SHOULD NEVER APPEAR').count(), 0);
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your response was not delivered' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByText('Which approach should I use?', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Focused fix Keep the change small' }).click();
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your response was not delivered' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send answer', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.locator('.code-message.assistant').filter({ hasText: 'The focused fix is ready.' }).waitFor();
  await page.locator('.agent-workbench .workbench-status').filter({ hasText: 'Ready' }).waitFor();
  checks.push('Coding session startup, model/project, streaming, session isolation, failed permission/answer retry, completion');
  await page.screenshot({ path: resolve(output, 'coding-completed.png') });

  await page.getByRole('textbox', { name: 'Task for coding agent' }).fill('A second task');
  await page.getByRole('button', { name: 'Send task', exact: true }).click();
  await page.getByText('Approve edit', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await page.getByText('Task stopped. You can continue in this conversation.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__agentTest.history.filter(message => message.info.role === 'user').length), 2, 'Stop must not submit another prompt');
  checks.push('Coding Stop sends abort, clears pending prompts, and keeps conversation available');

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'Connect agents', exact: true }).click();
  await page.locator('.task-workbench .workbench-status').filter({ hasText: 'Ready' }).waitFor();
  assert.equal(await page.getByRole('checkbox').count(), 2);
  await page.getByRole('textbox', { name: 'Task for selected agents' }).fill('Prepare a plan');
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await page.getByText('This is a full response with a visible final sentence, beyond the old truncated preview.', { exact: true }).waitFor();
  await page.getByText('Complete', { exact: true }).waitFor();
  const started = await page.evaluate(() => window.__agentTest.calls.filter(call => call.command === 'openclaw_stream'));
  assert.equal(started.length, 1);
  assert.equal(started[0].args.agent, 'openclaw/main');
  await page.screenshot({ path: resolve(output, 'agents-completed.png') });
  checks.push('Task agent selection, full Markdown output, actual completion, no implicit broadcast to all agents');

  await page.evaluate(() => { window.__agentTest.clawLong = true; });
  await page.getByRole('textbox', { name: 'Task for selected agents' }).fill('A longer task');
  await page.getByRole('button', { name: 'Run task', exact: true }).click();
  await page.locator('.task-workbench').getByRole('button', { name: 'Stop task', exact: true }).click();
  await page.getByText('Task runtime stopped. Your output is preserved. Connect to continue.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect agents', exact: true }).isEnabled(), true);
  assert.equal(await page.getByText('Stopped', { exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => window.__agentTest.calls.filter(call => call.command === 'openclaw_stream').length), 2, 'Stop must not dispatch a new run');
  checks.push('Task Stop shuts down native runtime, marks task Stopped and provides reconnect');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
} finally { await browser.close(); }
