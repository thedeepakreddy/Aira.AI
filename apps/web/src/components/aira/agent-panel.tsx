import {useCallback,useEffect,useRef,useState} from 'react';
import {Terminal,Power,Send,Folder,ChevronRight,ShieldAlert,FileEdit,Square,Check,Loader2,FileText,Search,SquareTerminal} from 'lucide-react';
import {isDesktop,supervisor,OpenCodeClient,type AgentEvent,type OpenCodeStatus,type PermissionRequest,type ToolActivity} from '@/lib/opencode';
import {getAccessToken} from '@/lib/supabase';
import {listCatalogue} from '@/lib/gateway';

/**
 * The OpenCode agent panel.
 *
 * Replaces the reference project's simulated terminal. The layout and classes
 * are the ones that screen already used, so the design is unchanged — what
 * changed is that the output is a real agent working on real files.
 *
 * Two deliberate safety choices:
 *
 *  - Every tool call the agent wants to make surfaces here as an explicit
 *    Allow / Deny. OpenCode defaults to allowing everything, so Aira configures
 *    it to ask and treats this panel as the gate.
 *  - Nothing here ever calls POST /session/{id}/shell. That endpoint executes
 *    arbitrary commands and sits outside the permission system, so it is not
 *    something a model should be able to reach through Aira.
 */

type Entry =
  | {kind:'tool';activity:ToolActivity}
  | {kind:'you';text:string}
  | {kind:'agent';text:string}
  | {kind:'notice';text:string}
  | {kind:'permission';request:PermissionRequest;resolved?:'once'|'always'|'reject'};

