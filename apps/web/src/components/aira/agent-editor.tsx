/**
 * Staffing the fleet.
 *
 * Aira ships six agents. This is where the user adds their own — a tax agent,
 * a lab-notebook agent, one that knows a single codebase — so the board becomes
 * a team they picked rather than a cast they were given.
 *
 * Two things it is careful about.
 *
 * The tool list comes from the shell, never from here. Which tools a custom
 * agent may hold is a security boundary, and a second copy in the UI would
 * drift and start offering something the shell refuses. The panel renders
 * whatever it is handed.
 *
 * And it does not pretend to validate. The shell's rules are the real ones, so
 * a rejected agent shows the shell's own message rather than a guess made here
 * about what was wrong — the two can only disagree, and the shell is right.
 */

import { useEffect, useState } from 'react';
import { Bot, Loader2, Plus, Trash2, X } from 'lucide-react';
import { roster, type FleetOptions, type FleetMember, type NewAgent } from '@/lib/openclaw';
import '@/styles/agent-editor.css';

const BLANK: NewAgent = { id: '', name: '', description: '', brief: '', tier: 'balanced', tools: ['read', 'memory_search'] };

/** A short example, so the brief field is not a blank wall. */
const BRIEF_PLACEHOLDER =
  'You answer questions about our tax filings.\n\n' +
  '- Cite the filing year for anything you assert.\n' +
  '- Say when a figure is an estimate rather than filed.\n' +
  '- Refuse to guess at numbers you have not been given.';

export default function AgentEditor({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  /** Fired after a change, so the board can pick the new roster up. */
  onChanged: () => void;
}) {
  const [options, setOptions] = useState<FleetOptions | null>(null);
  const [draft, setDraft] = useState<NewAgent>(BLANK);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    void roster.list().then(setOptions).catch(e => setError(String(e)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function save() {
    setBusy(true);
    setError('');
    try {
      setOptions(await roster.add(draft));
      setDraft(BLANK);
      setAdding(false);
      onChanged();
    } catch (e) {
      // The shell's own message — it knows the rule that was broken.
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function drop(id: string) {
    setBusy(true);
    try {
      setOptions(await roster.remove(id));
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const mine = options?.members.filter(m => m.custom) ?? [];
  const theirs = options?.members.filter(m => !m.custom) ?? [];
  const full = options ? mine.length >= options.maxCustom : false;

  return <div className="ae-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="ae-panel" role="dialog" aria-modal="true" aria-label="Your agents">
      <header className="ae-head">
        <div>
          <span className="ae-eyebrow">Fleet</span>
          <h2>Your agents</h2>
        </div>
        <button className="ae-close" onClick={onClose} aria-label="Close"><X /></button>
      </header>

      <div className="ae-body">
        {error && <p className="ae-error" role="alert">{error}</p>}

        {!adding && <>
          <section className="ae-group">
            <h3>Added by you</h3>
            {mine.length === 0
              ? <p className="ae-empty">None yet. An agent is a name, a brief, and the tools it is allowed to use.</p>
              : <ul className="ae-list">{mine.map(agent => <li key={agent.id}>
                  <div className="ae-item">
                    <strong>{agent.name}</strong>
                    <span className="ae-id">{agent.id} · {agent.tier}</span>
                    <span className="ae-desc">{agent.description || agent.brief.split('\n')[0]}</span>
                    <span className="ae-tools">{agent.tools.join(' · ') || 'no tools'}</span>
                  </div>
                  <button className="ae-drop" disabled={busy} onClick={() => void drop(agent.id)}
                    aria-label={`Remove ${agent.name}`}><Trash2 /></button>
                </li>)}</ul>}

            <button className="ae-add" disabled={full} onClick={() => { setAdding(true); setError(''); }}
              title={full ? `You can have up to ${options?.maxCustom} of your own agents.` : undefined}>
              <Plus />{full ? `Limit reached (${options?.maxCustom})` : 'Add an agent'}
            </button>
          </section>

          <section className="ae-group">
            <h3>Aira's own</h3>
            <ul className="ae-list built-in">{theirs.map(agent => <li key={agent.id}>
              <div className="ae-item">
                <strong><Bot />{agent.name}</strong>
                <span className="ae-id">{agent.id} · {agent.tier}</span>
                <span className="ae-desc">{agent.description}</span>
              </div>
            </li>)}</ul>
            <p className="ae-note">These ship with Aira and cannot be edited, so a change here can never leave you without a working fleet.</p>
          </section>
        </>}

        {adding && <form className="ae-form" onSubmit={e => { e.preventDefault(); void save(); }}>
          <label>
            <span>Name</span>
            <input value={draft.name} autoFocus maxLength={40} placeholder="Tax"
              onChange={e => setDraft(d => ({
                ...d,
                name: e.target.value,
                // The id follows the name until the user edits it themselves,
                // which is one fewer field to think about.
                id: d.id === slug(d.name) ? slug(e.target.value) : d.id,
              }))} />
          </label>
          <label>
            <span>Id</span>
            <input value={draft.id} maxLength={24} placeholder="tax"
              onChange={e => setDraft(d => ({ ...d, id: e.target.value }))} />
          </label>
          <label className="ae-wide">
            <span>What it does</span>
            <input value={draft.description} maxLength={120} placeholder="Answers questions about our filings."
              onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
          </label>
          <label className="ae-wide">
            <span>Brief</span>
            <textarea value={draft.brief} rows={7} placeholder={BRIEF_PLACEHOLDER}
              onChange={e => setDraft(d => ({ ...d, brief: e.target.value }))} />
            <small>Its standing instructions. Written into the agent's own AGENTS.md and sent with every task.</small>
          </label>
          <label>
            <span>Model tier</span>
            <select value={draft.tier} onChange={e => setDraft(d => ({ ...d, tier: e.target.value }))}>
              {(options?.tiers ?? []).map(tier => <option key={tier} value={tier}>{tier}</option>)}
            </select>
          </label>
          <fieldset className="ae-wide">
            <legend>Tools</legend>
            <div className="ae-tool-grid">
              {(options?.grantable ?? []).map(tool => <label key={tool} className="ae-tool">
                <input type="checkbox" checked={draft.tools.includes(tool)}
                  onChange={e => setDraft(d => ({
                    ...d,
                    tools: e.target.checked ? [...d.tools, tool] : d.tools.filter(t => t !== tool),
                  }))} />
                {tool}
              </label>)}
            </div>
            <small>Read-only tools only. Writing files, running commands and directing other agents are not available to agents you add.</small>
          </fieldset>

          <div className="ae-actions">
            <button type="button" className="ae-cancel" onClick={() => { setAdding(false); setDraft(BLANK); setError(''); }}>Cancel</button>
            <button type="submit" className="ae-save" disabled={busy}>
              {busy ? <Loader2 className="spin" /> : <Plus />}{busy ? 'Adding…' : 'Add agent'}
            </button>
          </div>
        </form>}
      </div>
    </div>
  </div>;
}

/** "Lab Notes" → "lab-notes", matching what the shell will accept. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}
