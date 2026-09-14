/**
 * Board state that outlives the app.
 *
 * Results lived in React state alone, so closing Aira threw away every
 * agent's work — a project was only ever as durable as the window. Keyed per
 * account, because a shared key would show one user another's board.
 */
export const BOARD_KEY = 'aira.agent-board.v1';

export interface SavedBoard {
  sent: string;
  results: { id: string; name: string; text: string; error: string }[];
  at: number;
}

/**
 * How many past boards to keep.
 *
 * Each holds every agent's full answer, so this is the largest thing Aira
 * stores per user. Twenty is roughly a week of ordinary use and still an order
 * of magnitude under the quota a browser gives one origin.
 */
export const BOARD_HISTORY = 20;
const HISTORY_SUFFIX = 'history';

function bound(parsed: SavedBoard): SavedBoard | null {
  if (typeof parsed?.sent !== 'string' || !Array.isArray(parsed.results)) return null;
  // Bound what a corrupted or hand-edited entry can do to a render.
  return {
    sent: parsed.sent.slice(0, 8_000),
    at: typeof parsed.at === 'number' ? parsed.at : 0,
    results: parsed.results.slice(0, 12).map(r => ({
      id: String(r.id ?? ''), name: String(r.name ?? ''),
      text: String(r.text ?? '').slice(0, 100_000),
      error: String(r.error ?? '').slice(0, 2_000),
    })),
  };
}

/** Past boards, newest first. */
export function loadBoardHistory(userId: string | null): SavedBoard[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(`${BOARD_KEY}.${HISTORY_SUFFIX}.${userId}`);
    const parsed: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => { const ok = bound(item as SavedBoard); return ok ? [ok] : []; }).slice(0, BOARD_HISTORY);
  } catch { return []; }
}

/**
 * Files a finished board into the history.
 *
 * Keyed by the task text: re-running the same goal replaces its entry rather
 * than stacking near-identical rows, which is what makes the list worth
 * opening. An empty board is not filed at all.
 */
export function recordBoard(userId: string | null, board: SavedBoard): SavedBoard[] {
  if (!userId || !board.sent.trim() || !board.results.some(r => r.text || r.error)) {
    return loadBoardHistory(userId);
  }
  const next = [board, ...loadBoardHistory(userId).filter(b => b.sent !== board.sent)].slice(0, BOARD_HISTORY);
  try { localStorage.setItem(`${BOARD_KEY}.${HISTORY_SUFFIX}.${userId}`, JSON.stringify(next)); }
  catch { /* a full store must never break a run */ }
  return next;
}

export function forgetBoard(userId: string | null, at: number): SavedBoard[] {
  const next = loadBoardHistory(userId).filter(b => b.at !== at);
  try { localStorage.setItem(`${BOARD_KEY}.${HISTORY_SUFFIX}.${userId}`, JSON.stringify(next)); }
  catch { /* nothing to do */ }
  return next;
}

export function loadBoard(userId: string | null): SavedBoard | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${BOARD_KEY}.${userId}`);
    if (!raw) return null;
    return bound(JSON.parse(raw) as SavedBoard);
  } catch { return null; }
}

export function saveBoard(userId: string | null, board: SavedBoard): void {
  if (!userId) return;
  try { localStorage.setItem(`${BOARD_KEY}.${userId}`, JSON.stringify(board)); }
  catch { /* a full or blocked store must never break a run */ }
}

