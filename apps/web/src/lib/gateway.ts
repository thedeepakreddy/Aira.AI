/**
 * Client for the Aira gateway.
 *
 * The gateway holds every provider key, so this module only ever talks to our
 * own origin — no vendor SDK, no API key, nothing sensitive reaches the browser
 * or the packaged desktop app.
 */

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
  | { type: 'error'; message: string; retryable: boolean };

export interface StreamChatOptions {
  messages: ChatMessage[];
  surface?: Surface;
  model?: string;
  conversationId?: string | null;
  signal?: AbortSignal;
}

const GATEWAY_URL: string =
  (import.meta.env?.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787';

/** Dev-only shim so the gateway can be exercised before Supabase auth is wired. */
const DEV_USER = import.meta.env?.VITE_AIRA_DEV_USER as string | undefined;

/**
 * Parses an SSE byte stream into discrete `data:` payloads.
 *
 * A chunk boundary can land anywhere, including mid-event, so bytes are held in
 * a buffer until a complete `\n\n`-delimited frame is present. Splitting on
 * chunk arrival instead would corrupt any event that spans two reads.
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams a reply. Yields normalised events identical in shape across every
 * provider, so nothing here needs to know which model answered.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const { messages, surface = 'chat', model, conversationId, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${GATEWAY_URL}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DEV_USER ? { 'x-aira-dev-user': DEV_USER } : {}),
      },
      body: JSON.stringify({ messages, surface, model, conversationId }),
      signal,
    });
  } catch (error) {
    // Abort is a deliberate user action, not a failure to report.
    if (signal?.aborted) return;
    yield {
      type: 'error',
      message: `Can't reach Aira's gateway at ${GATEWAY_URL}. Is it running?`,
      retryable: true,
    };
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
    yield { type: 'error', message, retryable: response.status >= 500 };
    return;
  }

  try {
    for await (const data of parseSSE(response.body)) {
      if (!data) continue;
      try {
        yield JSON.parse(data) as StreamEvent;
      } catch {
        // A malformed frame shouldn't kill an otherwise healthy stream.
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    yield { type: 'error', message: 'The connection dropped mid-response.', retryable: true };
  }
}
