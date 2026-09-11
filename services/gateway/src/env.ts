/**
 * Environment configuration.
 *
 * Provider API keys live here and only here. They are read server-side and are
 * never returned to a client — the whole point of the gateway is that a browser
 * bundle or a packaged desktop app never contains a vendor key.
 */
export interface Env {
  port: number;
  host: string;
  anthropicApiKey: string | undefined;
  anthropicModels: string | undefined;
  openaiApiKey: string | undefined;
  openaiModels: string | undefined;
  openrouterApiKey: string | undefined;
  openrouterModels: string | undefined;
  geminiApiKey: string | undefined;
  geminiModels: string | undefined;
  supabaseUrl: string | undefined;
  supabaseServiceKey: string | undefined;
  requireAuth: boolean;
  memoryEnabled: boolean;
  allowedOrigins: string[];
  compatibleProviders: Array<{ id: string; apiKey: string; baseURL: string; models: string; maxTokensField?: 'max_tokens' | 'max_completion_tokens' }>;
  maxConcurrentRequests: number;
  requestsPerMinute: number;
}

/**
 * Origins the packaged desktop shell serves from. Tauri uses a custom protocol
 * on macOS and Linux and a virtual host on Windows; both are fixed properties
 * of the framework, not of a deployment. They are always allowed because the
 * alternative is a failure that never appears in dev — the browser at
 * localhost:5180 works fine while the bundled .app is silently blocked by CORS.
 */
const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (['true', '1'].includes(value.toLowerCase())) return true;
  if (['false', '0'].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean environment value "${value}". Use true or false.`);
}

function positiveInt(name: string, fallback: number, maximum: number): number {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}

function compatibleProviders(): Env['compatibleProviders'] {
  const raw = process.env.AIRA_COMPATIBLE_PROVIDERS;
  if (!raw?.trim()) return [];
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error('AIRA_COMPATIBLE_PROVIDERS must be a JSON array.'); }
  if (!Array.isArray(entries)) throw new Error('AIRA_COMPATIBLE_PROVIDERS must be a JSON array.');
  const ids = new Set(['anthropic', 'openai', 'openrouter', 'gemini']);
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Compatible providers need a unique lowercase id.');
    ids.add(entry.id);
    const url = new URL(entry.baseURL);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error(`Provider ${entry.id} requires an HTTPS baseURL (HTTP is allowed only on loopback).`);
    const apiKey = typeof entry.apiKeyEnv === 'string' ? process.env[entry.apiKeyEnv]?.trim() : undefined;
    if (!apiKey || typeof entry.models !== 'string' || !entry.models.trim()) throw new Error(`Provider ${entry.id} requires apiKeyEnv pointing to a nonempty environment variable and a models catalogue.`);
    if (entry.maxTokensField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(entry.maxTokensField)) throw new Error(`Invalid maxTokensField for ${entry.id}.`);
    return { id: entry.id, apiKey, baseURL: url.toString().replace(/\/$/, ''), models: entry.models, maxTokensField: entry.maxTokensField };
  });
}

export function loadEnv(): Env {
  const env: Env = {
    port: positiveInt('PORT', 8787, 65535),
    host: process.env.AIRA_HOST ?? (bool(process.env.AIRA_REQUIRE_AUTH, true) ? '0.0.0.0' : '127.0.0.1'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    anthropicModels: process.env.ANTHROPIC_MODELS,
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    openaiModels: process.env.OPENAI_MODELS,
    openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    openrouterModels: process.env.OPENROUTER_MODELS,
    // GOOGLE_API_KEY is accepted too; it is the name Google's own tooling uses.
    geminiApiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim() || undefined,
    geminiModels: process.env.GEMINI_MODELS,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    // Defaults to on: a paid product must not ship with auth accidentally off.
    requireAuth: bool(process.env.AIRA_REQUIRE_AUTH, true),
    // On by default: the surfaces are meant to feel like one assistant, and a
    // memory layer nobody turns on is a memory layer nobody has.
    memoryEnabled: bool(process.env.AIRA_MEMORY, true),
    compatibleProviders: compatibleProviders(),
    maxConcurrentRequests: positiveInt('AIRA_MAX_CONCURRENT_REQUESTS', 4, 100),
    requestsPerMinute: positiveInt('AIRA_REQUESTS_PER_MINUTE', 120, 10000),
    allowedOrigins: [
      ...new Set([
        ...(process.env.AIRA_ALLOWED_ORIGINS ?? 'http://localhost:5180,http://127.0.0.1:5180')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
        ...DESKTOP_ORIGINS,
      ]),
    ],
  };

  if (!env.anthropicApiKey && !env.openaiApiKey && !env.openrouterApiKey && !env.geminiApiKey && !env.compatibleProviders.length) {
    throw new Error(
      'No provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
        'OPENROUTER_API_KEY and/or GEMINI_API_KEY in services/gateway/.env',
    );
  }
  if (!env.requireAuth && !['localhost', '127.0.0.1', '::1'].includes(env.host)) throw new Error('Development authentication can only bind to loopback. Enable AIRA_REQUIRE_AUTH before exposing the gateway.');
  if (env.requireAuth && (!env.supabaseUrl || !env.supabaseServiceKey)) {
    throw new Error(
      'AIRA_REQUIRE_AUTH is on but Supabase is not configured. Set SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY, or set AIRA_REQUIRE_AUTH=false for local testing.',
    );
  }
  return env;
}
