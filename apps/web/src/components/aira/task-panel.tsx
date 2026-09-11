import {useCallback,useEffect,useRef,useState} from 'react';
import {Power,Plus,Minus,Eye,Trash2,Sparkles,ChevronDown,ChevronRight,Square,Send,Cloud,CircleHelp,Bot,Activity,Coins,Cpu} from 'lucide-react';
import {isDesktop,supervisor,OpenClawClient,type Agent,type OpenClawStatus} from '@/lib/openclaw';
import {getAccessToken} from '@/lib/supabase';
import {listCatalogue} from '@/lib/gateway';

/**
 * The OpenClaw task panel.
 *
 * A canvas of agent cards around the task you gave them, rather than a
 * transcript: the point of this surface is that several agents work at once,
 * and a scrolling log makes concurrency look like a queue.
 *
 * Every card is a real agent the gateway reported. Nothing here is placeholder
 * furniture — an agent with no run yet simply shows as idle.
 */

type Phase='idle'|'working'|'done'|'error';

interface AgentState {
 agent:Agent;
 phase:Phase;
 /** Streamed reply, shown as the card's own output. */
 text:string;
 /** Characters received, the only honest progress signal a stream gives. */
 received:number;
 startedAt:number|null;
 endedAt:number|null;
 error:string;
}

