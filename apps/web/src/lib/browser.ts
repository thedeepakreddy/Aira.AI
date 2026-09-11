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

/** One open tab in the agent's browser. */
export interface Tab {
  id: string;
  url: string;
  title: string;
}

export interface TabState {
  tabs: Tab[];
  /** True when the browser is on a throwaway profile. */
  private: boolean;
  running: boolean;
  error?: string;
}

export class BrowserClient {
  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  private api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return invoke<T>('browser_api', { port: this.port, token: this.token, method, path, body });
  }

  /**
   * A frame of whatever the agent is looking at.
   *
   * Polled rather than screencast: the efficient way needs an event
   * subscription held open across the bridge, and a frame a second is enough to
   * watch an agent work.
   */
  screen(): Promise<{ image: string | null; url: string; title: string }> {
    return this.api<{ image: string | null; url: string; title: string }>('GET', '/screen');
  }

  /**
   * Sends a click, scroll or keystroke to the page.
   *
   * Coordinates are in page pixels, not panel pixels — the caller scales by the
   * ratio between the captured frame and how large it is being drawn.
   */
  input(event: Record<string, unknown>): Promise<{ ok: boolean }> {
    return this.api<{ ok: boolean }>('POST', '/input', event);
  }

  /** Open tabs. Never starts the browser just because someone looked. */
  tabs(): Promise<TabState> {
    return this.api<TabState>('GET', '/tabs');
  }

  openTab(url: string): Promise<TabState> {
    return this.api<TabState>('POST', '/tabs/open', { url });
  }

  closeTab(id: string): Promise<TabState> {
    return this.api<TabState>('POST', '/tabs/close', { id });
  }

  /**
   * Switches between the saved profile and a throwaway one.
   *
   * Applies to the next browser rather than the current one: the swap is a
   * different Chrome, and doing that inside the request took long enough that
   * the caller gave up before it answered.
   */
  setPrivate(isPrivate: boolean): Promise<{ private: boolean }> {
    return this.api<{ private: boolean }>('POST', '/mode', { private: isPrivate });
  }

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
