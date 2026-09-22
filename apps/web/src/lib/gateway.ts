/**
 * Client for the Aira gateway.
 *
 * The gateway holds every provider key, so this module only ever talks to our
 * configured gateway — no vendor SDK or provider API key reaches the browser
 * or packaged app. Account sessions still use sensitive bearer credentials.
 */

import { parseSSE } from './sse';
import { getAccessToken } from './supabase';
import { waitForGateway } from './gateway-ready.ts';

export type Surface = 'chat' | 'voice' | 'code' | 'task';

export interface ChatMessage {
  /**
   * `tool` carries the result of something the model asked the caller to do.
   *
   * The gateway has always accepted these; the client type did not describe
   * them, which is part of why chat could be offered a browsing tool and never
   * complete one.
   */
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on an assistant turn that asked for tool calls. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Present on a tool turn; identifies the call being answered. */
  toolCallId?: string;
}

export type StreamEvent =
  | { type: 'start'; model: string; provider: string }
  /** The routed model could not answer and another one is taking the turn. */
  | { type: 'fallback'; from: string; to: string; fault?: Fault }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'done'; usage: unknown; stopReason: string | null }
  | { type: 'error'; message: string; retryable: boolean; fault?: Fault; advice?: string }
  /**
   * The model asking for something to be done on its behalf.
   *
   * Dropped silently until now, which is why chat could be offered a browsing
   * tool and never use it: the gateway declares tools, but the caller owns the
   * browser and has to run them.
   */
  | { type: 'tool_call'; call: { id: string; name: string; arguments: string } };

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
  /**
   * Whether this caller can actually perform a browse.
   *
   * A property of the caller, not the account: the same user has a real browser
   * on the desktop and a hosted one on the web, and neither before signing in.
   * The gateway offers the tool only when this is true, because a model told it
   * may search — when nothing can — announces a search and invents the result.
   */
  canBrowse?: boolean;
}

export const GATEWAY_URL: string =
  ((import.meta.env?.VITE_GATEWAY_URL as string | undefined) || 'http://localhost:8787').replace(/\/+$/, '');

