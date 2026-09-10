/**
 * Structured event log.
 *
 * Every surface — chat, voice, OpenCode, OpenClaw — writes here in one shape,
 * even while nothing reads it back. Two things depend on that later:
 *   1. Billing. Usage metering is a query over these rows, so it never has to
 *      be retrofitted into four already-built surfaces.
 *   2. The shared memory layer, which becomes a reader over an existing log
 *      rather than a logging pass across finished systems.
 *
 * Tokens are recorded even when cost cannot be computed; a missing price must
 * never cause a request to go unmetered.
 */

export type EventKind = 'model_request' | 'agent_action' | 'session';

export interface AiraEvent {
  kind: EventKind;
  /** ISO-8601 UTC. */
  at: string;
  userId: string | null;
  conversationId: string | null;
  surface: string;
  payload: Record<string, unknown>;
}

export interface ModelRequestPayload extends Record<string, unknown> {
  provider: string;
  model: string;
  routedBy: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the model has no verified pricing. */
  costUsd: number | null;
  durationMs: number;
  stopReason: string | null;
  ok: boolean;
  /** Raw vendor error text when the request failed; null otherwise. */
  error?: string | null;
}

export type EventSink = (event: AiraEvent) => void | Promise<void>;

/**
 * Default sink: one JSON object per line on stdout. Fly captures stdout, so
 * this is queryable from day one with no database dependency. A Supabase sink
 * can be added alongside it without changing any caller.
 */
const stdoutSink: EventSink = (event) => {
  process.stdout.write(JSON.stringify(event) + '\n');
};

const sinks: EventSink[] = [stdoutSink];

export function addEventSink(sink: EventSink): void {
  sinks.push(sink);
}

/**
 * Never throws. A failure to record an event must not fail the user's request;
 * it is logged and swallowed.
 */
export async function emit(event: AiraEvent): Promise<void> {
  await Promise.all(
    sinks.map(async (sink) => {
      try {
        await sink(event);
      } catch (error) {
        console.error('[events] sink failed:', error);
      }
    }),
  );
}
