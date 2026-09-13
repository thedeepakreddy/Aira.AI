import { useCallback, useEffect, useRef, useState } from 'react';
import { isDesktop, supervisor, OpenClawClient, type Agent, type OpenClawStatus } from '@/lib/openclaw';
import { getAccessToken } from '@/lib/supabase';
import { listCatalogue, type ModelSpec } from '@/lib/gateway';
import { createStreamBuffer } from '@/lib/stream-buffer';
import AgentCanvas from './agent-canvas';

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
/** One line on what each member is for, so the checkboxes mean something. */
const ROLES: Record<string, string> = {
  Research: 'Finds and verifies information',
  Plan: 'Turns a goal into ordered steps',
  Write: 'Drafts and edits prose',
  Review: 'Finds what is wrong or missing',
  Analyse: 'Reasons over data and trade-offs',
};
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

  /** Stops the running task and leaves the runtime up, so the next one is instant. */
  function stopTask() {
    runs.current?.abort();
    runs.current = null;
    setBusy(false);
    setAgents(list => list.map(a => a.phase === 'working' ? { ...a, phase: 'stopped', endedAt: Date.now() } : a));
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
      setNotice('Agents disconnected. Your output is preserved.');
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
    if (!text || busy || changing.current) return;
    changing.current = true; setStarting(true); setError(''); setNotice('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to continue.');
      // A refreshed login token must reach the child process before another run.
      // Connect on demand. Making this a separate button the user had to find
      // and press first put a fifteen-second wall in front of the one thing
      // they came to do; the task they typed is a clear enough instruction to
      // start the runtime for.
      let targets = selected;
      if (!connected || activeToken.current !== token) {
        setNotice(connected ? '' : 'Starting your agents…');
        const available = await connect(token);
        targets = selected.filter(id => available.some(agent => agent.id === id));
        if (!targets.length) targets = available.slice(0, 1).map(agent => agent.id);
        setNotice('');
      }
      const c = client.current;
      if (!c) throw new Error('Connect the task runtime first.');
      const controller = new AbortController(); runs.current = controller;
      setSent(text); setTask(''); setBusy(true); setExpanded(targets); setSelected(targets);
      setAgents(list => list.map(a => targets.includes(a.agent.id) ? { ...blank(a.agent), phase: 'working', startedAt: Date.now() } : blank(a.agent)));
      changing.current = false; setStarting(false);
      // One render a frame for all agents together. Appending per token rebuilt
      // the agent list for every token of every agent at once, so running three
      // agents cost three times the renders for the same answer.
      const buffer = createStreamBuffer<string>(batch => {
        if (!alive.current || controller.signal.aborted) return;
        setAgents(list => list.map(a => {
          const delta = batch.get(a.agent.id);
          return delta ? { ...a, text: a.text + delta } : a;
        }));
      });
      try {
      await Promise.all(targets.map(async id => {
        try {
          await c.stream(id, text, delta => {
            if (!alive.current || controller.signal.aborted) return;
            buffer.push(id, delta);
          }, controller.signal);
          if (!controller.signal.aborted) update(id, { phase: 'done', endedAt: Date.now() });
        } catch (e) {
          if (!controller.signal.aborted) update(id, { phase: 'error', error: messageOf(e), endedAt: Date.now() });
        }
      }));
      } finally {
        // Whatever arrived in the final frame still has to be shown.
        if (alive.current && !controller.signal.aborted) buffer.finish(); else buffer.dispose();
      }
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

  return <AgentCanvas
    agents={agents.map(a => ({
      id: a.agent.id, name: a.agent.name, role: ROLES[a.agent.name] ?? 'Task agent',
      phase: a.phase, text: a.text, startedAt: a.startedAt, endedAt: a.endedAt, error: a.error,
    }))}
    selected={selected}
    onToggleSelect={id => setSelected(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id])}
    task={task}
    onTaskChange={setTask}
    sent={sent}
    busy={busy}
    starting={starting || checking}
    connected={connected}
    error={error || notice}
    models={models.map(m => ({ id: m.id, label: m.label }))}
    model={model}
    onModelChange={setModel}
    modelLocked={connected || busy || starting}
    examples={examples}
    onRun={() => void send()}
    onStop={() => (busy ? stopTask() : void stop())}
    onNewProject={() => { setSent(''); setAgents(list => list.map(a => blank(a.agent))); setNotice(''); }}
    onSave={() => {
      // The board's own content, saved as one document.
      const body = agents.filter(a => a.text).map(a => `## ${a.agent.name}\n\n${a.text}`).join('\n\n');
      const file = new Blob([`# ${sent}\n\n${body}\n`], { type: 'text/markdown' });
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url; link.download = 'aira-project.md';
      link.click();
      URL.revokeObjectURL(url);
    }}
    canSave={Boolean(sent && agents.some(a => a.text))}
    footnote={!isDesktop
      ? 'Local agents run in the Aira desktop app. Your chat is available on the web.'
      : missing ? 'OpenClaw is not installed. Install the runtime, then run a task.'
      : 'Planning, synthesis, and thoughtful second opinions. Start with the outcome you want.'}
  />;
}
