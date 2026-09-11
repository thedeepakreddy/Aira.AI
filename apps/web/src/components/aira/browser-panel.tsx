import {useCallback,useEffect,useRef,useState} from 'react';
import {Power,Globe,Send,Square,ArrowUpRight,Check,Loader2,ShieldAlert,Link2} from 'lucide-react';
import {isDesktop,supervisor,BrowserClient,type BrowseEvent,type BrowserStatus} from '@/lib/browser';
import {getAccessToken} from '@/lib/supabase';
import {listCatalogue} from '@/lib/gateway';
import Markdown from './markdown';

/**
 * The browsing agent.
 *
 * Shows the trail rather than a spinner: a browse takes tens of seconds, most
 * of it spent looking at a page, and the steps are the only evidence that
 * anything is happening. They are also the only way to see *where* the agent
 * went, which matters on the one surface that acts on what a page tells it.
 */

interface Step {n:number;url:string;action:string}

export default function BrowserPanel(){
 const [status,setStatus]=useState<BrowserStatus|null>(null);
 const [task,setTask]=useState('');
 const [sent,setSent]=useState('');
 const [steps,setSteps]=useState<Step[]>([]);
 const [result,setResult]=useState('');
 const [visited,setVisited]=useState<string[]>([]);
 const [busy,setBusy]=useState(false);
 const [starting,setStarting]=useState(false);
 const [error,setError]=useState('');
 const [model,setModel]=useState('');
 const client=useRef<BrowserClient|null>(null);
 const run=useRef<AbortController|null>(null);
 const trail=useRef<HTMLDivElement>(null);

 const connected=Boolean(status?.running&&client.current);
 const missing=Boolean(status&&!status.python);

 useEffect(()=>{trail.current?.scrollTo({top:trail.current.scrollHeight,behavior:'instant'})},[steps,result]);

 useEffect(()=>{
  if(!isDesktop)return;
  void supervisor.status().then(next=>{
   setStatus(next);
   // The service outlives this panel, so returning to the screen reattaches
   // rather than showing a running agent as stopped.
   if(next.running&&next.port!=null&&next.token){
    client.current=new BrowserClient(next.port,next.token);
    void listCatalogue().then(({routing})=>setModel(routing.task??'')).catch(()=>{});
   }
  }).catch(()=>{});
  return()=>{run.current?.abort()};
 },[]);

 async function start(){
  setError('');setStarting(true);
  try{
   const token=await getAccessToken();
   if(!token)throw new Error('Sign in before starting the browser.');
   const {models,routing}=await listCatalogue();
   const chosen=routing.task??models[0]?.id;
   if(!chosen)throw new Error('No models available from the gateway.');
   const gatewayUrl=(import.meta.env?.VITE_GATEWAY_URL as string|undefined)??'http://localhost:8787';
   const next=await supervisor.start({gatewayUrl,token,model:chosen});
   setStatus(next);setModel(chosen);
   if(!next.running||next.port==null||!next.token)throw new Error('The browsing agent did not start.');
   client.current=new BrowserClient(next.port,next.token);
  }catch(e){
   const said=await supervisor.log().catch(()=>[] as string[]);
   const tail=said.slice(-2).join(' · ');
   setError((e instanceof Error?e.message:'Could not start the browser.')+(tail?` It said: ${tail}`:''));
  }finally{setStarting(false)}
 }

 async function stop(){
  run.current?.abort();run.current=null;
  client.current=null;
  setBusy(false);
  try{await supervisor.stop()}catch{}
  setStatus(await supervisor.status().catch(()=>null));
 }

 const onEvent=useCallback((event:BrowseEvent)=>{
  if(event.type==='step')setSteps(list=>[...list,{n:event.n,url:event.url,action:event.action}]);
  else if(event.type==='result'){setResult(event.text);setVisited(event.urls)}
  else if(event.type==='error')setError(event.message);
 },[]);

 async function go(){
  const text=task.trim();
  const c=client.current;
  if(!text||!c||busy)return;
  run.current?.abort();
  const controller=new AbortController();run.current=controller;
  setTask('');setSent(text);setSteps([]);setResult('');setVisited([]);setError('');setBusy(true);
  try{
   await c.run(text,12,onEvent,controller.signal);
  }catch(e){
   if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));
  }finally{
   if(!controller.signal.aborted)setBusy(false);
  }
 }

 function interrupt(){
  run.current?.abort();run.current=null;setBusy(false);
 }

 return <section className="cli-page agent-page browse-page screen-content" aria-label="Browsing agent">
  <div className="cli-heading">
   <span className="eyebrow">BROWSING AGENT</span>
   <div className="agent-title-row">
    <h1>Web<span className="desktop-only"> research.</span></h1>
    <div className="agent-controls">
     <span className="session-badge" role="status"><span/>
      {connected?(busy?`Step ${steps.length||1}`:'Ready'):isDesktop?'Not running':'Desktop app only'}</span>
     <button className={'agent-power '+(connected?'on':'')} onClick={connected?stop:()=>void start()}
      disabled={starting||!isDesktop||!status?.python}
      aria-label={connected?'Stop the browser':'Start the browser'}
      title={!isDesktop?'The browsing agent runs in the Aira desktop app':status?.python?(connected?'Stop the browser':'Start the browser'):'The browsing agent is not installed'}>
      <Power/>
     </button>
    </div>
   </div>
   <p>Ask it to look something up. It browses in its own profile, signed out.</p>
  </div>

  <div className="cli-grid agent-grid">
   <div className="terminal-window">
    <div className="terminal-title"><Globe/><span>aira — browser</span>
     {busy&&<span className="terminal-mode">BROWSING</span>}
     {status?.running&&status.port&&<span className="terminal-endpoint">127.0.0.1:{status.port}</span>}</div>
    <div className="terminal-path"><Link2/><span>{model||'No session'}</span>
     {connected&&<span className="browse-profile">its own Chrome profile · signed out</span>}</div>

    <div className="terminal-log" ref={trail} role="log" aria-live="polite">
     <div className="terminal-welcome"><span>Aira Browser</span>
      <p>{connected?'Give it something to find. Every page it opens is listed as it goes.'
       :!isDesktop?'The browsing agent drives a real browser on your machine, so it runs in the Aira desktop app rather than a browser tab.'
       :missing?'The browsing agent is not installed. Aira keeps it in its own virtualenv at ~/.aira/browser/venv.'
       :'Press power to start the browser.'}</p>
     </div>

     {sent&&<div className="terminal-entry"><div className="terminal-command"><span>❯</span> {sent}</div></div>}

     {steps.map(step=><div className="browse-step" key={step.n}>
      <span className="browse-step-n">{step.n}</span>
      <span className="browse-step-body">
       {step.action&&<span className="browse-action">{step.action}</span>}
       {step.url&&<code>{step.url.length>64?step.url.slice(0,63)+'…':step.url}</code>}
       {!step.action&&!step.url&&<span className="browse-action quiet">looking…</span>}
      </span>
     </div>)}

     {busy&&<div className="browse-step pending"><span className="browse-step-n"><Loader2 className="spin"/></span>
      <span className="browse-step-body"><span className="browse-action quiet">reading the page…</span></span></div>}

     {result&&<div className="browse-result">
      <div className="browse-result-head"><Check/><span>Found it</span></div>
      <Markdown>{result}</Markdown>
      {visited.length>0&&<ul className="browse-visited">
       {visited.map((url,i)=><li key={i}><ArrowUpRight/><code>{url}</code></li>)}
      </ul>}
     </div>}

     {error&&<div className="agent-notice error"><ShieldAlert/><span>{error}</span></div>}
    </div>

    <form className="terminal-input-row" onSubmit={e=>{e.preventDefault();void go()}}>
     <Globe/>
     <input aria-label="What should Aira look up?" value={task} disabled={!connected||busy}
      placeholder={connected?(busy?'Browsing…':'What should Aira look up?'):isDesktop?'Start the browser first':'Desktop app only'}
      autoComplete="off" spellCheck={false} onChange={e=>setTask(e.target.value)}/>
     {busy
      ? <button type="button" onClick={interrupt} aria-label="Stop browsing"><Square/></button>
      : <button type="submit" disabled={!connected||!task.trim()} aria-label="Start browsing"><Send/></button>}
    </form>

    <div className="terminal-shortcuts">
     {['Summarise the top story on Hacker News','Find the latest Tauri release notes','What is on example.com?'].map(s=>
      <button key={s} disabled={!connected||busy} onClick={()=>setTask(s)}>{s}</button>)}
    </div>
   </div>
  </div>
 </section>;
}
