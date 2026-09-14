import {useCallback,useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {ArrowLeft,ArrowRight,ArrowRightLeft,ArrowUpRight,Check,Clock3,EyeOff,Globe,Loader2,PanelRightClose,PanelRightOpen,Plus,Power,RotateCw,Search,Send,ShieldAlert,Sparkles,Square,X} from 'lucide-react';
import {isDesktop,supervisor,BrowserClient,type BrowseEvent,type BrowserStatus,type TabState} from '@/lib/browser';
import {getAccessToken} from '@/lib/supabase';
import {handOff,quote} from '@/lib/handoff';
import {listCatalogue,gatewayRequest,keepPage,searchPages,type PageHit} from '@/lib/gateway';
import Markdown from './markdown';
import './browser-workbench.css';

const HOME='https://www.google.com/';
const EMPTY:TabState={tabs:[],private:false,running:false};
// Account remounts wait for the prior owner's runtime to stop before reading
// status. A StrictMode effect replay does not end ownership.
let browserCleanup:Promise<void>=Promise.resolve();
function label(url:string){try{return new URL(url).hostname.replace(/^www\./,'')||'New tab'}catch{return 'New tab'}}
export function browserAddress(text:string){
 const value=text.trim();
 if(/^https?:\/\//i.test(value)||value==='about:blank')return value;
 if(/^[a-z][a-z\d+.-]*:/i.test(value)&&!/^localhost:\d/i.test(value))throw new Error('Use an HTTP or HTTPS web address.');
 if(!/\s/.test(value)&&(/^[\w-]+(\.[\w-]+)+(?:[:/].*)?$/.test(value)||/^localhost(?::\d+)?(?:\/.*)?$/.test(value)))return `https://${value}`;
 return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export default function BrowserPanel({active=true}:{active?:boolean}){
 const [status,setStatus]=useState<BrowserStatus|null>(null);
 const [tabState,setTabState]=useState<TabState>(EMPTY);
 const [address,setAddress]=useState('');
 const [task,setTask]=useState('');
 const [sent,setSent]=useState('');
 const [steps,setSteps]=useState<{n:number;url:string;action:string}[]>([]);
 const [result,setResult]=useState('');
 const [visited,setVisited]=useState<string[]>([]);
 const [busy,setBusy]=useState(false);
 const [starting,setStarting]=useState(false);
 const [working,setWorking]=useState(false);
 const [error,setError]=useState('');
 const [model,setModel]=useState('');
 const [showResearch,setShowResearch]=useState(true);
 const [frame,setFrame]=useState<string|null>(null);
 const [frameTitle,setFrameTitle]=useState('');
 const [memoryState,setMemoryState]=useState<'idle'|'saving'|'saved'>('idle');
 const [privateResult,setPrivateResult]=useState(false);
 const client=useRef<BrowserClient|null>(null);
 const run=useRef<AbortController|null>(null);
 const editingAddress=useRef(false);
 const [recallOpen,setRecallOpen]=useState(false);
 const [recallQuery,setRecallQuery]=useState('');
 /** null means "not searched yet", which reads differently from "no matches". */
 const [recallHits,setRecallHits]=useState<PageHit[]|null>(null);
 const captured=useRef<Set<string>>(new Set());
 const pendingCapture=useRef<{url:string;timer:number}>({url:'',timer:0});
 const currentAddress=useRef('');
 const alive=useRef(true);
 const pendingStart=useRef<Promise<BrowserStatus>|null>(null);
 const startingController=useRef<AbortController|null>(null);
 const imageRef=useRef<HTMLImageElement>(null);
 const connected=Boolean(status?.running&&client.current);
 const locked=busy||working||Boolean(tabState.busy);

 const showError=useCallback((e:unknown)=>setError(e instanceof Error?e.message:String(e)),[]);
 const applyTabs=useCallback((state:TabState)=>{
  setTabState(state);
  const url=state.tabs.find(t=>t.id===state.activeId)?.url;
  if(url){currentAddress.current=url;if(!editingAddress.current)setAddress(url)}
 },[]);

 useEffect(()=>{
  alive.current=true;
  let cancelled=false;
  queueMicrotask(()=>{
   if(!isDesktop||cancelled)return;
   void browserCleanup.then(()=>supervisor.status()).then(next=>{
    if(cancelled)return;
    if(next.running&&next.port!=null&&next.token)client.current=new BrowserClient(next.port,next.token);
    setStatus(next);
   }).catch(e=>{if(!cancelled)showError(e)});
  });
  return()=>{
   cancelled=true;alive.current=false;run.current?.abort();startingController.current?.abort();client.current=null;
   queueMicrotask(()=>{
    if(isDesktop&&!alive.current){
     const launch=pendingStart.current;
     browserCleanup=browserCleanup.then(async()=>{await launch?.catch(()=>undefined);await supervisor.stop()}).catch(()=>undefined);
    }
   });
  };
 },[showError]);

 useEffect(()=>{
  if(!connected||!active)return;
  let disposed=false;
  let timer:ReturnType<typeof setTimeout>;
  let failures=0;
  async function refresh(){
   const c=client.current;
   if(!c||disposed)return;
   try{
    const state=await c.tabs();
    if(disposed)return;
    if(state.error)throw new Error(state.error);
    applyTabs(state);
    if(state.tabs.length){
     const next=await c.screen();
     if(disposed)return;
     setFrame(next.image);setFrameTitle(next.title||label(next.url));
     if(next.url){
      currentAddress.current=next.url;if(!editingAddress.current)setAddress(next.url);
      void capture(c,next.url);
     }
    }else setFrame(null);
    failures=0;
   }catch(e){
    failures++;
    if(failures===3){showError(e);const next=await supervisor.status().catch(()=>null);if(!disposed)setStatus(next)}
   }finally{if(!disposed)timer=setTimeout(()=>void refresh(),busy?1200:700)}
  }
  void refresh();
  return()=>{disposed=true;clearTimeout(timer)};
 },[connected,active,busy,applyTabs,showError]);

 /**
  * Keeps a page once the user has actually settled on it.
  *
  * Waits for the address to hold still for a moment rather than firing on every
  * frame: a single navigation produces several, and a page mid-load has not
  * finished saying what it says. Each URL is kept once per session — re-reading
  * something is not new reading.
  *
  * Every failure is silent. This happens because the user browsed, not because
  * they asked, and a browser that interrupts reading to report a memory problem
  * is worse than one that forgets.
  */
 async function capture(c:BrowserClient,url:string){
  if(captured.current.has(url))return;
  if(pendingCapture.current.url===url)return;
  clearTimeout(pendingCapture.current.timer);
  pendingCapture.current={url,timer:setTimeout(async()=>{
   if(currentAddress.current!==url)return;
   captured.current.add(url);
   try{
    const page=await c.snapshot();
    if(page?.url)await keepPage({url:page.url,title:page.title||'',text:page.text||''});
   }catch{/* reading must not break because memory did */}
  },2500) as unknown as number};
 }

 /**
  * Sends the current page to another surface.
  *
  * The text is quoted and attributed rather than pasted raw. A page body
  * reaching a coding agent with nothing marking it as someone else's words is
  * the neatest injection path in the app — and it only ever fills a composer,
  * so the user reads it before anything runs.
  */
 async function sendPageTo(target:'cli'|'tasks'){
  const c=client.current;
  if(!c)return;
  try{
   const page=await c.snapshot();
   if(!page?.url)return;
   handOff(target,{
    text:quote(page.text||'',page.url),
    from:page.title?`the page "${page.title}"`:'the browser',
    source:page.url,
   });
  }catch(e){showError(e)}
 }

 async function runRecall(){
  const q=recallQuery.trim();
  if(!q){setRecallHits(null);return}
  setRecallHits(await searchPages(q).catch(()=>[]));
 }

 async function start(){
  // A real Chrome on this machine, driven over Tauri's bridge. Neither exists
  // in a browser tab — which already has tabs of its own.
  if(!isDesktop){setError('The Aira browser drives a real Chrome on your machine, so it needs the desktop app.');return}
  setError('');setStarting(true);
  const controller=new AbortController();startingController.current=controller;
  try{
   const gatewayUrl=(import.meta.env.VITE_GATEWAY_URL as string|undefined)??'http://localhost:8787';
   // Ordinary browsing does not consume model tokens or require a model.
   await browserCleanup;
   if(!alive.current||controller.signal.aborted)return;
   const launch=supervisor.start({gatewayUrl,token:'',model:''});pendingStart.current=launch;
   const next=await launch;
   if(!alive.current||controller.signal.aborted){await supervisor.stop();return}
   if(!next.running||next.port==null||!next.token)throw new Error('The browser service could not start.');
   const c=new BrowserClient(next.port,next.token);
   await c.waitUntilReady(controller.signal);
   if(!alive.current||controller.signal.aborted){await supervisor.stop();return}
   const state=await c.openTab(HOME);
   if(!alive.current||controller.signal.aborted){await supervisor.stop();return}
   client.current=c;applyTabs(state);setStatus(next);
  }catch(e){
   if(alive.current&&!controller.signal.aborted)showError(e);
   await supervisor.stop().catch(()=>{});
   if(alive.current)setStatus(await supervisor.status().catch(()=>null));
  }finally{pendingStart.current=null;if(startingController.current===controller)startingController.current=null;if(alive.current)setStarting(false)}
 }

 async function stop(){
  setWorking(true);run.current?.abort();
  try{await supervisor.stop();client.current=null;setStatus(await supervisor.status());setTabState(EMPTY);setFrame(null);setBusy(false)}
  catch(e){showError(e)}finally{setWorking(false)}
 }

 async function operate(action:(c:BrowserClient)=>Promise<TabState>){
  const c=client.current;if(!c||locked)return;
  setWorking(true);setError('');
  try{applyTabs(await action(c))}catch(e){showError(e)}finally{setWorking(false)}
 }

 /** `to` is for callers that already know the URL — a recalled page, say. */
 async function navigate(to?:string){
  const typed=to??address;
  if(!typed.trim())return;
  try{const url=browserAddress(typed);editingAddress.current=false;await operate(c=>c.navigate(url))}catch(e){showError(e)}
 }

 const onEvent=useCallback((event:BrowseEvent)=>{
  if(!alive.current)return;
  if(event.type==='step')setSteps(list=>[...list,event]);
  else if(event.type==='result'){setResult(event.text);setVisited([...new Set(event.urls)].filter(u=>/^https?:\/\//i.test(u)))}
  else if(event.type==='error')setError(event.message);
  else if(event.type==='cancelled')setError('Research stopped. Your tabs are still open.');
 },[]);

 async function research(){
  const c=client.current,text=task.trim();if(!c||!text||locked)return;
  const controller=new AbortController();run.current=controller;
  setBusy(true);setError('');setSent(text);setResult('');setSteps([]);setVisited([]);setMemoryState('idle');setPrivateResult(tabState.private);
  try{
   const token=await getAccessToken();if(!token)throw new Error('Sign in to use the research agent. Browsing remains available.');
   const catalogue=await listCatalogue();
   const chosen=catalogue.routing.task??catalogue.models[0]?.id;
   if(!chosen)throw new Error('Configure a model in the gateway to use research.');
   if(controller.signal.aborted)return;
   await c.configure(chosen,token);setModel(chosen);setTask('');
   await c.run(text,12,onEvent,controller.signal);
  }catch(e){if(!controller.signal.aborted)showError(e)}
  finally{if(alive.current)setBusy(false);if(run.current===controller)run.current=null}
 }

 async function input(event:Record<string,unknown>){
  if(locked||!client.current)return;
  try{const response=await client.current.input(event);if(!response.ok)throw new Error('The page did not accept this input.')}catch(e){showError(e)}
 }
 async function saveMemory(){
  if(!result||privateResult||memoryState!=='idle')return;
  setMemoryState('saving');
  try{
   await gatewayRequest('/v1/memory',{method:'POST',body:JSON.stringify({text:`Research: ${sent}\n${result}`.slice(0,4000),surface:'browser'})});
   setMemoryState('saved');
  }catch(e){setMemoryState('idle');showError(e)}
 }
 function key(event:KeyboardEvent<HTMLImageElement>){
  if(event.metaKey||event.ctrlKey||event.altKey)return;
  const controls=['Enter','Backspace','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape'];
  if(event.key.length===1||controls.includes(event.key)){
   event.preventDefault();void input(event.key.length===1?{type:'text',text:event.key}:{type:'key',key:event.key});
  }
 }

 return <section className="cli-page agent-page browse-page screen-content browser-workbench" aria-label="Browser workspace">
  <div className="cli-heading">
   <span className="eyebrow">EXPLORE · RESEARCH · ACT</span>
   <div className="agent-title-row"><h1>A wider view.</h1><div className="agent-controls">
    <span className="session-badge" role="status"><span/>{starting?'Starting Chrome':connected?(busy?'Researching':'Connected'):'Disconnected'}</span>
    <button className={'agent-power '+(connected?'on':'')} onClick={()=>void(connected?stop():start())} disabled={starting||working||!isDesktop||!status?.python} aria-label={connected?'Disconnect browser':'Connect browser'} title={connected?'Close the shared browser session':'Start shared Chrome'}><Power/></button>
   </div></div>
   <p>Your browsing and research, in one shared Chrome session.</p>
  </div>
  {error&&<div className="agent-notice error browser-notice" role="alert"><ShieldAlert/><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss browser message"><X/></button></div>}
  {!connected?<div className="browser-welcome">
   <div className="browser-welcome-orbit"><Globe/></div>
   <span className="eyebrow">A BROWSER WITH CONTEXT</span><h2>Follow your curiosity.</h2>
   <p>{!isDesktop?'The shared Chrome session runs in Aira Desktop. On the web, open pages in your browser and bring findings back to chat.':status&&!status.python?'Install the browser runtime using the project’s Browser setup guide, then reopen this panel.':'Open real tabs, browse the web, and let research work in the same session. No model is needed to browse.'}</p>
   <div className="browser-welcome-actions">{isDesktop?<button className="browser-primary" disabled={starting||!status?.python} onClick={()=>void start()}>{starting?<Loader2 className="spin"/>:<Power/>}{starting?'Connecting…':'Connect browser'}</button>:<a className="browser-primary" href="https://www.google.com/" target="_blank" rel="noopener noreferrer">Open web search <ArrowUpRight/></a>}</div>
   <div className="browser-feature-row"><span>Real tabs & history</span><span>Shared with coding tools</span><span>Research in context</span></div>
  </div>:<div className={'browser-workbench-grid '+(!showResearch?'research-collapsed':'')}>
   <div className="browser-surface">
    <div className="browse-chrome">
     <div className="browse-tabstrip" role="tablist" aria-label="Shared Chrome tabs">
      {tabState.tabs.map(tab=><div className={'browse-tab '+(tab.id===tabState.activeId?'active':'')} key={tab.id}>
       <button role="tab" aria-selected={tab.id===tabState.activeId} className="browse-tab-title" title={tab.title||tab.url} disabled={locked} onClick={()=>void operate(c=>c.selectTab(tab.id))}>{tab.title||label(tab.url)}</button>
       <button className="browse-tab-x" disabled={locked} onClick={()=>void operate(c=>c.closeTab(tab.id))} aria-label={`Close ${tab.title||label(tab.url)}`}><X/></button>
      </div>)}
      <button className="browse-tab-new" disabled={locked} onClick={()=>void operate(c=>c.openTab('about:blank'))} aria-label="New browser tab"><Plus/></button>
     </div>
     <div className="browse-toolbar"><div className="browse-nav">
      <button className="browse-icon" disabled={locked} onClick={()=>void operate(c=>c.history('back'))} aria-label="Back"><ArrowLeft/></button>
      <button className="browse-icon" disabled={locked} onClick={()=>void operate(c=>c.history('forward'))} aria-label="Forward"><ArrowRight/></button>
      <button className="browse-icon" disabled={locked} onClick={()=>void operate(c=>c.history('reload'))} aria-label="Reload"><RotateCw className={working?'spin':''}/></button>
     </div><form className="browse-bar" onSubmit={e=>{e.preventDefault();void navigate()}}><Search/><input aria-label="Search or enter a web address" value={address} placeholder="Search or enter a web address" disabled={locked} autoComplete="off" spellCheck={false} onFocus={()=>{editingAddress.current=true}} onBlur={()=>{editingAddress.current=false}} onChange={e=>setAddress(e.target.value)}/><button className="browse-bar-go" disabled={locked||!address.trim()} aria-label="Navigate"><ArrowRight/></button></form><button type="button" className={"browse-recall-toggle"+(recallOpen?" on":"")} onClick={()=>{setRecallOpen(o=>!o);setRecallHits(null)}} title="Search pages you have read in Aira" aria-label="Search pages you have read" aria-pressed={recallOpen}><Clock3/></button><button type="button" className="browse-recall-toggle" disabled={!connected} onClick={()=>void sendPageTo('cli')} title="Send this page to the coding agent" aria-label="Send this page to the coding agent"><ArrowRightLeft/></button>
     {recallOpen&&<div className="browse-recall">
      <form onSubmit={e=>{e.preventDefault();void runRecall()}}>
       <Search/>
       <input autoFocus value={recallQuery} placeholder="a phrase you remember from it…"
        aria-label="Search pages you have read"
        onChange={e=>setRecallQuery(e.target.value)}/>
      </form>
      {/* Three states, said plainly: not searched yet, searched and empty,
        * searched and found. A blank drawer reads as broken. */}
      {recallHits===null
       ?<p className="browse-recall-hint">Pages you read in Aira are kept for 30 days. Nothing here is sent anywhere.</p>
       :recallHits.length===0
       ?<p className="browse-recall-hint">Nothing matched. Try a phrase from the page itself.</p>
       :<ul className="browse-recall-hits">{recallHits.map(hit=><li key={hit.url+hit.at}>
         <button type="button" onClick={()=>{setAddress(hit.url);setRecallOpen(false);void navigate(hit.url)}}>
          <strong>{hit.title}</strong>
          <span className="browse-recall-excerpt">{hit.excerpt}</span>
          <span className="browse-recall-url">{label(hit.url)}</span>
         </button>
        </li>)}</ul>}
     </div>}
     <button className={'browse-icon '+(tabState.private?'on':'')} disabled={locked} aria-label="Private browser profile" aria-pressed={tabState.private} title="Switch profile and close current tabs" onClick={()=>void operate(async c=>{await c.setPrivate(!tabState.private);return c.openTab(HOME)})}><EyeOff/></button>
     <button className="browse-icon" aria-label={showResearch?'Hide research panel':'Show research panel'} aria-expanded={showResearch} onClick={()=>setShowResearch(!showResearch)}>{showResearch?<PanelRightClose/>:<PanelRightOpen/>}</button></div>
    </div>
    <div className="browser-preview" aria-busy={busy||working}>
     {frame?<img ref={imageRef} src={frame} alt={frameTitle?`Interactive preview of ${frameTitle}`:'Interactive Chrome page preview'} tabIndex={locked?-1:0} draggable={false} onKeyDown={key} onPaste={e=>{e.preventDefault();void input({type:'text',text:e.clipboardData.getData('text')})}} onClick={e=>{const img=e.currentTarget;img.focus();const r=img.getBoundingClientRect();void input({type:'click',x:(e.clientX-r.left)*img.naturalWidth/r.width,y:(e.clientY-r.top)*img.naturalHeight/r.height})}} onWheel={e=>{void input({type:'scroll',deltaX:e.deltaX,deltaY:e.deltaY})}}/>:<div className="browser-preview-empty"><Globe/><p>{working?'Opening page…':'Your page preview will appear here.'}</p></div>}
    </div>
    <div className="browser-statusbar"><span>{tabState.private?'Temporary profile':'Aira profile'} · {busy?'Agent has control':'Interactive preview'}</span><button disabled={working} onClick={()=>{void client.current?.focus().catch(showError)}}>Open browser window <ArrowUpRight/></button></div>
   </div>
   {showResearch&&<aside className="browser-research" aria-label="Research assistant">
    <div className="browser-research-heading"><Sparkles/><div><h2>Research companion</h2><p>Works in your open tabs</p></div></div>
    <div className="browser-research-log" role="log" aria-live="polite">
     {!sent&&<div className="browser-research-empty"><p>Ask a question worth exploring.</p><span>The agent reads the same Chrome session you see here. Stop it any time to take control.</span><div className="browser-prompts">{['Summarize the current page with sources','Compare these open tabs','Find official documentation for this topic'].map(s=><button key={s} onClick={()=>setTask(s)}>{s}<ArrowUpRight/></button>)}</div></div>}
     {sent&&<div className="browser-question">{sent}</div>}
     {steps.map(step=><div className="browse-step" key={step.n}><span className="browse-step-n">{step.n}</span><span className="browse-step-body"><span className="browse-action">{step.action||'Reading page'}</span>{step.url&&<code>{label(step.url)}</code>}</span></div>)}
     {busy&&<div className="browse-step"><Loader2 className="spin"/><span>Researching your question…</span></div>}
     {result&&<div className="browse-result"><div className="browse-result-head"><Check/><span>Research result</span></div><Markdown>{result}</Markdown>{visited.length>0&&<ul className="browse-visited">{visited.map(url=><li key={url}><button disabled={locked} onClick={()=>void operate(c=>c.openTab(url))}>{label(url)}<ArrowUpRight/></button></li>)}</ul>}<button className="browser-primary" disabled={privateResult||memoryState!=='idle'} onClick={()=>void saveMemory()} title={privateResult?'Memory is disabled for temporary profiles':'Save these findings to shared Aira memory'}>{memoryState==='saving'?'Saving…':memoryState==='saved'?'Saved to memory':'Save to memory'}</button></div>}
    </div>
    <form className="browser-research-composer" onSubmit={e=>{e.preventDefault();void research()}}><textarea value={task} onChange={e=>setTask(e.target.value)} placeholder="Ask Aira to research…" aria-label="Research question" rows={3} disabled={busy}/><div><span>{model?labelModel(model):'Uses your research model'}</span>{busy?<button key="stop" type="button" className="browser-primary" onClick={e=>{e.preventDefault();run.current?.abort()}}><Square/>Stop</button>:<button key="research" type="submit" className="browser-primary" disabled={!task.trim()||locked}><Send/>Research</button>}</div></form>
   </aside>}
  </div>}
 </section>;
}
function labelModel(model:string){return model.split('/').pop()||model}
