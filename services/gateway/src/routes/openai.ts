import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthedVars } from '../auth.ts';
import { estimateCostUsd, findModel, listModels } from '../providers/registry.ts';
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from '../providers/types.ts';
import { routeModel } from '../routing/router.ts';
import { emit, type ModelRequestPayload } from '../usage/events.ts';

/**
 * OpenAI-compatible surface, mounted at /openai/v1.
 *
 * It exists so tools that only speak OpenAI's protocol — OpenCode in
 * particular — can run through the gateway instead of holding provider keys of
 * their own. That is what keeps agent spend inside Aira's metering and under
 * the same per-user caps; a coding agent is the most expensive surface there
 * is, so letting it bill somewhere else would leave the largest cost centre
 * invisible.
 *
 * Deliberately mounted under its own prefix rather than at /v1, because Aira's
 * own /v1/models returns a different shape and an OpenAI client would choke
 * on it.
 */

interface OpenAIMessage {
  role: string;
  content: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
}

/**
 * OpenAI wraps each tool in a `function` envelope. Anything without a usable
 * name is dropped rather than forwarded half-formed.
 */
function parseTools(raw: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools: ToolDefinition[] = [];
  for (const entry of raw) {
    const fn = (entry as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })
      ?.function;
    if (!fn || typeof fn.name !== 'string') continue;
    tools.push({
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters:
        fn.parameters && typeof fn.parameters === 'object'
          ? (fn.parameters as Record<string, unknown>)
          : { type: 'object', properties: {} },
    });
  }
  return tools.length ? tools : undefined;
}

function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const c = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof c?.id !== 'string' || typeof c.function?.name !== 'string') continue;
    calls.push({
      id: c.id,
      name: c.function.name,
      arguments: typeof c.function.arguments === 'string' ? c.function.arguments : '{}',
    });
  }
  return calls.length ? calls : undefined;
}

