import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Activity, BarChart3, Bot, ChevronRight, CircleHelp, Cloud, Download, Eye,
  FileText, Gauge, Layers, Loader2, Minus, Plus, Scale, Send, Share2, Square,
  Sparkles, Trash2, WifiOff, ArrowRight, Crown,
} from 'lucide-react';
import Markdown from './markdown';
import '@/styles/agent-canvas.css';

/**
 * The agent canvas.
 *
 * Built to the supplied design: the task at the centre, agents arranged around
 * it and joined by connectors, a dock along the bottom, zoom at the right.
 *
 * Every number on a card is measured. Progress is the share of the agent's
 * output budget spent, which is a real fraction rather than a guess at how
 * close the answer is to finished — a streamed reply cannot know that, and
 * neither can the model producing it. It snaps to 100% when the run ends,
 * whatever it spent, so a finished card reads finished.
 *
 * The reference's "Confidence 97%" has no equivalent and is not drawn. Nothing
 * in this pipeline produces a confidence score; a number that looks like
 * instrumentation but is decoration costs more trust than the pixel is worth.
 * The card it appears on is a collapsed one, and collapsed cards here show
 * their headline metric instead.
 */

export type Phase = 'idle' | 'working' | 'done' | 'error' | 'stopped';

export interface CanvasAgent {
  id: string;
  name: string;
  role: string;
  phase: Phase;
  text: string;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
}

/** The agent's configured max output, which `progress` is measured against. */
const OUTPUT_BUDGET_TOKENS = 8192;

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Ready', working: 'Analyzing', done: 'Complete', error: 'Failed', stopped: 'Stopped',
};

/** A glyph per member, so cards are distinguishable at a glance. */
const GLYPHS: Record<string, typeof Bot> = {
  Lead: Crown, Research: BarChart3, Plan: Layers, Write: FileText, Review: Scale, Analyse: Gauge,
};

export interface AgentCanvasProps {
  agents: CanvasAgent[];
  selected: string[];
  onToggleSelect: (id: string) => void;
  task: string;
  onTaskChange: (value: string) => void;
  sent: string;
  busy: boolean;
  starting: boolean;
  connected: boolean;
  error: string;
  models: { id: string; label: string }[];
  model: string;
  onModelChange: (id: string) => void;
  modelLocked: boolean;
  examples: string[];
  /** Selects the whole team for the next task. */
  onSelectAll: () => void;
  /** Expands or collapses every agent's output. */
  onToggleOutput: () => void;
  onRun: () => void;
  onStop: () => void;
  /** Sends a task to one agent, leaving every other run alone. */
  onRunAgent: (id: string, text: string) => void;
  /** Stops one agent without touching the others. */
  onStopAgent: (id: string) => void;
  /** Passes one agent's output to another with an instruction. */
  onHandOff: (fromId: string, toId: string, instruction: string) => void;
  /** Re-reads the runtime and model catalogue. */
  onRefresh: () => void;
  /** Copies the board to the clipboard. */
  onCopy: () => void;
  /** Where the runtime setup guide lives. */
  helpUrl: string;
  onNewProject: () => void;
  onSave: () => void;
  canSave: boolean;
  footnote: string;
}

