import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, History, Loader2, MessageCircleQuestion, Plus, Power, RefreshCw, Send, ShieldAlert, ShieldCheck, Square, Terminal, WifiOff } from 'lucide-react';
import { isDesktop, supervisor, pickDirectory, OpenCodeClient, toolTarget, type AgentEvent, type OpenCodeStatus, type PermissionRequest, type QuestionRequest, type ToolActivity } from '@/lib/opencode';
import { getAccessToken } from '@/lib/supabase';
import { listCatalogue, fetchUsage, type ModelSpec, type UsageSummary } from '@/lib/gateway';
import { log as appLog } from '@/lib/applog';
import SessionHistory, { type HistoryEntry } from './session-history';
import Markdown from './markdown';
import '@/styles/agent-workbench.css';
import '@/styles/code-terminal.css';

type Reply = 'once' | 'always' | 'reject';
type Entry =
  | { kind: 'tool'; activity: ToolActivity }
  | { kind: 'you' | 'agent'; text: string; partID?: string }
  | { kind: 'notice'; text: string }
  | { kind: 'permission'; request: PermissionRequest; resolved?: Reply }
  | { kind: 'question'; request: QuestionRequest; answers?: string[][]; skipped?: boolean };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * How much transcript to keep.
 *
 * Every entry is a live DOM node, and the hot path below rebuilds the array on
 * each streamed delta — so the cost of one token is proportional to the length
 * of the whole session. Unbounded, a long run on a large-context model spends
 * minutes getting slower and then stops responding, which is what "it crashed
 * after ten minutes" turned out to be.
 *
 * The window is generous enough that no ordinary session reaches it; the whole
 * conversation is still on disk in the runtime, and reconnecting replays it.
 */
const TRANSCRIPT_LIMIT = 400;

/** Trims the head, leaving a marker so the gap is visible rather than silent. */
function capped(entries: Entry[]): Entry[] {
  if (entries.length <= TRANSCRIPT_LIMIT) return entries;
  const dropped = entries.length - TRANSCRIPT_LIMIT;
  return [
    { kind: 'notice', text: `${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} hidden to keep this view responsive` },
    ...entries.slice(dropped + 1),
  ];
}
const examples = ['Explain the architecture of this project', 'Find a bug and propose a focused fix', 'Add tests for the most important untested behavior'];

async function replay(client: OpenCodeClient, sessionID: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const message of await client.messages(sessionID)) {
    for (const part of message.parts ?? []) {
      if (part.type === 'text' && part.text?.trim()) entries.push({ kind: message.info?.role === 'user' ? 'you' : 'agent', text: part.text, partID: part.id });
      else if (part.type === 'tool' && part.tool && part.tool !== 'question') entries.push({ kind: 'tool', activity: {
        partID: part.id ?? `replay-${entries.length}`, tool: part.tool,
        status: part.state?.status === 'error' ? 'error' : part.state?.status === 'running' ? 'running' : part.state?.status === 'pending' ? 'pending' : 'completed',
        target: toolTarget(part.state?.input),
      } });
    }
  }
  return entries;
}

