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
    provider: 'anthropic',
    contextWindow: 1_000_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    tier: 'frontier',
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    tier: 'balanced',
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    contextWindow: 200_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    tier: 'fast',
  },
];

/**
 * OpenAI models are declared through OPENAI_MODELS rather than hardcoded, so
 * the catalogue never asserts a model id or price that has not been confirmed
 * against OpenAI's current pricing page. Format:
 *   OPENAI_MODELS="id:tier:ctx:inPerMTok:outPerMTok,..."
 * Price fields may be omitted: "id:tier:ctx".
 */
function parseOpenAIModels(raw: string | undefined): ModelSpec[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, tier, ctx, input, output] = entry.split(':');
      if (!id) throw new Error(`OPENAI_MODELS entry missing an id: "${entry}"`);
      const spec: ModelSpec = {
        id,
        provider: 'openai',
        contextWindow: Number(ctx) || 128_000,
        tier: (tier as ModelSpec['tier']) || 'balanced',
      };
      if (input && output) {
        spec.pricing = { inputPerMTok: Number(input), outputPerMTok: Number(output) };
      }
      return spec;
    });
}

let catalogue: ModelSpec[] = ANTHROPIC_MODELS;

export function loadCatalogue(openAIModels: string | undefined): void {
  catalogue = [...ANTHROPIC_MODELS, ...parseOpenAIModels(openAIModels)];
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
