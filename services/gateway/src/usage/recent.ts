import type { AiraEvent } from './events.ts';

/**
 * A rolling window of recent usage, per user.
 *
 * Events were written to stdout and nowhere else, so the gateway knew exactly
 * what every task cost and had no way to tell anyone. This keeps just enough to
 * answer "what did this cost?" in the interface.
 *
 * In memory and bounded on purpose. It is a live read-out, not a ledger:
 * billing needs durable storage and a query over it, and pretending this is
 * that would be worse than not having it. It empties on restart, and says so.
 */

/** Roughly a day of heavy use for one person, and a hard ceiling on memory. */
const MAX_PER_USER = 500;
const MAX_USERS = 200;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UsageRow {
  at: string;
  surface: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model has no verified pricing — never guessed. */
  costUsd: number | null;
  ok: boolean;
}

const byUser = new Map<string, UsageRow[]>();

export function recordUsage(event: AiraEvent): void {
  if (event.kind !== 'model_request' || !event.userId) return;
  const p = event.payload as Record<string, unknown>;
  const rows = byUser.get(event.userId) ?? [];
  rows.push({
    at: event.at,
    surface: event.surface,
    model: String(p.model ?? ''),
    provider: String(p.provider ?? ''),
    inputTokens: Number(p.inputTokens ?? 0),
    outputTokens: Number(p.outputTokens ?? 0),
    costUsd: typeof p.costUsd === 'number' ? p.costUsd : null,
    ok: p.ok === true,
  });
  if (rows.length > MAX_PER_USER) rows.splice(0, rows.length - MAX_PER_USER);
  byUser.set(event.userId, rows);

  // Oldest user evicted first, so one busy gateway cannot grow without bound.
  if (byUser.size > MAX_USERS) {
    const oldest = byUser.keys().next();
    if (!oldest.done) byUser.delete(oldest.value);
  }
}

export interface UsageSummary {
  /** Whether any price was unknown, so a total can be read honestly. */
  complete: boolean;
  requests: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  bySurface: Record<string, { requests: number; costUsd: number }>;
  /** This window only; the store is not durable. */
  windowHours: number;
}

export function summarise(userId: string, surface?: string): UsageSummary {
  const cutoff = Date.now() - WINDOW_MS;
  const rows = (byUser.get(userId) ?? []).filter((row) => {
    if (surface && row.surface !== surface) return false;
    return new Date(row.at).getTime() >= cutoff;
  });

  const summary: UsageSummary = {
    complete: true, requests: rows.length, failed: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0,
    bySurface: {}, windowHours: WINDOW_MS / 3_600_000,
  };
  for (const row of rows) {
    if (!row.ok) summary.failed++;
    summary.inputTokens += row.inputTokens;
    summary.outputTokens += row.outputTokens;
    // A missing price makes the total a floor, not a figure. Saying so is the
    // difference between a number and a misleading one.
    if (row.costUsd === null) summary.complete = false;
    else summary.costUsd += row.costUsd;
    const bucket = summary.bySurface[row.surface] ??= { requests: 0, costUsd: 0 };
    bucket.requests++;
    bucket.costUsd += row.costUsd ?? 0;
  }
  return summary;
}

/** Test seam. */
export function clearUsage(): void { byUser.clear(); }
