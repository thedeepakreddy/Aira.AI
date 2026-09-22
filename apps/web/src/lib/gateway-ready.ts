/**
 * Waiting for a gateway the app is still starting.
 *
 * On the desktop the gateway is a process Aira spawns at launch, and a cold one
 * takes a few seconds — it loads five provider SDKs before it listens. The
 * window paints well inside that, so without this the first thing a user sees
 * on opening the app is "Could not reach Aira", about two seconds before it
 * could in fact reach Aira.
 *
 * So a connection failure on the desktop asks the shell what is going on before
 * it becomes an error. If the shell says a gateway is on its way, the request
 * waits for it and is tried again. If the shell says it has given up — no Node,
 * no gateway directory — that message is worth far more than "check your
 * connection", and it is what gets shown.
 *
 * In the browser there is no shell to ask and nothing is being started, so
 * every one of these is a no-op and a failure stays a failure.
 */

import { invoke, isDesktop } from './bridge.ts';

export interface GatewayStatus {
  running: boolean;
  port: number;
  /** Whether Aira started this gateway, as opposed to finding it already up. */
  managed: boolean;
  note: string;
}

export async function gatewayStatus(): Promise<GatewayStatus | null> {
  if (!isDesktop) return null;
  try {
    return await invoke<GatewayStatus>('gateway_status');
  } catch {
    // An older shell without the command. Not knowing is not an error.
    return null;
  }
}

/** Long enough for a cold start, short enough that a real failure still fails. */
const WAIT_MS = 30_000;
const POLL_MS = 400;

/**
 * Blocks until the shell reports a gateway, or until waiting stops being
 * reasonable. Returns what to tell the user if it never came up.
 */
export async function waitForGateway(): Promise<{ ready: boolean; note: string }> {
  const first = await gatewayStatus();
  if (!first) return { ready: false, note: '' };
  if (first.running) return { ready: true, note: first.note };

  const deadline = Date.now() + WAIT_MS;
  let note = first.note;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const status = await gatewayStatus();
    if (!status) break;
    note = status.note;
    if (status.running) return { ready: true, note };
    // A shell that has stopped trying says so, and there is no point waiting
    // out the rest of the deadline for something nobody is starting.
    if (!status.managed && note && !/starting/i.test(note)) break;
  }
  return { ready: false, note };
}
