import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthedVars } from '../auth.ts';
import { faultAdvice } from '../providers/fault.ts';
import { estimateCostUsd, findModel } from '../providers/registry.ts';
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type Surface,
  type TokenUsage,
} from '../providers/types.ts';
import { routeModel } from '../routing/router.ts';
import { routeIntent } from '../routing/orchestrator.ts';
import { browseTools } from '../tools/browse.ts';
import { contextFor, record, withContext } from '../memory/context.ts';
import { learn } from '../memory/facts.ts';
import { emit, type ModelRequestPayload } from '../usage/events.ts';
import { invalid, object, parseToolCalls, tokenLimit, validateConversation } from './validation.ts';

const SURFACES: Surface[] = ['chat', 'voice', 'code', 'task'];

interface ChatBody {
  messages?: unknown;
  canBrowse?: unknown;
  system?: unknown;
  surface?: unknown;
  model?: unknown;
  conversationId?: unknown;
  maxTokens?: unknown;
}

function parseBody(body: ChatBody): {
  messages: ChatMessage[];
  system?: string;
  surface: Surface;
  model?: string;
  conversationId: string | null;
  maxTokens?: number;
  canBrowse: boolean;
} {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ProviderError('`messages` must be a non-empty array.', false, 400);
  }
  const messages = body.messages.map((m: unknown, i: number) => {
    const msg = m as Partial<ChatMessage>;
    if (
      !msg ||
      !['user', 'assistant', 'tool'].includes(msg.role ?? '') ||
      typeof msg.content !== 'string'
    ) {
      throw new ProviderError(`messages[${i}] needs a user, assistant or tool role and string content.`, false, 400);
    }
    return { role: msg.role!, content: msg.content, ...(msg.role === 'assistant' && msg.toolCalls ? { toolCalls: parseToolCalls(msg.toolCalls, false) } : {}), ...(msg.role === 'tool' ? { toolCallId: msg.toolCallId } : {}) };
  });
  validateConversation(messages);
  if (body.surface !== undefined && !SURFACES.includes(body.surface as Surface)) invalid('Unknown surface.');
  if (body.canBrowse !== undefined && typeof body.canBrowse !== 'boolean') invalid('canBrowse must be boolean.');
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) invalid('model must be a non-empty string.');
  if (body.system !== undefined && typeof body.system !== 'string') invalid('system must be text.');

  const surface = SURFACES.includes(body.surface as Surface) ? (body.surface as Surface) : 'chat';

  return {
    messages,
    system: typeof body.system === 'string' ? body.system : undefined,
    surface,
    model: typeof body.model === 'string' && body.model !== 'auto' ? body.model : undefined,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
    maxTokens: tokenLimit(body.maxTokens),
    // Declared by the caller, because only the caller knows whether it has a
    // browsing agent to run the tool with.
    canBrowse: body.canBrowse === true,
  };
}

