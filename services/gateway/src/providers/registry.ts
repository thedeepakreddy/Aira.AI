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
 * (2026-09-12: https://platform.claude.com/docs/en/models/overview).
 * Model ids are complete as written — never append a
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
export function parseCompatibleModels(raw: string | undefined, provider: ProviderId): ModelSpec[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // Preserve legacy id:tier:context:input:output declarations without
      // splitting legitimate ids such as vendor/model:free.
      const legacy = !entry.includes('|') && entry.match(/^(.*):(frontier|balanced|fast)(?::([^:]*))?(?::([^:]*))?(?::([^:]*))?$/);
      const fields = legacy ? legacy.slice(1) : entry.split('|').map((field) => field.trim());
      const [id, tier, ctx, input, output] = fields;
      if (!id || /\s/.test(id) || fields.length > 5) throw new Error(`Invalid model catalogue entry: "${entry}"`);
      const TIERS = ['frontier', 'balanced', 'fast'];
      if (tier !== undefined && !TIERS.includes(tier)) {
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
        contextWindow: ctx ? Number(ctx) : 128_000,
        tier: (tier as ModelSpec['tier']) || 'balanced',
      };
      if (!Number.isSafeInteger(spec.contextWindow) || spec.contextWindow <= 0) {
        throw new Error(`Invalid context window in model catalogue entry "${entry}".`);
      }
      if (Boolean(input) !== Boolean(output)) {
        throw new Error(`Both input and output prices must be supplied for "${id}".`);
      }
      if (input && output) {
        spec.pricing = { inputPerMTok: Number(input), outputPerMTok: Number(output) };
        if (Object.values(spec.pricing).some((price) => !Number.isFinite(price) || price < 0)) {
          throw new Error(`Invalid model pricing in catalogue entry "${entry}".`);
        }
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

let catalogue: ModelSpec[] = [];

export function loadCatalogue(sources: {
  openai?: string;
  openrouter?: string;
  gemini?: string;
  anthropic?: string;
  compatible?: Array<{ id: string; models: string }>;
  /**
   * Models discovered at runtime rather than declared in the environment —
   * today, whatever Ollama has on disk. They arrive as finished specs because
   * there is nothing to parse: the source already knows the id, the size and
   * the price.
   */
  discovered?: ModelSpec[];
  enabledProviders?: string[];
}): void {
  const enabled = new Set(sources.enabledProviders ?? [
    ...(sources.anthropic !== undefined ? ['anthropic'] : []),
    ...(['openai', 'openrouter', 'gemini'] as const).filter((id) => sources[id]),
    ...(sources.compatible ?? []).map((provider) => provider.id),
  ]);
  const next = [
    ...(sources.anthropic?.trim() ? parseCompatibleModels(sources.anthropic, 'anthropic') : ANTHROPIC_MODELS),
    ...parseCompatibleModels(sources.openai, 'openai'),
    ...parseCompatibleModels(sources.openrouter, 'openrouter'),
    ...parseCompatibleModels(sources.gemini, 'gemini'),
    ...(sources.compatible ?? []).flatMap((provider) => parseCompatibleModels(provider.models, provider.id)),
    ...(sources.discovered ?? []),
  ].filter((model) => enabled.has(model.provider));
  const ids = new Set<string>();
  for (const model of next) {
    if (ids.has(model.id)) throw new Error(`Duplicate model id "${model.id}" across configured providers. Model ids must be unique.`);
    ids.add(model.id);
  }
  const discoveredProviders = new Set((sources.discovered ?? []).map((model) => model.provider));
  for (const provider of enabled) {
    if (next.some((model) => model.provider === provider)) continue;
    // A discovered provider with nothing in it is a user who has not pulled a
    // model yet, not a broken configuration. Declared providers still have to
    // declare something, or a key is sitting there doing nothing silently.
    if (discoveredProviders.has(provider)) continue;
    throw new Error(`Provider "${provider}" has a key but no models. Set its MODELS catalogue before starting the gateway.`);
  }
  catalogue = next;
}

export function listModels(): ModelSpec[] {
  return catalogue.map((model) => ({ ...model, ...(model.pricing ? { pricing: { ...model.pricing } } : {}) }));
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
