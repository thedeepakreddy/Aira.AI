import { findModel, listModels } from '../providers/registry.ts';
import type { Surface } from '../providers/types.ts';

/**
 * Surface-based model routing.
 *
 * Routing happens per surface, never per turn. Prompt caches are scoped to a
 * model, so switching models inside a conversation throws away the cached
 * prefix and re-bills the whole history at full price — often costing more than
 * not routing at all. Separate surfaces are separate conversations with separate
 * caches, so choosing per surface is free.
 *
 * To trade cost against quality *within* a surface, vary effort on one model
 * rather than swapping models.
 */
const DEFAULT_TIERS: Record<Surface, 'frontier' | 'balanced' | 'fast'> = {
  // Coding agents justify the strongest model; errors are expensive.
  code: 'frontier',
  // Voice is latency-bound, not intelligence-bound. A slow brilliant answer is
  // a worse experience than a fast good one.
  voice: 'fast',
  chat: 'balanced',
  task: 'balanced',
};

const ENV_KEYS: Record<Surface, string> = {
  chat: 'AIRA_ROUTE_CHAT',
  voice: 'AIRA_ROUTE_VOICE',
  code: 'AIRA_ROUTE_CODE',
  task: 'AIRA_ROUTE_TASK',
};

export interface RouteDecision {
  model: string;
  reason: 'explicit' | 'env-override' | 'tier-default';
}

/**
 * Resolves a surface to a concrete model. An explicit choice from the UI always
 * wins — routing should never silently override what a user picked.
 */
export function routeModel(surface: Surface, explicitModel?: string): RouteDecision {
  if (explicitModel) return { model: explicitModel, reason: 'explicit' };

  const override = process.env[ENV_KEYS[surface]]?.trim();
  if (override) return { model: override, reason: 'env-override' };

  const tier = DEFAULT_TIERS[surface];
  const match = listModels().find((m) => m.tier === tier) ?? listModels()[0];
  if (!match) throw new Error('No models are configured in the catalogue.');
  return { model: match.id, reason: 'tier-default' };
}

/** Deployment mistakes fail at boot, before any client can spend a request. */
export function validateRoutes(): void {
  for (const [surface, key] of Object.entries(ENV_KEYS)) {
    const model = process.env[key]?.trim();
    if (model && !findModel(model)) throw new Error(`${key} names unavailable model "${model}" for ${surface}.`);
  }
  if (!listModels().length) throw new Error('No models are configured in the catalogue.');
}
