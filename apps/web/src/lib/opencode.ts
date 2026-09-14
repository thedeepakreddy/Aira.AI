import { parseSSE } from './sse.ts';
import { invoke, isDesktop } from './bridge.ts';

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
  /** Working directory of the running server, or null when it is not running. */
  directory: string | null;
  /** Model configured on the supervised process, not a routing guess. */
  model?: string | null;
}

/** True inside the Tauri shell; false in a browser tab. */
export { isDesktop };

export interface StartOptions {
  directory?: string;
  /**
   * A public repository to seed a hosted workspace from.
   *
   * Only meaningful off the desktop: there the agent works in a folder the user
   * picked, and there is nothing to clone.
   */
  repo?: string;
  /** Base URL of the Aira gateway the agent should bill through. */
  gatewayUrl: string;
  /** Current session token. Passed to the agent's environment, never to disk. */
  token: string;
  /** Model id as the gateway knows it; the shell qualifies it as `aira/<id>`. */
  model: string;
  /**
   * Every model the gateway serves.
   *
   * All of them are declared in the agent's config, not just the routed one:
   * OpenCode stores a model per session, so declaring only the current route
   * strands existing sessions the moment that route changes.
   */
  catalogue?: string[];
}

/**
 * Native folder picker, so the agent can be pointed at a project.
 *
 * Imported lazily for the same reason as the supervisor bridge: the web bundle
 * must not pull in the desktop plugin. Returns null when the user cancels.
 */
export async function pickDirectory(current?: string): Promise<string | null> {
  if (!isDesktop) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const chosen = await open({ directory: true, multiple: false, defaultPath: current || undefined });
  return typeof chosen === 'string' ? chosen : null;
}

export const supervisor = {
  status: () => invoke<OpenCodeStatus>('opencode_status'),
  start: (options: StartOptions) => invoke<OpenCodeStatus>('opencode_start', { ...options }),
  stop: () => invoke<void>('opencode_stop'),
  /** Tail of the agent's own stderr — what it said before it gave up. */
  log: () => invoke<string[]>('opencode_log'),
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

/** One stored message, as the server replays it. */
export interface MessageRecord {
  info?: { id?: string; role?: string };
  parts?: { id?: string; type?: string; text?: string; tool?: string; state?: { status?: string; input?: Record<string,unknown> } }[];
}

/** What the agent is doing right now, so long steps are legible. */
/**
 * Turns a failed tool's state into one line a person can act on.
 *
 * The case worth naming is a path outside the project. OpenCode refuses those
 * outright, with no prompt, so every command touching one fails instantly and
 * identically — and the remedy is not "try again" but "you opened a folder one
 * level too deep", which nothing in the raw error says.
 */
export function describeToolError(state: unknown): string | undefined {
  const raw = state && typeof state === 'object'
    ? (state as { error?: unknown; output?: unknown }).error ?? (state as { output?: unknown }).output
    : undefined;
  if (raw === undefined || raw === null) return undefined;
  const text = (typeof raw === 'string' ? raw : JSON.stringify(raw)).trim();
  if (!text) return undefined;
  if (/external_directory|outside (the |your )?(project|workspace)|not (in|within) the project/i.test(text)) {
    return 'Outside your project folder — reconnect with the folder that contains it.';
  }
  // Long tool output is a wall of text on one line; the first sentence is the
  // part that says what went wrong.
  const first = text.split('\n')[0];
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

export interface ToolActivity {
  /** Stable per tool call, so updates replace rather than stack up. */
  partID: string;
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  /** The thing being acted on: a path, a command, a search term. */
  target: string;
  /**
   * Why it failed, when it did.
   *
   * The runtime has always sent this and the panel always dropped it, so a
   * denied path and an overloaded model both rendered as a bare cross — two
   * failures needing opposite responses, shown identically.
   */
  error?: string;
}

export type AgentEvent =
  | { kind: 'text'; sessionID: string; messageID: string; partID: string; delta: string }
  | { kind: 'tool'; sessionID?: string; activity: ToolActivity }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'permission-resolved'; sessionID?: string; id: string; reply?: string }
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'question-resolved'; sessionID?: string; id: string; answers?: string[][] }
  | { kind: 'file-edited'; sessionID?: string; path: string }
  | { kind: 'idle'; sessionID: string }
  | { kind: 'status'; sessionID: string; status: string }
  | { kind: 'error'; sessionID?: string; message: string }
  | { kind: 'other'; type: string };

interface ToolPart {
  type?: string;
  id?: string;
  tool?: string;
  sessionID?: string;
  state?: { status?: string; input?: Record<string, unknown> };
}

/**
 * Picks the most meaningful field out of a tool's input.
 *
 * Tools disagree on what to call their subject — a path, a command, a pattern —
 * so the first recognised key wins and anything unknown shows nothing rather
 * than a blob of JSON.
 */
