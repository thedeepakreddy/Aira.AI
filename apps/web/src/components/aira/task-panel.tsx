import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Bot, Check, ChevronDown, Clock3, Copy, Cpu, Loader2, Plus, Power, RefreshCw, Send, ShieldCheck, Square, WifiOff } from 'lucide-react';
import { isDesktop, supervisor, OpenClawClient, type Agent, type OpenClawStatus } from '@/lib/openclaw';
import { getAccessToken } from '@/lib/supabase';
import { listCatalogue, type ModelSpec } from '@/lib/gateway';
import Markdown from './markdown';
import '@/styles/agent-workbench.css';

type Phase = 'idle' | 'working' | 'done' | 'error' | 'stopped';
interface AgentState {
  agent: Agent;
  phase: Phase;
  text: string;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
}
const blank = (agent: Agent): AgentState => ({ agent, phase: 'idle', text: '', startedAt: null, endedAt: null, error: '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const examples = ['Compare three approaches to my next project', 'Turn this idea into an actionable plan', 'Review these notes and identify what is missing'];

export default function TaskPanel() {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [task, setTask] = useState('');
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(isDesktop);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [model, setModel] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const client = useRef<OpenClawClient | null>(null);
  const runs = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const changing = useRef(false);
  const activeToken = useRef<string | null>(null);
  const connected = Boolean(status?.running && client.current && agents.length);
  const active = agents.filter(a => a.phase === 'working').length;

  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => tick(n => n + 1), 1_000);
    return () => clearInterval(interval);
  }, [busy]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void listCatalogue().then(({ models: available, routing }) => {
      if (cancelled) return;
      setModels(available);
      setModel(current => current || routing.task || available[0]?.id || '');
    });
    if (isDesktop) void (async () => {
      try {
        const next = await supervisor.status();
        if (cancelled) return;
        setStatus(next);
        if (next.model) setModel(next.model);
        if (next.running && next.port && next.token) {
          const c = new OpenClawClient(next.port, next.token);
          const found = await c.agents();
          if (cancelled) return;
          if (!found.length) throw new Error('The runtime is running but has no available agents. Reconnect to try again.');
          client.current = c;
          setAgents(found.map(blank));
          setSelected(found.slice(0, 1).map(a => a.id));
          activeToken.current = null; // Verify credentials on the next task.
        }
      } catch (e) {
        if (!cancelled) setError(messageOf(e));
      } finally { if (!cancelled) setChecking(false); }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      runs.current?.abort();
      // Panels remain mounted while navigating. Unmount means account change
      // or application exit; credentials and local work must not cross users.
      queueMicrotask(() => { if (isDesktop && !alive.current) void supervisor.stop().catch(() => undefined); });
    };
  }, []);

  async function connect(token: string): Promise<Agent[]> {
    const catalogue = await listCatalogue();
    const chosen = model || catalogue.routing.task || catalogue.models[0]?.id;
    if (!chosen || !catalogue.models.some(m => m.id === chosen)) throw new Error('Connect a model provider in Aira before starting agents.');
    setModels(catalogue.models);
    if (status?.running) await supervisor.stop();
    client.current = null; activeToken.current = null;
    const next = await supervisor.start({
      gatewayUrl: (import.meta.env?.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787',
      token, model: chosen,
    });
    if (!alive.current) { await supervisor.stop(); throw new Error('The workspace was closed.'); }
    setStatus(next);
    setModel(chosen);
    if (!next.running || !next.port || !next.token) throw new Error('The task runtime could not start.');
    const c = new OpenClawClient(next.port, next.token);
    let found: Agent[] = [];
    for (let attempt = 0; attempt < 60 && alive.current; attempt++) {
      try { found = await c.agents(); if (found.length) break; } catch { /* startup can take a moment */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!alive.current) { await supervisor.stop(); throw new Error('The workspace was closed.'); }
    if (!found.length) {
      const tail = (await supervisor.log().catch(() => [])).slice(-3).join(' · ');
      await supervisor.stop();
      setStatus(await supervisor.status());
      throw new Error(`The task runtime did not become ready.${tail ? ` ${tail}` : ' Check the OpenClaw installation and try again.'}`);
    }
    client.current = c;
    activeToken.current = token;
    setAgents(previous => found.map(agent => previous.find(a => a.agent.id === agent.id) ?? blank(agent)));
    setSelected(previous => {
      const valid = previous.filter(id => found.some(a => a.id === id));
      return valid.length ? valid : [found[0].id];
    });
    return found;
  }

  async function start() {
    if (changing.current || busy) return;
    changing.current = true;
    setStarting(true); setError(''); setNotice('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in to start task agents.');
      await connect(token);
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      changing.current = false;
      if (alive.current) setStarting(false);
    }
  }

  async function stop() {
    if (changing.current) return;
    changing.current = true; setStarting(true); setError('');
    try {
      runs.current?.abort();
      await supervisor.stop();
      runs.current = null;
      client.current = null; activeToken.current = null;
      setStatus(await supervisor.status());
      setAgents(list => list.map(a => a.phase === 'working' ? { ...a, phase: 'stopped', endedAt: Date.now() } : a));
      setBusy(false);
      setNotice('Task runtime stopped. Your output is preserved. Connect to continue.');
    } catch (e) { setError(`Could not stop the task runtime: ${messageOf(e)}`); }
    finally { changing.current = false; if (alive.current) setStarting(false); }
  }

  async function refreshSetup() {
    setChecking(true); setError('');
    try {
      const catalogue = await listCatalogue();
      setModels(catalogue.models);
      setModel(current => catalogue.models.some(item => item.id === current) ? current : catalogue.routing.task ?? catalogue.models[0]?.id ?? '');
      if (isDesktop) setStatus(await supervisor.status());
    } catch (e) { setError(messageOf(e)); }
    finally { if (alive.current) setChecking(false); }
  }

  const update = useCallback((id: string, patch: Partial<AgentState>) => {
    if (alive.current) setAgents(list => list.map(a => a.agent.id === id ? { ...a, ...patch } : a));
  }, []);

  async function send() {
    const text = task.trim();
    if (!text || !connected || busy || changing.current || !selected.length) return;
    changing.current = true; setStarting(true); setError(''); setNotice('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to continue.');
      // A refreshed login token must reach the child process before another run.
      let targets = selected;
      if (activeToken.current !== token) {
        const available = await connect(token);
        targets = selected.filter(id => available.some(agent => agent.id === id));
        if (!targets.length) targets = available.slice(0, 1).map(agent => agent.id);
      }
      const c = client.current;
      if (!c) throw new Error('Connect the task runtime first.');
      const controller = new AbortController(); runs.current = controller;
      setSent(text); setTask(''); setBusy(true); setExpanded(targets); setSelected(targets);
      setAgents(list => list.map(a => targets.includes(a.agent.id) ? { ...blank(a.agent), phase: 'working', startedAt: Date.now() } : blank(a.agent)));
      changing.current = false; setStarting(false);
      await Promise.all(targets.map(async id => {
        try {
          await c.stream(id, text, delta => {
            if (!alive.current || controller.signal.aborted) return;
            setAgents(list => list.map(a => a.agent.id === id ? { ...a, text: a.text + delta } : a));
          }, controller.signal);
          if (!controller.signal.aborted) update(id, { phase: 'done', endedAt: Date.now() });
        } catch (e) {
          if (!controller.signal.aborted) update(id, { phase: 'error', error: messageOf(e), endedAt: Date.now() });
        }
      }));
      if (runs.current === controller) runs.current = null;
      if (alive.current) {
        setBusy(false);
        const current = await supervisor.status();
        if (alive.current) {
          setStatus(current);
          if (!current.running) { client.current = null; activeToken.current = null; }
        }
      }
    } catch (e) { if (alive.current) setError(messageOf(e)); }
    finally { changing.current = false; if (alive.current) setStarting(false); }
  }

  const stateLabel = checking ? 'Checking runtime' : starting ? 'Connecting…' : busy ? `${active} working` : connected ? 'Ready' : isDesktop ? 'Offline' : 'Desktop required';
  const missing = Boolean(status && !status.binary);

  return <section className="cli-page agent-page task-workbench screen-content" aria-label="Task agents">
    <div className="cli-heading">
      <span className="eyebrow">AIRA AGENTS</span>
      <div className="agent-title-row">
        <h1>A little more possible.</h1>
        <span className={`workbench-status ${connected ? 'connected' : ''}`} role="status"><span />{stateLabel}</span>
      </div>
      <p>Give your agents a clear goal. Follow the work, keep the result.</p>
    </div>

    <div className="task-workbench-layout">
      <aside className="workbench-sidebar" aria-label="Agent setup">
        <div className="workbench-section-label"><Bot /> YOUR TEAM</div>
        <h2>One goal. The right agents.</h2>
        <p className="workbench-muted">Choose who receives your task. Each selected agent runs separately.</p>
        <div className="workbench-label-row"><label className="workbench-label" htmlFor="task-model">Model</label><button className="workbench-text-button" disabled={connected || starting || checking} aria-label="Refresh task runtime and models" onClick={() => void refreshSetup()}><RefreshCw /></button></div>
        <select id="task-model" className="workbench-select" value={model} disabled={connected || busy || starting} onChange={e => setModel(e.target.value)}>
          {!models.length && <option value="">No connected models</option>}
          {models.map(m => <option key={m.id} value={m.id}>{m.label} · {m.provider}</option>)}
        </select>
        {connected && <p className="workbench-hint">Disconnect to change the model.</p>}
        {agents.length > 0 && <div className="workbench-agent-list">
          {agents.map(({ agent }) => <label className="workbench-agent-choice" key={agent.id}>
            <input type="checkbox" checked={selected.includes(agent.id)} disabled={busy || starting} onChange={() => setSelected(ids => ids.includes(agent.id) ? ids.filter(id => id !== agent.id) : [...ids, agent.id])} />
            <span><strong>{agent.name}</strong><small>Task agent</small></span><Bot />
          </label>)}
        </div>}
        <button className={`workbench-primary ${connected ? 'secondary' : ''}`} disabled={!isDesktop || checking || starting || (!connected && missing)} onClick={() => void (connected ? stop() : start())}>
          {starting ? <Loader2 className="spin" /> : <Power />}{connected ? busy ? 'Stop all agents' : 'Disconnect' : 'Connect agents'}
        </button>
        <div className="workbench-runtime-note"><ShieldCheck /><span>{!isDesktop ? 'Local tools run in the Aira desktop app. Your chat is available on the web.' : missing ? 'OpenClaw is not installed. Install the supported runtime, then reconnect.' : 'Agents run on this device. Stopping a task shuts down the task runtime.'}</span></div>
        {missing && <code className="workbench-install">npm install -g openclaw</code>}
        <a className="workbench-doc-link" href="https://docs.openclaw.ai/" target="_blank" rel="noreferrer noopener">Runtime setup guide <ArrowUpRight /></a>
      </aside>

      <div className="workbench-main">
        <div className="workbench-output-heading"><span><Activity />Workspace</span><button className="workbench-text-button" disabled={busy || starting || !sent} onClick={() => { setSent(''); setAgents(list => list.map(a => blank(a.agent))); }}><Plus />New task</button></div>
        {error && <div className="workbench-alert" role="alert"><WifiOff /><span>{error}</span></div>}
        {notice && <div className="workbench-notice" role="status">{notice}</div>}
        <div className="workbench-results">
          {!sent ? <div className="workbench-empty">
            <div className="workbench-empty-icon"><Bot /></div>
            <span className="eyebrow">FROM IDEA TO OUTCOME</span>
            <h2>What can we move forward?</h2>
            <p>Planning, synthesis, and thoughtful second opinions.<br />Start with the outcome you want to reach.</p>
            <div className="workbench-examples">{examples.map(example => <button key={example} onClick={() => setTask(example)}>{example}<ArrowUpRight /></button>)}</div>
          </div> : <>
            <div className="workbench-goal"><span className="eyebrow">YOUR TASK</span><p>{sent}</p></div>
            {agents.filter(a => a.startedAt !== null).map(state => <AgentCard key={state.agent.id} state={state} open={expanded.includes(state.agent.id)} onToggle={() => setExpanded(ids => ids.includes(state.agent.id) ? ids.filter(id => id !== state.agent.id) : [...ids, state.agent.id])} />)}
          </>}
        </div>
        <form className="workbench-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
          <textarea aria-label="Task for selected agents" placeholder={!isDesktop ? 'Open Aira desktop to run local agents…' : connected ? 'Describe the outcome, context, and any constraints…' : 'Write a task, then connect your agents…'} value={task} onChange={e => setTask(e.target.value)} rows={3} disabled={busy || starting} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
          <div className="workbench-composer-footer"><span>{selected.length ? `${selected.length} agent${selected.length === 1 ? '' : 's'} selected` : 'Select an agent'}<span className="workbench-key-hint"> · ⌘ / Ctrl + Enter</span></span>
            {busy ? <button key="stop" className="workbench-primary compact" type="button" disabled={starting} onClick={event => { event.preventDefault(); void stop(); }}><Square />Stop task</button> : <button key="send" className="workbench-primary compact" disabled={!connected || !task.trim() || !selected.length || starting} type="submit"><Send />Run task</button>}
          </div>
        </form>
      </div>
    </div>
  </section>;
}

