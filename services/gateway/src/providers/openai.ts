import OpenAI from 'openai';
import { findModel } from './registry.ts';
import { ProviderError, type ChatProvider, type ChatRequest, type StreamEvent } from './types.ts';

/**
 * OpenAI adapter.
 *
 * Usage totals only arrive when `stream_options.include_usage` is set — without
 * it the final chunk carries no token counts and every request meters as zero,
 * which would quietly under-bill.
 */
export class OpenAIProvider implements ChatProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  supports(model: string): boolean {
    return findModel(model)?.provider === 'openai';
  }

  async *streamChat(request: ChatRequest & { model: string }): AsyncIterable<StreamEvent> {
    const { model, messages, system, maxTokens = 16000, signal } = request;

    yield { type: 'start', model, provider: this.id };

    try {
      const stream = await this.client.chat.completions.create(
        {
          model,
          max_completion_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            ...(system ? [{ role: 'system' as const, content: system }] : []),
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { signal },
      );

      let stopReason: string | null = null;
      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

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

function toProviderError(error: unknown): ProviderError {
  if (error instanceof OpenAI.NotFoundError) {
    return new ProviderError('Model not found or unavailable.', false, 404);
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ProviderError('Rate limited by OpenAI.', true, 429);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError('Could not reach OpenAI.', true);
  }
  // Base class last: every error above extends it.
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 500;
    return new ProviderError(error.message, status >= 500, status);
  }
  return new ProviderError(error instanceof Error ? error.message : 'Unknown provider error', false);
}