/** OpenAI allows content as a string or as an array of parts; both must work. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '',
      )
      .join('');
  }
  return '';
}

export function createOpenAIModelsRoute() {
  return (c: Context) =>
    c.json({
      object: 'list',
      data: listModels().map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.provider,
      })),
    });
}

export function createOpenAIChatRoute(providers: ChatProvider[]) {
  return async (c: Context<{ Variables: AuthedVars }>) => {
    let body: {
      model?: unknown;
      messages?: unknown;
      stream?: unknown;
      max_tokens?: unknown;
      max_completion_tokens?: unknown;
      tools?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: 'Malformed JSON body.', type: 'invalid_request_error' } }, 400);
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(
        { error: { message: '`messages` must be a non-empty array.', type: 'invalid_request_error' } },
        400,
      );
    }

    // A system message is a separate field for us, and OpenAI puts it in the
    // array; pull it out rather than sending it through as a turn.
    const system: string[] = [];
    const messages: ChatMessage[] = [];
    for (const raw of body.messages as OpenAIMessage[]) {
      const text = flattenContent(raw?.content);
      if (raw?.role === 'system' || raw?.role === 'developer') {
        system.push(text);
      } else if (raw?.role === 'tool') {
        messages.push({
          role: 'tool',
          content: text,
          toolCallId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined,
        });
      } else if (raw?.role === 'assistant') {
        const toolCalls = parseToolCalls(raw.tool_calls);
        messages.push({ role: 'assistant', content: text, ...(toolCalls ? { toolCalls } : {}) });
      } else {
        messages.push({ role: 'user', content: text });
      }
    }
    if (messages.length === 0) {
      return c.json(
        { error: { message: 'At least one user or assistant message is required.', type: 'invalid_request_error' } },
        400,
      );
    }

    const requested = typeof body.model === 'string' ? body.model : undefined;
    // Anything reaching this surface is agent work, so it routes as `code`
    // unless it named a model we actually have.
    const decision = routeModel('code', requested && findModel(requested) ? requested : undefined);
    const spec = findModel(decision.model);
    const provider = spec && providers.find((p) => p.supports(decision.model));
    if (!spec || !provider) {
      return c.json(
        { error: { message: `No provider configured for "${decision.model}".`, type: 'invalid_request_error' } },
        503,
      );
    }

    const maxTokens =
      typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : 16000;

    const userId = c.get('userId');
    const startedAt = Date.now();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    const request = {
      messages,
      system: system.length ? system.join('\n\n') : undefined,
      surface: 'code' as const,
      model: decision.model,
      maxTokens,
      // Forwarding these is what separates an agent gateway from a chat proxy;
      // dropping them leaves a model that can only describe actions.
      tools: parseTools(body.tools),
    };

    async function record(usage: TokenUsage, stopReason: string | null, ok: boolean, failure: string | null) {
      const payload: ModelRequestPayload = {
        provider: provider!.id,
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
        conversationId: null,
        // Tagged so agent spend is separable from chat in the usage log.
        surface: 'code',
        payload,
      });
    }

    const empty: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    // ── non-streaming ────────────────────────────────────────────────────────
    if (body.stream !== true) {
      let text = '';
      const calls: ToolCall[] = [];
      let usage = empty;
      let stopReason: string | null = null;
      try {
        for await (const event of provider.streamChat({ ...request, signal: undefined })) {
          if (event.type === 'text') text += event.text;
          else if (event.type === 'tool_call') calls.push(event.call);
          else if (event.type === 'done') {
            usage = event.usage;
            stopReason = event.stopReason;
          } else if (event.type === 'error') throw new ProviderError(event.message, event.retryable);
        }
      } catch (error) {
        const pe = error instanceof ProviderError ? error : new ProviderError('Upstream failed.', false);
        await record(empty, null, false, pe.raw ?? pe.message);
        return c.json({ error: { message: pe.message, type: 'api_error' } }, (pe.status ?? 500) as 500);
      }
      await record(usage, stopReason, true, null);
      return c.json({
        id,
        object: 'chat.completion',
        created,
        model: decision.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              // OpenAI sends null content when the turn is purely tool calls.
              content: text || (calls.length ? null : ''),
              ...(calls.length ? { tool_calls: calls.map(toOpenAIToolCall) } : {}),
            },
            finish_reason: calls.length ? 'tool_calls' : mapStop(stopReason),
          },
        ],
        usage: openAIUsage(usage),
      });
    }

    // ── streaming ────────────────────────────────────────────────────────────
    return streamSSE(c, async (sse) => {
      const abort = new AbortController();
      c.req.raw.signal?.addEventListener('abort', () => abort.abort());

      const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: decision.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

      let usage = empty;
      let stopReason: string | null = null;
      let ok = false;
      let failure: string | null = null;
      let toolCalls = 0;

      try {
        await sse.writeSSE({ data: JSON.stringify(chunk({ role: 'assistant' }, null)) });
        for await (const event of provider.streamChat({ ...request, signal: abort.signal })) {
          if (event.type === 'text') {
            await sse.writeSSE({ data: JSON.stringify(chunk({ content: event.text }, null)) });
          } else if (event.type === 'tool_call') {
            // Emitted whole rather than as fragments; clients accept either.
            await sse.writeSSE({
              data: JSON.stringify(
                chunk({ tool_calls: [{ index: toolCalls, ...toOpenAIToolCall(event.call) }] }, null),
              ),
            });
            toolCalls += 1;
          } else if (event.type === 'done') {
            usage = event.usage;
            stopReason = event.stopReason;
            ok = true;
          } else if (event.type === 'error') {
            failure = event.message;
          }
        }
        await sse.writeSSE({
          data: JSON.stringify({
            ...chunk({}, toolCalls ? 'tool_calls' : mapStop(stopReason)),
            usage: openAIUsage(usage),
          }),
        });
      } catch (error) {
        const pe = error instanceof ProviderError ? error : new ProviderError('Upstream failed.', false);
        failure = pe.raw ?? pe.message;
        await sse.writeSSE({ data: JSON.stringify({ error: { message: pe.message, type: 'api_error' } }) });
      } finally {
        // OpenAI clients wait for this sentinel; without it they hang.
        await sse.writeSSE({ data: '[DONE]' });
        await record(usage, stopReason, ok, failure);
      }
    });
  };
}

function toOpenAIToolCall(call: ToolCall) {
  return {
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  };
}

function mapStop(stopReason: string | null): string {
  if (stopReason === 'max_tokens' || stopReason === 'length') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function openAIUsage(u: TokenUsage) {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
  };
}
