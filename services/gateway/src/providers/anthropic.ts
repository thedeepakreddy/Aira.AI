import Anthropic from '@anthropic-ai/sdk';
import { humanize } from './messages.ts';
import { classifyFault } from './fault.ts';
import { findModel } from './registry.ts';
import {
  ProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatRequest,
  type StreamEvent,
  type ToolDefinition,
} from './types.ts';

/**
 * Anthropic adapter.
 *
 * Notes that are easy to get wrong and expensive to discover later:
 *  - Model ids are complete as written; never append a date suffix.
 *  - A safety refusal arrives as HTTP 200 with stop_reason "refusal", not as a
 *    thrown error, so stop_reason is checked before the result is trusted.
 *  - Standard Messages API only; no experimental fallback or beta flags.
 */
export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, fetch?: NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch']) {
    this.client = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 1, ...(fetch ? { fetch } : {}) });
  }

  supports(model: string): boolean {
    return findModel(model)?.provider === 'anthropic';
  }

  async *streamChat(request: ChatRequest & { model: string }): AsyncIterable<StreamEvent> {
    const { model, messages, system, maxTokens = 16000, tools, signal } = request;

    if (request.responseFormat?.type === 'json_object') throw new ProviderError('This Anthropic model requires response_format json_schema for structured output.', false, 400);
    if (request.frequencyPenalty || request.presencePenalty) throw new ProviderError('Anthropic does not support frequency or presence penalties. Omit these settings for this provider.', false, 400);

    yield { type: 'start', model, provider: this.id };

    const params = {
      model,
      max_tokens: maxTokens,
      // Caches the longest stable prefix. Cache reads are far cheaper than
      // fresh input tokens and dominate cost on long conversations.
      cache_control: { type: 'ephemeral' as const },
      ...(system ? { system } : {}),
      ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
      ...(request.toolChoice ? { tool_choice: {
        ...(typeof request.toolChoice === 'object' ? { type: 'tool' as const, name: request.toolChoice.name } : { type: request.toolChoice === 'required' ? 'any' as const : request.toolChoice }),
        ...(request.parallelToolCalls !== undefined ? { disable_parallel_tool_use: !request.parallelToolCalls } : {}),
      } } : request.parallelToolCalls !== undefined && tools?.length ? { tool_choice: { type: 'auto' as const, disable_parallel_tool_use: !request.parallelToolCalls } } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.stop?.length ? { stop_sequences: request.stop } : {}),
      ...(request.responseFormat?.type === 'json_schema' || request.reasoningEffort ? { output_config: {
        ...(request.responseFormat?.type === 'json_schema' ? { format: { type: 'json_schema', schema: request.responseFormat.json_schema.schema } } : {}),
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      } } : {}),
      messages: toAnthropicMessages(messages),
    };

    try {
      const stream = this.client.messages.stream(params, { signal });

      // Tool calls stream as a start block naming the tool, then JSON
      // fragments. They are accumulated per block index and emitted whole.
      const pending = new Map<number, { id: string; name: string; json: string }>();

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            pending.set(event.index, { id: block.id, name: block.name, json: '' });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking', text: event.delta.thinking };
          } else if (event.delta.type === 'input_json_delta') {
            const open = pending.get(event.index);
            if (open) open.json += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          const done = pending.get(event.index);
          if (done) {
            pending.delete(event.index);
            try { JSON.parse(done.json || '{}'); } catch { throw new ProviderError('The model returned incomplete tool arguments. Please retry.', true, 502); }
            yield {
              type: 'tool_call',
              // An empty argument object still has to be valid JSON.
              call: { id: done.id, name: done.name, arguments: done.json || '{}' },
            };
          }
        }
      }

      const final = await stream.finalMessage();

      if (final.stop_reason === 'refusal') {
        yield {
          type: 'error',
          message: 'The model declined this request.',
          retryable: false,
          fault: 'provider',
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

/** OpenAI calls the schema `parameters`; Anthropic calls it `input_schema`. */
function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
    ...(t.strict !== undefined ? { strict: t.strict } : {}),
  }));
}

/**
 * Translates the neutral message shape into Anthropic's.
 *
 * Anthropic has no `tool` role: results come back as `tool_result` blocks
 * inside a *user* message. Crucially, all results answering one assistant turn
 * must share a single user message — splitting them across messages teaches the
 * model to stop making parallel tool calls — so consecutive tool turns are
 * merged here.
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'user' && message.contentParts?.length) {
      const blocks: Anthropic.ContentBlockParam[] = message.contentParts.map((part) => {
        if (part.type === 'text') return part;
        const data = part.url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
        return { type: 'image', source: data ? { type: 'base64', media_type: data[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: data[2] } : { type: 'url', url: part.url } };
      });
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result' as const,
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      };
      const previous = out.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: safeParse(call.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: message.role, content: message.content });
  }

  return out;
}

/** Tool arguments come from a model, so malformed JSON is a real possibility. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json || '{}');
  } catch {
    throw new ProviderError('Tool call arguments are not valid JSON.', false, 400);
  }
}

/**
 * Most specific first. Every one of these extends APIError, so APIError is the
 * catch-all and must come last, and a flat catch would lose the
 * retryable/non-retryable split that decides whether the client may retry.
 */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError('Model not found or unavailable.', false, 404, undefined, 'gateway');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError('Rate limited by Anthropic.', true, 429, undefined, 'provider');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError('Could not reach Anthropic.', true, undefined, undefined, 'provider');
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 500;
    return new ProviderError(humanize(error.message), status >= 500, status, error.message, classifyFault(status, error.message));
  }
  return new ProviderError('The model request could not complete. Please retry.', false, 502, error instanceof Error ? error.message : undefined, 'provider');
}
