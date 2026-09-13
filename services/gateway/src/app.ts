import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { createAuthMiddleware, type AuthedVars } from './auth.ts';
import type { Env } from './env.ts';
import { memory } from './memory/store.ts';
import { listModels } from './providers/registry.ts';
import type { ChatProvider } from './providers/types.ts';
import { routeModel } from './routing/router.ts';
import { createChatRoute } from './routes/chat.ts';
import { createOpenAIChatRoute, createOpenAIModelsRoute } from './routes/openai.ts';
import { createMemoryRoutes } from './routes/memory.ts';
import { createUsageRoutes } from './routes/usage.ts';
import { createMcpRoutes } from './routes/mcp.ts';
import { requestLimits } from './limits.ts';

/** Importable app factory keeps auth, routes, limits and CORS testable offline. */
export function createApp(env: Env, providers: ChatProvider[]) {
  const app = new Hono<{ Variables: AuthedVars }>();
  app.use('*', cors({
    origin: env.allowedOrigins,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Aira-Memory', 'MCP-Protocol-Version', 'MCP-Session-Id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Retry-After'],
  }));
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !env.allowedOrigins.includes(origin)) return c.json({ error: 'Origin is not allowed.' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body exceeds the 2 MiB limit.' }, 413) }));
  app.onError((error, c) => {
    console.error('[gateway] request failed:', error);
    return c.json({ error: 'The gateway could not complete this request. Please retry.' }, 500);
  });
  app.get('/health', (c) => c.json({
    ok: true, version: '0.1.0', providers: providers.map((provider) => provider.id), models: listModels().length,
    authRequired: env.requireAuth, memory: { enabled: env.memoryEnabled, storage: memory().kind },
    capabilities: { mcp: true, sharedMemory: env.memoryEnabled },
  }));
  app.get('/v1/models', (c) => c.json({
    models: listModels(),
    routing: Object.fromEntries((['chat', 'voice', 'code', 'task'] as const).map((surface) => [surface, routeModel(surface).model])),
  }));
  const auth = createAuthMiddleware(env);
  const limits = requestLimits(env.requestsPerMinute, env.maxConcurrentRequests);
  const secure = new Hono<{ Variables: AuthedVars }>();
  secure.use('*', auth, limits);
  secure.post('/v1/chat', createChatRoute(providers));
  secure.get('/openai/v1/models', createOpenAIModelsRoute());
  secure.post('/openai/v1/chat/completions', createOpenAIChatRoute(providers, 'code'));
  secure.get('/openai/task/v1/models', createOpenAIModelsRoute());
  secure.post('/openai/task/v1/chat/completions', createOpenAIChatRoute(providers, 'task'));
  secure.route('/v1/memory', createMemoryRoutes());
  secure.route('/v1/usage', createUsageRoutes());
  secure.route('/mcp', createMcpRoutes(env.allowedOrigins));
  app.route('/', secure);
  return app;
}
