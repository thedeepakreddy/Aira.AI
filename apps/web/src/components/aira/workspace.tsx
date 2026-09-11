import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Paperclip, Sparkles, Signal, Wifi, BatteryFull, X, Send, PauseCircle, PlayCircle, MessageCircle, Plus, Terminal, LogIn, LogOut } from 'lucide-react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';


import {Sheet,SheetTrigger,SheetContent,SheetTitle,SheetDescription,SheetHeader} from '@/components/ui/sheet';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import AgentPanel from './agent-panel';
import Login from './login';
import {HISTORY_KEY,parseHistory,saveConversation,type Conversation} from '@/lib/workspace-state';
import {streamChat,listModels,type ModelSpec} from '@/lib/gateway';
import {getSession,onAuthChange,signOut as authSignOut} from '@/lib/supabase';
import {playOrb} from '@/lib/orb';
import Markdown from './markdown';
import VoiceScreen from './voice-screen';
export type Screen = 'home' | 'voice' | 'chat' | 'cli' | 'login';
type View = 'auto'|'mobile'|'desktop';
type Message = {role:'user'|'assistant'; text:string};
const SUGGESTIONS = ['Deploy autonomous agent','Optimize gas for ZK-proofs','Audit my protocol'];

export default function Workspace({view='auto',initialScreen='home'}:{view?:View;initialScreen?:Screen}) {
 const [screen,setScreen]=useState<Screen>(initialScreen);
 const [historyOpen,setHistoryOpen]=useState(false);
 const [conversations,setConversations]=useState<Conversation[]>([]);
 const [currentId,setCurrentId]=useState<string|null>(null);
 const [historyReady,setHistoryReady]=useState(false);
 const [storageNotice,setStorageNotice]=useState('');
 const [signedIn,setSignedIn]=useState(false);
 const [models,setModels]=useState<ModelSpec[]>([]);
 const [model,setModel]=useState('');
 const basePath=view==='auto'?'':'/'+view;
 function showScreen(next:Screen){
  setScreen(next);
  const path=basePath+(next==='cli'?'/cli':next==='login'?'/login':'')||'/';
  if(typeof window!=='undefined'&&window.location.pathname!==path)window.history.pushState({},'',path);
 }
 function newChat(){clearTimers();setCurrentId(null);setMessages([]);setDraft('');setAttachment('');setBusy(false);setHistoryOpen(false);showScreen('home')}
 function openConversation(conversation:Conversation){clearTimers();setCurrentId(conversation.id);setMessages(conversation.messages);setDraft('');setAttachment('');setBusy(false);setHistoryOpen(false);showScreen('chat')}
 function openCLI(){clearTimers();setBusy(false);setHistoryOpen(false);showScreen('cli')}
 function openLogin(){clearTimers();setBusy(false);setHistoryOpen(false);showScreen('login')}
 // onAuthChange is the single source of truth for signedIn; these only navigate.
 function completeLogin(){showScreen('home')}
 function signOut(){void authSignOut();clearTimers();setBusy(false);setHistoryOpen(false);showScreen('login')}

 const [draft,setDraft]=useState('');
 const [messages,setMessages]=useState<Message[]>([]);
 const [busy,setBusy]=useState(false);
 const [attachment,setAttachment]=useState('');
 const [reduceMotion,setReduceMotion]=useState(false);
 const fileInput=useRef<HTMLInputElement>(null);
 const textarea=useRef<HTMLTextAreaElement>(null);
 const scrollRegion=useRef<HTMLDivElement>(null);
 const closeButton=useRef<HTMLButtonElement>(null);
 const heroVideo=useRef<HTMLVideoElement>(null);
 const timers=useRef<ReturnType<typeof setTimeout>[]>([]);
 const screenRef=useRef(screen);
 screenRef.current=screen;
 const messagesRef=useRef<Message[]>(messages);
 messagesRef.current=messages;
 const request=useRef<AbortController|null>(null);

 function clearTimers(){timers.current.forEach(clearTimeout);timers.current=[];request.current?.abort();request.current=null}
 function later(fn:()=>void,ms:number){timers.current.push(setTimeout(fn,ms))}
 function goHome(){clearTimers();showScreen('home');setBusy(false)}
 function startVoice(){clearTimers();showScreen('voice');setBusy(false)}
 /** Appends streamed text to the open assistant bubble, or opens one. */
 function appendAssistant(text:string,started:boolean){
  if(!started){setMessages(previous=>[...previous,{role:'assistant',text}]);return}
  setMessages(previous=>{
   const next=previous.slice();const last=next[next.length-1];
   if(last?.role==='assistant')next[next.length-1]={...last,text:last.text+text};
   return next;
  });
 }
 async function runStream(history:Message[],conversationId:string){
  const controller=new AbortController();request.current=controller;
  let started=false;
  try{
   for await(const event of streamChat({
    messages:history.map(m=>({role:m.role,content:m.text})),
    surface:'chat',model:model||undefined,conversationId,signal:controller.signal,
   })){
    if(controller.signal.aborted)return;
    if(event.type==='text'){
     // The first token clears the thinking state and opens the bubble.
     if(!started)setBusy(false);
     appendAssistant(event.text,started);started=true;
    }else if(event.type==='error'){
     setBusy(false);appendAssistant(event.message,started);started=true;
    }
   }
  }finally{
   if(request.current===controller)request.current=null;
   if(!controller.signal.aborted)setBusy(false);
  }
 }
 function sendMessage(text:string){
  const clean=text.trim(); if(!clean)return;
  const continuing=screenRef.current==='chat';
  clearTimers();
  const conversationId=(!continuing||!currentId)?crypto.randomUUID():currentId;
  if(conversationId!==currentId)setCurrentId(conversationId);
  showScreen('chat');setDraft('');setAttachment('');setBusy(true);
  const history:Message[]=[...(continuing?messagesRef.current:[]),{role:'user' as const,text:clean}];
  setMessages(history);
  void runStream(history,conversationId);
 }
 function submit(){if(busy)return;if(draft.trim())sendMessage(draft);else startVoice()}
 useEffect(()=>{
  try{setConversations(parseHistory(localStorage.getItem(HISTORY_KEY)))}catch{setStorageNotice('History is available for this session only.')}
  setHistoryReady(true);
  function back(){
   clearTimers();setBusy(false);setHistoryOpen(false);
   const path=window.location.pathname;
   setScreen(path.endsWith('/cli')?'cli':path.endsWith('/login')?'login':'home');
  }
  window.addEventListener('popstate',back);
  return()=>window.removeEventListener('popstate',back);
 },[]);
 useEffect(()=>{
  if(historyReady&&currentId&&messages.length)setConversations(previous=>saveConversation(previous,currentId,messages,Date.now()));
 },[messages,currentId,historyReady]);
 useEffect(()=>{
  if(!historyReady)return;
  try{localStorage.setItem(HISTORY_KEY,JSON.stringify(conversations))}catch{setStorageNotice('Browser storage is full or unavailable. New history stays in this session.')}
 },[conversations,historyReady]);
 useEffect(()=>{
  void getSession().then(session=>setSignedIn(Boolean(session)));
  return onAuthChange(session=>setSignedIn(Boolean(session)));
 },[]);
 useEffect(()=>{
  let live=true;
  void listModels().then(list=>{
   if(!live)return;
   setModels(list);
   // Keep the user's choice if it survived; otherwise let the gateway route.
   setModel(current=>list.some(m=>m.id===current)?current:'');
  });
  return()=>{live=false};
 },[signedIn]);
 useEffect(()=>{
  const query=window.matchMedia('(prefers-reduced-motion: reduce)');
  const update=()=>setReduceMotion(query.matches);update();query.addEventListener('change',update);
  return()=>{query.removeEventListener('change',update);clearTimers()}
 },[]);
 useEffect(()=>{
  if(screen==='voice'||screen==='chat')closeButton.current?.focus({preventScroll:true});
 },[screen]);
 useEffect(()=>{
  function key(event:KeyboardEvent){if(event.key==='Escape'&&!event.defaultPrevented&&!historyOpen&&(screenRef.current==='voice'||screenRef.current==='chat'))goHome()}
  window.addEventListener('keydown',key);
  return()=>window.removeEventListener('keydown',key)
 },[screen,historyOpen]);
 useEffect(()=>{scrollRegion.current?.scrollTo({top:scrollRegion.current.scrollHeight,behavior:reduceMotion?'instant':'smooth'})},[messages,busy,reduceMotion]);

 return <div className={'viewport-frame view-'+view}><main className="stage"><div className="device"><div className={'surface '+screen}>
 <p className="sr-only">Aira workspace. Chat and voice are answered by a live model; the voice screen listens to your microphone while it is open.</p>
 <div className="status-bar" aria-hidden="true"><span>9:41</span><div className="island"/><div className="status-icons"><Signal/><Wifi/><BatteryFull/></div></div>
 <input ref={fileInput} className="sr-only" type="file" tabIndex={-1} onChange={event=>{setAttachment(event.target.files?.[0]?.name??'');event.target.value=''}}/>
 <header className={'home-header app-header '+(screen!=='home'?'in-session':'')}>
 <Sheet open={historyOpen} onOpenChange={setHistoryOpen}><SheetTrigger className="history-trigger glass" aria-label="Open chat history"><span className="menu-glyph" aria-hidden="true"><i/><i/><i/></span></SheetTrigger>
 <SheetContent side="left" className={"history-sheet "+(view==="mobile"?"mobile-sheet":"")}>
  <SheetHeader><span className="brand-wordmark">Aira <span className="brand-byline">by AskDeepakAI</span></span><SheetTitle>Your workspace</SheetTitle><SheetDescription>Pick up a conversation or start something new.</SheetDescription></SheetHeader>
  <Tabs defaultValue={screen==='cli'?'cli':'chat'} className="history-tabs"><TabsList aria-label="Workspace mode"><TabsTrigger value="chat"><MessageCircle/>Chat</TabsTrigger><TabsTrigger value="cli"><Terminal/>CLI</TabsTrigger></TabsList>
  <TabsContent value="chat"><button className="new-chat-button warm-button" onClick={newChat}><Plus/>New chat</button><p className="history-label">CHAT HISTORY</p><div className="history-list">{conversations.length?conversations.map(conversation=><button className={'history-item '+(currentId===conversation.id?'selected':'')} key={conversation.id} onClick={()=>openConversation(conversation)}><MessageCircle/><span><strong>{conversation.title}</strong><small>{new Date(conversation.updatedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</small></span></button>):<div className="history-empty"><MessageCircle/><p>A little space for big ideas.</p><span>Your conversations will appear here.</span></div>}</div></TabsContent>
  <TabsContent value="cli"><div className="history-cli"><Terminal/><h3>Your remote workspace.</h3><p>Explore a terminal designed for your laptop and phone.</p><button className="warm-button" onClick={openCLI}>Open CLI<Send/></button><small>Front-end demo session</small></div></TabsContent></Tabs>
  <footer className="history-footer"><p>{storageNotice||'Chat history is saved on this browser.'}</p><button className="history-account" onClick={signedIn?signOut:openLogin}>{signedIn?<LogOut/>:<LogIn/>}{signedIn?'Sign out':'Log in'}<span>Demo</span></button></footer>
 </SheetContent></Sheet>
 <button className="brand-home" onClick={goHome} aria-label="Aira by AskDeepakAI home"><span className="brand-wordmark">Aira <span className="brand-byline">by AskDeepakAI</span></span><small>{screen==='cli'?'Remote workspace':screen==='login'?'Your next chapter starts here':'Your AI workspace'}</small></button>
 <div className="app-header-actions">{screen!=='login'&&<><button className={'header-cli '+(screen==='cli'?'active':'')} onClick={screen==='cli'?goHome:openCLI}>{screen==='cli'?<MessageCircle/>:<Terminal/>}<span>{screen==='cli'?'Chat':'CLI'}</span></button><button className="account-button glass" onClick={signedIn?signOut:openLogin} aria-label={signedIn?'Sign out':'Log in'}>{signedIn?<LogOut/>:<LogIn/>}<span>{signedIn?'Sign out':'Log in'}</span></button></>}</div>
 </header>
 {screen==='login'?<Login onComplete={completeLogin} onBack={goHome} reduceMotion={reduceMotion}/>:screen==='cli'?<AgentPanel/>:
 screen==='home'?<div className="screen-content" key="home">
 <section className="home-content"><h1>What are we<br/>building today?</h1><div className="suggestions" aria-label="Prompt suggestions">{SUGGESTIONS.map(text=><button className="suggestion" key={text} onClick={()=>{setDraft(text);textarea.current?.focus()}}><Sparkles/><span>{text}</span></button>)}</div></section>
 <form className="home-composer" onSubmit={event=>{event.preventDefault();submit()}}>
 <textarea ref={textarea} aria-label="Ask AI a question or describe your idea" placeholder="Ask AI a question or describe your idea" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit()}}}/>
 {attachment&&<div className="attachment"><Paperclip/><span>{attachment}</span><button type="button" aria-label="Remove attachment" onClick={()=>setAttachment('')}><X/></button></div>}
 <div className="composer-actions"><button type="button" className="glass icon-button" aria-label="Attach local file" onClick={()=>fileInput.current?.click()}><Paperclip/></button><Select value={model} onValueChange={value=>setModel(String(value))}><SelectTrigger className="model-picker" aria-label="Model"><SelectValue>{(value:unknown)=>models.find(m=>m.id===value)?.label??(models.length?'Auto':'Model')}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">Auto</SelectItem>{models.map(m=><SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}</SelectContent></Select><button className="mic-button" type="submit" aria-label={draft.trim()?'Send message':'Start voice demo'}>{draft.trim()?<Send/>:<Mic/>}</button></div></form>
 <aside className="desktop-intro"><button className="desktop-orb-button" onClick={startVoice} aria-label="Start a voice conversation with Aira">{reduceMotion?<img src="/assets/orb.jpg" alt=""/>:<video ref={heroVideo} src="/assets/orb.mp4" poster="/assets/orb.jpg" autoPlay loop muted playsInline aria-hidden="true"/>}</button><span className="desktop-orb-caption">Meet Aira</span><h2>A thought away.</h2><p>Speak your next idea into life.</p><button className="desktop-voice-link" onClick={startVoice}><Mic/>Start a conversation<span aria-hidden="true">↗</span></button></aside>
 </div>:<>
 <button ref={closeButton} className="close-chat glass" onClick={goHome}><X/>{screen==='voice'?'Close conversation':'Close chat'}</button>
 {screen==='voice'?<VoiceScreen reduceMotion={reduceMotion}/>:<section className="chat-screen screen-content" key="chat" aria-label="Chat demo">
 <div className="messages" ref={scrollRegion} role="log" aria-live="polite" aria-relevant="additions text">{messages.map((message,index)=><div key={index} className={'message-row '+message.role}>{message.role==='assistant'&&<img src="/assets/orb.jpg" className="avatar" alt="Aira"/>}{message.role==="assistant"?<div className="message-bubble"><Markdown>{message.text}</Markdown></div>:<p className="message-bubble">{message.text}</p>}</div>)}{busy&&<p className="working-status">Aira is thinking…</p>}</div>
 <form className="chat-composer" onSubmit={e=>{e.preventDefault();submit()}}>{attachment&&<div className="attachment"><span>{attachment}</span><button type="button" aria-label="Remove attachment" onClick={()=>setAttachment('')}><X/></button></div>}<div className="chat-input-row"><button className="chat-icon" type="button" aria-label="Attach local file" onClick={()=>fileInput.current?.click()}><Paperclip/></button><input aria-label="Ask AI a question" placeholder="Ask AI a question" value={draft} onChange={e=>setDraft(e.target.value)}/><button className="chat-icon" type="submit" disabled={busy} aria-label={draft.trim()?'Send message':'Start voice demo'}>{draft.trim()?<Send/>:<Mic/>}</button></div></form>
 </section>}
 </>}
 <div className="home-indicator" aria-hidden="true"/>
 </div></div></main></div>
}



