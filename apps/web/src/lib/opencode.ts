import { parseSSE } from './sse';

/**
 * Client for the OpenCode agent server.
 *
 * OpenCode runs as a local subprocess supervised by the desktop shell, so this
 * only works in the Tauri app — the agent needs the user's actual files, which
 * a browser tab cannot reach. On the web the panel says so rather than failing
 * obscurely.
 *
 * Everything here talks to 127.0.0.1 with a per-launch password the shell
 * minted. That password is not optional: the server runs shell commands, and
 * without it any process on the machine could drive it.
 */

export interface OpenCodeStatus {
  running: boolean;
  port: number | null;
  password: string | null;
  /** Path to the binary, or null when OpenCode is not installed. */
  binary: string | null;
}

/** True inside the Tauri shell; false in a browser tab. */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Imported lazily so the web bundle never pulls the desktop bridge.
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(command, args);
}

export const supervisor = {
  status: () => invoke<OpenCodeStatus>('opencode_status'),
  start: (directory?: string) => invoke<OpenCodeStatus>('opencode_start', { directory }),
  stop: () => invoke<void>('opencode_stop'),
};

// ── server API ───────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  directory: string;
  title?: string;
}

/** A tool the agent wants to run, awaiting the user's decision. */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
}

export type AgentEvent =
  | { kind: 'text'; sessionID: string; messageID: string; partID: string; delta: string }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'permission-resolved'; id: string }
  | { kind: 'file-edited'; path: string }
  | { kind: 'idle'; sessionID: string }
  | { kind: 'other'; type: string };

export class OpenCodeClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(port: number, password: string) {
    this.base = `http://127.0.0.1:${port}`;
    this.auth = `Basic ${btoa(`opencode:${password}`)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: this.auth, ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`OpenCode ${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  health() {
    return this.request<{ healthy: boolean; version: string }>('/global/health');
  }

  createSession(directory?: string) {
    return this.request<Session>('/session', {
      method: 'POST',
      body: JSON.stringify(directory ? { directory } : {}),
    });
  }

  /**
   * Sends a task. Resolves when the agent finishes; progress arrives on the
   * event stream rather than in this response.
   */
  sendMessage(sessionID: string, text: string) {
    return this.request<unknown>(`/session/${sessionID}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });
  }

  abort(sessionID: string) {
    return this.request<unknown>(`/session/${sessionID}/abort`, { method: 'POST' });
  }

  /** `once` allows this call only; `always` remembers it; `reject` denies it. */
  replyPermission(requestID: string, reply: 'once' | 'always' | 'reject') {
    return this.request<unknown>(`/permission/${requestID}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply }),
    });
  }

  /**
   * Normalises the server's ~94 event types down to the handful the panel acts
   * on. Unrecognised events are surfaced as `other` rather than dropped, so a
   * new event type shows up in the log instead of vanishing.
   */
  async *events(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const response = await fetch(`${this.base}/event`, {
      headers: { Authorization: this.auth },
      signal,
    });
    if (!response.body) return;

    for await (const data of parseSSE(response.body)) {
      if (!data) continue;
      let event: { type?: string; properties?: Record<string, unknown> };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const p = (event.properties ?? {}) as Record<string, string>;

      switch (event.type) {
        case 'message.part.delta':
          if (p.field === 'text' && p.delta) {
            yield {
              kind: 'text',
              sessionID: p.sessionID,
              messageID: p.messageID,
              partID: p.partID,
              delta: p.delta,
            };
          }
          break;
        case 'permission.asked':
        case 'permission.v2.asked':
          yield {
            kind: 'permission',
            request: {
              id: p.id,
              sessionID: p.sessionID,
              action: p.action,
              resources: (p.resources as unknown as string[]) ?? [],
            },
          };
          break;
        case 'permission.replied':
        case 'permission.v2.replied':
          yield { kind: 'permission-resolved', id: p.id };
          break;
        case 'file.edited':
          yield { kind: 'file-edited', path: p.path ?? p.file ?? '' };
          break;
        case 'session.idle':
          yield { kind: 'idle', sessionID: p.sessionID };
          break;
        default:
          yield { kind: 'other', type: event.type ?? 'unknown' };
      }
    }
  }
}