export default function TaskPanel(){
 const [status,setStatus]=useState<OpenClawStatus|null>(null);
 const [agents,setAgents]=useState<AgentState[]>([]);
 const [task,setTask]=useState('');
 const [sent,setSent]=useState('');
 const [busy,setBusy]=useState(false);
 const [starting,setStarting]=useState(false);
 const [error,setError]=useState('');
 const [zoom,setZoom]=useState(100);
 const [model,setModel]=useState('');
 const [openCard,setOpenCard]=useState<string|null>(null);
 const client=useRef<OpenClawClient|null>(null);
 const runs=useRef<AbortController|null>(null);

 const connected=Boolean(status?.running&&agents.length);
 const working=agents.some(a=>a.phase==='working');

 // A card's elapsed time is computed at render, and React only renders on a
 // state change — so before the first delta arrives the clock reads 0.0s and
 // a thirty-second model looks like a stuck one. This is the heartbeat.
 const [,tick]=useState(0);
 useEffect(()=>{
  if(!working)return;
  const id=setInterval(()=>tick(n=>n+1),200);
  return()=>clearInterval(id);
 },[working]);

 useEffect(()=>{
  if(!isDesktop)return;
  void supervisor.status().then(async next=>{
   setStatus(next);
   if(!next.running||next.port==null||!next.token)return;
   // The agent server outlives this panel, so a panel that mounts over a
   // running one reattaches instead of showing it as stopped.
   const c=new OpenClawClient(next.port,next.token);
   try{
    const found=await c.agents();
    client.current=c;
    setAgents(found.map(blank));
    // The label is cosmetic, so a gateway that is briefly unreachable should
    // not stop the panel reattaching to a perfectly healthy agent.
    void listCatalogue().then(({routing})=>setModel(routing.task??'')).catch(()=>{});
   }catch{/* leave it stopped; power still works */}
  }).catch(()=>{});
  return()=>{runs.current?.abort()};
 },[]);

 async function start(){
  setError('');setStarting(true);
  try{
   const token=await getAccessToken();
   if(!token)throw new Error('Sign in before starting the agent.');
   // Daily-task work routes to the `task` surface, so it gets the model the
   // gateway chose for it and its spend is attributed there.
   const {models,routing}=await listCatalogue();
   const chosen=routing.task??models[0]?.id;
   if(!chosen)throw new Error('No models available from the gateway.');
   const gatewayUrl=(import.meta.env?.VITE_GATEWAY_URL as string|undefined)??'http://localhost:8787';
   const next=await supervisor.start({gatewayUrl,token,model:chosen});
   setStatus(next);setModel(chosen);
   if(!next.running||next.port==null||!next.token)throw new Error('OpenClaw did not start.');
   const c=new OpenClawClient(next.port,next.token);
   // It loads a plugin runtime and a model catalogue before it answers, which
   // takes appreciably longer than OpenCode's boot.
   let ready=false;
   for(let attempt=0;attempt<60;attempt++){
    try{if(await c.health()){ready=true;break}}catch{/* not up yet */}
    await new Promise(r=>setTimeout(r,500));
   }
   if(!ready){
    // Quote the agent rather than only reporting silence: every start
    // failure so far has had a cause sitting in its own stderr.
    const said=await supervisor.log().catch(()=>[] as string[]);
    const tail=said.slice(-3).join(' · ');
    throw new Error(`Started OpenClaw on port ${next.port}, but it never answered.`
     +(tail?` It last said: ${tail}`:' It printed nothing.')
     +' Try again, or check that nothing else is holding that port.');
   }
   const found=await c.agents();
   if(!found.length)throw new Error('OpenClaw started but reported no agents.');
   client.current=c;
   setAgents(found.map(blank));
  }catch(e){
   setError(e instanceof Error?e.message:'Could not start the agent.');
  }finally{setStarting(false)}
 }

 async function stop(){
  runs.current?.abort();runs.current=null;
  client.current=null;
  setAgents([]);setBusy(false);setSent('');
  try{await supervisor.stop()}catch{}
  setStatus(await supervisor.status().catch(()=>null));
 }

 const update=useCallback((id:string,patch:Partial<AgentState>)=>{
  setAgents(list=>list.map(a=>a.agent.id===id?{...a,...patch}:a));
 },[]);

 /** Gives the task to every agent at once — which is the point of the canvas. */
 async function send(){
  const text=task.trim();
  const c=client.current;
  if(!text||!c||busy)return;
  runs.current?.abort();
  const controller=new AbortController();runs.current=controller;
  setTask('');setSent(text);setBusy(true);setError('');
  setAgents(list=>list.map(a=>({...blank(a.agent),phase:'working',startedAt:Date.now()})));

  await Promise.all(agents.map(async({agent})=>{
   try{
    await c.stream(agent.id,text,delta=>{
     setAgents(list=>list.map(a=>a.agent.id===agent.id
      ?{...a,text:a.text+delta,received:a.received+delta.length}:a));
    },controller.signal);
    if(controller.signal.aborted)return;
    update(agent.id,{phase:'done',endedAt:Date.now()});
   }catch(e){
    if(controller.signal.aborted)return;
    // The bridge rejects with the agent's own wording, which says more than
    // anything this panel could invent.
    update(agent.id,{phase:'error',error:e instanceof Error?e.message:String(e),endedAt:Date.now()});
   }
  }));
  if(!controller.signal.aborted)setBusy(false);
 }

 function interrupt(){
  runs.current?.abort();runs.current=null;
  setBusy(false);
  setAgents(list=>list.map(a=>a.phase==='working'?{...a,phase:'idle'}:a));
 }

 function clear(){
  interrupt();
  setSent('');
  setAgents(list=>list.map(a=>blank(a.agent)));
 }

 const active=agents.filter(a=>a.phase==='working').length;
 const missing=Boolean(status&&!status.binary);

 return <section className="cli-page agent-page task-page screen-content" aria-label="Task agents">
  <div className="cli-heading">
   <span className="eyebrow">TASK AGENTS</span>
   <div className="agent-title-row">
    <h1>Agent<span className="desktop-only"> canvas.</span></h1>
    <div className="agent-controls">
     <span className="session-badge" role="status"><span/>
      {connected?(active?`${active} active agent${active===1?'':'s'}`:'Ready'):isDesktop?'Not running':'Desktop app only'}</span>
     <button className={'agent-power '+(connected?'on':'')} onClick={connected?stop:()=>void start()}
      disabled={starting||!isDesktop||!status?.binary}
      aria-label={connected?'Stop the agents':'Start the agents'}
      title={!isDesktop?'The task agent runs in the Aira desktop app':status?.binary?(connected?'Stop the agents':'Start the agents'):'OpenClaw is not installed'}>
      <Power/>
     </button>
    </div>
   </div>
   <p>Give them a task. Watch each one work.</p>
  </div>

  <div className="canvas" style={{['--canvas-zoom' as string]:String(zoom/100)}}>
   <div className="canvas-stage">
    {!connected&&<div className="canvas-empty">
     <Bot/>
     <p>{!isDesktop
      ?'The task agent runs on your machine, so it lives in the Aira desktop app rather than a browser tab.'
      :missing?'OpenClaw is not installed. Install it with: npm install -g openclaw'
      :starting?'Starting the agents…'
      :'Press power to start the agents.'}</p>
    </div>}

    {connected&&<div className="canvas-grid">
     {agents.map(a=><AgentCard key={a.agent.id} state={a} open={openCard===a.agent.id}
      onToggle={()=>setOpenCard(openCard===a.agent.id?null:a.agent.id)}/>)}
    </div>}

    {connected&&<div className="task-card">
     <div className="task-card-head">
      <span className="task-chip"><span/>{active?`${active} active agent${active===1?'':'s'}`:'Idle'}</span>
     </div>
     <div className="task-card-body">
      {sent
       ?<p>{sent}</p>
       :<textarea aria-label="Task for the agents" value={task} rows={3}
         placeholder="Describe a task for every agent…"
         onChange={e=>setTask(e.target.value)}
         onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send()}}}/>}
     </div>
     <div className="task-card-status">
      <span>{busy?'Agents are working…':sent?'Finished.':'Ready when you are.'}</span>
      {sent&&<button onClick={clear}>New task<ChevronRight/></button>}
     </div>
     <div className="task-card-actions">
      <button className="task-icon" onClick={clear} aria-label="New task"><Plus/></button>
      <span className="task-icon quiet" aria-hidden="true"><Sparkles/></span>
      <span className="task-model" title="Chosen by the gateway for the task surface">
       {model||'Model'}<ChevronDown/></span>
      {busy
       ?<button className="task-run stop" onClick={interrupt} aria-label="Stop the agents"><Square/></button>
       :<button className="task-run" onClick={()=>void send()} disabled={!task.trim()} aria-label="Send the task"><Send/></button>}
     </div>
    </div>}
   </div>

   {connected&&<>
    <div className="canvas-tools">
     <button onClick={()=>setZoom(z=>Math.min(140,z+10))} aria-label="Zoom in"><Plus/></button>
     <button onClick={()=>setZoom(z=>Math.max(60,z-10))} aria-label="Zoom out"><Minus/></button>
     <button onClick={()=>setOpenCard(null)} aria-label="Collapse all cards"><Eye/></button>
     <button onClick={clear} aria-label="Clear the canvas"><Trash2/></button>
    </div>
    <div className="canvas-meta">
     <span className="canvas-pill"><Cloud/>{status?.port?`127.0.0.1:${status.port}`:'local'}</span>
     <span className="canvas-pill zoom">
      <button onClick={()=>setZoom(z=>Math.max(60,z-10))} aria-label="Zoom out">−</button>
      {zoom}%
      <button onClick={()=>setZoom(z=>Math.min(140,z+10))} aria-label="Zoom in">+</button>
     </span>
     <span className="canvas-pill" title="Every agent bills through Aira's gateway"><CircleHelp/></span>
    </div>
   </>}

   {error&&<div className="canvas-error"><Activity/><span>{error}</span></div>}
  </div>
 </section>;
}

