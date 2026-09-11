import {useCallback,useEffect,useRef,useState} from 'react';
import {Power,Globe,Send,Square,ArrowUpRight,Check,Loader2,ShieldAlert,Link2,Plus,X,Search,EyeOff,Puzzle,ArrowLeft,ArrowRight,RotateCw} from 'lucide-react';
import {isDesktop,supervisor,page,BrowserClient,type BrowseEvent,type BrowserStatus,type Tab} from '@/lib/browser';
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
 const pageArea=useRef<HTMLDivElement>(null);
 const opened=useRef(false);

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

 /**
  * Keeps the native page view exactly over the panel's content area.
  *
  * A child webview is positioned in window coordinates, not laid out by CSS, so
  * nothing moves it when the window resizes or the toolbar changes height —
  * which is what this does. And it is closed on the way out: the webview draws
  * over its parent, so one left open would hang over whatever screen comes
  * next.
  */
 useEffect(()=>{
  if(!isDesktop||!connected)return;
  const area=pageArea.current;
  if(!area)return;
  let alive=true;

  const place=()=>{
   const rect=area.getBoundingClientRect();
   if(rect.width<2||rect.height<2)return;
   void (opened.current?page.bounds(rect):page.open('https://duckduckgo.com',rect).then(()=>{opened.current=true}))
    .catch(()=>{});
  };
  place();
  const observer=new ResizeObserver(()=>{if(alive)place()});
  observer.observe(area);
  window.addEventListener('resize',place);

  // The address bar shows where the page actually went, including links the
  // user followed inside it.
  const poll=setInterval(()=>{void page.url().then(u=>{if(alive&&u)setPageUrl(u)}).catch(()=>{})},1200);

  return()=>{
   alive=false;observer.disconnect();window.removeEventListener('resize',place);
   clearInterval(poll);
   opened.current=false;
   void page.close().catch(()=>{});
  };
 },[connected]);

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
  if(!looksLikeAddress(text)&&busy){
   setError('The agent is still working. Stop it first, or type an address — those always go through.');
   return;
  }
  // An address always goes through, even mid-research: the browser and the
  // agent are doing different jobs, and a browser you cannot type into because
  // something else is busy is not a browser.
  if(looksLikeAddress(text)){
   setTask('');
   // Straight into the page view — this is the browser the person is looking
   // at. The agent's Chrome is a separate thing and gets its own tasks.
   await page.navigate(/^[a-z]+:\/\//i.test(text)?text:`https://${text}`).catch(
    (e:unknown)=>setError(e instanceof Error?e.message:String(e)));
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
   <p>A real browser, and an agent that can research for you.</p>
  </div>

  <div className="cli-grid agent-grid">
   <div className="terminal-window">

    {connected&&<div className="browse-chrome">
     <div className="browse-tabstrip" role="tablist" aria-label="Open tabs">
      {tabs.map(tab=><span className="browse-tab" key={tab.id} title={tab.url}>
       <span className="browse-tab-title">{tab.title||tab.url||'New tab'}</span>
       <button onClick={()=>void closeTab(tab.id)} aria-label={`Close ${tab.title||tab.url}`}><X/></button>
      </span>)}
      <button className="browse-tab-new" onClick={()=>void openTab()} aria-label="New tab"><Plus/></button>
     </div>
     <form className="browse-bar" onSubmit={e=>{e.preventDefault();void submit()}}>
      <button type="button" className="browse-icon" onClick={()=>void page.history('back')} aria-label="Back"><ArrowLeft/></button>
      <button type="button" className="browse-icon" onClick={()=>void page.history('forward')} aria-label="Forward"><ArrowRight/></button>
      <button type="button" className="browse-icon" onClick={()=>void page.history('reload')} aria-label="Reload"><RotateCw/></button>
      {isPrivate?<EyeOff/>:<Search/>}
      <input aria-label="Address or question" value={task}
       placeholder={pageUrl||'Search, ask, or type a web address'}
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

    {/* The native page view sits over this rectangle. Nothing is drawn here:
        the hole is the point, and its measured bounds are what the webview is
        given. */}
    <div className="browse-canvas" ref={pageArea}/>

    {(sent||busy||error)&&<div className={'terminal-log '+(connected&&frame?'browse-trail':'')} ref={trail} role="log" aria-live="polite">
     {!(connected&&frame)&&<div className="terminal-welcome"><span>Aira Browser</span>
      <p>{connected?'Browse above, or ask a question and the agent researches it — its own Chrome, with every page it opens listed here.'
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
    </div>}

    {connected&&!sent&&<div className="terminal-shortcuts">
     {['Summarise the top story on Hacker News','Find the latest Tauri release notes','What is on example.com?'].map(s=>
      <button key={s} disabled={busy} onClick={()=>setTask(s)}>{s}</button>)}
    </div>}
   </div>
  </div>
 </section>;
}
