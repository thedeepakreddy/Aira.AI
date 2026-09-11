import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuthMiddleware, type AuthedVars } from './auth.ts';
import { loadEnv } from './env.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAICompatibleProvider } from './providers/openai.ts';
import { initMemory } from './memory/store.ts';
import { listModels, loadCatalogue } from './providers/registry.ts';
import { routeModel } from './routing/router.ts';
import type { ChatProvider } from './providers/types.ts';
import { createChatRoute } from './routes/chat.ts';
import { createOpenAIChatRoute, createOpenAIModelsRoute } from './routes/openai.ts';

const env = loadEnv();
loadCatalogue({
  openai: env.openaiModels,
  openrouter: env.openrouterModels,
  gemini: env.geminiModels,
});

// Cross-surface memory. Supabase when it is configured, an in-process ring
// otherwise — the gateway says which at boot, because "memory works" and
// "memory survives a restart" are different promises.
const memoryStore = initMemory({
  supabaseUrl: env.supabaseUrl,
  supabaseServiceKey: env.supabaseServiceKey,
  enabled: env.memoryEnabled,
});

const providers: ChatProvider[] = [];
if (env.anthropicApiKey) {
  providers.push(new AnthropicProvider(env.anthropicApiKey, env.anthropicFallbacks));
}
if (env.openaiApiKey) {
  providers.push(new OpenAICompatibleProvider({ id: 'openai', apiKey: env.openaiApiKey }));
}
if (env.openrouterApiKey) {
  providers.push(
    new OpenAICompatibleProvider({
      id: 'openrouter',
      apiKey: env.openrouterApiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      // OpenRouter uses these for attribution in its dashboards.
      headers: { 'HTTP-Referer': 'https://askdeepak.ai', 'X-Title': 'Aira' },
    }),
  );
}

if (env.geminiApiKey) {
  providers.push(
    new OpenAICompatibleProvider({
      id: 'gemini',
      apiKey: env.geminiApiKey,
      // Google mirrors the OpenAI wire format at this path, so Gemini needs no
      // adapter of its own — only a base URL. The trailing segment matters:
      // the SDK appends /chat/completions to whatever it is given.
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }),
  );
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

/**
 * Catalogue for the model picker, plus what each surface currently routes to.
 *
 * Publishing the routing matters for callers that must name a model rather than
 * a surface — the agent panel has to hand OpenCode a concrete model id, and
 * without this it would have to guess, pick a different model than the gateway
 * would have, and silently bypass the routing rules.
 *
 * Deliberately unauthenticated: it is the same information a public pricing
 * page carries, and requiring a session would leave the picker an empty, dead
 * control on the signed-out screen.
 */
app.get('/v1/models', (c) =>
  c.json({
    models: listModels(),
    routing: {
      chat: routeModel('chat').model,
      voice: routeModel('voice').model,
      code: routeModel('code').model,
      task: routeModel('task').model,
    },
  }),
);

app.post('/v1/chat', auth, createChatRoute(providers));

/**
 * OpenAI-compatible surface for tools that only speak that protocol (OpenCode).
 * Kept off /v1 so it cannot collide with Aira's own model catalogue shape.
 */
app.get('/openai/v1/models', auth, createOpenAIModelsRoute());
app.post('/openai/v1/chat/completions', auth, createOpenAIChatRoute(providers, 'code'));

/**
 * The same protocol, mounted per surface.
 *
 * Which surface is calling has to come from the path, not a header: an agent
 * configures this gateway by base URL alone, and not every client lets you add
 * headers to a provider. Without it both agents route to the `code` model and
 * their spend is indistinguishable in the usage log.
 */
app.get('/openai/task/v1/models', auth, createOpenAIModelsRoute());
app.post('/openai/task/v1/chat/completions', auth, createOpenAIChatRoute(providers, 'task'));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.error(
    `[gateway] listening on :${info.port} — providers: ${
      providers.map((p) => p.id).join(', ') || 'none'
    } — auth: ${env.requireAuth ? 'required' : 'DISABLED (dev)'} — memory: ${
      env.memoryEnabled ? memoryStore.kind : 'off'
    }`,
  );
});