function blank(agent:Agent):AgentState{
 return {agent,phase:'idle',text:'',received:0,startedAt:null,endedAt:null,error:''};
}

const PHASE_LABEL:Record<Phase,string>={idle:'Idle',working:'Working',done:'Complete',error:'Failed'};

/**
 * One agent, as a card.
 *
 * The metrics are the ones a stream can honestly report — characters received
 * and elapsed time. A percentage would be invented: the agent does not say how
 * much of the answer is left.
 */
function AgentCard({state,open,onToggle}:{state:AgentState;open:boolean;onToggle:()=>void}){
 const {agent,phase,text,received,startedAt,endedAt,error}=state;
 const elapsed=startedAt?((endedAt??Date.now())-startedAt)/1000:0;
 const preview=text.trim().split('\n').filter(Boolean);
 return <article className={'agent-node '+phase+(open?' open':'')}>
  <div className="agent-node-head">
   <span className="agent-node-icon"><Bot/></span>
   <span className={'agent-node-status '+phase}><span/>{PHASE_LABEL[phase]}</span>
  </div>
  <h2>{agent.name}</h2>
  <p className="agent-node-sub">Task agent</p>

  {phase==='error'
   ?<p className="agent-node-error">{error}</p>
   :<ul className="agent-node-tags">
     {preview.slice(open?-6:-2).map((line,i)=><li key={i}>{line.slice(0,70)}</li>)}
     {!preview.length&&<li className="quiet">{phase==='working'?'Thinking…':'No output yet'}</li>}
    </ul>}

  <dl className="agent-node-metrics">
   <div><dt><Activity/>Received</dt><dd>{received?`${received.toLocaleString()} chars`:'—'}</dd></div>
   <div><dt><Coins/>Elapsed</dt><dd>{startedAt?`${elapsed.toFixed(1)}s`:'—'}</dd></div>
   <div><dt><Cpu/>Agent</dt><dd className="mono">{agent.name}</dd></div>
  </dl>

  {text&&<button className="agent-node-more" onClick={onToggle}>
   {open?'Show less':'See output'}<ChevronRight/></button>}
 </article>;
}
