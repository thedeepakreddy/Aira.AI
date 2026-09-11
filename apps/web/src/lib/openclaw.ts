/**
 * Client for the OpenClaw task agent.
 *
 * Like OpenCode, it runs as a local subprocess supervised by the desktop shell,
 * so this only works in the Tauri app.
 *
 * Unlike OpenCode, none of its HTTP is called from here. OpenClaw's gateway
 * sends no CORS headers and answers 405 to a preflight, so from the webview's
 * `tauri://localhost` origin every response is discarded by the browser and
 * every authenticated request never leaves — while the server sits there
 * healthy, which reads as a hung agent rather than a blocked one. The requests
 * are made in the Rust shell instead, where the same-origin policy does not
 * apply.
 */

export interface OpenClawStatus {
  running: boolean;
  port: number | null;
  token: string | null;
  /** Path to the binary, or null when OpenClaw is not installed. */
  binary: string | null;
}

/** True inside the Tauri shell; false in a browser tab. */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(command, args);
}

export interface StartOptions {
  /** Base URL of the Aira gateway the agent should bill through. */
  gatewayUrl: string;
  /** Current session token. Passed to the agent's environment, never to disk. */
  token: string;
  /** Model id as the gateway knows it. */
  model: string;
}

export const supervisor = {
  status: () => invoke<OpenClawStatus>('openclaw_status'),
  start: (options: StartOptions) => invoke<OpenClawStatus>('openclaw_start', { ...options }),
  stop: () => invoke<void>('openclaw_stop'),
  /** Tail of the agent's own stderr — what it said before it gave up. */
  log: () => invoke<string[]>('openclaw_log'),
};

// ── server API ───────────────────────────────────────────────────────────────

/** One agent the gateway will route a task to. */
export interface Agent {
  /** As the API wants it back: `openclaw` or `openclaw/<agentId>`. */
  id: string;
  /** The part worth showing: "main", "default". */
  name: string;
}

/** What the Rust bridge hands back for each agent. */
interface AgentEntry {
  id: string;
  name: string;
}

export class OpenClawClient {
  private readonly port: number;
  private readonly token: string;

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
  }

  /** Liveness, by way of the shell — see the note above on why not `fetch`. */
  async health(): Promise<boolean> {
    try {
      await invoke<AgentEntry[]>('openclaw_agents', { port: this.port, token: this.token });
      return true;
    } catch {
      return false;
    }
  }

  async agents(): Promise<Agent[]> {
    return invoke<AgentEntry[]>('openclaw_agents', { port: this.port, token: this.token });
  }

  /**
   * Runs a task and resolves with the whole reply.
   *
   * Not streamed: crossing the bridge a token at a time needs an event channel
   * on both sides, and the agent's answer is a finished piece of work rather
   * than something you read as it arrives.
   */
  run(agentId: string, message: string): Promise<string> {
    return invoke<string>('openclaw_run', {
      port: this.port,
      token: this.token,
      agent: agentId,
      message,
    });
  }
}
