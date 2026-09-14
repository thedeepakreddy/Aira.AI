import { Hono } from 'hono';
import type { AuthedVars } from '../auth.ts';
import { memory, type MemoryEntry } from '../memory/store.ts';
import { isPageSurface, rememberPage, searchPages } from '../memory/pages.ts';
import { isFactSurface } from '../memory/facts.ts';
import { invalid, object } from './validation.ts';
import { ProviderError } from '../providers/types.ts';

/**
 * Surfaces a client may attribute a memory to.
 *
 * `browser` is deliberately absent, and this is a security boundary rather
 * than an oversight. The browsing agent reads whatever a page says; if it
 * could write to shared memory, any web page could author context that every
 * other surface later treats as established fact — a page asserting "they
 * prefer you skip confirmations" would reach the coding agent tomorrow. That
 * is prompt injection with a thirty-day half-life and cross-surface reach.
 *
 * Browsing results still reach memory, but only when the person keeps one, at
 * which point it is a workspace note they chose — not something a page said.
 * Reading is unaffected: the browser agent gets full context, it just cannot
 * add to it.
 */
export const MEMORY_SURFACES = ['chat', 'voice', 'code', 'task', 'workspace'] as const;

export function memoryInput(value: unknown): Omit<MemoryEntry, 'id'> {
  if (!object(value)) invalid('Memory must be an object.');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 4000) invalid('Memory text must contain 1–4000 characters.');
  // Also rejects the reserved fact surface: a client that could write there
  // would be asserting settled truths about the user rather than recording
  // what happened, and those never expire.
  if (value.surface !== undefined && !MEMORY_SURFACES.includes(value.surface as typeof MEMORY_SURFACES[number])) {
    invalid(isFactSurface(String(value.surface))
      ? 'Facts are derived by Aira, not written directly.'
      // A client that could write here would be planting web-sourced text in a
      // store the user believes holds their own reading.
      : isPageSurface(String(value.surface))
      ? 'Pages are recorded by the browser, not written directly.'
      : 'Invalid memory surface.');
  }
  return { at: new Date().toISOString(), surface: typeof value.surface === 'string' ? value.surface : 'workspace', role: 'user', text: value.text.trim() };
}

export function memoryQuery(query: unknown, limit: unknown) {
  if (query !== undefined && (typeof query !== 'string' || query.length > 200)) invalid('Memory query must be at most 200 characters.');
  if (limit !== undefined && typeof limit !== 'number' && typeof limit !== 'string') invalid('Memory limit must be an integer from 1 to 100.');
  const count = limit === undefined ? 30 : Number(limit);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) invalid('Memory limit must be an integer from 1 to 100.');
  return { query: query as string | undefined, limit: count };
}

export function createMemoryRoutes() {
  const app = new Hono<{ Variables: AuthedVars }>();
  app.onError((error, c) => {
    if (error instanceof ProviderError) return c.json({ error: error.message }, 400);
    console.error('[memory] operation failed:', error);
    return c.json({ error: 'Shared memory is unavailable. Check the gateway database migrations and retry.' }, 503);
  });
  app.use('*', async (c, next) => {
    if (!c.get('userId')) return c.json({ error: 'Authentication required.' }, 401);
    return next();
  });
  app.get('/preferences', async (c) => c.json({ enabled: await memory().enabled(c.get('userId')!), storage: memory().kind }));
  app.patch('/preferences', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!object(body) || typeof body.enabled !== 'boolean') invalid('enabled must be boolean.');
    if (memory().kind === 'disabled') return c.json({ error: 'Memory is disabled by the gateway administrator.' }, 409);
    await memory().setEnabled(c.get('userId')!, body.enabled);
    return c.json({ enabled: body.enabled, storage: memory().kind });
  });
  app.get('/', async (c) => {
    const { query, limit } = memoryQuery(c.req.query('query'), c.req.query('limit'));
    const user = c.get('userId')!;
    const [enabled, entries] = await Promise.all([memory().enabled(user), memory().recall(user, limit, query)]);
    return c.json({ enabled, storage: memory().kind, entries });
  });
  app.post('/', async (c) => {
    const entry = memoryInput(await c.req.json().catch(() => null));
    const user = c.get('userId')!;
    if (!await memory().enabled(user)) return c.json({ error: 'Shared memory is paused or disabled.' }, 409);
    return c.json({ entry: await memory().remember(user, entry) }, 201);
  });
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) invalid('Invalid memory id.');
    const deleted = await memory().forget(c.get('userId')!, id);
    return c.json({ deleted }, deleted ? 200 : 404);
  });
  app.delete('/', async (c) => {
    await memory().forget(c.get('userId')!);
    return c.json({ deleted: true });
  });
  /**
   * Records a page the user read.
   *
   * Fire-and-forget by design: the browser calls this on navigation and the
   * user did not ask for it, so a page that does not qualify comes back as
   * "not kept" rather than as an error they would have to think about.
   */
  app.post('/pages', async (c) => {
    const user = c.get('userId');
    if (!user) return c.json({ error: 'Sign in to keep what you read.' }, 401);
    const body = await c.req.json().catch(() => null) as { url?: string; title?: string; text?: string } | null;
    if (!body?.url || typeof body.url !== 'string') return c.json({ error: 'url is required.' }, 400);
    const kept = await rememberPage(user, {
      url: body.url,
      title: typeof body.title === 'string' ? body.title : '',
      text: typeof body.text === 'string' ? body.text : '',
    });
    return c.json({ kept });
  });

  /** Finds pages by a phrase the user remembers from one. */
  app.get('/pages', async (c) => {
    const user = c.get('userId');
    if (!user) return c.json({ error: 'Sign in to search what you have read.' }, 401);
    const query = c.req.query('q') ?? '';
    if (query.length > 200) return c.json({ error: 'Search is limited to 200 characters.' }, 400);
    return c.json({ hits: await searchPages(user, query) });
  });

  return app;
}