export default function AgentPanel(){
 const [status,setStatus]=useState<OpenCodeStatus|null>(null);
 const [entries,setEntries]=useState<Entry[]>([]);
 const [task,setTask]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [workdir,setWorkdir]=useState('');
 const [starting,setStarting]=useState(false);
 const client=useRef<OpenCodeClient|null>(null);
 const session=useRef<string|null>(null);
 const stream=useRef<AbortController|null>(null);
 const log=useRef<HTMLDivElement>(null);

 const connected=Boolean(status?.running&&session.current);

 useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'instant'})},[entries]);

 useEffect(()=>{
  if(!isDesktop)return;
  void supervisor.status().then(setStatus).catch(()=>{});
  return()=>{stream.current?.abort()};
 },[]);

 const note=useCallback((text:string)=>setEntries(e=>[...e,{kind:'notice',text}]),[]);

 /** Appends a streamed delta to the open agent block, or starts a new one. */
 const appendAgent=useCallback((delta:string)=>{
  setEntries(e=>{
   const last=e[e.length-1];
   if(last?.kind==='agent')return[...e.slice(0,-1),{...last,text:last.text+delta}];
   return[...e,{kind:'agent',text:delta}];
  });
 },[]);

 const consume=useCallback(async(c:OpenCodeClient,signal:AbortSignal)=>{
  try{
   for await(const event of c.events(signal)){
    if(signal.aborted)return;
    switch(event.kind){
     case 'text':appendAgent(event.delta);break;
     case 'tool':{
      // Replace the existing line for this call so a tool reports progress in
      // place instead of stacking pending/running/completed on top of itself.
      const a=event.activity;
      const line:Entry={kind:'tool',activity:a};
      setEntries(e=>{
       const at=e.findIndex(x=>x.kind==='tool'&&x.activity.partID===a.partID);
       if(at===-1)return[...e,line];
       const next=e.slice();next[at]=line;return next;
      });
      break;}
     case 'permission':setEntries(e=>[...e,{kind:'permission',request:event.request}]);break;
     case 'permission-resolved':{
      // Reflect what was actually chosen, including decisions made elsewhere.
      const chosen=event.reply==='reject'?'reject':event.reply==='always'?'always':'once';
      setEntries(e=>e.map(x=>x.kind==='permission'&&x.request.id===event.id&&!x.resolved?{...x,resolved:chosen}:x));
      break;}
     case 'file-edited':if(event.path)note(`edited ${event.path}`);break;
     case 'idle':setBusy(false);break;
     default:break;
    }
   }
  }catch{
   if(!signal.aborted)setError('Lost the connection to the agent.');
  }
 },[appendAgent,note]);

 async function start(){
  setError('');setStarting(true);
  try{
   // The agent bills through Aira's gateway, so it needs the session token and
   // a model the gateway actually serves. Agent work routes to the `code`
   // surface, which is the frontier tier.
   const token=await getAccessToken();
   if(!token)throw new Error('Sign in before starting the agent.');
   // Ask the gateway what the `code` surface routes to rather than picking a
   // model here: choosing locally would quietly bypass the routing rules and
   // could land on a provider the gateway would not have used.
   const {models,routing}=await listCatalogue();
   const model=routing.code??models[0]?.id;
   if(!model)throw new Error('No models available from the gateway.');
   const gatewayUrl=(import.meta.env?.VITE_GATEWAY_URL as string|undefined)??'http://localhost:8787';
   const next=await supervisor.start({gatewayUrl,token,model});
   setStatus(next);
   if(!next.running||next.port==null||!next.password)throw new Error('OpenCode did not start.');
   const c=new OpenCodeClient(next.port,next.password);
   // Poll health briefly: the process is spawned but the port takes a moment.
   for(let attempt=0;attempt<25;attempt++){
    try{await c.health();break}catch{await new Promise(r=>setTimeout(r,300))}
   }
   const s=await c.createSession();
   client.current=c;session.current=s.id;
   stream.current?.abort();
   const controller=new AbortController();stream.current=controller;
   void consume(c,controller.signal);
   setWorkdir(s.directory);
   setEntries([{kind:'notice',text:`Agent ready in ${s.directory}`}]);
  }catch(e){
   setError(e instanceof Error?e.message:'Could not start the agent.');
  }finally{setStarting(false)}
 }

 async function stop(){
  stream.current?.abort();stream.current=null;
  client.current=null;session.current=null;
  setWorkdir('');setBusy(false);
  try{await supervisor.stop()}catch{}
  setStatus(await supervisor.status().catch(()=>null));
  note('Agent stopped.');
 }

 async function send(){
  const text=task.trim();
  if(!text||!client.current||!session.current||busy)return;
  setTask('');setBusy(true);
  setEntries(e=>[...e,{kind:'you',text}]);
  try{await client.current.sendMessage(session.current,text)}
  catch(e){setError(e instanceof Error?e.message:'The agent rejected that task.');setBusy(false)}
 }

 async function interrupt(){
  if(!client.current||!session.current)return;
  try{await client.current.abort(session.current)}catch{}
  setBusy(false);note('Interrupted.');
 }

 async function decide(request:PermissionRequest,reply:'once'|'always'|'reject'){
  setEntries(e=>e.map(x=>x.kind==='permission'&&x.request.id===request.id?{...x,resolved:reply}:x));
  try{await client.current?.replyPermission(request.id,reply)}
  catch{setError('Could not send that decision to the agent.')}
 }

 // Surfaced in the log because the power button is otherwise a dead control
 // with no explanation for why it will not do anything.
 const missing=Boolean(status&&!status.binary);

 if(!isDesktop)return <section className="cli-page screen-content" aria-label="Agent">
  <div className="cli-heading"><div><span className="eyebrow">CODING AGENT</span><h1>Agent<span className="desktop-only"> workspace.</span></h1><p>Available in the desktop app.</p></div></div>
  <div className="cli-grid agent-grid">
  <div className="terminal-window"><div className="terminal-title"><Terminal/><span>aira — agent</span></div><div className="terminal-log"><div className="terminal-welcome"><span>Agent</span><p>The agent reads and edits files on your machine, so it runs in the Aira desktop app rather than a browser tab.</p></div></div></div></div>
 </section>;

 return <section className="cli-page screen-content" aria-label="Coding agent">
  <div className="cli-heading"><div><span className="eyebrow">CODING AGENT</span><h1>Agent<span className="desktop-only"> workspace.</span></h1><p>Give it a task. Approve what it does.</p></div>
   <div className="agent-controls">
    <span className="session-badge" role="status"><span/>{connected?'Agent running':'Not running'}</span>
    <button className={'agent-power '+(connected?'on':'')} onClick={connected?stop:start}
     disabled={starting||!status?.binary}
     aria-label={connected?'Stop the agent':'Start the agent'}
     title={status?.binary?(connected?'Stop the agent':'Start the agent'):'OpenCode is not installed'}>
     <Power/>
    </button>
   </div></div>

  <div className="cli-grid agent-grid">
   <div className="terminal-window">
    <div className="terminal-title"><Terminal/><span>aira — agent</span>{busy&&<span className="terminal-mode">WORKING</span>}
     {status?.running&&status.port&&<span className="terminal-endpoint">127.0.0.1:{status.port}</span>}</div>
    <div className="terminal-path"><Folder/><span>{workdir||(status?.running?'Local workspace':'No session')}</span></div>

    <div className="terminal-log" ref={log} role="log" aria-live="polite">
     <div className="terminal-welcome"><span>Aira Agent</span>
      <p>{connected?'Describe a task. You approve every file edit and command.':missing?'OpenCode is not installed. Install it with: brew install opencode':'Press power to start the agent.'}</p>
     </div>
     {entries.map((entry,i)=>{
      if(entry.kind==='you')return <div className="terminal-entry" key={i}><div className="terminal-command"><span>❯</span> {entry.text}</div></div>;
      if(entry.kind==='agent')return <div className="terminal-entry" key={i}><pre>{entry.text}</pre></div>;
      if(entry.kind==='tool')return <ToolLine key={i} activity={entry.activity}/>;
      if(entry.kind==='notice')return <div className="agent-notice" key={i}><FileEdit/><span>{entry.text}</span></div>;
      return <div className={'agent-permission '+(entry.resolved?'resolved':'')} key={i}>
       <div className="agent-permission-head"><ShieldAlert/><strong>{entry.request.action}</strong></div>
       {entry.request.resources?.length>0&&<ul>{entry.request.resources.map((r,n)=><li key={n}>{r}</li>)}</ul>}
       {entry.resolved
        ? <span className="agent-permission-done">{entry.resolved==='reject'?'Denied':entry.resolved==='always'?'Always allowed':'Allowed'}</span>
        : <div className="agent-permission-actions">
           <button onClick={()=>decide(entry.request,'once')}>Allow once</button>
           <button onClick={()=>decide(entry.request,'always')}>Always</button>
           <button className="deny" onClick={()=>decide(entry.request,'reject')}>Deny</button>
          </div>}
      </div>;
     })}
     {error&&<div className="agent-notice error"><ShieldAlert/><span>{error}</span></div>}
    </div>

    <form className="terminal-input-row" onSubmit={e=>{e.preventDefault();void send()}}>
     <ChevronRight/>
     <input aria-label="Task for the agent" value={task} disabled={!connected||busy}
      placeholder={connected?(busy?'Working…':'Describe a task…'):'Start the agent first'}
      autoComplete="off" spellCheck={false} onChange={e=>setTask(e.target.value)}/>
     {busy
      ? <button type="button" onClick={()=>void interrupt()} aria-label="Interrupt the agent"><Square/></button>
      : <button type="submit" disabled={!connected||!task.trim()} aria-label="Send task"><Send/></button>}
    </form>

    <div className="terminal-shortcuts">
     {['Explain this codebase','Find the bug in this file','Add a test'].map(s=>
      <button key={s} disabled={!connected||busy} onClick={()=>setTask(s)}>{s}</button>)}
    </div>
   </div>
  </div>
 </section>;
}

