import { useCallback, useEffect, useRef, useState } from 'react';
import { isDesktop, supervisor, OpenClawClient, type Agent, type OpenClawStatus } from '@/lib/openclaw';
import { getAccessToken, getSession } from '@/lib/supabase';
import { BOARD_KEY, loadBoard, saveBoard } from '@/lib/agent-board';
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
/**
 * Who gets a task when nothing has been chosen.
 *
 * Never the lead: it directs the others and writes up what they found, so a
 * board where only the lead is ticked has nobody to report to it.
 */
function defaultSelection(available: Agent[]): string[] {
  const specialist = available.find(a => !a.id.endsWith('/lead'));
  return specialist ? [specialist.id] : available.slice(0, 1).map(a => a.id);
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
/** One line on what each member is for, so the checkboxes mean something. */
const ROLES: Record<string, string> = {
  Lead: 'Directs the team and writes the answer',
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
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(isDesktop);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [model, setModel] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const client = useRef<OpenClawClient | null>(null);
  /** One controller per agent, so runs are independent. */
  const runs = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  const changing = useRef(false);
  const activeToken = useRef<string | null>(null);
  /** In-flight connect, shared so concurrent tasks await it rather than race. */
  const connecting = useRef<Promise<Agent[]> | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const connected = Boolean(status?.running && client.current && agents.length);
  const active = agents.filter(a => a.phase === 'working').length;
  const busy = active > 0;

  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => tick(n => n + 1), 1_000);
    return () => clearInterval(interval);
  }, [busy]);

  // Restore the last board for this account, so closing Aira does not throw
  // away the work. Agents reattach separately; this is only their output.
  useEffect(() => {
    let cancelled = false;
    void getSession().then(session => {
      const id = session?.user.id ?? null;
      if (cancelled) return;
      setAccount(id);
      const saved = loadBoard(id);
      if (!saved) return;
      setSent(saved.sent);
      setAgents(previous => previous.length ? previous : saved.results.map(r => ({
        agent: { id: r.id, name: r.name }, phase: (r.error ? 'error' : 'done') as Phase,
        text: r.text, startedAt: null, endedAt: saved.at, error: r.error,
      })));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Persist whenever a run settles, not on every token.
  useEffect(() => {
    if (!account || !sent || busy) return;
    saveBoard(account, {
      sent, at: Date.now(),
      results: agents.filter(a => a.text || a.error).map(a => ({
        id: a.agent.id, name: a.agent.name, text: a.text, error: a.error,
      })),
    });
  }, [account, sent, busy, agents]);

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
          setSelected(defaultSelection(found));
          activeToken.current = null; // Verify credentials on the next task.
        }
      } catch (e) {
        if (!cancelled) setError(messageOf(e));
      } finally { if (!cancelled) setChecking(false); }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      for (const controller of runs.current.values()) controller.abort();
      runs.current.clear();
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
      return valid.length ? valid : defaultSelection(found);
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

  /** Stops every running agent and leaves the runtime up. */
  function stopTask() {
    for (const controller of runs.current.values()) controller.abort();
    runs.current.clear();
    setAgents(list => list.map(a => a.phase === 'working'
      ? { ...a, phase: 'stopped', endedAt: Date.now() } : a));
  }

  /** Stops one agent without touching the others. */
  function stopAgent(id: string) {
    runs.current.get(id)?.abort();
    runs.current.delete(id);
    update(id, { phase: 'stopped', endedAt: Date.now() });
  }

  async function stop() {
    if (changing.current) return;
    changing.current = true; setStarting(true); setError('');
    try {
      for (const controller of runs.current.values()) controller.abort();
      runs.current.clear();
      await supervisor.stop();
      client.current = null; activeToken.current = null;
      setStatus(await supervisor.status());
      setAgents(list => list.map(a => a.phase === 'working' ? { ...a, phase: 'stopped', endedAt: Date.now() } : a));
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

  /**
   * Starts a run on each named agent.
   *
   * Runs are tracked per agent rather than one controller for the whole board.
   * A single shared controller meant a second task could not begin until the
   * first finished — so giving one agent a follow-up, or handing a result to
   * another, was impossible while anything was still working. Each agent now
   * owns its own run and its own Stop.
   */
  /**
   * Starts a run on each named agent.
   *
   * Runs are tracked per agent rather than one controller for the whole board,
   * so a follow-up to one agent — or handing a result to another — never waits
   * on anything else.
   */
  async function dispatch(
    text: string,
    targets: string[],
    options: { headline?: boolean; reset?: boolean } = {},
  ) {
    const body = text.trim();
    if (!body) return;
    // Not `!targets.length`: before the first connect there are no agents to
    // have selected, so that guard returned here every time — the composer
    // cleared itself and nothing happened, which is what "the buttons do
    // nothing" looked like. An empty selection is only meaningless once agents
    // exist to choose from; otherwise connecting is what produces them.
    if (!targets.length && connected) {
      setError('Choose at least one agent for this task.');
      return;
    }
    setError(''); setNotice('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to continue.');

      let ids = targets;
      if (!connected || activeToken.current !== token) {
        // A second task pressed during the fifteen-second connect used to be
        // dropped on the floor by a `changing` guard — the button did nothing
        // and said nothing. Concurrent callers now await the same connect
        // instead of racing it or being discarded.
        setStarting(true);
        setNotice('Starting your agents…');
        connecting.current ??= connect(token).finally(() => { connecting.current = null; });
        const available = await connecting.current;
        ids = targets.filter(id => available.some(agent => agent.id === id));
        // Nothing was selected because nothing existed to select. Default to
        // the first agent rather than the whole team: five agents on a first
        // task is five bills for one question.
        if (!ids.length) ids = defaultSelection(available);
        setSelected(ids);
        setNotice('');
        if (alive.current) setStarting(false);
      }

      const c = client.current;
      if (!c) throw new Error('Connect the task runtime first.');
      if (options.headline) setSent(body);
      setExpanded(previous => [...new Set([...previous, ...ids])]);

      const buffer = createStreamBuffer<string>(batch => {
        if (!alive.current) return;
        setAgents(list => list.map(a => {
          const delta = batch.get(a.agent.id);
          return delta ? { ...a, text: a.text + delta } : a;
        }));
      });

      await Promise.all(ids.map(async id => {
        // A fresh run replaces whatever that agent was doing, and leaves every
        // other agent alone.
        runs.current.get(id)?.abort();
        const controller = new AbortController();
        runs.current.set(id, controller);
        setAgents(list => list.map(a => {
          if (a.agent.id !== id) return a;
          // A new board task starts the card clean. A follow-up keeps what the
          // agent already wrote and adds to it — wiping it would throw away the
          // work the follow-up is asking it to build on.
          const kept = options.reset || !a.text ? '' : `${a.text}\n\n---\n\n`;
          return { ...blank(a.agent), text: kept, phase: 'working', startedAt: Date.now() };
        }));
        try {
          await c.stream(id, body, delta => {
            if (!alive.current || controller.signal.aborted) return;
            buffer.push(id, delta);
          }, controller.signal);
          buffer.finish();
          if (!controller.signal.aborted) update(id, { phase: 'done', endedAt: Date.now() });
        } catch (e) {
          buffer.finish();
          if (!controller.signal.aborted) {
            update(id, { phase: 'error', error: messageOf(e), endedAt: Date.now() });
          }
        } finally {
          if (runs.current.get(id) === controller) runs.current.delete(id);
        }
      }));
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setStarting(false);
    }
  }

  /**
   * The board composer.
   *
   * Two phases when a lead is available: the selected specialists answer the
   * goal in parallel, then the lead reads what they produced and writes the
   * answer. Before this, a board task fanned out to N agents who each replied
   * independently and nothing joined them up — a panel of opinions rather than
   * a team, and the user was left to reconcile them by reading every card.
   *
   * The specialists' raw output stays on their own cards. The lead's answer is
   * the one the board is actually for.
   */
  async function send() {
    const text = task.trim();
    if (!text) return;
    setTask('');
    try {
      const lead = agents.find(a => a.agent.id.endsWith('/lead'))?.agent.id;
      const specialists = selected.filter(id => id !== lead);

      // No lead configured, or nothing else picked: this is a plain run.
      if (!lead || !specialists.length) {
        await dispatch(text, selected.length ? selected : [lead ?? ''].filter(Boolean),
          { headline: true, reset: true });
        return;
      }

      await dispatch(text, specialists, { headline: true, reset: true });
      if (!alive.current) return;

      // Read the results off the latest state rather than the closure, which
      // was captured before any of them had written a word.
      const reports = await new Promise<{ name: string; text: string }[]>(resolve => {
        setAgents(list => {
          resolve(list
            .filter(a => specialists.includes(a.agent.id) && a.text.trim())
            .map(a => ({ name: a.agent.name, text: a.text.trim() })));
          return list;
        });
      });
      if (!reports.length || !alive.current) return;

      await dispatch(
        `Goal: ${text}\n\n`
        + reports.map(r => `## ${r.name} reported\n\n${r.text}`).join('\n\n')
        + `\n\nWrite the answer to the goal from these reports.`,
        [lead],
        { reset: true },
      );
    } catch {
      // dispatch surfaces its own error; put the text back so it is not lost.
      if (alive.current) setTask(current => current || text);
    }
  }

  /** Hands one agent's result to another, with an instruction. */
  function handOff(fromId: string, toId: string, instruction: string) {
    const source = agents.find(a => a.agent.id === fromId);
    if (!source?.text) return;
    void dispatch(
      `${instruction}\n\nHere is ${source.agent.name}'s work to build on:\n\n${source.text}`,
      [toId],
    );
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
    onRun={send}
    onStop={() => (busy ? stopTask() : void stop())}
    onRunAgent={(id, text) => void dispatch(text, [id])}
    onStopAgent={stopAgent}
    onHandOff={handOff}
    onSelectAll={() => setSelected(agents.map(a => a.agent.id))}
    onToggleOutput={() => setExpanded(previous =>
      previous.length ? [] : agents.filter(a => a.text).map(a => a.agent.id))}
    onRefresh={() => void refreshSetup()}
    onCopy={() => {
      const body = agents.filter(a => a.text)
        .map(a => `## ${a.agent.name}\n\n${a.text}`).join('\n\n');
      void navigator.clipboard.writeText(`# ${sent}\n\n${body}\n`)
        .then(() => setNotice('Board copied to the clipboard.'))
        .catch(() => setError('Clipboard access is unavailable. Use Save instead.'));
    }}
    helpUrl="https://docs.openclaw.ai/" 
    onNewProject={() => {
      // A new project is a clean board: stop what is running, clear the cards,
      // the headline task, the composer and any leftover message. It used to
      // reset only the cards, so the text you had typed survived into the
      // "new" project and agents kept working on the old one.
      stopTask();
      // Also clear what was stored, or the "new" board returns on next launch.
      if (account) { try { localStorage.removeItem(`${BOARD_KEY}.${account}`); } catch { /* ignore */ } }
      setSent(''); setTask(''); setNotice(''); setError('');
      setExpanded([]);
      setAgents(list => list.map(a => blank(a.agent)));
    }}
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
