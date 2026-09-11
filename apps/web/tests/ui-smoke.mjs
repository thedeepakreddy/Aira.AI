import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.AIRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.AIRA_TEST_URL || 'http://127.0.0.1:5191';
const output = resolve('artifacts/ui-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
const models = [{ id: 'test-chat', label: 'Workspace Chat', provider: 'test-provider', tier: 'balanced', contextWindow: 128000 }, { id: 'test-code', label: 'Workspace Code', provider: 'test-provider', tier: 'frontier', contextWindow: 200000 }];
let memories = [{ id: 'memory-1', at: new Date().toISOString(), surface: 'workspace', role: 'user', text: 'Use TypeScript for this project.' }];
let memoryEnabled = true;
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === new URL(base).origin) return route.continue();
  const path = url.pathname;
  let body;
  if (path === '/v1/models') body = { models, routing: { chat: 'test-chat', code: 'test-code', task: 'test-chat', voice: 'test-chat' } };
  else if (path === '/health') body = { ok: true, providers: ['test-provider'], models: 2, authRequired: true, memory: { enabled: true, storage: 'ephemeral' }, capabilities: { mcp: true, sharedMemory: true } };
  else if (path === '/v1/memory/preferences') { if (request.method() === 'PATCH') memoryEnabled = request.postDataJSON().enabled; body = { enabled: memoryEnabled, storage: 'ephemeral' }; }
  else if (path === '/v1/memory' && request.method() === 'GET') body = { enabled: memoryEnabled, storage: 'ephemeral', entries: memories.filter(entry => entry.text.toLowerCase().includes((url.searchParams.get('query') || '').toLowerCase())) };
  else if (path === '/v1/memory' && request.method() === 'POST') { const entry = { id: 'memory-' + Date.now(), at: new Date().toISOString(), role: 'user', ...request.postDataJSON() }; memories.push(entry); body = { entry }; }
  else if (path.startsWith('/v1/memory') && request.method() === 'DELETE') { memories = path === '/v1/memory' ? [] : memories.filter(entry => entry.id !== path.split('/').at(-1)); body = { deleted: true }; }
  else if (url.hostname.includes('supabase')) body = { session: null, user: null };
  else return route.abort(); // No external provider calls or user credentials are used.
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
});
await context.addInitScript(() => {
  const original = window.fetch.bind(window);
  window.__airaRequests = [];
  window.fetch = async (input, init) => {
    if (String(input).endsWith('/v1/chat')) {
      const payload = JSON.parse(init.body);
      window.__airaRequests.push(payload);
      const encoder = new TextEncoder();
      const forceError = payload.messages.at(-1).content.includes('force-error');
      const stream = new ReadableStream({
        start(controller) {
          let closed = false;
          const push = value => { if (!closed) controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')); };
          const close = () => { if (!closed) { closed = true; controller.close(); } };
          init.signal?.addEventListener('abort', close, { once: true });
          push({ type: 'start', model: 'test-chat', provider: 'test-provider' });
          setTimeout(() => push({ type: 'text', text: 'A useful response with **Markdown**.' }), 100);
          setTimeout(() => { push(forceError ? { type: 'error', message: 'Test connection interrupted.', retryable: true } : { type: 'done', usage: {}, stopReason: 'stop' }); close(); }, 1200);
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return original(input, init);
  };
});

try {
  const sizes = process.env.AIRA_SKIP_LAYOUT ? [] : [[1440,1000],[1280,860],[1000,700],[768,700],[390,844],[360,640],[844,390]];
  for (const [width,height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const path of ['/', '/chat', '/cli', '/tasks', '/browse', '/connections', '/login']) {
      await page.goto(base + path);
      await page.locator('.app-header').waitFor();
      const surfaces = { '/': '.home-content', '/chat': '.chat-screen', '/cli': '.agent-workbench', '/tasks': '.task-workbench', '/browse': '.browser-workbench', '/connections': '.connections-page', '/login': '.login-page' };
      await page.locator(surfaces[path]).waitFor();
      await page.waitForTimeout(80);
      const metrics = await page.evaluate(() => {
        const header = document.querySelector('.app-header').getBoundingClientRect();
        const heading = document.querySelector('.cli-heading, .settings-heading');
        return { overflow: document.documentElement.scrollWidth > innerWidth + 1, headerBottom: header.bottom, headingTop: heading?.getBoundingClientRect().top, width: innerWidth };
      });
      assert.equal(metrics.overflow, false, path + ' horizontal overflow at ' + width);
      if (metrics.headingTop !== undefined) assert.ok(metrics.headingTop >= metrics.headerBottom, path + ' heading overlaps navigation at ' + width + 'x' + height + ': ' + JSON.stringify(metrics));
      if (width === 1280 || width === 390) await page.screenshot({ path: resolve(output, (path === '/' ? 'home' : path.slice(1)) + '-' + width + '.png') });
      checks.push('Layout ' + path + ' ' + width + 'x' + height);
    }
    console.log('Layouts passed: ' + width + 'x' + height);
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(base);
  await page.getByRole('button', { name: 'Build something useful', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'context.ts', mimeType: 'text/plain', buffer: Buffer.from('export const attached = 42;') });
  await page.getByText('context.ts', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
  await page.getByText('A useful response with').waitFor();
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Stop response', exact: true }).count(), 0);
  assert.match(await page.evaluate(() => window.__airaRequests[0].messages[0].content), /export const attached = 42/);
  checks.push('Actual attachment content, streaming Markdown, Stop during response');

  await page.getByRole('textbox', { name: 'Ask AI a question', exact: true }).fill('force-error');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Test connection interrupted.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  const sent = await page.evaluate(() => window.__airaRequests.at(-1));
  assert.ok(!sent.messages.some(message => message.content.includes('Test connection interrupted.')));
  checks.push('Failure and retry keep errors out of model history');

  await page.getByRole('button', { name: 'Open workspace navigation' }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const mainNavigation = page.getByRole('navigation', { name: 'Main navigation' });
  await mainNavigation.getByRole('button', { name: 'Browser', exact: true }).click();
  await mainNavigation.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.goBack();
  await page.getByRole('region', { name: 'Browser workspace' }).waitFor();
  await page.goForward();
  await mainNavigation.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByText('Everything, connected.').waitFor();
  checks.push('Navigation, browser Back/Forward, and new chat');

  await page.getByRole('textbox', { name: 'Context to remember' }).fill('Prefer clear release notes.');
  await page.getByRole('button', { name: 'Remember', exact: true }).click();
  await page.getByText('Prefer clear release notes.', { exact: true }).waitFor();
  await page.getByRole('switch', { name: 'Shared memory' }).click();
  await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false');
  await page.getByRole('switch', { name: 'Shared memory' }).click();
  await page.getByRole('button', { name: 'Delete memory: Prefer clear release notes.' }).click();
  await page.getByRole('textbox', { name: 'Search shared memory' }).fill('TypeScript');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('Use TypeScript for this project.', { exact: true }).waitFor();
  checks.push('Memory create, pause/resume, delete, search');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  await writeFile(resolve(output,'results.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, errors, screenshots: output }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output,'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ url: page.url(), errors, body: (await page.locator('body').innerText()).slice(0,5000) }, null, 2));
  throw error;
} finally { await browser.close(); }
