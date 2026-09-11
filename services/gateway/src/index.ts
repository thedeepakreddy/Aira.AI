import { serve } from '@hono/node-server';
import { loadEnv } from './env.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAICompatibleProvider } from './providers/openai.ts';
import { initMemory } from './memory/store.ts';
import { loadCatalogue } from './providers/registry.ts';
import { validateRoutes } from './routing/router.ts';
import type { ChatProvider } from './providers/types.ts';
import { createApp } from './app.ts';

const env = loadEnv();

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
loadCatalogue({
  anthropic: env.anthropicModels, openai: env.openaiModels, openrouter: env.openrouterModels,
  gemini: env.geminiModels, compatible: env.compatibleProviders, enabledProviders: providers.map((provider) => provider.id),
});
validateRoutes();
const app = createApp(env, providers);

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
