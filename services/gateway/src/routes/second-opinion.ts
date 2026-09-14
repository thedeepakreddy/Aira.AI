import { Hono } from 'hono';
import type { AuthedVars } from '../auth.ts';
import type { ChatProvider, ChatMessage } from '../providers/types.ts';
import { listModels, findModel } from '../providers/registry.ts';
import { describeDifference, pickSecond, type SecondOpinion } from '../routing/second-opinion.ts';

/**
 * A second model on the same question.
 *
 * Deliberately not streamed. A second opinion is read next to the first one,
 * whole, rather than watched arriving — and the sentence naming the difference
 * cannot be written until both answers exist, so there is nothing to show
 * progressively that would not have to be rearranged at the end.
 *
 * The judge is a local model when one is available. That is the whole reason
 * this feature is affordable: the second answer costs what a request costs, and
 * the comparison on top of it costs nothing.
 */
export function createSecondOpinionRoutes(providers: ChatProvider[]) {
  const routes = new Hono<{ Variables: AuthedVars }>();

  /** Runs one model to completion, collecting the text. */
  async function complete(model: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
    const provider = providers.find((p) => p.supports(model));
    if (!provider) throw new Error(`No provider serves ${model}.`);
    let text = '';
    // Attributed to chat: a second opinion is a chat action, and metering it
    // as its own surface would split one conversation's spend across two rows.
    for await (const event of provider.streamChat({ model, messages, maxTokens, surface: 'chat' })) {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'error') throw new Error(event.message);
    }
    return text;
  }

  routes.post('/', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Sign in to ask for a second opinion.' }, 401);

    const body = await c.req.json().catch(() => null) as {
      messages?: ChatMessage[];
      answer?: string;
      model?: string;
      against?: string;
    } | null;

    const messages = body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return c.json({ error: 'messages is required.' }, 400);
    }
    const first = (body?.answer ?? '').trim();
    if (!first) return c.json({ error: 'answer is required — there is nothing to compare against.' }, 400);

    const catalogue = listModels();
    // An explicit choice is honoured if it exists; otherwise pick a different
    // vendor from whoever gave the first answer.
    const against = body?.against && findModel(body.against)
      ? body.against
      : pickSecond(catalogue, body?.model ?? '');
    if (!against) {
      return c.json({ error: 'Only one model is configured, so there is no second opinion to ask for.' }, 409);
    }

    let answer: string;
    try {
      answer = await complete(against, messages, 2_048);
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'The second model could not be reached.',
      }, 502);
    }

    /*
     * A local model writes the comparison when there is one. Falling back to
     * the second model itself would mean asking it to describe the difference
     * between someone else's answer and its own, which is not a neutral seat.
     */
    const judge = catalogue.find((m) => m.provider === 'ollama')?.id;
    const difference = judge
      ? await describeDifference(first, answer, judge, (model, prompt, maxTokens) =>
          complete(model, [{ role: 'user', content: prompt }], maxTokens))
      : null;

    return c.json({ answer, model: against, difference } satisfies SecondOpinion);
  });

  return routes;
}