const PHASE_LABEL: Record<Phase, string> = { idle: 'Ready', working: 'Working', done: 'Complete', error: 'Failed', stopped: 'Stopped' };

function AgentCard({ state, open, onToggle }: { state: AgentState; open: boolean; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const elapsed = state.startedAt ? Math.max(0, ((state.endedAt ?? Date.now()) - state.startedAt) / 1000) : 0;
  async function copy() {
    try { await navigator.clipboard.writeText(state.text); setCopied(true); setCopyError(''); }
    catch { setCopyError('Clipboard access is unavailable. Select the output to copy it.'); }
  }
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2_000); return () => clearTimeout(timer); }, [copied]);
  return <article className={`workbench-result ${state.phase}`}>
    <div className="workbench-result-header"><span className="workbench-result-avatar"><Bot /></span><div><strong>{state.agent.name}</strong><span>{PHASE_LABEL[state.phase]}</span></div>
      <button className="workbench-icon-button" type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} output from ${state.agent.name}`}><ChevronDown className={open ? 'expanded' : ''} /></button>
    </div>
    {open && <div className="workbench-result-body">
      {state.text ? <Markdown>{state.text}</Markdown> : <p className="workbench-muted">{state.phase === 'working' ? 'Working on your task. Output will appear here.' : 'No text was returned.'}</p>}
      {state.error && <div className="workbench-alert" role="alert">{state.error}</div>}
      {copyError && <p className="workbench-muted" role="status">{copyError}</p>}
    </div>}
    <div className="workbench-result-footer"><span><Clock3 />{Math.round(elapsed)}s</span><span><Cpu />{state.text.length.toLocaleString()} characters</span>
      {state.phase === 'working' && <Loader2 className="spin" />}
      {state.text && <button type="button" className="workbench-text-button" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy output'}</button>}
    </div>
  </article>;
}