export function toolTarget(input: Record<string, unknown> | undefined): string {
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
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !password) {
      throw new Error('The coding runtime returned invalid connection details.');
    }
    this.base = `http://127.0.0.1:${port}`;
    this.auth = `Basic ${btoa(`opencode:${password}`)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: this.auth, ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenCode request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : '.'}`);
    }
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  /** Sessions the server knows about, including ones from earlier runs. */
  sessions() {
    return this.request<(Session & { time?: { updated?: number } })[]>('/session');
  }

  /** Every message in a session, used to rebuild the log after a remount. */
  messages(sessionID: string) {
    return this.request<MessageRecord[]>(`/session/${encodeURIComponent(sessionID)}/message`);
  }

  sessionStatuses() { return this.request<Record<string, { type: string }>>('/session/status'); }
  async permissions(): Promise<PermissionRequest[]> {
    const requests = await this.request<(PermissionRequest & { permission?: string; patterns?: string[] })[]>('/permission');
    return requests.map(request => ({ ...request, action: request.action ?? request.permission ?? 'action', resources: request.resources ?? request.patterns ?? [] }));
  }
  questions() { return this.request<QuestionRequest[]>('/question'); }

  health() {
    return this.request<{ healthy: boolean; version: string }>('/global/health', { signal: AbortSignal.timeout(2_000) });
  }

  /**
   * Opens a session, optionally in a specific folder.
   *
   * The directory goes in the query string. Sending it in the body — the
   * obvious guess, and what the body schema seems to invite — is accepted and
   * silently ignored: the session comes back rooted at the server process's own
   * working directory instead.
   */
  createSession(directory?: string) {
    const path = directory ? `/session?directory=${encodeURIComponent(directory)}` : '/session';
    return this.request<Session>(path, { method: 'POST', body: '{}' });
  }

  /**
   * Accepts a task without holding an HTTP request open for the whole run.
   * Completion and failure arrive on the event stream.
   */
  sendMessage(sessionID: string, text: string) {
    return this.request<unknown>(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });
  }

  abort(sessionID: string) {
    return this.request<unknown>(`/session/${encodeURIComponent(sessionID)}/abort`, { method: 'POST' });
  }

  /** `once` allows this call only; `always` remembers it; `reject` denies it. */
  replyPermission(requestID: string, reply: 'once' | 'always' | 'reject') {
    return this.request<unknown>(`/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply }),
    });
  }

  /**
   * Answers the agent's question. One entry per question, in order; each entry
   * holds the labels the user picked (several only when `multiple` is set).
   */
  replyQuestion(requestID: string, answers: string[][]) {
    return this.request<boolean>(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
  }

  /** Declines to answer. The agent carries on with what it already knows. */
  rejectQuestion(requestID: string) {
    return this.request<boolean>(`/question/${encodeURIComponent(requestID)}/reject`, { method: 'POST' });
  }

  /**
   * Normalises the server's ~94 event types down to the handful the panel acts
   * on. Unrecognised events are surfaced as `other` rather than dropped, so a
   * new event type shows up in the log instead of vanishing.
   */
  async *events(signal: AbortSignal, sessionID?: string, onOpen?: () => void): AsyncGenerator<AgentEvent> {
    const response = await fetch(`${this.base}/event`, {
      headers: { Authorization: this.auth },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Coding agent event stream failed (${response.status}).`);
    onOpen?.();

    for await (const data of parseSSE(response.body)) {
      if (!data) continue;
      let event: { type?: string; properties?: Record<string, unknown> };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const p = (event.properties ?? {}) as Record<string, string>;
      const scoped = p.sessionID ?? (p as unknown as { part?: ToolPart }).part?.sessionID;
      if (sessionID && scoped && scoped !== sessionID) continue;

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
          if (id) yield { kind: 'permission-resolved', sessionID: scoped, id, reply: replied.reply };
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
          if (id) yield { kind: 'question-resolved', sessionID: scoped, id, answers: replied.answers };
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
            sessionID: scoped,
            activity: {
              partID: part.id,
              tool: part.tool ?? 'tool',
              status: (part.state?.status as ToolActivity['status']) ?? 'running',
              target: toolTarget(part.state?.input),
              error: describeToolError(part.state),
            },
          };
          break;
        }
        case 'file.edited':
          yield { kind: 'file-edited', sessionID: scoped, path: p.path ?? p.file ?? '' };
          break;
        case 'session.idle':
          yield { kind: 'idle', sessionID: p.sessionID };
          break;
        case 'session.status': {
          const status = (p as unknown as { status?: { type?: string } }).status?.type;
          if (status) yield { kind: 'status', sessionID: p.sessionID, status };
          break;
        }
        case 'session.error': {
          const error = (p as unknown as { error?: { name?: string; data?: { message?: string }; message?: string } }).error;
          yield { kind: 'error', sessionID: scoped, message: error?.data?.message ?? error?.message ?? error?.name ?? 'The coding task failed.' };
          break;
        }
        default:
          yield { kind: 'other', type: event.type ?? 'unknown' };
      }
    }
  }
}