export default function AgentPanel() {
  const [status, setStatus] = useState<OpenCodeStatus | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState('');
  /* Every error the panel shows also goes to the durable log, so a failure is
   * still diagnosable after the banner is dismissed or the window reloads. */
  const setError = useCallback((message: string) => {
    setErrorState(message);
    if (message) appLog('code', 'error', message);
  }, []);
  const [workdir, setWorkdir] = useState('');
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(isDesktop);
  const [streamState, setStreamState] = useState<'offline' | 'connecting' | 'live'>('offline');
  const [sessionID, setSessionID] = useState<string | null>(null);
  /* What this surface has spent. A coding agent runs long and reads a lot;
   * the panel that hides the bill is the one you stop trusting. */
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  /* Past coding sessions. These live in OpenCode, not in Aira — it had fifty-two
   * stored for this machine and no way to reach any of them from here. */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<HistoryEntry[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [model, setModel] = useState('');
  const client = useRef<OpenCodeClient | null>(null);
  const session = useRef<string | null>(null);
  const stream = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const alive = useRef(true);
  const changing = useRef(false);
  const sending = useRef(false);
  const decisionLocks = useRef(new Set<string>());
  const activeToken = useRef<string | null>(null);
  const revision = useRef(0);
  const connected = Boolean(status?.running && sessionID && client.current);
  const ready = connected && streamState === 'live' && !starting;
  const waiting = entries.some(entry => entry.kind === 'permission' ? !entry.resolved : entry.kind === 'question' && !entry.answers && !entry.skipped);

  useEffect(() => {
    if (entries.length && followOutput.current) log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'instant' });
  }, [entries]);

  const note = useCallback((text: string) => {
    if (alive.current) setEntries(previous => capped([...previous, { kind: 'notice', text }]));
  }, []);

  const applyEvent = useCallback((event: AgentEvent) => {
    if (!alive.current) return;
    revision.current++;
    switch (event.kind) {
      case 'text':
        setEntries(previous => {
          // The part being streamed is the last entry in all but pathological
          // cases, so try the tail before scanning the whole transcript.
          const last = previous[previous.length - 1];
          if (last?.kind === 'agent' && last.partID === event.partID) {
            const next = previous.slice();
            next[next.length - 1] = { ...last, text: last.text + event.delta };
            return next;
          }
          const at = previous.findIndex(entry => entry.kind === 'agent' && entry.partID === event.partID);
          if (at < 0) return capped([...previous, { kind: 'agent', text: event.delta, partID: event.partID }]);
          const next = previous.slice();
          const found = next[at];
          if (found.kind === 'agent') next[at] = { ...found, text: found.text + event.delta };
          return next;
        });
        break;
      case 'tool':
        setEntries(previous => previous.some(entry => entry.kind === 'tool' && entry.activity.partID === event.activity.partID)
          ? previous.map(entry => entry.kind === 'tool' && entry.activity.partID === event.activity.partID ? { kind: 'tool', activity: event.activity } : entry)
          : capped([...previous, { kind: 'tool', activity: event.activity }]));
        break;
      case 'permission':
        setEntries(previous => previous.some(entry => entry.kind === 'permission' && entry.request.id === event.request.id) ? previous : [...previous, { kind: 'permission', request: event.request }]);
        break;
      case 'permission-resolved':
        setEntries(previous => previous.map(entry => entry.kind === 'permission' && entry.request.id === event.id ? { ...entry, resolved: event.reply === 'always' ? 'always' : event.reply === 'reject' ? 'reject' : 'once' } : entry));
        break;
      case 'question':
        setEntries(previous => previous.some(entry => entry.kind === 'question' && entry.request.id === event.request.id) ? previous : [...previous, { kind: 'question', request: event.request }]);
        break;
      case 'question-resolved':
        setEntries(previous => previous.map(entry => entry.kind === 'question' && entry.request.id === event.id ? { ...entry, answers: event.answers, skipped: !event.answers } : entry));
        break;
      case 'file-edited': if (event.path) note(`Edited ${event.path}`); break;
      case 'idle': setBusy(false); sending.current = false; break;
      case 'status': setBusy(event.status !== 'idle'); if (event.status === 'idle') sending.current = false; break;
      case 'error': setError(event.message); setBusy(false); sending.current = false; break;
      default: break;
    }
  }, [note]);

  const refreshSession = useCallback(async (c: OpenCodeClient, id: string, signal?: AbortSignal) => {
    const snapshot = revision.current;
    const [history, statuses, permissions, questions] = await Promise.all([
      replay(c, id), c.sessionStatuses(), c.permissions(), c.questions(),
    ]);
    if (!alive.current || signal?.aborted || session.current !== id || client.current !== c || snapshot !== revision.current) return;
    // Pending requests are queried explicitly: they may predate this connection.
    setEntries([...history,
      ...permissions.filter(request => request.sessionID === id).map(request => ({ kind: 'permission' as const, request })),
      ...questions.filter(request => request.sessionID === id).map(request => ({ kind: 'question' as const, request })),
    ]);
    const working = Boolean(statuses[id] && statuses[id].type !== 'idle');
    setBusy(working); sending.current = working;
  }, []);

  const connectStream = useCallback(async (c: OpenCodeClient, id: string): Promise<void> => {
    stream.current?.abort();
    const controller = new AbortController(); stream.current = controller;
    const signal = controller.signal;
    setStreamState('connecting');
    // Resolve only once the event endpoint is open. A task must never start
    // while its permission prompts have nowhere to go.
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => { if (!opened) { controller.abort(); reject(new Error('The coding event stream did not connect. Try reconnecting.')); } }, 15_000);
      void (async () => {
        for (let attempt = 0; attempt < 5 && !signal.aborted && alive.current; attempt++) {
          try {
            for await (const event of c.events(signal, id, () => {
              opened = true; clearTimeout(timeout);
              if (alive.current && !signal.aborted) setStreamState('live');
              resolve();
            })) {
              if (signal.aborted || session.current !== id) return;
              applyEvent(event);
              if (event.kind === 'idle' || (event.kind === 'status' && event.status === 'idle')) {
                void refreshSession(c, id, signal).catch(e => { if (!signal.aborted && alive.current) setError(`Could not sync the task history: ${messageOf(e)}`); });
              }
            }
            if (!signal.aborted) throw new Error('The coding event stream closed.');
          } catch (e) {
            if (signal.aborted || !alive.current) break;
            setStreamState('connecting');
            if (attempt === 4) { setError(`Lost the coding event connection. ${messageOf(e)}`); break; }
            await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(4_000, 500 * 2 ** attempt)));
            if (!signal.aborted) await refreshSession(c, id, signal).catch(() => undefined);
          }
        }
        clearTimeout(timeout);
        if (!opened) reject(new Error('Could not connect to the coding event stream.'));
        if (!signal.aborted && alive.current) {
          setStreamState('offline');
          void supervisor.status().then(current => {
            if (signal.aborted || !alive.current) return;
            setStatus(current);
            if (!current.running) { client.current = null; activeToken.current = null; }
          }).catch(() => undefined);
        }
      })();
    });
  }, [applyEvent, refreshSession]);

  useEffect(() => {
    if (busy) return;
    void fetchUsage('code').then(next => { if (alive.current) setUsage(next); }).catch(() => undefined);
  }, [busy]);

  /* Refreshed when a task ends rather than on a timer: that is when the list
   * has actually changed, and it is also when the reader might go looking. */
  useEffect(() => {
    const c = client.current;
    if (!c || busy) return;
    void c.sessions().then(all => {
      if (!alive.current) return;
      setSessions(all
        .filter(item => !workdir || item.directory === workdir)
        .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
        .slice(0, 40)
        .map(item => ({
          id: item.id,
          title: item.title || 'Untitled session',
          at: item.time?.updated ?? 0,
          detail: item.directory?.split('/').filter(Boolean).at(-1),
        })));
    }).catch(() => undefined);
  }, [busy, connected, workdir, sessionID]);

  /** Loads a stored session into the panel, replacing what is on screen. */
  const openSession = useCallback(async (id: string) => {
    const c = client.current;
    if (!c || busy) return;
    setError('');
    try {
      stream.current?.abort();
      session.current = id;
      setSessionID(id);
      setEntries([]);
      await refreshSession(c, id);
      await connectStream(c, id);
    } catch (e) { setError(`Could not open that session: ${messageOf(e)}`); }
  }, [busy, connectStream, refreshSession, setError]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void listCatalogue().then(({ models: available, routing }) => {
      if (cancelled) return;
      setModels(available); setModel(current => current || routing.code || available[0]?.id || '');
    });
    if (isDesktop) void (async () => {
      try {
        const current = await supervisor.status();
        if (cancelled) return;
        setStatus(current);
        if (current.model) setModel(current.model);
        if (!current.running || !current.port || !current.password) return;
        const c = new OpenCodeClient(current.port, current.password);
        const all = await c.sessions();
        if (cancelled) return;
        const found = all.filter(item => item.directory === current.directory).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
        if (!found) { setWorkdir(current.directory ?? ''); return; }
        client.current = c; session.current = found.id; setSessionID(found.id); setWorkdir(found.directory);
        await refreshSession(c, found.id);
        if (cancelled) return;
        await connectStream(c, found.id);
      } catch (e) { if (!cancelled) setError(messageOf(e)); }
      finally { if (!cancelled) setChecking(false); }
    })();
    return () => {
      cancelled = true; alive.current = false; stream.current?.abort();
      queueMicrotask(() => { if (isDesktop && !alive.current) void supervisor.stop().catch(() => undefined); });
    };
  }, [connectStream, refreshSession]);

  async function launch(token: string, resume?: string) {
    if (!workdir.trim()) throw new Error('Choose the project folder your coding agent should work in.');
    const catalogue = await listCatalogue();
    const chosen = model || catalogue.routing.code || catalogue.models[0]?.id;
    if (!chosen || !catalogue.models.some(item => item.id === chosen)) throw new Error('Connect a model provider in Aira before starting the coding agent.');
    setModels(catalogue.models); setModel(chosen);
    stream.current?.abort(); setStreamState('connecting');
    if (status?.running) await supervisor.stop();
    client.current = null; activeToken.current = null;
    const next = await supervisor.start({
      gatewayUrl: (import.meta.env?.VITE_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787',
      token, model: chosen, directory: workdir,
      catalogue: catalogue.models.map(m => m.id),
    });
    if (!alive.current) { await supervisor.stop(); throw new Error('The workspace was closed.'); }
    setStatus(next);
    if (!next.running || !next.port || !next.password) throw new Error('The coding runtime could not start.');
    const c = new OpenCodeClient(next.port, next.password);
    let healthy = false;
    for (let attempt = 0; attempt < 25 && alive.current; attempt++) {
      try { healthy = (await c.health()).healthy; if (healthy) break; } catch { /* process is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!alive.current) { await supervisor.stop(); throw new Error('The workspace was closed.'); }
    if (!healthy) {
      const tail = (await supervisor.log().catch(() => [])).slice(-3).join(' · ');
      throw new Error(`The coding runtime did not become ready.${tail ? ` ${tail}` : ' Check your OpenCode installation and try again.'}`);
    }
    const created = resume ? null : await c.createSession(workdir);
    const id = resume ?? created!.id;
    if (!alive.current) { await supervisor.stop(); throw new Error('The workspace was closed.'); }
    client.current = c; session.current = id; setSessionID(id); activeToken.current = token;
    await refreshSession(c, id);
    await connectStream(c, id);
    return c;
  }

  async function start() {
    if (changing.current || busy) return;
    changing.current = true; setStarting(true); setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in to start the coding agent.');
      await launch(token, session.current ?? undefined);
    } catch (e) { if (alive.current) { setError(messageOf(e)); setStreamState('offline'); } }
    finally { changing.current = false; if (alive.current) setStarting(false); }
  }

  async function refreshSetup() {
    setChecking(true); setError('');
    try {
      const catalogue = await listCatalogue();
      setModels(catalogue.models);
      setModel(current => catalogue.models.some(item => item.id === current) ? current : catalogue.routing.code ?? catalogue.models[0]?.id ?? '');
      if (isDesktop) setStatus(await supervisor.status());
    } catch (e) { setError(messageOf(e)); }
    finally { if (alive.current) setChecking(false); }
  }

  async function stop() {
    if (changing.current) return;
    changing.current = true; setStarting(true); setError('');
    try {
      await supervisor.stop();
      stream.current?.abort(); stream.current = null; client.current = null;
      activeToken.current = null; sending.current = false;
      setStatus(await supervisor.status()); setBusy(false); setStreamState('offline');
      note('Coding runtime stopped. Your project and conversation are saved.');
    } catch (e) { setError(`Could not stop the coding runtime: ${messageOf(e)}`); }
    finally { changing.current = false; if (alive.current) setStarting(false); }
  }

  async function chooseFolder() {
    if (busy || changing.current || connected) return;
    try {
      const chosen = await pickDirectory(workdir);
      if (!chosen || chosen === workdir) return;
      setWorkdir(chosen); session.current = null; setSessionID(null); setEntries([]);
    } catch (e) { setError(`Could not choose a project: ${messageOf(e)}`); }
  }

  async function newSession() {
    if (!client.current || busy || changing.current) return;
    changing.current = true; setStarting(true); setError('');
    try {
      const created = await client.current.createSession(workdir);
      session.current = created.id; setSessionID(created.id); setEntries([]);
      await connectStream(client.current, created.id);
    } catch (e) { setError(messageOf(e)); }
    finally { changing.current = false; setStarting(false); }
  }

  async function reconnect() {
    if (!client.current || !session.current || changing.current) return;
    changing.current = true; setStarting(true); setError('');
    try { await refreshSession(client.current, session.current); await connectStream(client.current, session.current); }
    catch (e) { setError(messageOf(e)); }
    finally { changing.current = false; setStarting(false); }
  }

  async function send() {
    const text = task.trim();
    if (!text || !ready || busy || sending.current || changing.current || !session.current) return;
    sending.current = true; setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in again to continue.');
      if (activeToken.current !== token) {
        changing.current = true; setStarting(true);
        await launch(token, session.current);
        changing.current = false; setStarting(false);
      }
      if (!client.current || !session.current) throw new Error('Connect the coding runtime first.');
      followOutput.current = true;
      sending.current = true;
      revision.current++;
      setTask(''); setBusy(true);
      setEntries(previous => capped([...previous, { kind: 'you', text }]));
      await client.current.sendMessage(session.current, text);
    } catch (e) { setError(messageOf(e)); setBusy(false); setTask(text); sending.current = false; }
    finally { changing.current = false; setStarting(false); }
  }

  async function interrupt() {
    if (!client.current || !session.current || changing.current) return;
    changing.current = true; setStarting(true); setError('');
    try {
      await client.current.abort(session.current);
      sending.current = false; setBusy(false);
      await refreshSession(client.current, session.current);
      note('Task stopped. You can continue in this conversation.');
    } catch (e) { setError(`Could not confirm that the task stopped: ${messageOf(e)}`); }
    finally { changing.current = false; setStarting(false); }
  }

  async function respond(id: string, action: (c: OpenCodeClient) => Promise<unknown>, success: (entry: Entry) => Entry) {
    if (!client.current || decisionLocks.current.has(id) || !ready) return;
    const c = client.current;
    decisionLocks.current.add(id); setPending(ids => [...ids, id]); setError('');
    try {
      await action(c);
      if (client.current === c) setEntries(previous => previous.map(success));
    } catch (e) { setError(`Your response was not delivered. You can retry. ${messageOf(e)}`); }
    finally { decisionLocks.current.delete(id); setPending(ids => ids.filter(item => item !== id)); }
  }

  const missing = Boolean(status && !status.binary);
  const stateLabel = checking ? 'Checking runtime' : starting ? 'Connecting…' : !isDesktop ? 'Desktop required' : !connected ? 'Offline' : streamState !== 'live' ? 'Reconnecting…' : waiting ? 'Needs your input' : busy ? 'Working' : 'Ready';

  const folderName = workdir ? workdir.split('/').filter(Boolean).at(-1) : null;
  /* Tokens read better abbreviated at a glance; the exact figure is the title. */
  const tokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  const tokenLabel = tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : `${tokens}`;
  /* A floor, not a total, when a model in the window had no verified price —
   * so it is marked rather than quietly understated. */
  // Omitted at exactly zero: "$0.0000" is noise, and free-tier models legitimately
  // cost nothing — the token count already shows the work happened.
  const costLabel = usage && usage.costUsd > 0
    ? `${usage.complete ? '' : '≥'}$${usage.costUsd.toFixed(usage.costUsd < 1 ? 4 : 2)}`
    : null;
  const modelLabel = models.find(item => item.id === model)?.label ?? model ?? 'no model';
  const dot = !isDesktop || missing ? 'bad' : busy ? 'busy' : ready ? 'live' : '';

  return <section className="cli-page agent-page code-term screen-content" aria-label="Coding workspace">
    <SessionHistory
      open={historyOpen}
      onClose={() => setHistoryOpen(false)}
      noun="coding sessions"
      entries={sessions}
      currentId={sessionID}
      onOpen={id => void openSession(id)}
      empty="Sessions you start in this project will be listed here."
      footnote="Kept by the coding runtime on this machine, not by Aira — they survive reinstalling the app." />
    <div className="ct-bar">
      <span className={`ct-dot ${dot}`} aria-hidden="true" />
      <span className="ct-name">aira-code</span>
      <span className="ct-sep">·</span>
      {/* Reads right-to-left so a long path truncates at the front, keeping the
          part that identifies the project rather than the part that repeats. */}
      <span className="ct-path" title={workdir || undefined}>{workdir || stateLabel}</span>
      <div className="ct-bar-actions">
        {usage && usage.requests > 0 && <span className="ct-meter" title={`${tokens.toLocaleString()} tokens over ${usage.requests} request${usage.requests === 1 ? '' : 's'} in the last ${usage.windowHours}h${usage.complete ? '' : ' — a floor, one model had no published price'}`}>
          <span>{tokenLabel} tok</span>{costLabel && <><span className="ct-sep">·</span><span>{costLabel}</span></>}
        </span>}
        <span className="ct-model" title={`Model: ${modelLabel}`}>{modelLabel}</span>
        {connected && streamState !== 'live' && <button className="ct-btn" disabled={starting} onClick={() => void reconnect()} title="Reconnect the event stream"><RefreshCw />reconnect</button>}
        <button className="ct-btn" disabled={!connected} onClick={() => setHistoryOpen(true)} title="Past coding sessions in this project"><History />history</button>
        <button className="ct-btn" disabled={!ready || busy} onClick={() => void newSession()} title="Start a fresh conversation"><Plus />new</button>
        {connected && <button className="ct-btn danger" disabled={starting} onClick={() => void stop()} title="Disconnect the coding agent"><Power />disconnect</button>}
      </div>
    </div>

    <div className="ct-log" ref={log} role="log" aria-label="Coding activity" aria-live="off"
      onScroll={() => { const el = log.current; if (el) followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }}>

      {error && <div className="ct-alert" role="alert"><WifiOff /><span>{error}</span></div>}

      {!connected && <div className="ct-setup">
        <div className="ct-setup-title">aira-code — {stateLabel.toLowerCase()}</div>
        <p className="ct-setup-sub">Point the agent at a project and a model to begin.</p>

        <div className="ct-field">
          <span className="ct-field-label">model
            <button className="ct-btn" disabled={starting || checking} aria-label="Refresh coding runtime and models" onClick={() => void refreshSetup()}><RefreshCw /></button>
          </span>
          <select id="code-model" className="ct-select" value={model} disabled={starting || busy} onChange={e => setModel(e.target.value)}>
            {!models.length && <option value="">no connected models</option>}
            {models.map(item => <option key={item.id} value={item.id}>{item.label} · {item.provider}</option>)}
          </select>
        </div>

        <div className="ct-field">
          <span className="ct-field-label">project</span>
          <button className="ct-folder" disabled={!isDesktop || busy || starting} onClick={() => void chooseFolder()}>
            <FolderOpen /><span>{folderName ?? 'choose a folder'}<small>{workdir || 'no project selected'}</small></span>
          </button>
        </div>

        <button className="ct-connect" disabled={!isDesktop || checking || starting || missing || !workdir} onClick={() => void start()}>
          {starting ? <Loader2 className="spin" /> : <Power />}{starting ? 'connecting…' : 'connect'}
        </button>

        <div className="ct-setup-note"><ShieldCheck /><span>{!isDesktop
          ? 'File access and command execution are available in Aira desktop.'
          : missing ? 'Install the supported OpenCode runtime to connect this project.'
          : 'File changes and commands request your approval. You control what is remembered.'}</span></div>
        {missing && <code>npm install -g opencode-ai</code>}
        {isDesktop && <div className="ct-setup-note"><Terminal /><span>For shared browser tools, start Browser before connecting Code.</span></div>}
        <div className="ct-setup-note"><a href="https://opencode.ai/docs/" target="_blank" rel="noreferrer noopener">Coding runtime guide ↗</a></div>
      </div>}

      {connected && <div className="ct-banner">
        <div className="ct-banner-glyph">✻</div>
        <div className="ct-banner-body">
          <strong>Aira Code</strong>
          <span>{folderName ?? 'project'} <span className="ct-sep">·</span> {modelLabel}</span>
          <span className="ct-banner-dim" title={workdir || undefined}>{workdir}</span>
        </div>
      </div>}

      {connected && !entries.length && <div className="ct-hints">
        <div className="ct-row"><span className="ct-mark">·</span><span className="ct-text">Try one of these, or describe your own:</span></div>
        {examples.map(example => <div className="ct-row" key={example}>
          <span className="ct-mark" />
          <button onClick={() => setTask(example)}>› {example}</button>
        </div>)}
      </div>}

      {entries.map((entry, index) => {
        if (entry.kind === 'you') return <div className="ct-row ct-you" key={index}><span className="ct-mark">›</span><span className="ct-text">{entry.text}</span></div>;
        if (entry.kind === 'agent') {
          // The block cursor trails the text only while it is still arriving,
          // and only on the last entry — a caret sitting under a finished
          // answer reads as "still working" when nothing is.
          const streaming = busy && index === entries.length - 1;
          return <div className={`ct-row ct-agent${streaming ? ' streaming' : ''}`} key={index}>
            <span className="ct-mark">⏺</span>
            <div className="ct-text"><Markdown>{entry.text}</Markdown></div>
          </div>;
        }
        if (entry.kind === 'tool') return <ToolLine key={index} activity={entry.activity} />;
        if (entry.kind === 'notice') return <div className="ct-row ct-note" key={index}><span className="ct-mark">·</span><span className="ct-text">{entry.text}</span></div>;
        if (entry.kind === 'question') return <QuestionCard key={entry.request.id} request={entry.request} answers={entry.answers} skipped={entry.skipped} pending={pending.includes(entry.request.id) || !ready}
          onAnswer={answers => void respond(entry.request.id, c => c.replyQuestion(entry.request.id, answers), item => item.kind === 'question' && item.request.id === entry.request.id ? { ...item, answers } : item)}
          onSkip={() => void respond(entry.request.id, c => c.rejectQuestion(entry.request.id), item => item.kind === 'question' && item.request.id === entry.request.id ? { ...item, skipped: true } : item)} />;
        if (entry.kind !== 'permission') return null;
        return <div className={`ct-ask ${entry.resolved ? 'resolved' : ''}`} key={entry.request.id}>
          <div className="ct-ask-head"><ShieldAlert /><strong>approve {entry.request.action}</strong></div>
          {entry.request.resources.length > 0 && <ul>{entry.request.resources.map((resource, i) => <li key={i}>{resource}</li>)}</ul>}
          {entry.resolved ? <span className="ct-ask-done">{entry.resolved === 'reject' ? 'denied' : entry.resolved === 'always' ? 'allowed and remembered' : 'allowed once'}</span> : <div className="ct-ask-actions">
            {(['once', 'always', 'reject'] as Reply[]).map(reply => <button key={reply} disabled={pending.includes(entry.request.id) || !ready} className={reply === 'reject' ? 'deny' : ''} title={reply === 'always' ? 'Remember this permission for matching future requests' : undefined} onClick={() => void respond(entry.request.id, c => c.replyPermission(entry.request.id, reply), item => item.kind === 'permission' && item.request.id === entry.request.id ? { ...item, resolved: reply } : item)}>{reply === 'once' ? 'allow once' : reply === 'always' ? 'allow & remember' : 'deny'}</button>)}
          </div>}
        </div>;
      })}

      {busy && <div className="ct-working" role="status"><Loader2 className="spin" />{waiting ? 'waiting for your response above' : 'working…'}</div>}
    </div>

    <form className="ct-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      <div className="ct-input-row">
        <span className="ct-mark" aria-hidden="true">›</span>
        <textarea aria-label="Task for coding agent" value={task} rows={2} disabled={busy || starting}
          placeholder={!isDesktop ? 'open Aira desktop to work with local code…' : connected ? 'ask about your project, or describe what to build…' : 'connect a project to begin…'}
          onChange={e => setTask(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      </div>
      <div className="ct-foot">
        <ShieldCheck style={{ width: 12, height: 12 }} /><span>approvals on</span>
        <span className="ct-sep">·</span><span>⌘⏎ to send</span>
        {sessionID && <><span className="ct-sep">·</span><span title={sessionID}>{sessionID.slice(0, 12)}</span></>}
        <div className="ct-foot-actions">
          {busy
            ? <button key="stop" className="ct-send stop" type="button" disabled={starting} onClick={event => { event.preventDefault(); void interrupt(); }}><Square />stop</button>
            : <button key="send" className="ct-send" type="submit" disabled={!ready || !task.trim() || waiting}><Send />send</button>}
        </div>
      </div>
    </form>
  </section>;
}

function QuestionCard({ request, answers, skipped, pending, onAnswer, onSkip }: { request: QuestionRequest; answers?: string[][]; skipped?: boolean; pending: boolean; onAnswer: (answers: string[][]) => void; onSkip: () => void }) {
  const [picked, setPicked] = useState<string[][]>(() => request.questions.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => request.questions.map(() => ''));
  const done = Boolean(answers) || skipped;
  const final = picked.map((selected, index) => {
    const own = typed[index].trim();
    return own ? request.questions[index].multiple ? [...new Set([...selected, own])] : [own] : selected;
  });
  function toggle(index: number, label: string, multiple: boolean) {
    setPicked(previous => previous.map((selected, i) => i !== index ? selected : !multiple ? [label] : selected.includes(label) ? selected.filter(item => item !== label) : [...selected, label]));
    if (!multiple) setTyped(previous => previous.map((value, i) => i === index ? '' : value));
  }
  return <div className={`ct-ask ${done ? 'resolved' : ''}`}>
    <div className="ct-ask-head"><MessageCircleQuestion /><strong>a question before continuing</strong></div>
    {request.questions.map((question, index) => <div className="ct-q-item" key={index}>
      <span className="ct-q-head">{question.header}</span><p>{question.question}</p>
      {done ? <span className="ct-q-answer">{skipped ? 'Skipped' : answers?.[index]?.join(', ') || '—'}</span> : <>
        {question.multiple && <p className="ct-q-answer">Choose one or more answers.</p>}
        <div className="ct-q-options">{question.options.map(option => <button key={option.label} type="button" disabled={pending} className={picked[index].includes(option.label) && (question.multiple || !typed[index]) ? 'on' : ''} aria-pressed={picked[index].includes(option.label) && (Boolean(question.multiple) || !typed[index])} onClick={() => toggle(index, option.label, Boolean(question.multiple))}>{option.label}{option.description && <small>{option.description}</small>}</button>)}</div>
        {question.custom !== false && <input className="ct-q-custom" value={typed[index]} disabled={pending} placeholder="Or type your own answer…" aria-label={`Custom answer: ${question.header || question.question}`} onChange={e => setTyped(previous => previous.map((value, i) => i === index ? e.target.value : value))} />}
      </>}
    </div>)}
    {!done && <div className="ct-ask-actions"><button disabled={pending || !final.every(answer => answer.length > 0)} onClick={() => onAnswer(final)}>{pending ? 'sending…' : 'send answer'}</button><button className="deny" disabled={pending} onClick={onSkip}>skip</button></div>}
  </div>;
}

/* Lowercase, because these read as a command log rather than as prose. */
const TOOL_VERBS: Record<string, string> = { write: 'Write', edit: 'Edit', read: 'Read', patch: 'Patch', bash: 'Bash', grep: 'Grep', glob: 'Glob', list: 'List', webfetch: 'Fetch', websearch: 'Search', task: 'Task', todowrite: 'Plan' };
function ToolLine({ activity }: { activity: ToolActivity }) {
  const done = activity.status === 'completed';
  const failed = activity.status === 'error';
  // One glyph per state, in the marker column every other row already uses, so
  // the log scans as a single column instead of a stack of little icons.
  const mark = done ? '⏺' : failed ? '✗' : '◍';
  return <div className={`ct-row ct-tool ${done ? 'done' : failed ? 'failed' : 'active'}`}>
    <span className="ct-mark">{mark}</span>
    <span className="ct-tool-line">
      <span className="ct-verb">{TOOL_VERBS[activity.tool] ?? activity.tool}</span>
      {activity.target && <span className="ct-target" title={activity.target}>{activity.target}</span>}
      {/* A cross with no reason is the same cross for a denied path and an
        * overloaded model, which need opposite responses from the reader. */}
      {failed && activity.error && <span className="ct-why" title={activity.error}>{activity.error}</span>}
    </span>
  </div>;
}
