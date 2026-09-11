/**
 * Client for Aira's browsing agent.
 *
 * The third supervised subprocess, and the one with the most reach: it drives a
 * real Chrome and acts on whatever a page says. Its HTTP is called from the
 * Rust shell rather than here — same reason as the task agent, and the same
 * benefit of keeping a loopback service out of the webview's origin.
 */

export interface BrowserStatus {
  running: boolean;
  port: number | null;
  token: string | null;
  /** Path to the service's Python, or null when it is not installed. */
  python: string | null;
}

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(command, args);
}

export interface StartOptions {
  gatewayUrl: string;
  token: string;
  model: string;
}

export const supervisor = {
  status: () => invoke<BrowserStatus>('browser_status'),
  start: (options: StartOptions) => invoke<BrowserStatus>('browser_start', { ...options }),
  stop: () => invoke<void>('browser_stop'),
  log: () => invoke<string[]>('browser_log'),
};

/** One thing the agent did, as the panel shows it. */
export type BrowseEvent =
  | { type: 'start'; task: string; model: string }
  | { type: 'step'; n: number; url: string; action: string }
  | { type: 'result'; text: string; steps: number; urls: string[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

export class BrowserClient {
  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  /**
   * Runs a browsing task, reporting each step as it happens.
   *
   * A browse takes tens of seconds and spends most of it looking at a page, so
   * the steps are not decoration — without them the panel is a spinner over a
   * process that might equally be stuck.
   */
  async run(
    task: string,
    maxSteps: number,
    onEvent: (event: BrowseEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    const run = crypto.randomUUID();

    let stop: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      void listen<BrowseEvent>(`browser://event/${run}`, (e) => {
        onEvent(e.payload);
        if (e.payload.type === 'done') resolve();
      }).then((off) => {
        stop = off;
      });
      signal?.addEventListener('abort', () => resolve());
    });

    try {
      await Promise.race([
        invoke<void>('browser_run', {
          port: this.port,
          token: this.token,
          task,
          maxSteps,
          run,
        }),
        finished,
      ]);
    } finally {
      stop?.();
    }
  }
}
