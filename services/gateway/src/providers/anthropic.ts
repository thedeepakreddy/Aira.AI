import Anthropic from '@anthropic-ai/sdk';
import { findModel } from './registry.ts';
import { ProviderError, type ChatProvider, type ChatRequest, type StreamEvent } from './types.ts';

/**
 * Anthropic adapter.
 *
 * Notes that are easy to get wrong and expensive to discover later:
 *  - Model ids are complete as written; never append a date suffix.
 *  - `budget_tokens` is rejected on Opus 5. Thinking is adaptive by default,
 *    so it is simply omitted here.
 *  - A safety refusal arrives as HTTP 200 with stop_reason "refusal", not as a
 *    thrown error, so stop_reason is checked before the result is trusted.
 *  - Server-side fallbacks reroute a refusal automatically. It rides a beta
 *    flag, so it is switchable in case an account lacks access.
 */
export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly useFallbacks: boolean;

  constructor(apiKey: string, useFallbacks = true) {
    this.client = new Anthropic({ apiKey });
    this.useFallbacks = useFallbacks;
  }

  supports(model: string): boolean {
    return findModel(model)?.provider === 'anthropic';
  }

  async *streamChat(request: ChatRequest & { model: string }): AsyncIterable<StreamEvent> {
    const { model, messages, system, maxTokens = 16000, signal } = request;

    yield { type: 'start', model, provider: this.id };

    const params = {
      model,
      max_tokens: maxTokens,
      // Caches the longest stable prefix. Cache reads are far cheaper than
      // fresh input tokens and dominate cost on long conversations.
      cache_control: { type: 'ephemeral' as const },
      ...(system ? { system } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    try {
      const stream = this.useFallbacks
        ? this.client.beta.messages.stream(
            { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as never,
            { signal },
          )
        : this.client.messages.stream(params, { signal });

      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', text: event.delta.thinking };
        }
      }

      const final = await stream.finalMessage();

      if (final.stop_reason === 'refusal') {
        yield {
          type: 'error',
          message: 'The model declined this request.',
          retryable: false,
        };
        return;
      }

      const u = final.usage;
      yield {
        type: 'done',
        stopReason: final.stop_reason,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

/**
 * Most specific first. Every one of these extends APIError, so APIError is the
 * catch-all and must come last, and a flat catch would lose the
 * retryable/non-retryable split that decides whether the client may retry.
 */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError('Model not found or unavailable.', false, 404);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError('Rate limited by Anthropic.', true, 429);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError('Could not reach Anthropic.', true);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 500;
    return new ProviderError(error.message, status >= 500, status);
  }
  return new ProviderError(error instanceof Error ? error.message : 'Unknown provider error', false);
}
