/**
 * Client for the Aira gateway.
 *
 * The gateway holds every provider key, so this module only ever talks to our
 * configured gateway — no vendor SDK or provider API key reaches the browser
 * or packaged app. Account sessions still use sensitive bearer credentials.
 */

import { parseSSE } from './sse';
import { getAccessToken } from './supabase';

export type Surface = 'chat' | 'voice' | 'code' | 'task';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StreamEvent =
  | { type: 'start'; model: string; provider: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'done'; usage: unknown; stopReason: string | null }
  | { type: 'error'; message: string; retryable: boolean; fault?: Fault; advice?: string };

/**
 * Whose problem a failure is, mirrored from the gateway.
 *
 * `account` means the user's provider account — credit, quota, an expired key.
 * `provider` means the vendor is busy or down. `gateway` means Aira. Without
 * the distinction the interface apologises for billing problems it cannot fix.
 */
export type Fault = 'account' | 'provider' | 'gateway';

export interface StreamChatOptions {
  messages: ChatMessage[];
  surface?: Surface;
  model?: string;
  conversationId?: string | null;
  signal?: AbortSignal;
}

export const GATEWAY_URL: string =
  ((import.meta.env?.VITE_GATEWAY_URL as string | undefined) || 'http://localhost:8787').replace(/\/+$/, '');

/**
 * Streams a reply. Yields normalised events identical in shape across every
 * provider, so nothing here needs to know which model answered.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { messages, surface = 'chat', model, conversationId, signal } = options;

  // The gateway pays for every token it forwards, so it needs to know who is
  // asking. Without a session it answers 401 and nothing is spent.
  let response: Response;
  try {
    const token = await getAccessToken();
    if (signal?.aborted) return;
    response = await fetch(`${GATEWAY_URL}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages, surface, model, conversationId }),
      signal,
    });
  } catch (error) {
    // Abort is a deliberate user action, not a failure to report.
    if (signal?.aborted) return;
    yield {
      type: 'error',
      message: 'Aira could not connect. Check Connections and try again.',
      retryable: true,
      fault: 'gateway',
    };
    return;
  }

  if (response.status === 401) {
    yield { type: 'error', message: 'Please sign in to continue.', retryable: false, fault: 'account' };
    return;
  }

  if (!response.ok || !response.body) {
    let message = `Gateway returned ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    yield {
      type: 'error', message, retryable: response.status >= 500,
      fault: response.status === 402 || response.status === 403 ? 'account' : response.status >= 500 ? 'provider' : 'gateway',
    };
    return;
  }

  let completed = false;
  try {
    for await (const data of parseSSE(response.body)) {
      if (!data) continue;
      try {
        const event = JSON.parse(data) as StreamEvent;
        if (event.type === 'done' || event.type === 'error') completed = true;
        if (event.type === 'text' && typeof event.text !== 'string') continue;
        yield event;
      } catch {
        // A malformed frame shouldn't kill an otherwise healthy stream.
      }
    }
    if (!completed && !signal?.aborted) yield { type: 'error', message: 'The response ended early. You can retry this message.', retryable: true, fault: 'provider' };
  } catch (error) {
    if (signal?.aborted) return;
    yield { type: 'error', message: 'The connection dropped mid-response.', retryable: true };
  }
}

export interface ModelSpec {
  id: string;
  label: string;
  provider: string;
  tier: 'frontier' | 'balanced' | 'fast';
  contextWindow: number;
  pricing?: { inputPerMTok: number; outputPerMTok: number };
}

/** What each surface currently routes to, as the gateway decides it. */
export type SurfaceRouting = Partial<Record<'chat' | 'voice' | 'code' | 'task', string>>;

/**
 * Model catalogue for the picker, plus the gateway's current routing. Returns
 * empty values rather than throwing when the gateway is unreachable or the
 * session has expired — an empty picker is a better failure than a blank screen.
 */
export async function listCatalogue(): Promise<{ models: ModelSpec[]; routing: SurfaceRouting }> {
  try {
    const token = await getAccessToken();
    const response = await fetch(`${GATEWAY_URL}/v1/models`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { models: [], routing: {} };
    const body = (await response.json()) as { models?: ModelSpec[]; routing?: SurfaceRouting };
    return { models: Array.isArray(body.models) ? body.models : [], routing: body.routing ?? {} };
  } catch {
    return { models: [], routing: {} };
  }
}

export async function listModels(): Promise<ModelSpec[]> {
  return (await listCatalogue()).models;
}

/** Authenticated requests for workspace settings; never persist bearer tokens. */
export async function gatewayRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`${GATEWAY_URL}${path}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(12000) }); }
  catch { throw new Error('Could not reach Aira. Check your connection and try again.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = typeof body?.error === 'string' ? body.error : body?.error?.message;
    throw new Error(error || (response.status === 401 ? 'Sign in to manage your workspace.' : `Request failed (${response.status}).`));
  }
  return response.json() as Promise<T>;
}
