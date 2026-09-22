import { useCallback, useEffect, useState } from 'react';
import { Brain, Cable, Check, Copy, Cpu, Globe, Loader2, Plus, RefreshCw, Search, Server, Trash2 } from 'lucide-react';
import { gatewayRequest, GATEWAY_URL, listCatalogue, type ModelSpec, type SurfaceRouting } from '@/lib/gateway';
import { gatewayStatus, type GatewayStatus } from '@/lib/gateway-ready';

interface Health {
  ok: boolean; providers: string[]; models: number; authRequired: boolean;
  memory?: { enabled: boolean; storage: string }; capabilities?: { mcp: boolean; sharedMemory: boolean };
}
interface MemoryEntry { id: string; at: string; surface: string; role: string; text: string }
interface MemoryState { enabled: boolean; storage: string; entries: MemoryEntry[] }

export default function ConnectionsPanel({ onModelsChanged }: { onModelsChanged: () => Promise<void> }) {
  const [health, setHealth] = useState<Health>();
  /**
   * What the desktop shell is doing about the gateway, which is now a
   * process it starts rather than one the user is expected to have running.
   * Null in the browser, where nothing is being supervised.
   */
  const [shell, setShell] = useState<GatewayStatus | null>(null);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [routing, setRouting] = useState<SurfaceRouting>({});
  const [memory, setMemory] = useState<MemoryState>();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const reloadMemory = useCallback(async (search = '') => {
    const data = await gatewayRequest<MemoryState>('/v1/memory?limit=40&query=' + encodeURIComponent(search));
    setMemory(data);
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError(''); setMemoryError('');
    setShell(await gatewayStatus());
    const result = await Promise.allSettled([
      gatewayRequest<Health>('/health'), listCatalogue(), reloadMemory(),
      gatewayRequest<{ enabled: boolean }>('/v1/memory/preferences'),
    ]);
    if (result[0].status === 'fulfilled') setHealth(result[0].value);
    else { setHealth(undefined); setError(result[0].reason instanceof Error ? result[0].reason.message : 'Could not load workspace status.'); }
    if (result[1].status === 'fulfilled') { setModels(result[1].value.models); setRouting(result[1].value.routing); }
    if (result[2].status === 'rejected') setMemoryError(result[2].reason instanceof Error ? result[2].reason.message : 'Could not load shared memory.');
    if (result[3].status === 'fulfilled') setEnabled(result[3].value.enabled);
    else setMemoryError(result[3].reason instanceof Error ? result[3].reason.message : 'Could not load memory preferences.');
    setLoading(false);
  }, [reloadMemory]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function action(operation: () => Promise<unknown>) {
    if (pending) return;
    setPending(true); setMemoryError('');
    try { await operation(); await reloadMemory(query); }
    catch (cause) { setMemoryError(cause instanceof Error ? cause.message : 'Could not update shared memory.'); }
    finally { setPending(false); }
  }
  async function toggle() {
    await action(async () => {
      const result = await gatewayRequest<{ enabled: boolean }>('/v1/memory/preferences', { method: 'PATCH', body: JSON.stringify({ enabled: !enabled }) });
      setEnabled(result.enabled);
    });
  }
  async function copyEndpoint() {
    try { await navigator.clipboard.writeText(GATEWAY_URL + '/mcp'); setCopied(true); }
    catch { setError('Clipboard access is unavailable. Select and copy the endpoint below.'); }
  }

  return <section className="connections-page screen-content" aria-label="Workspace connections and memory">
    <div className="settings-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h1>Everything, connected.</h1><p>Models, shared context, and the tools behind your work.</p></div><button className="subtle-button" disabled={loading} onClick={() => { void refresh(); void onModelsChanged(); }}>{loading ? <Loader2 className="spin" /> : <RefreshCw />}Refresh</button></div>
    {error && <div className="agent-notice error" role="alert">{error}</div>}
    <div className="connection-summary">
      <article><Server /><span>Gateway<strong>{health?.ok ? (shell?.managed ? 'Started by Aira' : 'Connected') : loading ? 'Checking…' : shell?.note || 'Unavailable'}</strong></span><i className={health?.ok ? 'healthy' : ''} /></article>
      <article><Cpu /><span>Models<strong>{models.length ? models.length + ' available' : 'No models configured'}</strong></span></article>
      <article><Brain /><span>Shared memory<strong>{memory?.storage === 'supabase' ? 'Persistent' : memory?.storage === 'ephemeral' ? 'Session storage' : 'Unavailable'}</strong></span></article>
    </div>
    <div className="settings-grid">
      <section className="settings-card lit"><div className="settings-card-title"><Cpu /><h2>Model routing</h2></div><p>Auto uses your workspace defaults. You can choose an available model in each conversation.</p>
        <dl className="routing-list">{(['chat', 'voice', 'code', 'task'] as const).map(surface => <div key={surface}><dt>{surface === 'task' ? 'Agents' : surface[0].toUpperCase() + surface.slice(1)}</dt><dd>{models.find(model => model.id === routing[surface])?.label ?? routing[surface] ?? 'Not configured'}</dd></div>)}</dl>
        <details className="model-catalogue"><summary>Available models <span>{models.length}</span></summary><div>{models.map(model => <article key={model.id}><strong>{model.label}</strong><span>{model.provider} · {model.tier} · {new Intl.NumberFormat(undefined, { notation: 'compact' }).format(model.contextWindow)} context</span></article>)}{!models.length && <p>Connect a model provider to the gateway to populate this catalogue.</p>}</div></details>
      </section>
      <section className="settings-card lit"><div className="settings-card-title"><Cable /><h2>Tool connections</h2></div><p>Connect compatible MCP clients to the same account memory and model catalogue used by Aira.</p><div className="endpoint-field"><code>{GATEWAY_URL}/mcp</code><button onClick={() => void copyEndpoint()} aria-label="Copy MCP endpoint">{copied ? <Check /> : <Copy />}</button></div><p className="settings-caption">Requires your account access token. Tokens are never included in the copied address.</p>
        <div className="connection-capability"><TerminalIcon /><span><strong>Coding & agents</strong>Local runtimes run in the desktop app. Their connection status appears in Code and Agents; coding tools ask for approval.</span></div><div className="connection-capability"><Globe /><span><strong>Shared browser</strong>Start Browser before connecting Code to share Chrome through MCP. Reconnect Code after restarting Browser. Research uses that same session; the separate task-agent runtime has no direct browser MCP bridge yet.</span></div>
      </section>
      <section className="settings-card memory-card lit"><div className="settings-card-title"><Brain /><h2>Shared memory</h2><button type="button" className={'memory-switch ' + (enabled ? 'enabled' : '')} role="switch" aria-checked={enabled} aria-label="Shared memory" disabled={pending || !memory || !health?.memory?.enabled} onClick={() => void toggle()}><span />{enabled ? 'On' : 'Off'}</button></div><p>Remember useful context across chat, voice, coding, and agents. Saved text is treated as context, never as tool instructions.</p>
        {memory?.storage === 'ephemeral' && <div className="agent-notice">Memory is currently held by the gateway process. Configure persistent storage to retain it after a restart.</div>}
        {memoryError && <div className="agent-notice error" role="alert">{memoryError}</div>}
        <form className="memory-add" onSubmit={event => { event.preventDefault(); if (note.trim()) void action(async () => { await gatewayRequest('/v1/memory', { method: 'POST', body: JSON.stringify({ text: note.trim(), surface: 'workspace' }) }); setNote(''); }); }}><label className="sr-only" htmlFor="memory-note">Context to remember</label><textarea id="memory-note" value={note} onChange={event => setNote(event.target.value)} placeholder="A preference, project decision, or detail worth remembering…" maxLength={4000} rows={2} disabled={!enabled || pending} /><button className="subtle-button" disabled={!enabled || pending || !note.trim()}><Plus />Remember</button></form>
        <form className="memory-search" onSubmit={event => { event.preventDefault(); void action(() => reloadMemory(query)); }}><Search /><input aria-label="Search shared memory" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search shared context" /><button disabled={pending}>Search</button></form>
        <div className="memory-list">{memory?.entries.map(entry => <article key={entry.id}><div><span>{entry.surface} · {entry.role}</span><time dateTime={entry.at}>{new Date(entry.at).toLocaleDateString()}</time><button aria-label={'Delete memory: ' + entry.text.slice(0,40)} disabled={pending} onClick={() => void action(() => gatewayRequest('/v1/memory/' + encodeURIComponent(entry.id), { method: 'DELETE' }))}><Trash2 /></button></div><p>{entry.text}</p></article>)}{memory && !memory.entries.length && <p className="memory-empty">{query ? 'No matching context.' : 'No shared context yet. Add a note or start a conversation.'}</p>}</div>
        {!!memory?.entries.length && <div className="memory-clear">{confirmClear ? <><span>Delete all shared memory for your account?</span><button disabled={pending} onClick={() => void action(async () => { await gatewayRequest('/v1/memory', { method: 'DELETE' }); setConfirmClear(false); })}>Delete all</button><button onClick={() => setConfirmClear(false)}>Cancel</button></> : <button onClick={() => setConfirmClear(true)}>Clear account memory</button>}</div>}
      </section>
    </div>
  </section>;
}

function TerminalIcon() { return <Cable />; }
