/**
 * Asking a second model, and naming what the two disagree about.
 *
 * The design this started as does not work, and the measurements are worth
 * keeping because they rule out the two obvious implementations.
 *
 * Embedding distance cannot detect disagreement. Cosine similarity over
 * `nomic-embed-text` scored a contradicting pair (0.78) *higher* than an
 * agreeing one (0.74): embeddings measure what an answer is about, and "yes it
 * is thread safe" and "no it is not" are about the same thing in nearly the
 * same words. Any threshold over that signal is noise.
 *
 * Nor can a small model classify it. Asked for AGREE or DIFFER, llama3.1:8b got
 * 5 of 6 with a bias toward DIFFER; a prompt that fixed the false DIFFERs
 * flipped the bias and began calling "retry this request" and "do not retry"
 * agreement — 5 of 8, failing in the direction that hides a real contradiction.
 * A verdict that is wrong in the dangerous direction is worse than no verdict.
 *
 * Describing the difference does work. The same model, asked for one sentence
 * on what the reader has to choose between, produced usable answers for every
 * genuine disagreement tested ("whether to cache the result in Redis or add an
 * index"). Generation is an easier task than classification, and it degrades
 * gracefully: on two answers that agree it writes a distinction without a
 * difference, which a reader dismisses in a second.
 *
 * So this returns both answers and one sentence naming the choice. It does not
 * return a verdict, and the UI must not present one — the reader decides, which
 * is the only party here qualified to.
 */

/** Kept short: this is a sentence, and a long one would not be read. */
const DIFFERENCE_TOKENS = 80;

/**
 * Asks for the choice, not for a judgement.
 *
 * "What would a reader have to decide between" is answerable from the text.
 * "Do these agree" requires the model to hold both positions and compare them,
 * which is where the small ones fall over.
 *
 * Forcing the sentence to start "Whether to" was measured to sharpen it
 * considerably: without it the model compared style ("one is concise, one is
 * detailed"), and with it the same model named the actual crux — "whether to
 * retry depends on whether the operation is idempotent".
 *
 * The cost is that it always names a choice, including when the two answers
 * agree and there is not really one. That is the right trade: both answers are
 * shown side by side, so a soft sentence over two answers the reader can see
 * agree costs a moment, where a missed contradiction costs more. Do not add a
 * verdict back to recover it — the classification was measured unreliable in
 * the dangerous direction.
 */
export const DIFFERENCE_PROMPT = `Two assistants answered the same question.

Compare only their ADVICE — what they tell the reader to do or conclude.
Ignore length, tone, formatting, and how much detail each gives.

In ONE short sentence starting "Whether to", name the choice the reader faces.

A: {a}

B: {b}

Reply:`;

export interface SecondOpinion {
  /** The other model's full answer. */
  answer: string;
  model: string;
  /**
   * One sentence naming the choice, or null when it could not be produced.
   * Null is normal — no local model, or the judge failed — and the caller shows
   * the two answers side by side without it.
   */
  difference: string | null;
}

export interface CompletionFn {
  (model: string, prompt: string, maxTokens: number): Promise<string>;
}

/** Trimmed so a long answer cannot push the other one out of the judge's context. */
export function excerpt(text: string, limit = 4_000): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

/**
 * Names what the two answers make the reader choose between.
 *
 * Returns null rather than throwing: this is the optional half of the feature,
 * and losing the sentence must never lose the second answer it describes.
 */
export async function describeDifference(
  first: string,
  second: string,
  judgeModel: string,
  complete: CompletionFn,
): Promise<string | null> {
  if (!first.trim() || !second.trim()) return null;
  const prompt = DIFFERENCE_PROMPT
    .replace('{a}', excerpt(first))
    .replace('{b}', excerpt(second));
  try {
    const said = (await complete(judgeModel, prompt, DIFFERENCE_TOKENS)).trim();
    if (!said) return null;
    // One sentence. A model that ignores the instruction and writes three gets
    // its first one used rather than the whole paragraph.
    const firstSentence = said.split(/(?<=[.!?])\s/)[0]?.trim() ?? said;
    return firstSentence.length > 240 ? `${firstSentence.slice(0, 240)}…` : firstSentence;
  } catch {
    return null;
  }
}

/**
 * Picks who gives the second opinion.
 *
 * The point is a different perspective, so the rule is simply "not the same
 * provider": two models from one vendor share training and tend to share
 * mistakes, which is the failure this feature exists to catch. Prefers the
 * strongest available tier, since a second opinion from something weaker than
 * the first answer is not worth the wait.
 */
export function pickSecond(
  models: Array<{ id: string; provider: string; tier: string }>,
  firstModel: string,
): string | null {
  const first = models.find((m) => m.id === firstModel);
  const candidates = models.filter((m) => m.id !== firstModel);
  if (!candidates.length) return null;
  const rank = { frontier: 0, balanced: 1, fast: 2 } as Record<string, number>;
  const sorted = [...candidates].sort((a, b) => (rank[a.tier] ?? 3) - (rank[b.tier] ?? 3));
  return (first ? sorted.find((m) => m.provider !== first.provider) : undefined)?.id
    ?? sorted[0].id;
}
