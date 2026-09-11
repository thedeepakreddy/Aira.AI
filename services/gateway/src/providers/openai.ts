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

  constructor(options: {
    id: ProviderId;
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
  }) {
    this.id = options.id;
    this.client = new OpenAI({
      apiKey: options.apiKey,
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
          max_completion_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
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

      for (const [, call] of [...pending].sort((a, b) => a[0] - b[0])) {
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
    },
  }));
}

function toOpenAIMessage(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
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
  return new ProviderError(error instanceof Error ? error.message : 'Unknown provider error', false);
}
