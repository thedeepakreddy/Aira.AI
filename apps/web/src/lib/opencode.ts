import { parseSSE } from './sse.ts';

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

export interface StartOptions {
  directory?: string;
  /** Base URL of the Aira gateway the agent should bill through. */
  gatewayUrl: string;
  /** Current session token. Passed to the agent's environment, never to disk. */
  token: string;
  /** Model id as the gateway knows it; the shell qualifies it as `aira/<id>`. */
  model: string;
}

export const supervisor = {
  status: () => invoke<OpenCodeStatus>('opencode_status'),
  start: (options: StartOptions) => invoke<OpenCodeStatus>('opencode_start', { ...options }),
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

/** One choice offered by the agent's `question` tool. */
export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  /** Very short label — the server caps it at 30 characters. */
  header: string;
  options: QuestionOption[];
  /** When true the user may pick several options. */
  multiple?: boolean;
  /** When true the user may type an answer of their own. */
  custom?: boolean;
}

/**
 * The agent asking the user something before it continues.
 *
 * This is not a permission prompt: the run blocks until every question is
 * answered, and nothing in the session advances in the meantime. Without a UI
 * for it a task like "build a calculator app" hangs forever on a spinner.
 */
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
}

/** What the agent is doing right now, so long steps are legible. */
export interface ToolActivity {
  /** Stable per tool call, so updates replace rather than stack up. */
  partID: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  /** The thing being acted on: a path, a command, a search term. */
  target: string;
}

export type AgentEvent =
  | { kind: 'text'; sessionID: string; messageID: string; partID: string; delta: string }
  | { kind: 'tool'; activity: ToolActivity }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'permission-resolved'; id: string; reply?: string }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'question-resolved'; id: string; answers?: string[][] }
  | { kind: 'file-edited'; path: string }
  | { kind: 'idle'; sessionID: string }
  | { kind: 'other'; type: string };

interface ToolPart {
  type?: string;
  id?: string;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown> };
}

/**
 * Picks the most meaningful field out of a tool's input.
 *
 * Tools disagree on what to call their subject — a path, a command, a pattern —
 * so the first recognised key wins and anything unknown shows nothing rather
 * than a blob of JSON.
 */
function toolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['filePath', 'path', 'command', 'pattern', 'query', 'description', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

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
   * Answers the agent's question. One entry per question, in order; each entry
   * holds the labels the user picked (several only when `multiple` is set).
   */
  replyQuestion(requestID: string, answers: string[][]) {
    return this.request<boolean>(`/question/${requestID}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
  }

  /** Declines to answer. The agent carries on with what it already knows. */
  rejectQuestion(requestID: string) {
    return this.request<boolean>(`/question/${requestID}/reject`, { method: 'POST' });
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
        case 'permission.v2.asked': {
          // The two event generations disagree, and the OpenAPI spec describes
          // only the v2 shape: v1 sends `permission` + `patterns`, v2 sends
          // `action` + `resources`. Reading only the documented names left the
          // prompt with a blank action and no filenames, so both are accepted.
          const raw = p as unknown as {
            id: string;
            sessionID: string;
            permission?: string;
            action?: string;
            patterns?: string[];
            resources?: string[];
            metadata?: { filepath?: string };
          };
          const resources = raw.patterns ?? raw.resources ?? [];
          yield {
            kind: 'permission',
            request: {
              id: raw.id,
              sessionID: raw.sessionID,
              action: raw.action ?? raw.permission ?? 'action',
              // Absolute paths read better than the relative pattern form.
              resources: resources.length
                ? resources
                : raw.metadata?.filepath
                  ? [raw.metadata.filepath]
                  : [],
            },
          };
          break;
        }
        case 'permission.replied':
        case 'permission.v2.replied': {
          // The reply event names the request `requestID`, while the ask event
          // names it `id`. Reading only `id` here left every prompt stuck
          // showing its buttons after the user had already answered it.
          const replied = p as unknown as { id?: string; requestID?: string; reply?: string };
          const id = replied.requestID ?? replied.id;
          if (id) yield { kind: 'permission-resolved', id, reply: replied.reply };
          break;
        }
        case 'question.asked':
        case 'question.v2.asked': {
          // Same two-generation split as permissions; the live server emits the
          // unversioned names, the spec documents both. Their payloads match.
          const raw = p as unknown as QuestionRequest;
          if (raw.id && Array.isArray(raw.questions)) yield { kind: 'question', request: raw };
          break;
        }
        case 'question.replied':
        case 'question.v2.replied':
        case 'question.rejected':
        case 'question.v2.rejected': {
          // As with permissions, the reply names the request `requestID` while
          // the ask names it `id`.
          const replied = p as unknown as { id?: string; requestID?: string; answers?: string[][] };
          const id = replied.requestID ?? replied.id;
          if (id) yield { kind: 'question-resolved', id, answers: replied.answers };
          break;
        }
        case 'message.part.updated': {
          const part = (p as unknown as { part?: ToolPart }).part;
          if (part?.type !== 'tool' || !part.id) break;
          // The question tool gets its own card with the actual question in it;
          // a spinner reading "question" next to it says nothing.
          if (part.tool === 'question') break;
          yield {
            kind: 'tool',
            activity: {
              partID: part.id,
              tool: part.tool ?? 'tool',
              status: (part.state?.status as ToolActivity['status']) ?? 'running',
              target: toolTarget(part.state?.input),
            },
          };
          break;
        }
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