/**
 * Streams a reply. Yields normalised events identical in shape across every
 * provider, so nothing here needs to know which model answered.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { messages, surface = 'chat', model, conversationId, signal, canBrowse = false } = options;

  // The gateway pays for every token it forwards, so it needs to know who is
  // asking. Without a session it answers 401 and nothing is spent.
  let response: Response;
  const send = async () => {
    const token = await getAccessToken();
    return fetch(`${GATEWAY_URL}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        messages, surface, model, conversationId,
        // Declared per request, because it is a property of the caller and not
        // of the account: the same user has a browser on the desktop and a
        // hosted one on the web, and neither before they have signed in.
        canBrowse,
      }),
      signal,
    });
  };

  try {
    if (signal?.aborted) return;
    response = await send();
  } catch (error) {
    // Abort is a deliberate user action, not a failure to report.
    if (signal?.aborted) return;
    /*
     * The desktop starts its own gateway, so a message sent during that window
     * should wait for it rather than blaming the user's connection.
     *
     * Retried exactly once, in place. Recursing into streamChat here would
     * loop without end the moment the gateway reports healthy while the
     * request keeps failing for some other reason — a wrong port, a proxy —
     * because every pass would be told it was fine and try again immediately.
     */
    const { ready, note } = await waitForGateway();
    let retried: Response | null = null;
    if (ready && !signal?.aborted) {
      try { retried = await send(); } catch { retried = null; }
    }
    if (!retried) {
      if (signal?.aborted) return;
      yield {
        type: 'error',
        message: note || 'Aira could not connect. Check Connections and try again.',
        retryable: true,
        fault: 'gateway',
      };
      return;
    }
    response = retried;
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
  const fetchOnce = async () => {
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
  };
  try {
    return await fetchOnce();
  } catch {
    /*
     * An empty catalogue is indistinguishable from a configured one on a
     * gateway that has not finished starting, and the model picker renders
     * both as "no models". On the desktop this is usually the second case, so
     * it is worth waiting out the cold start before believing the empty list.
     */
    const { ready } = await waitForGateway();
    if (!ready) return { models: [], routing: {} };
    try {
      return await fetchOnce();
    } catch {
      return { models: [], routing: {} };
    }
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
  const send = () => fetch(`${GATEWAY_URL}${path}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(12000) });
  let response: Response;
  try { response = await send(); }
  catch {
    /*
     * On the desktop this is as likely to be "not up yet" as "not there". The
     * app starts its own gateway at launch and a cold one takes seconds, so the
     * first requests after opening Aira can arrive before it is listening —
     * which used to greet the user with a connection error on every screen at
     * once, moments before it would have worked.
     */
    const { ready, note } = await waitForGateway();
    if (!ready) throw new Error(note || 'Could not reach Aira. Check your connection and try again.');
    try { response = await send(); }
    catch { throw new Error('Could not reach Aira. Check your connection and try again.'); }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = typeof body?.error === 'string' ? body.error : body?.error?.message;
    throw new Error(error || (response.status === 401 ? 'Sign in to manage your workspace.' : `Request failed (${response.status}).`));
  }
  return response.json() as Promise<T>;
}

/** Recent spend for the signed-in user, as the gateway sees it. */
export interface UsageSummary {
  /** False when a model in the window has no verified price, so the total is a floor. */
  complete: boolean;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  windowHours: number;
  /** Always false today: the window lives in the gateway's memory. */
  durable: boolean;
}

export async function fetchUsage(surface?: string): Promise<UsageSummary | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const url = new URL(`${GATEWAY_URL}/v1/usage`);
  if (surface) url.searchParams.set('surface', surface);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  return response.json() as Promise<UsageSummary>;
}

/** A second model's answer, and one sentence on what the two make you choose. */
export interface SecondOpinion {
  answer: string;
  model: string;
  /** Null when no local judge was available; the answers still stand alone. */
  difference: string | null;
}

/**
 * Asks a different model the same question.
 *
 * Never automatic. A second opinion costs a second request, so it happens when
 * the reader asks for one — and only they can decide an answer is worth
 * checking.
 */
export async function fetchSecondOpinion(
  messages: Array<{ role: string; content: string }>,
  answer: string,
  model: string,
): Promise<SecondOpinion> {
  const token = await getAccessToken();
  if (!token) throw new Error('Sign in to ask for a second opinion.');
  const response = await fetch(`${GATEWAY_URL}/v1/second-opinion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages, answer, model }),
  });
  const body = await response.json().catch(() => ({})) as SecondOpinion & { error?: string };
  if (!response.ok) throw new Error(body.error || 'The second opinion could not be fetched.');
  return body;
}

/** A page the user read, found again by something they remember from it. */
export interface PageHit {
  url: string;
  title: string;
  excerpt: string;
  at: string;
}

/**
 * Keeps a page the user read.
 *
 * Silent on every failure. This runs because the user browsed, not because they
 * asked, so there is nothing to report a problem to — and a browser that
 * interrupts reading to complain about memory is worse than one that forgets.
 */
export async function keepPage(page: { url: string; title: string; text: string }): Promise<boolean> {
  try {
    const token = await getAccessToken();
    if (!token) return false;
    const response = await fetch(`${GATEWAY_URL}/v1/memory/pages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(page),
    });
    if (!response.ok) return false;
    return Boolean(((await response.json()) as { kept?: boolean }).kept);
  } catch {
    return false;
  }
}

/** Searches pages the user has read. */
export async function searchPages(query: string): Promise<PageHit[]> {
  const token = await getAccessToken();
  if (!token) return [];
  const url = new URL(`${GATEWAY_URL}/v1/memory/pages`);
  url.searchParams.set('q', query);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return [];
  return ((await response.json()) as { hits?: PageHit[] }).hits ?? [];
}
