/**
 * Past work on the surface you are looking at.
 *
 * Chat has had a history drawer since it was built; Code and Agents both keep
 * sessions and neither surfaced them — the coding runtime had fifty-two stored
 * conversations with no way to reach any of them from Aira. This is the same
 * affordance, per surface, because the histories are genuinely different
 * things: a coding session lives in OpenCode and outlives the app, while a
 * board lives in this browser and belongs to one account.
 *
 * It sits inside its own surface rather than in the workspace drawer. That
 * drawer is navigation — where do I want to be — and this is recall — what was
 * I doing here. Putting both in one panel would make the destination list
 * shift under the reader depending on which page they happened to be on.
 */

import { useEffect, useRef } from 'react';
import { Clock3, Trash2, X } from 'lucide-react';
import '@/styles/session-history.css';

export interface HistoryEntry {
  /** Stable per entry, and what `onOpen` is called with. */
  id: string;
  title: string;
  /** Epoch ms. 0 when the source did not record one. */
  at: number;
  /** Optional second line: agent names, a file count, whatever the surface has. */
  detail?: string;
}

export interface SessionHistoryProps {
  open: boolean;
  onClose: () => void;
  /** What this surface calls its past work — "sessions", "boards". */
  noun: string;
  entries: HistoryEntry[];
  /** The entry currently loaded, so the list can say where you are. */
  currentId?: string | null;
  onOpen: (id: string) => void;
  /** Omitted when the surface cannot delete — OpenCode owns its own sessions. */
  onDelete?: (id: string) => void;
  /** Shown in place of the list when there is nothing yet. */
  empty: string;
  /** Where this history is kept, said plainly rather than assumed. */
  footnote: string;
}

/** "Today", "Yesterday", then a date. Absolute beats "3 days ago" for recall. */
function when(at: number): string {
  if (!at) return '';
  const date = new Date(at);
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= midnight) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at >= midnight - 86_400_000) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function SessionHistory(props: SessionHistoryProps) {
  const { open, onClose, entries } = props;
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves in on open: this covers the whole surface,
  // so leaving the keyboard behind the overlay would trap it.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return <div className="sh-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sh-panel" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Recent ${props.noun}`}>
      <header className="sh-head">
        <div>
          <span className="sh-eyebrow">Recent</span>
          <h2>{props.noun}</h2>
        </div>
        <button className="sh-close" onClick={onClose} aria-label="Close history"><X /></button>
      </header>

      {entries.length === 0
        ? <div className="sh-empty"><Clock3 /><p>{props.empty}</p></div>
        : <div className="sh-list">
            {entries.map(entry => <div className="sh-row" key={entry.id}>
              <button
                className={`sh-item ${props.currentId === entry.id ? 'current' : ''}`}
                onClick={() => { props.onOpen(entry.id); onClose(); }}>
                <strong>{entry.title || 'Untitled'}</strong>
                <span className="sh-meta">
                  {when(entry.at)}{entry.detail && <><span className="sh-dot">·</span>{entry.detail}</>}
                </span>
              </button>
              {props.onDelete && <button
                className="sh-delete"
                aria-label={`Delete ${entry.title || 'this entry'}`}
                onClick={() => props.onDelete?.(entry.id)}><Trash2 /></button>}
            </div>)}
          </div>}

      <footer className="sh-foot">{props.footnote}</footer>
    </div>
  </div>;
}
