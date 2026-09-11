import { memory, trim, type MemoryEntry } from './store.ts';

/**
 * Turns what Aira has seen elsewhere into something a model can use.
 *
 * Two rules shape this, and both exist to stop memory making answers worse:
 *
 *   * The block is capped hard. Context that grows with use would quietly
 *     inflate the cost of every request and, on a small model, crowd out the
 *     actual question.
 *   * The current surface's own turns are left out. Chat already has its own
 *     history in the request; repeating it as "memory" would double it and
 *     teach the model that the last thing said is the most important thing
 *     known.
 */

/** Entries considered. Older than this is not the same working session. */
const RECALL = 24;
/** Entries actually shown. */
const SHOW = 10;
/** Characters. Roughly 400 tokens — a floor on how much it can cost. */
const BUDGET = 1400;

const SURFACE_NAME: Record<string, string> = {
  chat: 'chat',
  voice: 'voice',
  code: 'the coding agent',
  task: 'the task agent',
};

function ago(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function render(entries: MemoryEntry[], now = Date.now()): string {
  if (!entries.length) return '';
  const lines: string[] = [];
  let used = 0;
  // Newest first while filling, so the budget is spent on what is most recent.
  for (const entry of [...entries].reverse()) {
    const who = entry.role === 'user' ? 'They said' : 'Aira replied';
    const line = `- [${SURFACE_NAME[entry.surface] ?? entry.surface}, ${ago(entry.at, now)}] ${who}: ${trim(entry.text)}`;
    if (used + line.length > BUDGET) break;
    used += line.length;
    lines.push(line);
    if (lines.length >= SHOW) break;
  }
  if (!lines.length) return '';
  lines.reverse();
  return [
    'Context from this user\'s other Aira surfaces, most recent last:',
    ...lines,
    'Use it only where it is relevant. Do not mention or list it back to them.',
  ].join('\n');
}

/**
 * The memory block for a request, or empty when there is nothing worth adding.
 *
 * Never throws: a memory lookup that fails must not take the user's request
 * down with it. Losing context degrades an answer; losing the answer is worse.
 */
export async function contextFor(userId: string | null, surface: string): Promise<string> {
  if (!userId) return '';
  try {
    const entries = await memory().recall(userId, RECALL);
    return render(entries.filter((e) => e.surface !== surface));
  } catch (error) {
    console.error('[memory] recall failed:', error);
    return '';
  }
}

/** Records a turn. Same rule as recall: never throws. */
export async function record(
  userId: string | null,
  surface: string,
  role: 'user' | 'assistant',
  text: string,
): Promise<void> {
  const clean = trim(text);
  if (!userId || !clean) return;
  try {
    await memory().remember(userId, { at: new Date().toISOString(), surface, role, text: clean });
  } catch (error) {
    console.error('[memory] remember failed:', error);
  }
}

/** Prepends the memory block to whatever system prompt the caller already had. */
export function withContext(system: string | undefined, block: string): string | undefined {
  if (!block) return system;
  return system ? `${block}\n\n${system}` : block;
}
