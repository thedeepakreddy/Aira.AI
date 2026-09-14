import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthedVars } from '../auth.ts';
import { faultAdvice } from '../providers/fault.ts';
import { estimateCostUsd, findModel, listModels } from '../providers/registry.ts';
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatProvider,
  type Surface,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
} from '../providers/types.ts';
import { contextFor, record as remember, withContext } from '../memory/context.ts';
import { routeModel } from '../routing/router.ts';
import { exhaustedMessage, nextModel, worthFallingBack } from '../routing/fallback.ts';
import { emit, type ModelRequestPayload } from '../usage/events.ts';
import { invalid, messageContent, numberOption, object, parseToolCalls, parseToolChoice, parseTools, responseFormat, stopSequences, tokenLimit, validateConversation } from './validation.ts';

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

/** Attempts in total, including the first. Three is two retries. */
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 600;

/**
 * Whether a failed attempt may be tried again.
 *
 * Exported for tests: the conditions matter more than the loop around them,
 * and "does this duplicate output" is not something to discover in production.
 */
export function shouldRetry(
  error: unknown,
  state: { attempt: number; emitted: boolean; aborted: boolean },
): boolean {
  if (state.aborted) return false;
  // Anything already sent cannot be unsent, so a second attempt would append a
  // second answer to the first.
  if (state.emitted) return false;
  if (state.attempt >= MAX_ATTEMPTS) return false;
  // An account with no credit, a rejected key, a prompt that is too long: none
  // of these change by asking again, and retrying bills the user for it.
  if (!(error instanceof ProviderError)) return false;
  if (error.fault === 'account') return false;
  return error.retryable;
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

/**
 * @param surface Which Aira surface the caller is. OpenCode is `code`; the
 * daily-task agent is `task`. It decides both the model the request routes to
 * and how the spend is attributed, so a single hardcoded value would meter
 * every agent's work as coding.
 */
export function createOpenAIChatRoute(providers: ChatProvider[], surface: Surface = 'code') {
  return async (c: Context<{ Variables: AuthedVars }>) => {
    let body: Record<string, unknown>;
    try {
      const raw = await c.req.json();
      if (!object(raw)) invalid('The request body must be an object.');
      body = raw;
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
    let tools: ToolDefinition[] | undefined;
    let options: Partial<ChatRequest>;
    try {
    if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be boolean.');
    if (body.n !== undefined && body.n !== 1) invalid('This gateway supports one completion per request (n=1).');
    for (const option of ['functions', 'function_call', 'logprobs', 'logit_bias', 'modalities', 'audio', 'prediction', 'seed', 'service_tier']) {
      if (body[option] !== undefined && body[option] !== null) invalid(`The gateway does not yet support ${option}; omit it instead of relying on a silently ignored setting.`);
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) invalid('model must be a non-empty string.');
    for (const raw of body.messages) {
      if (!object(raw) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(raw.role))) invalid('Every message must have a supported role.');
      const content = messageContent(raw.content ?? (raw.role === 'assistant' && raw.tool_calls ? null : undefined), String(raw.role));
      const text = content.content;
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
      } else if (raw.role === 'user') {
        messages.push({ role: 'user', ...content });
      }
    }
    validateConversation(messages);
    tools = parseTools(body.tools);
    if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be boolean.');
    if (body.stream_options !== undefined && (!object(body.stream_options) || (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) invalid('stream_options.include_usage must be boolean.');
    if (body.reasoning_effort !== undefined && !['low', 'medium', 'high'].includes(String(body.reasoning_effort))) invalid('Supported reasoning_effort values are low, medium and high.');
    options = {
      maxTokens: tokenLimit(body.max_completion_tokens ?? body.max_tokens),
      toolChoice: parseToolChoice(body.tool_choice, tools),
      parallelToolCalls: body.parallel_tool_calls as boolean | undefined,
      temperature: numberOption(body.temperature, 'temperature', 2),
      topP: numberOption(body.top_p, 'top_p', 1),
      stop: stopSequences(body.stop),
      responseFormat: responseFormat(body.response_format),
      reasoningEffort: body.reasoning_effort as ChatRequest['reasoningEffort'],
      frequencyPenalty: numberOption(body.frequency_penalty, 'frequency_penalty', 2, -2),
      presencePenalty: numberOption(body.presence_penalty, 'presence_penalty', 2, -2),
    };
    } catch (error) {
      return c.json({ error: { message: error instanceof ProviderError ? error.message : 'Invalid request.', type: 'invalid_request_error' } }, 400);
    }

    const requested = typeof body.model === 'string' ? body.model : undefined;
    // Agent work routes to the surface this endpoint was mounted for, unless it
    // named a model we actually have.
    if (requested && requested !== 'auto' && !findModel(requested)) return c.json({ error: { message: `Unknown or unavailable model "${requested}".`, type: 'invalid_request_error' } }, 400);
    const decision = routeModel(surface, requested === 'auto' ? undefined : requested);
    const spec = findModel(decision.model);
    const provider = spec && providers.find((p) => p.supports(decision.model));
    if (!spec || !provider) {
      return c.json(
        { error: { message: `No provider configured for "${decision.model}".`, type: 'invalid_request_error' } },
        503,
      );
    }

    const userId = c.get('userId');
    const startedAt = Date.now();
    /**
     * The vendor currently answering, which is not necessarily the one routed
     * to: a provider that cannot be reached hands the turn to the next one.
     *
     * This matters more here than on the chat screen. A person whose chat
     * errors asks again; a coding agent twenty tool calls into a task loses the
     * task, and the surface most likely to be pointed at a free endpoint is
     * exactly the one most likely to be told "temporarily overloaded".
     */
    const reachable = listModels().filter((candidate) => providers.some((p) => p.supports(candidate.id)));
    const tried: string[] = [decision.model];
    let active = provider;
    let activeModel = decision.model;
    let attemptStartedAt = startedAt;
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // The agents get the same cross-surface context the chat screen does. They
    // reach this gateway directly and never touch the app, so this is the only
    // point at which they can know what the user has been doing elsewhere.
    const useMemory = c.req.header('x-aira-memory')?.toLowerCase() !== 'off';
    const recalled = useMemory ? await contextFor(userId, surface) : '';
    // Last, not first: an agent's system prompt is its instructions, and
    // context that displaces them changes what the agent is.
    const asked = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    const request = {
      messages,
      system: withContext(system.length ? system.join('\n\n') : undefined, recalled),
      surface,
      model: decision.model,
      ...options,
      // Forwarding these is what separates an agent gateway from a chat proxy;
      // dropping them leaves a model that can only describe actions.
      tools,
    };

    async function record(usage: TokenUsage, stopReason: string | null, ok: boolean, failure: string | null) {
      const payload: ModelRequestPayload = {
        // Whoever served this attempt, not whoever the router first chose. A
        // turn rescued by a second vendor cost two requests, and usage that
        // reports one understates the bill.
        provider: active.id,
        model: activeModel,
        routedBy: activeModel === decision.model ? decision.reason : `fallback from ${decision.model}`,
        ...usage,
        costUsd: estimateCostUsd(activeModel, usage),
        durationMs: Date.now() - attemptStartedAt,
        stopReason,
        ok,
        error: failure,
      };
      await emit({
        kind: 'model_request',
        at: new Date().toISOString(),
        userId,
        conversationId: null,
        // Tagged so each agent's spend is separable in the usage log.
        surface,
        payload,
      });
    }

    const empty: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    /**
     * Hands the turn to a vendor that has not been asked yet, if this failure
     * is one another vendor could answer and one is left. Records the attempt
     * that failed on the way out, while `active` still names it.
     */
    async function fallBack(error: unknown, emitted: boolean, aborted: boolean): Promise<boolean> {
      if (aborted || !(error instanceof ProviderError)) return false;
      if (!worthFallingBack(error.fault, emitted, tried.length)) return false;
      const candidate = nextModel(reachable, spec!.tier, tried);
      const backup = candidate ? providers.find((p) => p.supports(candidate.id)) : undefined;
      if (!candidate || !backup) return false;
      await record(empty, null, false, error.raw ?? error.message);
      console.warn(`[gateway] ${active.id} unavailable — trying ${backup.id}/${candidate.id}`);
      active = backup;
      activeModel = candidate.id;
      attemptStartedAt = Date.now();
      tried.push(candidate.id);
      return true;
    }

    // ── non-streaming ────────────────────────────────────────────────────────
    if (body.stream !== true) {
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(300_000)]);
      let text = '';
      let calls: ToolCall[] = [];
      let usage = empty;
      let stopReason: string | null = null;
      while (true) {
        text = '';
        calls = [];
        usage = empty;
        stopReason = null;
        let completed = false;
        try {
          for await (const event of active.streamChat({ ...request, model: activeModel, signal })) {
            if (event.type === 'text') text += event.text;
            else if (event.type === 'tool_call') calls.push(event.call);
            else if (event.type === 'done') {
              usage = event.usage;
              stopReason = event.stopReason;
              completed = true;
            } else if (event.type === 'error') throw new ProviderError(event.message, event.retryable, undefined, undefined, event.fault);
          }
          if (!completed) throw new ProviderError('The model stream ended before completing. Please retry.', true, 502);
          break;
        } catch (error) {
          const pe = error instanceof ProviderError ? error : new ProviderError('Upstream failed.', false, undefined, undefined, 'provider');
          // Nothing has reached the client on this path — the body is sent in
          // one piece at the end — so a discarded attempt leaves no trace to
          // duplicate.
          if (await fallBack(pe, false, signal.aborted)) continue;
          await record(empty, null, false, pe.raw ?? pe.message);
          return c.json({ error: { message: exhaustedMessage(tried, pe.message), type: 'api_error', fault: pe.fault, advice: faultAdvice(pe.fault) } }, (pe.status ?? 500) as 500);
        }
      }
      await record(usage, stopReason, true, null);
      if (useMemory) {
        await remember(userId, surface, 'user', asked);
        await remember(userId, surface, 'assistant', text);
      }
      return c.json({
        id,
        object: 'chat.completion',
        created,
        model: activeModel,
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
      sse.onAbort(() => abort.abort());
      const signal = AbortSignal.any([abort.signal, c.req.raw.signal, AbortSignal.timeout(300_000)]);
      const includeUsage = object(body.stream_options) && body.stream_options.include_usage === true;

      const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        // Read at call time, so a turn handed to a second vendor says so from
        // the chunk it was handed over on.
        model: activeModel,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(includeUsage ? { usage: null } : {}),
      });

      let usage = empty;
      let stopReason: string | null = null;
      let ok = false;
      let failure: string | null = null;
      let toolCalls = 0;
      let streamed = '';

      try {
        await sse.writeSSE({ data: JSON.stringify(chunk({ role: 'assistant' }, null)) });
        /*
         * Two nested recoveries, because there are two kinds of failure.
         *
         * The inner loop retries the same vendor. `retryable` has been set on
         * these errors since the providers were written, and propagated to the
         * client, and never acted on — so a free endpoint answering "Service
         * temporarily overloaded" ended the turn, when trying again a second
         * later usually works. Seven of those in one session is what "why does
         * it fail sometimes" turned out to be.
         *
         * The outer loop asks a different vendor, once retrying has given up.
         * An overloaded endpoint clears in a second; an account with no credit
         * never does, and that is the failure only somebody else can answer.
         *
         * Both stop at the same line: nothing may have reached the client yet.
         * Once a token or a tool call is out the answer is partly delivered,
         * and starting over — here or elsewhere — would duplicate it. So a
         * stream that dies halfway still fails, and says so, rather than
         * stuttering.
         */
        while (true) {
          try {
            for (let attempt = 1; ; attempt++) {
              try {
                for await (const event of active.streamChat({ ...request, model: activeModel, signal })) {
                  if (event.type === 'text') {
                    streamed += event.text;
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
                    throw new ProviderError(event.message, event.retryable, undefined, undefined, event.fault);
                  }
                }
                if (!ok) throw new ProviderError('The model stream ended before completing. Please retry.', true, 502);
                break;
              } catch (error) {
                if (!shouldRetry(error, { attempt, emitted: streamed !== '' || toolCalls > 0, aborted: signal.aborted })) throw error;
                // Short and linear: these clear in a second or two when they
                // clear at all, and a long backoff just makes the surface feel
                // hung.
                await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_DELAY_MS));
              }
            }
            break;
          } catch (error) {
            if (await fallBack(error, streamed !== '' || toolCalls > 0, signal.aborted)) continue;
            throw error;
          }
        }
        await sse.writeSSE({
          data: JSON.stringify(chunk({}, toolCalls ? 'tool_calls' : mapStop(stopReason))),
        });
        if (includeUsage) await sse.writeSSE({ data: JSON.stringify({ ...chunk({}, null), choices: [], usage: openAIUsage(usage) }) });
      } catch (error) {
        const pe = error instanceof ProviderError ? error : new ProviderError('Upstream failed.', false);
        failure = pe.raw ?? pe.message;
        ok = false;
        if (!signal.aborted) await sse.writeSSE({ data: JSON.stringify({ error: { message: exhaustedMessage(tried, pe.message), type: 'api_error', fault: pe.fault, advice: faultAdvice(pe.fault) } }) });
      } finally {
        // OpenAI clients wait for this sentinel; without it they hang.
        if (!signal.aborted) await sse.writeSSE({ data: '[DONE]' }).catch(() => {});
        await record(usage, stopReason, ok, failure);
        if (ok && useMemory) {
          await remember(userId, surface, 'user', asked);
          await remember(userId, surface, 'assistant', streamed);
        }
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
  if (stopReason === 'tool_calls' || stopReason === 'content_filter') return stopReason;
  return 'stop';
}

function openAIUsage(u: TokenUsage) {
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.outputTokens,
    total_tokens: prompt + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cacheReadTokens },
  };
}
