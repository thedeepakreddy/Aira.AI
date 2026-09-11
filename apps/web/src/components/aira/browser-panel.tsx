import {useCallback,useEffect,useRef,useState} from 'react';
import {Power,Globe,Send,Square,ArrowUpRight,Check,Loader2,ShieldAlert,Link2,Plus,X,Search,EyeOff,Puzzle} from 'lucide-react';
import {isDesktop,supervisor,BrowserClient,type BrowseEvent,type BrowserStatus,type Tab} from '@/lib/browser';
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
 const [tabs,setTabs]=useState<Tab[]>([]);
 const [isPrivate,setPrivate]=useState(false);
 const [frame,setFrame]=useState<string|null>(null);
 const [pageUrl,setPageUrl]=useState('');
 const client=useRef<BrowserClient|null>(null);
 const run=useRef<AbortController|null>(null);
 const trail=useRef<HTMLDivElement>(null);

 const connected=Boolean(status?.running&&client.current);
 const missing=Boolean(status&&!status.python);

 useEffect(()=>{trail.current?.scrollTo({top:trail.current.scrollHeight,behavior:'instant'})},[steps,result]);

 const refreshTabs=useCallback(async()=>{
  const c=client.current;
  if(!c)return;
  // Listing must never be what launches Chrome, so a quiet failure here
  // just leaves the strip empty rather than showing an error.
  try{const state=await c.tabs();setTabs(state.tabs);setPrivate(state.private)}catch{/* not up yet */}
 },[]);

 /**
  * Turns a pointer event on the frame into page coordinates.
  *
  * The capture is the viewport at its own size and is drawn scaled to fit, so a
  * click at panel coordinates has to be divided back by that ratio or every
  * click lands somewhere else on the page.
  */
 function pagePoint(e:{clientX:number;clientY:number;currentTarget:HTMLImageElement}){
  const img=e.currentTarget;
  const box=img.getBoundingClientRect();
  return {
   x:(e.clientX-box.left)*(img.naturalWidth/box.width),
   y:(e.clientY-box.top)*(img.naturalHeight/box.height),
  };
 }

 const send=useCallback((event:Record<string,unknown>)=>{
  // Fire and forget: a dropped click should not raise an error card, and the
  // next frame shows whether it landed.
  void client.current?.input(event).catch(()=>{});
 },[]);

 // The page itself, drawn inside Aira. Chrome cannot render into this window —
 // it is a separate process with its own — so its frames are captured and shown
 // here instead, which is what makes the browsing visible in the app rather
 // than only in a window beside it.
 useEffect(()=>{
  if(!connected)return;
  let alive=true;
  const tick=async()=>{
   const c=client.current;
   if(!c||!alive)return;
   try{
    const shot=await c.screen();
    if(!alive)return;
    if(shot.image)setFrame(shot.image);
    setPageUrl(shot.url||'');
   }catch{/* a missed frame is not worth surfacing */}
  };
  void tick();
  const id=setInterval(()=>void tick(),busy?900:2500);
  return()=>{alive=false;clearInterval(id)};
 },[connected,busy]);

 useEffect(()=>{
  if(!connected)return;
  void refreshTabs();
  // While a browse runs the agent opens and closes tabs of its own, so the
  // strip is polled rather than only read once.
  const id=setInterval(()=>void refreshTabs(),busy?2500:8000);
  return()=>clearInterval(id);
 },[connected,busy,refreshTabs]);

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

 async function openTab(url='about:blank'){
  const c=client.current;
  if(!c)return;
  try{const state=await c.openTab(url);setTabs(state.tabs)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }

 /** An address goes to the browser; anything else goes to the agent. */
 function looksLikeAddress(text:string):boolean{
  if(/^[a-z]+:\/\//i.test(text))return true;
  // A single token with a dot and no spaces is an address; "what is a .com"
  // is not. Getting this wrong in the safe direction means a search, which is
  // what a browser does with an ambiguous omnibox anyway.
  return !/\s/.test(text)&&/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text);
 }

 async function submit(){
  const text=task.trim();
  if(!text)return;
  if(looksLikeAddress(text)){
   setTask('');
   await openTab(/^[a-z]+:\/\//i.test(text)?text:`https://${text}`);
   return;
  }
  await go();
 }

 async function closeTab(id:string){
  const c=client.current;
  if(!c)return;
  try{const state=await c.closeTab(id);setTabs(state.tabs)}
  catch(e){setError(e instanceof Error?e.message:String(e))}
 }

 async function togglePrivate(){
  const c=client.current;
  if(!c)return;
  const want=!isPrivate;
  try{
   const state=await c.setPrivate(want);
   setPrivate(state.private);
   // The swap is a different Chrome, so whatever was open belonged to the old
   // one. Clearing the strip now beats showing tabs that no longer exist.
   setTabs([]);
  }catch(e){setError(e instanceof Error?e.message:String(e))}
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
   <p>Ask it to look something up. A Chrome window opens so you can watch it work.</p>
  </div>

  <div className="cli-grid agent-grid">
   <div className="terminal-window">
    <div className="terminal-title"><Globe/><span>aira — browser</span>
     {busy&&<span className="terminal-mode">BROWSING</span>}
     {status?.running&&status.port&&<span className="terminal-endpoint">127.0.0.1:{status.port}</span>}</div>

    {connected&&<div className="browse-chrome">
     <div className="browse-tabstrip" role="tablist" aria-label="Open tabs">
      {tabs.map(tab=><span className="browse-tab" key={tab.id} title={tab.url}>
       <span className="browse-tab-title">{tab.title||tab.url||'New tab'}</span>
       <button onClick={()=>void closeTab(tab.id)} aria-label={`Close ${tab.title||tab.url}`}><X/></button>
      </span>)}
      <button className="browse-tab-new" onClick={()=>void openTab()} aria-label="New tab"><Plus/></button>
     </div>
     <form className="browse-bar" onSubmit={e=>{e.preventDefault();void submit()}}>
      {isPrivate?<EyeOff/>:<Search/>}
      <input aria-label="Address or question" value={task} disabled={busy}
       placeholder={busy?'Working…':'Search, ask, or type a web address'}
       autoComplete="off" spellCheck={false} onChange={e=>setTask(e.target.value)}/>
      {busy
       ? <button type="button" className="browse-bar-go" onClick={interrupt} aria-label="Stop"><Square/></button>
       : <button type="submit" className="browse-bar-go" disabled={!task.trim()} aria-label="Go"><Send/></button>}
      <button type="button" className={'browse-icon '+(isPrivate?'on':'')} onClick={()=>void togglePrivate()}
       aria-label={isPrivate?'Private browsing on':'Private browsing off'}
       title={isPrivate?'Private: nothing is kept. Click for the saved profile.':'Browse privately — applies to the next browser'}><EyeOff/></button>
      <span className="browse-icon quiet" title="Unpacked extensions in ~/.aira/browser/extensions load at start"><Puzzle/></span>
      </form>
    </div>}

    {connected&&frame&&<div className="browse-view">
     <img src={frame} alt={pageUrl?`Page at ${pageUrl}`:'The page the agent is looking at'}
      tabIndex={0}
      onClick={e=>{const p=pagePoint(e);send({type:'click',...p})}}
      onWheel={e=>{const p=pagePoint(e);send({type:'scroll',...p,deltaX:e.deltaX,deltaY:e.deltaY})}}
      onKeyDown={e=>{
       // Printable characters go as text; the rest have to be key events or
       // the page never reacts to Enter, Backspace or the arrows.
       if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){e.preventDefault();send({type:'text',text:e.key})}
       else if(['Enter','Backspace','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape'].includes(e.key)){
        e.preventDefault();send({type:'key',key:e.key});
       }
      }}/>
    </div>}

    <div className={'terminal-log '+(connected&&frame?'browse-trail':'')} ref={trail} role="log" aria-live="polite">
     {!(connected&&frame)&&<div className="terminal-welcome"><span>Aira Browser</span>
      <p>{connected?'Give it something to find. Chrome opens alongside Aira — the tabs above are that window, and every page is listed here as it goes.'
       :!isDesktop?'The browsing agent drives a real browser on your machine, so it runs in the Aira desktop app rather than a browser tab.'
       :missing?'The browsing agent is not installed. Aira keeps it in its own virtualenv at ~/.aira/browser/venv.'
       :'Press power to start the browser.'}</p>
     </div>}

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

    {connected&&!sent&&<div className="terminal-shortcuts">
     {['Summarise the top story on Hacker News','Find the latest Tauri release notes','What is on example.com?'].map(s=>
      <button key={s} disabled={busy} onClick={()=>setTask(s)}>{s}</button>)}
    </div>}
   </div>
  </div>
 </section>;
}
