import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthedVars } from '../auth.ts';
import { estimateCostUsd, findModel } from '../providers/registry.ts';
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type Surface,
  type TokenUsage,
} from '../providers/types.ts';
import { routeModel } from '../routing/router.ts';
import { emit, type ModelRequestPayload } from '../usage/events.ts';

const SURFACES: Surface[] = ['chat', 'voice', 'code', 'task'];

interface ChatBody {
  messages?: unknown;
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
} {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ProviderError('`messages` must be a non-empty array.', false, 400);
  }
  const messages = body.messages.map((m: unknown, i: number) => {
    const msg = m as Partial<ChatMessage>;
    if (
      !msg ||
      (msg.role !== 'user' && msg.role !== 'assistant') ||
      typeof msg.content !== 'string'
    ) {
      throw new ProviderError(`messages[${i}] must be {role:'user'|'assistant', content:string}.`, false, 400);
    }
    return { role: msg.role, content: msg.content };
  });

  const surface = SURFACES.includes(body.surface as Surface) ? (body.surface as Surface) : 'chat';

  return {
    messages,
    system: typeof body.system === 'string' ? body.system : undefined,
    surface,
    model: typeof body.model === 'string' ? body.model : undefined,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : null,
    maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
  };
}

export function createChatRoute(providers: ChatProvider[]) {
  return async (c: Context<{ Variables: AuthedVars }>) => {
    let parsed: ReturnType<typeof parseBody>;
    try {
      parsed = parseBody(await c.req.json());
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

    return streamSSE(c, async (sse) => {
      // Propagates client disconnect down to the provider so an abandoned
      // stream stops being billed the moment the user navigates away.
      const abort = new AbortController();
      c.req.raw.signal?.addEventListener('abort', () => abort.abort());

      let usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      let stopReason: string | null = null;
      let ok = false;
      let failure: string | null = null;

      try {
        for await (const event of provider.streamChat({
          ...parsed,
          model: decision.model,
          signal: abort.signal,
        })) {
          if (event.type === 'done') {
            usage = event.usage;
            stopReason = event.stopReason;
            ok = true;
          }
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      } catch (error) {
        const pe =
          error instanceof ProviderError
            ? error
            : new ProviderError('Something went wrong reaching the model. Please try again.', false);
        // The user sees a clean message; the raw vendor text stays in the log.
        failure = pe.raw ?? pe.message;
        console.error(`[gateway] ${provider.id}/${decision.model} failed:`, failure);
        await sse.writeSSE({
          event: 'error',
          data: JSON.stringify({ type: 'error', message: pe.message, retryable: pe.retryable }),
        });
      } finally {
        const payload: ModelRequestPayload = {
          provider: provider.id,
          model: decision.model,
          routedBy: decision.reason,
          ...usage,
          costUsd: estimateCostUsd(decision.model, usage),
          durationMs: Date.now() - startedAt,
          stopReason,
          ok,
          error: failure,
        };
        await emit({
          kind: 'model_request',
          at: new Date().toISOString(),
          userId,
          conversationId: parsed.conversationId,
          surface: parsed.surface,
          payload,
        });
      }
    });
  };
}
