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

export function loadBoard(userId: string | null): SavedBoard | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${BOARD_KEY}.${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedBoard;
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
  } catch { return null; }
}

export function saveBoard(userId: string | null, board: SavedBoard): void {
  if (!userId) return;
  try { localStorage.setItem(`${BOARD_KEY}.${userId}`, JSON.stringify(board)); }
  catch { /* a full or blocked store must never break a run */ }
}

