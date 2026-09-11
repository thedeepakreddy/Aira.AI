import OpenAI from 'openai';
import { humanize } from './messages.ts';
import { findModel } from './registry.ts';
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type ProviderId,
  type StreamEvent,
  type ToolDefinition,
} from './types.ts';

/**
 * Adapter for any OpenAI-compatible endpoint.
 *
 * OpenAI's wire format has become the de-facto interoperability layer, so one
 * adapter covers OpenAI itself and every vendor that mirrors it (OpenRouter,
 * Groq, and others) — a new vendor is a construction argument, not a new file.
 *
 * Usage totals only arrive when `stream_options.include_usage` is set — without
 * it the final chunk carries no token counts and every request meters as zero,
 * which would quietly under-bill.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: ProviderId;
  private readonly client: OpenAI;
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';

  constructor(options: {
    id: ProviderId;
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    /** Injectable transport enables offline adapter contract tests. */
    fetch?: NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'];
  }) {
    this.id = options.id;
    this.maxTokensField = options.maxTokensField ?? (options.id === 'openai' ? 'max_completion_tokens' : 'max_tokens');
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: 180_000,
      maxRetries: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.headers ? { defaultHeaders: options.headers } : {}),
    });
  }

  supports(model: string): boolean {
    return findModel(model)?.provider === this.id;
  }

  async *streamChat(request: ChatRequest & { model: string }): AsyncIterable<StreamEvent> {
    const { model, messages, system, maxTokens = 16000, tools, signal } = request;

    yield { type: 'start', model, provider: this.id };

    try {
      const stream = await this.client.chat.completions.create(
        {
          model,
          [this.maxTokensField]: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
          ...(request.toolChoice ? { tool_choice: typeof request.toolChoice === 'string' ? request.toolChoice : { type: 'function' as const, function: { name: request.toolChoice.name } } } : {}),
          ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.topP !== undefined ? { top_p: request.topP } : {}),
          ...(request.stop?.length ? { stop: request.stop } : {}),
          ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
          ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
          ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
          ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
          messages: [
            ...(system ? [{ role: 'system' as const, content: system }] : []),
            ...messages.map(toOpenAIMessage),
          ],
        },
        { signal },
      );

      let stopReason: string | null = null;
      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      // Tool calls arrive as fragments keyed by index; accumulate and emit whole.
      const pending = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        // The usage-bearing chunk arrives last and has an empty choices array.
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = choice.finish_reason;
        const text = choice.delta?.content;
        if (text) yield { type: 'text', text };

        for (const fragment of choice.delta?.tool_calls ?? []) {
          const open = pending.get(fragment.index) ?? { id: '', name: '', args: '' };
          if (fragment.id) open.id = fragment.id;
          if (fragment.function?.name) open.name = fragment.function.name;
          if (fragment.function?.arguments) open.args += fragment.function.arguments;
          pending.set(fragment.index, open);
        }
      }

      if (!stopReason) throw new ProviderError('The model stream ended before completing. Please retry.', true, 502);
      for (const [, call] of [...pending].sort((a, b) => a[0] - b[0])) {
        if (!call.id || !call.name) throw new ProviderError('The model returned an incomplete tool call.', true, 502);
        try { JSON.parse(call.args || '{}'); } catch { throw new ProviderError('The model returned incomplete tool arguments. Please retry.', true, 502); }
        yield {
          type: 'tool_call',
          call: { id: call.id, name: call.name, arguments: call.args || '{}' },
        };
      }

      // Cached prompt tokens are reported inside prompt_tokens; separating them
      // keeps the field meaning the same as it does for Anthropic.
      usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);

      yield { type: 'done', usage, stopReason };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

/** Anthropic calls the schema `input_schema`; OpenAI nests it under `function`. */
function toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters as Record<string, unknown>,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

function toOpenAIMessage(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === 'user' && message.contentParts?.length) return {
    role: 'user', content: message.contentParts.map((part) => part.type === 'text' ? part : { type: 'image_url' as const, image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } }),
  };
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.NotFoundError) {
    return new ProviderError('Model not found or unavailable.', false, 404);
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ProviderError('Rate limited by the model provider.', true, 429);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError('Could not reach the model provider.', true);
  }
  // Base class last: every error above extends it.
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 500;
    return new ProviderError(humanize(error.message), status >= 500, status, error.message);
  }
  return new ProviderError('The model request could not complete. Please retry.', false, 502, error instanceof Error ? error.message : undefined);
}
