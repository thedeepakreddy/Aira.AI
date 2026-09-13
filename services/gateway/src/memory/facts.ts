import { memory, trim } from './store.ts';

/**
 * Semantic memory: what is true about this user, rather than what was said.
 *
 * Episodic memory — the existing store — records utterances and retrieves them
 * by recency. That answers "what happened on Tuesday" and is a poor way to
 * answer "who is this and what are they building": every surface re-derives
 * the same handful of durable facts from thirty days of transcript, paying for
 * the derivation each time, and loses them the moment the window rolls past.
 *
 * Facts are distilled from those episodes, deduplicated, and do not expire.
 * They are stored as ordinary memory entries under a reserved surface, so they
 * inherit the isolation, retention override and pause switch already built
 * rather than needing a parallel table and a second set of rules to get wrong.
 */

/** Reserved surface. Never written by a real client — see `isFactSurface`. */
export const FACT_SURFACE = '__facts';

/** A fact is worth keeping only if it stays true past this conversation. */
const EXTRACTION_PROMPT = [
  'From the exchange below, extract durable facts about the user or their work:',
  'what they are building, the tools and versions they use, decisions they have',
  'settled, constraints they are under, and how they prefer to work.',
  '',
  'Rules:',
  '- One fact per line, no bullets, no numbering.',
  '- Only what stays true next week. Skip the question they just asked.',
  '- Skip anything already listed under KNOWN.',
  '- No speculation. If the exchange does not establish it, leave it out.',
  '- At most five lines. Fewer is better. Reply with nothing at all if there',
  '  is nothing durable.',
].join('\n');

/** Guards the reserved surface against a client claiming to be facts. */
export function isFactSurface(surface: string): boolean {
  return surface === FACT_SURFACE;
}

export async function knownFacts(userId: string): Promise<string[]> {
  const entries = await memory().recall(userId, 200);
  return entries.filter((e) => e.surface === FACT_SURFACE).map((e) => e.text);
}

/**
 * Whether two facts say the same thing.
 *
 * Deliberately crude: normalised token overlap, not embeddings. The cost of a
 * false merge is a lost fact, so the threshold is high, and this runs on every
 * extraction where an embedding call would not be affordable.
 */
export function saysTheSame(a: string, b: string): boolean {
  const words = (text: string) => new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
  );
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size) >= 0.8;
}

/** Splits a model's reply into candidate facts, dropping its padding. */
export function parseFacts(reply: string): string[] {
  return reply
    .split('\n')
    .map((line) => trim(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')))
    .filter((line) => line.length > 8 && line.length <= 300)
    // Models like to announce what they are about to do.
    .filter((line) => !/^(here are|the following|based on|i have|no durable|none\b)/i.test(line))
    .slice(0, 5);
}

/**
 * Distils an exchange into facts and stores what is new.
 *
 * Never throws and never blocks the reply it learned from: a failure here
 * costs a little future context, where a failure in the user's request costs
 * them the answer.
 */
export async function learn(
  userId: string | null,
  exchange: string,
  ask: (prompt: string) => Promise<string>,
): Promise<string[]> {
  if (!userId || trim(exchange).length < 40) return [];
  try {
    if (!await memory().enabled(userId)) return [];
    const known = await knownFacts(userId);
    const reply = await ask(
      `${EXTRACTION_PROMPT}\n\nKNOWN:\n${known.slice(-40).join('\n') || '(nothing yet)'}\n\nEXCHANGE:\n${trim(exchange)}`,
    );

    const added: string[] = [];
    for (const fact of parseFacts(reply)) {
      if (known.some((seen) => saysTheSame(seen, fact))) continue;
      if (added.some((seen) => saysTheSame(seen, fact))) continue;
      await memory().remember(userId, {
        at: new Date().toISOString(), surface: FACT_SURFACE, role: 'assistant', text: fact,
      });
      added.push(fact);
    }
    return added;
  } catch (error) {
    console.error('[memory] fact extraction failed:', error);
    return [];
  }
}
