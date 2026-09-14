/**
 * One call, two places it can land.
 *
 * Every runtime the app drives — the agent fleet, the coding agent, the browser
 * — is reached by naming a command: `openclaw_start`, `browser_api`, and the
 * rest. In the desktop app those names go over Tauri's bridge to processes on
 * this machine. In a browser tab there is no bridge, and until now that was the
 * end of it: three surfaces that simply did not work on the web.
 *
 * This routes the same names to the gateway instead, which runs the same
 * runtimes server-side. Panels call `invoke` and do not know or care which one
 * answered — and that is the point. A panel that branched on where it was
 * running would grow two behaviours, and the two would drift.
 *
 * What the gateway cannot honour, it refuses by name with a message saying so,
 * rather than this file keeping a list of what works where. One copy of that
 * knowledge, on the side that actually has it.
 */

/*
 * The auth client is imported lazily, not at module load.
 *
 * It reads Vite's `import.meta.env` on the way in, which does not exist outside
 * a Vite build — so importing it here eagerly made this module, and every
 * runtime client that imports it, impossible to load in a test. A transport
 * should not drag its whole dependency graph in behind it.
 */
async function accessToken(): Promise<string | null> {
  const { getAccessToken } = await import('./supabase.ts');
  return getAccessToken();
}

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const GATEWAY_URL = (import.meta.env?.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787';

/** Raised when a command exists but cannot run where the user is. */
export class NotHereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotHereError';
  }
}

async function overGateway<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const token = await accessToken();
  if (!token) throw new Error('Sign in to use Aira\'s runtimes.');
  const response = await fetch(`${GATEWAY_URL}/v1/runtime/invoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command, args: args ?? {} }),
  });
  const body = await response.json().catch(() => ({})) as { result?: T; error?: string };
  if (response.status === 501) throw new NotHereError(body.error ?? 'That needs the Aira desktop app.');
  if (!response.ok) throw new Error(body.error ?? `The runtime failed (${response.status}).`);
  return body.result as T;
}

/**
 * Calls a runtime command wherever it can be served.
 *
 * The Tauri import is dynamic and only reached on the desktop, so a browser
 * build never pulls it in — importing it eagerly would fail at module load in
 * a plain tab, which is why this indirection exists at all.
 */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    const { invoke: call } = await import('@tauri-apps/api/core');
    return call<T>(command, args);
  }
  return overGateway<T>(command, args);
}

/**
 * Streams a hosted agent's reply.
 *
 * Only used off the desktop; there, deltas arrive on a Tauri channel instead.
 * Frames are newline-delimited and a chunk can split one, so the tail is held
 * back until it completes — the same buffering every stream in this app needs.
 */
export async function streamOverGateway(
  request: { agent: string; message: string },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = await accessToken();
  if (!token) throw new Error('Sign in to use Aira\'s runtimes.');
  const response = await fetch(`${GATEWAY_URL}/v1/runtime/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `The agent runtime failed (${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const frame = JSON.parse(line.slice(6)) as { delta?: string; error?: string; done?: boolean };
        if (frame.error) throw new Error(frame.error);
        if (frame.delta) onDelta(frame.delta);
      } catch (error) {
        if (error instanceof Error && error.message && !error.message.startsWith('Unexpected')) throw error;
      }
    }
  }
}
