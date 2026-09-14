/**
 * Reaching a different provider when one is unreachable.
 *
 * Five providers are configured and, until now, one of them failing took a
 * surface down with it — models from the other four sitting idle while chat
 * returned an error. That is the wrong shape for a gateway whose whole job is
 * standing between the app and a set of vendors.
 *
 * THE CASE THAT MOTIVATES IT, and the one worth stating because the retry logic
 * deliberately does the opposite: an **account** fault — no credit, a rejected
 * key, a suspended organisation — is the one failure retrying can never fix,
 * and precisely the one a different vendor answers immediately. So the retry
 * declines to repeat an account failure and this one treats it as the strongest
 * possible reason to move on.
 *
 * What it will not do:
 *
 * **Fall back after anything has been sent.** Same rule as the retry. Once a
 * token is out the answer is partly delivered, and starting again elsewhere
 * appends a second answer to the first.
 *
 * **Fall back on the user's own mistake.** A prompt over the context window, a
 * malformed request, a refusal — every provider will say the same thing, and
 * trying four of them turns one clear error into four slow ones.
 *
 * **Cross a tier.** A frontier question answered by a fast model is not a
 * rescue, it is a quiet downgrade the user never agreed to. Falling back within
 * the tier keeps the promise the tier made.
 */

import type { Fault } from '../providers/types.ts';
import type { ModelSpec } from '../providers/registry.ts';

/** How many vendors to try in total, including the first. */
export const MAX_PROVIDERS = 3;

/**
 * Whether this failure is worth asking someone else about.
 *
 * `account` and `provider` faults are about the vendor. A `gateway` fault is
 * about us, and a different vendor will not help.
 */
export function worthFallingBack(fault: Fault | undefined, emitted: boolean, attempted: number): boolean {
  if (emitted) return false;
  if (attempted >= MAX_PROVIDERS) return false;
  return fault === 'account' || fault === 'provider';
}

/**
 * The next model to try: same tier, a vendor not yet attempted.
 *
 * Ordered by the catalogue, which is provider order, so the fallback sequence
 * is predictable rather than whichever vendor happens to be listed first in a
 * set. Returns null when the tier is exhausted, and the caller reports the
 * original failure rather than inventing a new one.
 */
export function nextModel(
  catalogue: ModelSpec[],
  tier: string,
  tried: string[],
): ModelSpec | null {
  const triedProviders = new Set(
    tried.flatMap((id) => {
      const spec = catalogue.find((model) => model.id === id);
      return spec ? [spec.provider] : [];
    }),
  );
  return catalogue.find((model) =>
    model.tier === tier
    && !tried.includes(model.id)
    && !triedProviders.has(model.provider)) ?? null;
}

/**
 * What to tell the user when every vendor in the tier has failed.
 *
 * Names what was tried. "Aira could not reach a model" invites the question
 * this answers, and a user who can see that three vendors were asked knows the
 * problem is not their connection.
 */
export function exhaustedMessage(tried: string[], lastError: string): string {
  if (tried.length <= 1) return lastError;
  return `${lastError} Aira also tried ${tried.length - 1} other provider${tried.length === 2 ? '' : 's'} without success.`;
}
