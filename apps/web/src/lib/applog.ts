/**
 * The app's own error log.
 *
 * Errors used to live in three places, none of them durable: a banner the user
 * dismissed, the webview console nobody opens, and an in-memory stderr tail
 * that dies with the process. So the one moment the log matters — after a hang
 * or a crash — was the one moment there wasn't one.
 *
 * This writes to `~/.aira/aira.log` through the shell. In a browser tab there
 * is no shell, so it degrades to the console rather than failing: the web build
 * is for trying Aira out, and the sessions worth diagnosing are local ones.
 */

/*
 * Checked here rather than imported from the OpenCode client. A logger should
 * not depend on a module it may one day have to report a failure in, and this
 * keeps the file importable on its own — including by its tests.
 */
const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type LogLevel = 'error' | 'warn' | 'info';

async function send(surface: string, level: LogLevel, message: string): Promise<void> {
  if (!isDesktop) {
    if (level === 'error') console.error(`[${surface}]`, message);
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('app_log_write', { surface, level, message });
  } catch {
    // A logger that throws is worse than one that misses a line.
  }
}

/** Records one line. Never throws and never blocks the caller. */
export function log(surface: string, level: LogLevel, message: string): void {
  void send(surface, level, message);
}

/** The shape most call sites want: an unknown from a catch block. */
export function logError(surface: string, error: unknown, context?: string): void {
  const body = error instanceof Error
    // The stack is the whole point of keeping this; the file flattens newlines.
    ? `${error.message}${error.stack ? ` | ${error.stack}` : ''}`
    : String(error);
  log(surface, 'error', context ? `${context}: ${body}` : body);
}

export async function readLog(lines = 300): Promise<string[]> {
  if (!isDesktop) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string[]>('app_log_read', { lines });
  } catch {
    return [];
  }
}

export async function logPath(): Promise<string | null> {
  if (!isDesktop) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('app_log_path');
  } catch {
    return null;
  }
}

export async function clearLog(): Promise<void> {
  if (!isDesktop) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('app_log_clear');
  } catch { /* nothing to do */ }
}

/** One entry, parsed back from the tab-separated line the shell wrote. */
export interface LogEntry {
  at: number;
  surface: string;
  level: LogLevel;
  message: string;
}

export function parseLog(lines: string[]): LogEntry[] {
  return lines.flatMap((line) => {
    const [at, surface, level, ...rest] = line.split('\t');
    const seconds = Number(at);
    // A line the writer did not produce is skipped rather than shown as junk.
    if (!Number.isFinite(seconds) || !surface || !rest.length) return [];
    return [{
      at: seconds * 1000,
      surface,
      level: (level === 'warn' || level === 'info' ? level : 'error') as LogLevel,
      message: rest.join('\t'),
    }];
  });
}

let installed = false;

/**
 * Catches what no `try` block did.
 *
 * The failures that precede a hang are exactly the ones nobody wrapped — an
 * unhandled rejection in a stream handler, a render that threw. Installed once
 * at startup, before anything else runs.
 */
export function installGlobalHandlers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    logError('window', event.error ?? event.message, `uncaught${where}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    logError('window', event.reason, 'unhandled rejection');
  });
}