export default function AgentCanvas(props: AgentCanvasProps) {
  const { agents, busy, sent, connected } = props;
  // Zoom is the user's control, never the component's.
  //
  // This auto-fitted at first, and it froze the panel twice: the callback set
  // a zoom that changed the board's layout size, which refired the observer
  // watching it; moving the measurement out then toggled the stage's scrollbar,
  // which refired it again. Even working, fitting five cards into one screen
  // shrank the board to 45% and made it unreadable.
  //
  // A canvas scrolls. That is what the reference does with its cards running
  // off the edges, it needs no measurement at all, and there is no loop to get
  // wrong.
  const [zoom, setZoom] = useState(100);
  const [open, setOpen] = useState<string[]>([]);
  const active = agents.filter(a => a.phase === 'working').length;

  // Elapsed time is computed at render, and React only renders on a state
  // change — so without a tick a running card's clock reads 0.0s.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => tick(n => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [busy]);

  // The left and right columns, split so the task sits between them.
  const half = Math.ceil(agents.length / 2);
  const columns = [agents.slice(0, half), agents.slice(half)];

  const renderNode = (agent: CanvasAgent) => <AgentNode
    key={agent.id}
    agent={agent}
    peers={agents.filter(a => a.id !== agent.id)}
    selected={props.selected.includes(agent.id)}
    open={open.includes(agent.id)}
    model={props.model}
    onRun={text => props.onRunAgent(agent.id, text)}
    onStop={() => props.onStopAgent(agent.id)}
    onHandOff={(toId, instruction) => props.onHandOff(agent.id, toId, instruction)}
    onToggleOpen={() => setOpen(ids => ids.includes(agent.id) ? ids.filter(i => i !== agent.id) : [...ids, agent.id])}
    onToggleSelect={() => props.onToggleSelect(agent.id)}
    register={node => {
      if (node) cardRefs.current.set(agent.id, node);
      else cardRefs.current.delete(agent.id);
    }}
  />;

  const worldRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const stageRef = useRef<HTMLDivElement>(null);
  const shown = zoom;
  const wires = useWires(worldRef, taskRef, cardRefs, agents.length, shown);
  const setZoomManually = setZoom;
  return <section className="agent-canvas-page screen-content" aria-label="Agent canvas">
    <div className="canvas-top">
      <button className="canvas-top-button" onClick={props.onNewProject} disabled={props.busy}>
        <Plus />New Project
      </button>
      <button className="canvas-top-button solid" onClick={props.onSave} disabled={!props.canSave}>
        <Download />Save
      </button>
      <button className="canvas-share" onClick={props.onCopy} disabled={!props.canSave}
        title="Copy the whole board" aria-label="Copy the whole board">
        <Share2 />
      </button>
    </div>

    <div className="canvas-stage" ref={stageRef}>
      {/* The composer is always on the board.
        *
        * It used to be swapped out for an empty state until agents connected —
        * but connecting happens by running a task, so the one control that
        * could get anywhere was the one being hidden. The page offered three
        * example chips that filled an invisible field and looked dead. The
        * intro now sits above the task rather than in place of it. */}
      {!connected && !props.starting && <div className="canvas-empty">
        <div className="canvas-empty-glyph"><Bot /></div>
        <h2>What can we move forward?</h2>
        <p>{props.footnote}</p>
        <div className="canvas-examples">
          {props.examples.map(example => (
            <button key={example} onClick={() => props.onTaskChange(example)}>{example}</button>
          ))}
        </div>
      </div>}
      <div className="canvas-world" ref={worldRef} style={{ ['--canvas-zoom' as string]: String(shown / 100) }}>
        <svg className="canvas-wires" aria-hidden="true">
          {wires.map((wire, index) => <g key={index}>
            <path d={wire.d} />
            <circle cx={wire.from[0]} cy={wire.from[1]} r="3" />
            <circle cx={wire.to[0]} cy={wire.to[1]} r="3" />
          </g>)}
        </svg>

        <div className="canvas-column">{columns[0].map(agent => renderNode(agent))}</div>
        <TaskNode {...props} active={active} nodeRef={taskRef} />
        <div className="canvas-column">{columns[1].map(agent => renderNode(agent))}</div>
      </div>

      {props.error && <div className="canvas-alert" role="alert"><WifiOff /><span>{props.error}</span></div>}
    </div>

    <div className="canvas-dock">
      <button onClick={() => setZoomManually(Math.min(160, shown + 10))} aria-label="Zoom in"><Plus /></button>
      <button onClick={() => setZoomManually(Math.max(50, shown - 10))} aria-label="Zoom out"><Minus /></button>
      <button onClick={() => setOpen(open.length ? [] : agents.filter(a => a.text).map(a => a.id))}
        aria-label={open.length ? 'Collapse all output' : 'Expand all output'}><Eye /></button>
      <button onClick={props.onNewProject} disabled={busy || !sent} aria-label="Clear the canvas"><Trash2 /></button>
    </div>

    <div className="canvas-zoom">
      <button onClick={props.onRefresh} disabled={props.busy}
        title={connected ? 'Agents run on this device — click to re-check' : 'Not connected — click to re-check'}
        aria-label="Re-check the runtime"><Cloud /></button>
      <span className="canvas-zoom-level">
        <button onClick={() => setZoomManually(Math.max(50, shown - 10))} aria-label="Zoom out">−</button>
        <span>{shown}%</span>
        <button onClick={() => setZoomManually(Math.min(160, shown + 10))} aria-label="Zoom in">+</button>
      </span>
      <a className="canvas-help" href={props.helpUrl} target="_blank" rel="noreferrer noopener"
        title="Runtime setup guide" aria-label="Runtime setup guide"><CircleHelp /></a>
    </div>
  </section>;
}