/** Verbs read better than tool names: "Writing calc.py", not "write". */
const TOOL_VERBS:Record<string,string>={
 write:'Writing',edit:'Editing',read:'Reading',patch:'Patching',
 bash:'Running',grep:'Searching',glob:'Finding',list:'Listing',
 webfetch:'Fetching',websearch:'Searching the web',task:'Delegating',todowrite:'Planning',
};

function ToolIcon({tool}:{tool:string}){
 if(tool==='bash')return <SquareTerminal/>;
 if(tool==='grep'||tool==='glob'||tool==='websearch')return <Search/>;
 return <FileText/>;
}

function ToolLine({activity}:{activity:ToolActivity}){
 const verb=TOOL_VERBS[activity.tool]??activity.tool;
 const done=activity.status==='completed';
 const failed=activity.status==='error';
 // Long absolute paths are mostly noise; the tail identifies the file.
 const target=activity.target.length>58?'…'+activity.target.slice(-57):activity.target;
 return <div className={'agent-tool '+(done?'done':failed?'failed':'active')}>
  <span className="agent-tool-icon">{done?<Check/>:failed?<ShieldAlert/>:<Loader2 className="spin"/>}</span>
  <span className="agent-tool-body">
   <ToolIcon tool={activity.tool}/>
   <span className="agent-tool-verb">{verb}</span>
   {target&&<code>{target}</code>}
  </span>
 </div>;
}
