/**
 * Environment configuration.
 *
 * Provider API keys live here and only here. They are read server-side and are
 * never returned to a client — the whole point of the gateway is that a browser
 * bundle or a packaged desktop app never contains a vendor key.
 */
export interface Env {
  port: number;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  openaiModels: string | undefined;
  openrouterApiKey: string | undefined;
  openrouterModels: string | undefined;
  anthropicFallbacks: boolean;
  supabaseUrl: string | undefined;
  supabaseServiceKey: string | undefined;
  requireAuth: boolean;
  allowedOrigins: string[];
}

/**
 * Origins the packaged desktop shell serves from. Tauri uses a custom protocol
 * on macOS and Linux and a virtual host on Windows; both are fixed properties
 * of the framework, not of a deployment. They are always allowed because the
 * alternative is a failure that never appears in dev — the browser at
 * localhost:5180 works fine while the bundled .app is silently blocked by CORS.
 */
const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value !== 'false' && value !== '0';
}

export function loadEnv(): Env {
  const env: Env = {
    port: Number(process.env.PORT) || 8787,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModels: process.env.OPENAI_MODELS,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    openrouterModels: process.env.OPENROUTER_MODELS,
    anthropicFallbacks: bool(process.env.ANTHROPIC_ENABLE_FALLBACKS, true),
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // Defaults to on: a paid product must not ship with auth accidentally off.
    requireAuth: bool(process.env.AIRA_REQUIRE_AUTH, true),
    allowedOrigins: [
      ...new Set([
        ...(process.env.AIRA_ALLOWED_ORIGINS ?? 'http://localhost:5180')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
        ...DESKTOP_ORIGINS,
      ]),
    ],
  };

  if (!env.anthropicApiKey && !env.openaiApiKey && !env.openrouterApiKey) {
    throw new Error(
      'No provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY and/or ' +
        'OPENROUTER_API_KEY in services/gateway/.env',
    );
  }
  if (env.requireAuth && (!env.supabaseUrl || !env.supabaseServiceKey)) {
    throw new Error(
      'AIRA_REQUIRE_AUTH is on but Supabase is not configured. Set SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY, or set AIRA_REQUIRE_AUTH=false for local testing.',
    );
  }
  return env;
}