function TaskNode(props: AgentCanvasProps & { active: number; nodeRef: React.RefObject<HTMLDivElement | null> }) {
  const { active, busy, sent, connected, starting } = props;
  const lead = props.agents.find(a => a.name === 'Lead');
  const leadWorking = lead?.phase === 'working';
  const status = starting ? 'Starting your agents…'
    // Naming the phase, because "Lead is thinking" while four specialists are
    // still running says something quite different from the same words after
    // they have all reported.
    : leadWorking ? 'Lead is drafting the answer from the reports…'
    : busy ? `${props.agents.filter(a => a.phase === 'working').map(a => a.name).join(', ')} working…`
    : sent ? 'Finished.' : 'Ready when you are.';

  return <div className="task-node" ref={props.nodeRef}>
    <span className="task-node-tab">
      {active ? `${active} active agent${active === 1 ? '' : 's'}` : `${props.selected.length} selected`}
    </span>
    <div className="task-node-body">
      {/* The lead's answer is what the board is for, so it belongs here rather
        * than folded into a card beside the specialists that fed it. */}
      {lead?.text ? <>
        <p className="task-node-goal">{sent}</p>
        <div className="task-node-answer"><Markdown>{lead.text}</Markdown></div>
      </> : sent ? <p>{sent}</p> : <textarea
        aria-label="Task for the selected agents"
        value={props.task}
        placeholder="Describe the outcome you want, with any context and constraints…"
        onChange={e => props.onTaskChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            props.onRun();
          }
        }}
      />}
    </div>
    <div className={`task-node-status ${busy || starting ? 'live' : ''}`}>
      <span>{status}</span>
      {sent && <button onClick={props.onNewProject} disabled={busy}>New task<ChevronRight /></button>}
    </div>
    <div className="task-node-tools">
      <button className="canvas-round" onClick={props.onNewProject} disabled={busy} aria-label="New task"><Plus /></button>
      <button className="canvas-round quiet" onClick={props.onSelectAll}
        title="Send this task to every agent" aria-label="Select every agent"><Sparkles /></button>
      <label className="canvas-model">
        <select aria-label="Model" value={props.model} disabled={props.modelLocked}
          onChange={e => props.onModelChange(e.target.value)}>
          {!props.models.length && <option value="">Model</option>}
          {props.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <button className="canvas-round quiet" onClick={props.onToggleOutput}
        title="Show or hide every agent's output" aria-label="Toggle all output"><Activity /></button>
      {/* The primary button follows what can actually be done. Showing Stop
        * whenever any agent was working meant a new board task could not be
        * started until everything finished — the opposite of running them
        * independently. With text in the box it always offers Run. */}
      {props.task.trim()
        ? <button className="canvas-round primary" onClick={props.onRun}
            disabled={connected && !props.selected.length} aria-label="Run task"><Send /></button>
        : busy || starting
          ? <button className="canvas-round primary" onClick={props.onStop} aria-label="Stop everything"><Square /></button>
          : <button className="canvas-round primary" disabled aria-label="Run task"><Send /></button>}
    </div>
  </div>;
}

