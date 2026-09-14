/**
 * Local models, discovered rather than configured.
 *
 * Every other provider here is declared: a key in the environment and a
 * hand-written catalogue naming each model and its price. That works when the
 * list changes about once a quarter and someone is paid to notice.
 *
 * Ollama is not like that. Its catalogue is whatever the user has pulled, it
 * changes the moment they pull another one, there is no key, and there is no
 * price — so a declared list would be stale the first time they run
 * `ollama pull` and would sit there claiming models that are no longer on the
 * disk. It gets asked instead.
 *
 * The whole module degrades to an empty list. Ollama not being installed is the
 * normal case, not a fault, and must never keep the gateway from starting.
 */

import type { ModelSpec } from './registry.ts';

/** Ollama's default. Overridable for a remote or non-standard install. */
export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

/** Short, because this runs at boot and a hung probe would delay every start. */
const PROBE_TIMEOUT_MS = 1_500;

interface OllamaTag {
  name?: string;
  model?: string;
  size?: number;
  details?: { parameter_size?: string; family?: string };
}

/**
 * Parameter count in billions, from Ollama's own label.
 *
 * The label is a display string ("7.6B", "137M"), not a number, so it is parsed
 * rather than read. An unparseable one returns null and the caller falls back
 * to file size, which is never absent.
 */
export function parseParams(label: string | undefined): number | null {
  if (!label) return null;
  const match = /^([\d.]+)\s*([BM])$/i.exec(label.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return match[2].toUpperCase() === 'M' ? value / 1000 : value;
}

/**
 * Which tier a local model belongs in.
 *
 * The thresholds are about felt speed on a laptop rather than benchmark
 * quality: under about 5B answers fast enough to sit behind a voice surface,
 * 5-25B is the usable working range, and above that a machine is thinking hard
 * enough that the user notices. Tier already means "how much does this cost
 * you" everywhere else in the catalogue; locally the currency is seconds.
 */
export function tierFor(params: number | null, bytes: number | undefined): ModelSpec['tier'] {
  const billions = params ?? (bytes ? bytes / 6e8 : 0);
  if (billions >= 25) return 'frontier';
  if (billions >= 5) return 'balanced';
  return 'fast';
}

/**
 * Embedding models are not chat models.
 *
 * They answer on a different endpoint and would fail every completion sent to
 * them, so listing one in a model picker is offering the user a broken choice.
 * Matched by name because Ollama's tag list does not say which is which.
 */
export function isEmbedding(name: string): boolean {
  return /embed|bge-|e5-|gte-|minilm/i.test(name);
}

/** "qwen2.5-coder:7b" → "Qwen2.5 Coder 7B", so the picker reads like the others. */
export function labelFor(name: string): string {
  const [base, tag] = name.split(':');
  const words = base
    .split(/[-_]/)
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
  // A ":latest" tag carries no information a person needs.
  return tag && tag !== 'latest' ? `${words} ${tag.toUpperCase()}` : words;
}

/**
 * Asks Ollama what it has.
 *
 * Returns an empty array for every failure — not installed, not running, a
 * different service on the port, a malformed answer. None of those are worth
 * failing a boot over, and all of them mean the same thing to the caller.
 */
export async function discoverOllama(
  baseUrl: string = OLLAMA_DEFAULT_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelSpec[]> {
  const root = baseUrl.replace(/\/+$/, '');
  let tags: OllamaTag[];
  try {
    const response = await fetchImpl(`${root}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: unknown };
    if (!Array.isArray(body?.models)) return [];
    tags = body.models as OllamaTag[];
  } catch {
    return [];
  }

  const specs: ModelSpec[] = [];
  for (const tag of tags) {
    const name = (tag.name ?? tag.model ?? '').trim();
    if (!name || isEmbedding(name)) continue;
    const params = parseParams(tag.details?.parameter_size);
    specs.push({
      id: name,
      label: labelFor(name),
      provider: 'ollama',
      // Ollama does not report a context window per model, and guessing one
      // would be worse than the router's own default. 8k is the floor every
      // model Ollama ships meets, so it under-promises rather than over.
      contextWindow: 8_192,
      // Not "unknown" — genuinely zero. This is the one provider where a price
      // of nothing is a fact rather than a missing verification, and the usage
      // meter should say $0.00 with confidence rather than showing a floor.
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      tier: tierFor(params, tag.size),
    });
  }
  // Stable order so the picker does not reshuffle between restarts.
  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

/** The embedding models, which the chat catalogue excludes but memory wants. */
export async function discoverEmbeddings(
  baseUrl: string = OLLAMA_DEFAULT_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const root = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetchImpl(`${root}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: OllamaTag[] };
    return (body.models ?? [])
      .map((tag) => (tag.name ?? tag.model ?? '').trim())
      .filter((name) => name && isEmbedding(name))
      .sort();
  } catch {
    return [];
  }
}
