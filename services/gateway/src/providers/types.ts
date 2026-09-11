/**
 * Provider-agnostic contract.
 *
 * Every model provider is normalised to this interface so nothing above it —
 * routes, routing rules, the frontend — ever needs to know which vendor served
 * a request. Adding a provider means adding one adapter, not touching callers.
 */

export type Role = 'user' | 'assistant' | 'tool';

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * A model's request to call a tool. `arguments` stays a raw JSON string
 * because that is how both providers emit it, and re-encoding it would risk
 * changing what the model actually asked for.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant turns that asked to call tools. */
  toolCalls?: ToolCall[];
  /** Present on `tool` turns; identifies the call being answered. */
  toolCallId?: string;
}

/**
 * The product surface a request came from. Routing keys off this rather than
 * inspecting message content: each surface is a separate conversation with its
 * own prompt cache, so choosing a model per surface costs nothing, while
 * switching models mid-conversation would forfeit the cached prefix.
 */
export type Surface = 'chat' | 'voice' | 'code' | 'task';

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string;
  surface: Surface;
  /** Explicit model override from the UI picker. Wins over routing. */
  model?: string;
  maxTokens?: number;
  /**
   * Tools the model may call. Agent surfaces depend on these: a gateway that
   * drops them turns an agent into something that can only describe actions it
   * cannot take, so adapters must either forward them or fail loudly.
   */
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic-only; 0 elsewhere. Tracked because it dominates cost at scale. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Normalised stream events. Both adapters emit exactly these, so the SSE layer
 * and the client stay provider-neutral.
 */
export type StreamEvent =
  | { type: 'start'; model: string; provider: ProviderId }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /**
   * Emitted once per call, complete. Providers stream argument fragments, but
   * a partial call is useless to a caller and dangerous to act on, so adapters
   * accumulate and emit only whole calls.
   */
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage: TokenUsage; stopReason: string | null }
  | { type: 'error'; message: string; retryable: boolean };

export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'gemini';

export interface ChatProvider {
  readonly id: ProviderId;
  /** Resolves once the model id is known to belong to this provider. */
  supports(model: string): boolean;
  streamChat(request: ChatRequest & { model: string }): AsyncIterable<StreamEvent>;
}

/** Thrown when a provider fails in a way the caller may want to retry. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  /** Original vendor text. Logged for diagnosis; never shown to a user. */
  readonly raw?: string;

  constructor(message: string, retryable: boolean, status?: number, raw?: string) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.status = status;
    this.raw = raw;
  }
}
