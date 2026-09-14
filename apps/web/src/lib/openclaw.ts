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
  model?: string | null;
  /** How many members the runtime was configured with; 0 when unknown. */
  fleet?: number;
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
  /**
   * "id|tier" per model the gateway serves.
   *
   * Lets each role take a model that suits it — synthesis and review on the
   * strongest, drafting on a cheaper one — rather than the whole fleet sharing
   * the routed model.
   */
  catalogue?: string[];
  /**
   * Run the fleet on models served from this machine where one fits the tier.
   *
   * A preference, not a filter: a tier with nothing local in it still gets a
   * remote model, because half a fleet is worse than a slow one.
   */
  localOnly?: boolean;
}

export const supervisor = {
  status: () => invoke<OpenClawStatus>('openclaw_status'),
  start: (options: StartOptions) => invoke<OpenClawStatus>('openclaw_start', { ...options }),
  stop: () => invoke<void>('openclaw_stop'),
  /** Tail of the agent's own stderr — what it said before it gave up. */
  log: () => invoke<string[]>('openclaw_log'),
  /** Recurring tasks the gateway runs on its own. */
  schedules: () => invoke<Schedule[]>('openclaw_schedules'),
  addSchedule: (job: { name: string; every: string; agent: string; prompt: string }) =>
    invoke<void>('openclaw_schedule_add', job),
  removeSchedule: (id: string) => invoke<void>('openclaw_schedule_remove', { id }),
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
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
      throw new Error('The task runtime returned invalid connection details.');
    }
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

  /** Runs a task and resolves with the whole reply. */
  run(agentId: string, message: string): Promise<string> {
    return invoke<string>('openclaw_run', {
      port: this.port,
      token: this.token,
      agent: agentId,
      message,
    });
  }

  /**
   * Runs a task, calling `onDelta` as the reply arrives.
   *
   * The shell reads the stream and re-emits each delta on a Tauri channel,
   * since the webview cannot read it directly. The run id keeps several agents
   * streaming at once separable — they all share one event bus.
   */
  async stream(
    agentId: string,
    message: string,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    await streamTask({ invoke, listen }, { port: this.port, token: this.token, agent: agentId, message }, onDelta, signal);
  }
}

export interface TaskBridge {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(name: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
}

/** Subscribe before dispatch; only the native command's result completes a run. */
export async function streamTask(
  bridge: TaskBridge,
  request: { port: number; token: string; agent: string; message: string },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const run = crypto.randomUUID();
  const off = await bridge.listen<string>(`openclaw://delta/${run}`, event => {
    if (!signal?.aborted) onDelta(event.payload);
  });
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        // Cancels this run only. OpenClaw exposes no per-task cancellation API,
        // so the shell drops its end of the stream instead — which stops the
        // deltas at once and leaves the runtime up for the next task.
        void bridge.invoke<void>('openclaw_cancel', { run }).then(
          () => reject(new DOMException('The task was stopped.', 'AbortError')),
          error => reject(new Error(`Could not confirm task cancellation: ${String(error)}`)),
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
    await Promise.race([bridge.invoke<void>('openclaw_stream', { ...request, run }), cancelled]);
    signal?.throwIfAborted();
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    off();
  }
}

/** A task the gateway repeats without anyone present. */
export interface Schedule {
  id: string;
  name: string;
  /** "every 2h", or the cron expression the job was created with. */
  when: string;
  agent: string;
  prompt: string;
  enabled: boolean;
}

/**
 * Waits for the whole fleet to register.
 *
 * Members appear in the runtime's model list one at a time as they come up, so
 * a single read taken during startup sees whichever ones happen to have landed
 * — usually just the lead. `expected` is the count the runtime was configured
 * with; without it (an older shell than this build) wait for the list to stop
 * growing instead, which arrives at the same answer a beat later.
 */
export async function collectFleet(
  client: { agents: () => Promise<AgentEntry[]> },
  expected: number,
  running: () => boolean,
  /** Overridable so tests need no real clock. */
  delayMs = 500,
): Promise<AgentEntry[]> {
  let found: AgentEntry[] = [];
  let previous = -1;
  for (let attempt = 0; attempt < 60 && running(); attempt++) {
    try {
      const seen = await client.agents();
      if (seen.length >= found.length) found = seen;
      if (expected > 0 ? found.length >= expected : found.length > 0 && seen.length === previous) break;
      previous = seen.length;
    } catch { /* startup can take a moment */ }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return found;
}

/** A fleet member as the shell reports it — Aira's own, or one the user added. */
export interface FleetMember {
  id: string;
  name: string;
  description: string;
  brief: string;
  tier: string;
  tools: string[];
  /** False for the six that ship with Aira; those cannot be edited or removed. */
  custom: boolean;
}

export interface FleetOptions {
  members: FleetMember[];
  /**
   * Tools a custom agent may be given.
   *
   * Comes from the shell rather than being listed here, because it is a
   * security boundary and there must be exactly one copy of it. A UI that kept
   * its own list would drift and start offering something the shell refuses.
   */
  grantable: string[];
  tiers: string[];
  maxCustom: number;
  used: number;
}

export interface NewAgent {
  id: string;
  name: string;
  description: string;
  brief: string;
  tier: string;
  tools: string[];
}

/** Shell field names are snake_case; the panel speaks camelCase. */
function toOptions(raw: Record<string, unknown>): FleetOptions {
  return {
    members: (raw.members as FleetMember[]) ?? [],
    grantable: (raw.grantable as string[]) ?? [],
    tiers: (raw.tiers as string[]) ?? [],
    maxCustom: Number(raw.max_custom ?? raw.maxCustom ?? 0),
    used: Number(raw.used ?? 0),
  };
}

export const roster = {
  list: async (): Promise<FleetOptions> => toOptions(await invoke('fleet_list')),
  add: async (agent: NewAgent): Promise<FleetOptions> => toOptions(await invoke('fleet_add', { agent })),
  remove: async (id: string): Promise<FleetOptions> => toOptions(await invoke('fleet_remove', { id })),
};
