import type { ProviderId } from './types.ts';

/**
 * Per-million-token prices, used to attach a cost estimate to every usage
 * event. Tokens are the ground truth and are always recorded; `pricing` is
 * optional so an unpriced model still meters correctly rather than silently
 * logging a wrong number.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface ModelSpec {
  id: string;
  /** Human name for the picker. Raw ids read like build artefacts. */
  label: string;
  provider: ProviderId;
  contextWindow: number;
  /** Undefined means "not verified yet" — cost is reported as null downstream. */
  pricing?: ModelPricing;
  /** Rough tiering used by the router. */
  tier: 'frontier' | 'balanced' | 'fast';
}

/**
 * Anthropic prices and ids verified against the Claude API reference
 * (2026-06-24 catalogue). Model ids are complete as written — never append a
 * date suffix.
 */
const ANTHROPIC_MODELS: ModelSpec[] = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    tier: 'frontier',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    tier: 'balanced',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    tier: 'fast',
  },
];

/**
 * Models for OpenAI-compatible providers are declared through env rather than
 * hardcoded, so the catalogue never asserts a model id or price that has not
 * been confirmed against that provider's current pricing.
 *
 *   "id|tier|contextWindow|inPerMTok|outPerMTok, ..."
 *
 * Fields are pipe-separated because model ids routinely contain both slashes
 * and colons (`nvidia/nemotron-3-ultra:free`), so a colon delimiter would split
 * the id itself. Everything after the tier may be omitted: "id|tier".
 */
function parseCompatibleModels(raw: string | undefined, provider: ProviderId): ModelSpec[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, tier, ctx, input, output] = entry.split('|');
      if (!id) throw new Error(`Model catalogue entry missing an id: "${entry}"`);
      // An entry written with the old colon delimiter parses as an id with the
      // tier stuck on the end — "gpt-5-nano:fast" — which the provider then
      // rejects as an unknown model. The catalogue looks right, every request
      // fails, and nothing says why, so it is rejected here instead.
      const TIERS = ['frontier', 'balanced', 'fast'];
      const misdelimited = TIERS.some((t) => id.endsWith(`:${t}`));
      if (misdelimited || (tier !== undefined && !TIERS.includes(tier))) {
        throw new Error(
          `Model catalogue entry "${entry}" is not pipe-separated. ` +
            'Expected id|tier|contextWindow|inPerMTok|outPerMTok, where tier is ' +
            'frontier, balanced or fast — model ids contain colons of their own.',
        );
      }
      const spec: ModelSpec = {
        id,
        label: prettifyModelId(id),
        provider,
        contextWindow: Number(ctx) || 128_000,
        tier: (tier as ModelSpec['tier']) || 'balanced',
      };
      if (input && output) {
        spec.pricing = { inputPerMTok: Number(input), outputPerMTok: Number(output) };
      }
      return spec;
    });
}

/**
 * "gpt-5.1-mini" -> "GPT-5.1 Mini"; "vendor/model-x:free" -> "Model X".
 * Ids are the only name these providers give us.
 */
function prettifyModelId(id: string): string {
  return id
    .split('/')
    .pop()!
    .replace(/:free$/, '')
    .split('-')
    .map((part) =>
      /^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ')
    .replace('GPT ', 'GPT-');
}

let catalogue: ModelSpec[] = ANTHROPIC_MODELS;

export function loadCatalogue(sources: {
  openai?: string;
  openrouter?: string;
}): void {
  catalogue = [
    ...ANTHROPIC_MODELS,
    ...parseCompatibleModels(sources.openai, 'openai'),
    ...parseCompatibleModels(sources.openrouter, 'openrouter'),
  ];
}

export function listModels(): ModelSpec[] {
  return catalogue;
}

export function findModel(id: string): ModelSpec | undefined {
  return catalogue.find((m) => m.id === id);
}

/**
 * Cost in USD, or null when the model has no verified pricing. Cache reads and
 * writes are billed differently from fresh input tokens; until those multipliers
 * are confirmed per provider they are counted at the standard input rate, which
 * over-estimates cache reads rather than under-estimating spend.
 */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number | null {
  const pricing = findModel(model)?.pricing;
  if (!pricing) return null;
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return (
    (billedInput / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}
