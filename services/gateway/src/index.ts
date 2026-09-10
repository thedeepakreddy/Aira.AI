import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuthMiddleware, type AuthedVars } from './auth.ts';
import { loadEnv } from './env.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAIProvider } from './providers/openai.ts';
import { listModels, loadCatalogue } from './providers/registry.ts';
import type { ChatProvider } from './providers/types.ts';
import { createChatRoute } from './routes/chat.ts';

const env = loadEnv();
loadCatalogue(env.openaiModels);

const providers: ChatProvider[] = [];
if (env.anthropicApiKey) {
  providers.push(new AnthropicProvider(env.anthropicApiKey, env.anthropicFallbacks));
}
if (env.openaiApiKey) {
  providers.push(new OpenAIProvider(env.openaiApiKey));
}

const app = new Hono<{ Variables: AuthedVars }>();

app.use(
  '*',
  cors({
    origin: env.allowedOrigins,
    allowHeaders: ['Content-Type', 'Authorization', 'x-aira-dev-user'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

app.get('/health', (c) =>
  c.json({
    ok: true,
    providers: providers.map((p) => p.id),
    models: listModels().length,
    authRequired: env.requireAuth,
  }),
);

const auth = createAuthMiddleware(env);

/** Catalogue for the model picker. Prices are included so the UI can show them. */
app.get('/v1/models', auth, (c) => c.json({ models: listModels() }));

app.post('/v1/chat', auth, createChatRoute(providers));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.error(
    `[gateway] listening on :${info.port} — providers: ${
      providers.map((p) => p.id).join(', ') || 'none'
    } — auth: ${env.requireAuth ? 'required' : 'DISABLED (dev)'}`,
  );
});