export function createChatRoute(providers: ChatProvider[]) {
  return async (c: Context<{ Variables: AuthedVars }>) => {
    let parsed: ReturnType<typeof parseBody>;
    try {
      const body = await c.req.json();
      if (!object(body)) invalid('The request body must be an object.');
      parsed = parseBody(body);
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : 'Malformed request body.';
      return c.json({ error: message }, 400);
    }

    const decision = routeModel(parsed.surface, parsed.model);
    const spec = findModel(decision.model);
    if (!spec) {
      return c.json({ error: `Unknown model "${decision.model}".` }, 400);
    }

    const provider = providers.find((p) => p.supports(decision.model));
    if (!provider) {
      return c.json({ error: `No provider configured for "${decision.model}".` }, 503);
    }

    const userId = c.get('userId');
    const startedAt = Date.now();

    // What this user has been doing on Aira's other surfaces. Fetched before
    // the stream opens, because once SSE has started there is no way to change
    // the request that was sent.
    const useMemory = c.req.header('x-aira-memory')?.toLowerCase() !== 'off';
    const asked = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // What the turn is about decides how the model is briefed, not which model
    // answers: the surface router owns that, and changing model mid
    // conversation would discard the prompt cache. Rules only here — no
    // classifier call — so this costs nothing per turn.
    const capability = await routeIntent(asked);
    const offered = browseTools(parsed.canBrowse);
    /*
     * The instruction only goes in when the tool it describes went in too.
     *
     * The search profile tells the model to consult the web and cite each
     * source. A caller with no browser gets an empty tool list, and a model
     * told to search with nothing to search with does not decline — it
     * announces a search it did not perform and invents the citations, which
     * is worse than the stale answer the instruction was meant to prevent.
     */
    const equipped = capability.tools.every((name) => offered.some((tool) => tool.name === name));
    const system = withContext(
      equipped && capability.system ? `${capability.system}\n\n${parsed.system ?? ''}`.trim() : parsed.system,
      useMemory ? await contextFor(userId, parsed.surface) : '',
    );

    return streamSSE(c, async (sse) => {
      // Propagates client disconnect down to the provider so an abandoned
      // stream stops being billed the moment the user navigates away.
      const abort = new AbortController();
      sse.onAbort(() => abort.abort());
      const signal = AbortSignal.any([abort.signal, c.req.raw.signal, AbortSignal.timeout(300_000)]);

      let usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let stopReason: string | null = null;
      let ok = false;
      let failure: string | null = null;
      let answered = '';

      try {
        for await (const event of provider.streamChat({
          ...parsed,
          system,
          tools: offered,
          model: decision.model,
          signal,
        })) {
          if (event.type === 'text') answered += event.text;
          if (event.type === 'done') {
            usage = event.usage;
            stopReason = event.stopReason;
            ok = true;
          }
          if (event.type === 'error') {
            failure = event.message;
            ok = false;
          }
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        if (!ok && !failure) throw new ProviderError('The model stream ended before completing. Please retry.', true, 502);
      } catch (error) {
        const pe =
          error instanceof ProviderError
            ? error
            : new ProviderError('Something went wrong reaching the model. Please try again.', false);
        // The user sees a clean message; the raw vendor text stays in the log.
        failure = pe.raw ?? pe.message;
        ok = false;
        console.error(`[gateway] ${provider.id}/${decision.model} failed:`, failure);
        if (!signal.aborted) await sse.writeSSE({
          event: 'error',
          data: JSON.stringify({
            type: 'error',
            message: pe.message,
            retryable: pe.retryable,
            // Whose problem it is, so the client can offer the right next step
            // instead of apologising for a billing failure it cannot fix.
            fault: pe.fault,
            advice: faultAdvice(pe.fault),
          }),
        });
      } finally {
        const payload: ModelRequestPayload = {
          provider: provider.id,
          model: decision.model,
          routedBy: decision.reason,
          intent: capability.intent,
          intentReason: capability.reason,
          ...usage,
          costUsd: estimateCostUsd(decision.model, usage),
          durationMs: Date.now() - startedAt,
          stopReason,
          ok,
          error: failure,
        };
        // Distil what was said into durable facts, after the reply has been
        // delivered and off the request's critical path. On the cheapest
        // configured model, because extraction is a summarising job and paying
        // frontier prices for it on every exchange would double the bill for
        // the least demanding call Aira makes.
        if (useMemory && ok && answered) {
          void learn(userId, `User: ${asked}\nAira: ${answered}`, async (prompt) => {
            const cheap = routeModel('voice').model;
            const helper = providers.find((p) => p.supports(cheap));
            if (!helper) return '';
            let out = '';
            for await (const event of helper.streamChat({
              messages: [{ role: 'user', content: prompt }],
              model: cheap, surface: 'chat', maxTokens: 300,
            })) {
              if (event.type === 'text') out += event.text;
            }
            return out;
          });
        }

        await emit({
          kind: 'model_request',
          at: new Date().toISOString(),
          userId,
          conversationId: parsed.conversationId,
          surface: parsed.surface,
          payload,
        });
        // Only a turn that actually completed is worth remembering; a failed
        // request would otherwise leave the question in memory with no answer.
        if (ok && useMemory) {
          await record(userId, parsed.surface, 'user', asked);
          await record(userId, parsed.surface, 'assistant', answered);
        }
      }
    });
  };
}