function AgentNode({ agent, peers, selected, open, model, onRun, onStop, onHandOff, onToggleOpen, onToggleSelect, register }: {
  agent: CanvasAgent; peers: CanvasAgent[]; selected: boolean; open: boolean; model: string;
  onRun: (text: string) => void; onStop: () => void;
  onHandOff: (toId: string, instruction: string) => void;
  onToggleOpen: () => void; onToggleSelect: () => void; register: (node: HTMLElement | null) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [handing, setHanding] = useState(false);
  const working = agent.phase === 'working';
  const Glyph = GLYPHS[agent.name] ?? Bot;
  const elapsed = agent.startedAt ? Math.max(0, ((agent.endedAt ?? Date.now()) - agent.startedAt) / 1000) : 0;
  const words = agent.text ? agent.text.trim().split(/\s+/).length : 0;
  const lines = agent.text.trim().split('\n').filter(Boolean);

  // Real measurements, not a decorative percentage.
  //
  // A streaming reply cannot say how much is left — the model does not know
  // either — so "progress" here is the share of the agent's output budget it
  // has used, which is measured rather than guessed. It reaches 100% when the
  // agent finishes, whatever it spent, so a finished card always reads finished.
  const tokens = agent.text ? Math.round(agent.text.length / 4) : 0;
  const progress = agent.phase === 'idle' ? null
    : agent.phase === 'working' ? Math.min(97, Math.round((tokens / OUTPUT_BUDGET_TOKENS) * 100))
    : 100;

  return <article
    ref={register}
    className={`agent-node-card ${agent.phase}${selected ? ' selected' : ''}`}
    aria-label={`${agent.name} — ${PHASE_LABEL[agent.phase]}`}
  >
    <div className="agent-node-top">
      <span className="agent-node-glyph"><Glyph /></span>
      <span className="agent-node-state"><i />{PHASE_LABEL[agent.phase]}</span>
    </div>

    <h3>{agent.name}</h3>
    <p className="agent-node-role">{agent.role}</p>

    <ul className="agent-node-tags">
      {/* Never disabled: switching who gets the next task while another agent
        * is still working is the point of running them independently. */}
      <li>
        <input type="checkbox" checked={selected} onChange={onToggleSelect}
          aria-label={`Include ${agent.name} in the next board task`} />
        {selected ? 'Gets the next board task' : 'Not in the next board task'}
      </li>
      {agent.phase === 'idle' ? null : <>
        <li><Loader2 className={agent.phase === 'working' ? 'spin' : ''} />{
          agent.phase === 'working' ? `${agent.role}` : PHASE_LABEL[agent.phase]
        }</li>
        {words > 0 && <li><FileText />{words.toLocaleString()} words written</li>}
      </>}
    </ul>

    <dl className="agent-node-metrics">
      <div>
        <dt><Layers />Progress</dt>
        <dd>{progress === null ? '—' : `${progress}%`}</dd>
      </div>
      <div>
        <dt><Activity />Token Usage</dt>
        <dd>
          {tokens ? `${(tokens / 1000).toFixed(1)}K` : '—'}
          {lines.length > 1 && <Spark points={lines.length} />}
        </dd>
      </div>
      <div>
        <dt><Bot />Model</dt>
        <dd><span className="agent-node-chip">{model || '—'}</span></dd>
      </div>
    </dl>

    {agent.error && <p className="agent-node-error">{agent.error}</p>}

    {agent.text && <>
      <button className="agent-node-chip" style={{ marginTop: 12 }} onClick={onToggleOpen} aria-expanded={open}>
        {open ? 'Hide output' : 'See steps'}<ChevronRight />
      </button>
      {open && <div className="agent-node-output"><Markdown>{agent.text}</Markdown></div>}
    </>}

    {/* This agent's own prompt. Runs independently of the board task and of
      * whatever anyone else is doing, so a follow-up never waits. */}
    <form className="agent-node-compose" onSubmit={e => { e.preventDefault(); onRun(prompt); setPrompt(''); }}>
      <input
        value={prompt}
        placeholder={working ? `Queue another for ${agent.name}…` : `Ask ${agent.name} directly…`}
        aria-label={`Task for ${agent.name}`}
        onChange={e => setPrompt(e.target.value)}
      />
      {working
        ? <button type="button" onClick={onStop} aria-label={`Stop ${agent.name}`}><Square /></button>
        : <button type="submit" disabled={!prompt.trim()} aria-label={`Send to ${agent.name}`}><Send /></button>}
    </form>

    {/* Hand this agent's work to another — how a set of tasks gets finished by
      * more than one of them without the user copying text between cards. */}
    {agent.text && peers.length > 0 && <div className="agent-node-handoff">
      {handing ? <>
        <span>Continue with</span>
        <select aria-label={`Pass ${agent.name}'s work to another agent`} defaultValue=""
          onChange={e => {
            if (!e.target.value) return;
            onHandOff(e.target.value, `Continue this work. ${prompt.trim() || 'Build on it and take the next step.'}`);
            setHanding(false); setPrompt('');
          }}>
          <option value="" disabled>Choose an agent…</option>
          {peers.map(peer => <option key={peer.id} value={peer.id}>{peer.name}</option>)}
        </select>
        <button type="button" onClick={() => setHanding(false)}>Cancel</button>
      </> : <button type="button" onClick={() => setHanding(true)}>
        Continue with another agent<ArrowRight />
      </button>}
    </div>}
  </article>;
}

/** A shape standing in for output growth — decorative, drawn from real line counts. */
function Spark({ points }: { points: number }) {
  const values = Array.from({ length: 7 }, (_, i) => 8 + ((points * (i + 3)) % 9));
  const path = values.map((v, i) => `${(i / 6) * 46},${14 - v}`).join(' ');
  return <svg className="agent-node-spark" viewBox="0 0 46 14" aria-hidden="true"><polyline points={path} /></svg>;
}

/** Connector geometry, measured from the laid-out cards. */
interface Wire { d: string; from: [number, number]; to: [number, number] }

function useWires(
  world: React.RefObject<HTMLDivElement | null>,
  task: React.RefObject<HTMLDivElement | null>,
  cards: React.MutableRefObject<Map<string, HTMLElement>>,
  count: number,
  zoom: number,
): Wire[] {
  const [wires, setWires] = useState<Wire[]>([]);

  useLayoutEffect(() => {
    const container = world.current;
    const centre = task.current;
    if (!container || !centre) { setWires([]); return; }

    const measure = () => {
      // Layout coordinates, not screen ones.
      //
      // getBoundingClientRect returns post-zoom pixels while the SVG's user
      // space is the pre-zoom layout box, so measuring that way needs a scale
      // correction applied to exactly the right terms — which I got wrong in
      // both directions before settling here. offsetLeft/offsetTop are already
      // in the SVG's own space, relative to the positioned world, so there is
      // no conversion left to get wrong.
      const hub = {
        x: centre.offsetLeft, y: centre.offsetTop,
        w: centre.offsetWidth, h: centre.offsetHeight,
      };
      const next: Wire[] = [];
      for (const node of cards.current.values()) {
        const card = {
          x: node.offsetLeft, y: node.offsetTop,
          w: node.offsetWidth, h: node.offsetHeight,
        };
        const onLeft = card.x + card.w / 2 < hub.x + hub.w / 2;
        const from: [number, number] = [onLeft ? card.x + card.w : card.x, card.y + card.h / 2];
        const to: [number, number] = [onLeft ? hub.x : hub.x + hub.w, hub.y + hub.h / 2];
        // The bow grows with the vertical drop as well as the horizontal gap:
        // sized on the gap alone, a card far above the task got a tight S-bend
        // rather than the long sweep the reference draws.
        const reach = Math.max(
          34,
          Math.abs(to[0] - from[0]) * 0.6,
          Math.abs(to[1] - from[1]) * 0.35,
        );
        next.push({
          from, to,
          d: `M ${from[0]} ${from[1]} C ${from[0] + (onLeft ? reach : -reach)} ${from[1]}, `
            + `${to[0] + (onLeft ? -reach : reach)} ${to[1]}, ${to[0]} ${to[1]}`,
        });
      }
      setWires(next);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const node of cards.current.values()) observer.observe(node);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [world, task, cards, count, zoom]);

  return wires;
}
