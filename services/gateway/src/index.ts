import { serve } from '@hono/node-server';
import { loadEnv } from './env.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAICompatibleProvider } from './providers/openai.ts';
import { discoverOllama } from './providers/ollama.ts';
import { initMemory } from './memory/store.ts';
import { loadCatalogue } from './providers/registry.ts';
import { validateRoutes } from './routing/router.ts';
import type { ChatProvider } from './providers/types.ts';
import { createApp } from './app.ts';
import { RuntimeSupervisor } from './runtimes/supervisor.ts';

const env = loadEnv();

// Cross-surface memory. Supabase when it is configured, an in-process ring
// otherwise — the gateway says which at boot, because "memory works" and
// "memory survives a restart" are different promises.
const memoryStore = initMemory({
  supabaseUrl: env.supabaseUrl,
  supabaseServiceKey: env.supabaseServiceKey,
  enabled: env.memoryEnabled,
});

/*
 * Asked, not assumed.
 *
 * A Supabase URL and key with no schema behind them produced a gateway that
 * reported `storage: supabase` on /health and only admitted otherwise after
 * something tried to use it and failed. Anyone checking a fresh deploy saw
 * durable memory that was not there. One query at boot costs a round trip and
 * makes the health endpoint mean something.
 */
const storage = await memoryStore.verify();
if (storage === 'ephemeral' && env.supabaseUrl) {
  console.error('[memory] Memory will not survive a restart. Run `npm run migrate` in services/gateway.');
}

const providers: ChatProvider[] = [];
if (env.anthropicApiKey) {
  providers.push(new AnthropicProvider(env.anthropicApiKey));
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

for (const config of env.compatibleProviders) providers.push(new OpenAICompatibleProvider(config));

/*
 * Local models, if any.
 *
 * Probed rather than declared, and awaited before the catalogue is built so the
 * first request already sees them. The probe is short and fails closed: not
 * having Ollama is the ordinary case and must not delay or break a boot.
 *
 * The adapter is the plain OpenAI-compatible one, because that is exactly what
 * Ollama serves at /v1. The api key is a placeholder it ignores — the field is
 * required by the adapter, not by the server.
 */
const localModels = env.ollamaUrl ? await discoverOllama(env.ollamaUrl) : [];
if (localModels.length) {
  providers.push(new OpenAICompatibleProvider({
    id: 'ollama',
    apiKey: 'local',
    baseURL: `${env.ollamaUrl.replace(/\/+$/, '')}/v1`,
  }));
}

loadCatalogue({
  anthropic: env.anthropicModels, openai: env.openaiModels, openrouter: env.openrouterModels,
  gemini: env.geminiModels, compatible: env.compatibleProviders, discovered: localModels,
  enabledProviders: providers.map((provider) => provider.id),
});
validateRoutes();
/*
 * One supervisor for every hosted runtime.
 *
 * Owned here rather than inside the app so shutdown can reach it: these are
 * real child processes, and a gateway that exits without stopping them leaves
 * them running with nothing to reap them.
 */
const runtimes = new RuntimeSupervisor({
  maxTotal: Number(process.env.AIRA_MAX_RUNTIMES ?? 8),
  idleMs: Number(process.env.AIRA_RUNTIME_IDLE_MS ?? 15 * 60_000),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { runtimes.shutdown(); process.exit(0); });
}

const app = createApp(env, providers, runtimes);

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.error(
    `[gateway] listening on :${info.port} — providers: ${
      providers.map((p) => p.id).join(', ') || 'none'
    } — auth: ${env.requireAuth ? 'required' : 'DISABLED (dev)'} — memory: ${
      env.memoryEnabled ? memoryStore.kind : 'off'
    }`,
  );
});

// Stop accepting requests first, then allow active streams a short drain period.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
