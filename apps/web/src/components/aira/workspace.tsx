import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Paperclip, Sparkles, X, Send, Square, MessageCircle, Plus, Terminal, LogIn, LogOut, Bot, Globe, Settings2, Trash2, RotateCcw, Loader2 } from 'lucide-react';
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription, SheetHeader } from '@/components/ui/sheet';
import ModelPicker from './model-picker';
import { listModels, type ModelSpec } from '@/lib/gateway';
import { getSession, onAuthChange, signOut as authSignOut } from '@/lib/supabase';
import { playOrb } from '@/lib/orb';
import { parseRoute, screenPath, type Screen, type View } from '@/lib/routes';
import { readTextAttachment, TEXT_FILE_ACCEPT, type TextAttachment } from '@/lib/attachments';
import { useChat } from '@/lib/use-chat';
const AgentPanel = lazy(() => import('./agent-panel'));
const TaskPanel = lazy(() => import('./task-panel'));
const BrowserPanel = lazy(() => import('./browser-panel'));
const ConnectionsPanel = lazy(() => import('./connections-panel'));
const Login = lazy(() => import('./login'));
const VoiceScreen = lazy(() => import('./voice-screen'));
const Markdown = lazy(() => import('./markdown'));
export type { Screen } from '@/lib/routes';

const SUGGESTIONS = ['Build something useful', 'Research a new idea', 'Review my code'];
const NAVIGATION = [
  { screen: 'home', label: 'Chat', icon: MessageCircle },
  { screen: 'browse', label: 'Browser', icon: Globe },
  { screen: 'cli', label: 'Code', icon: Terminal },
  { screen: 'tasks', label: 'Agents', icon: Bot },
  { screen: 'connections', label: 'Workspace', icon: Settings2 },
] as const;
const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export default function Workspace({ view = 'auto', initialScreen = 'home' }: { view?: View; initialScreen?: Screen }) {
  const [identity, setIdentity] = useState<{ ready: boolean; id: string | null; error?: string }>({ ready: false, id: null });
  useEffect(() => {
    let live = true;
    let changed = false;
    let currentId: string | null | undefined;
    let generation = 0;
    const acceptIdentity = (id: string | null) => {
      if (!live || currentId === id) return;
      const initial = currentId === undefined;
      currentId = id;
      const request = ++generation;
      if (initial || !isDesktop) { setIdentity({ ready: true, id }); return; }
      // Do not let the next account adopt the prior account's active process
      // or event stream while its panel cleanup is still awaiting native IPC.
      setIdentity({ ready: false, id });
      void import('@tauri-apps/api/core').then(async ({ invoke }) => {
        const results = await Promise.allSettled(['opencode_stop', 'openclaw_stop', 'browser_stop'].map(command => invoke(command)));
        if (results.some(result => result.status === 'rejected')) throw new Error('Could not stop all local tools. Close and reopen Aira before continuing with another account.');
        if (live && request === generation) setIdentity({ ready: true, id });
      }).catch(() => {
        if (live && request === generation) setIdentity({ ready: false, id, error: 'Could not stop all local tools. Close and reopen Aira before continuing with another account.' });
      });
    };
    const off = onAuthChange(session => { changed = true; acceptIdentity(session?.user.id ?? null); });
    void getSession().then(session => { if (!changed) acceptIdentity(session?.user.id ?? null); })
      .catch(() => { if (!changed) acceptIdentity(null); });
    return () => { live = false; generation++; off(); };
  }, []);
  if (identity.error) return <main className="app-recovery" role="alert"><h1>Local tools need to close.</h1><p>{identity.error}</p></main>;
  if (!identity.ready) return <div className="app-loading" role="status"><Loader2 className="spin" />Opening Aira…</div>;
  return <WorkspaceContent key={identity.id ?? 'local'} view={view} initialScreen={initialScreen} userId={identity.id} />;
}

function WorkspaceContent({ view, initialScreen, userId }: { view: View; initialScreen: Screen; userId: string | null }) {
  const [screen, setScreen] = useState<Screen>(() => parseRoute(window.location.pathname).screen || initialScreen);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [visited, setVisited] = useState<Set<Screen>>(() => new Set([screen]));
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<TextAttachment>();
  const [filePending, setFilePending] = useState(false);
  const [notice, setNotice] = useState('');
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [model, setModel] = useState('');
  const [reduceMotion, setReduceMotion] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const heroVideo = useRef<HTMLVideoElement>(null);
  const fileRead = useRef(0);
  const chat = useChat(userId);
  const signedIn = Boolean(userId);

  const showScreen = useCallback((next: Screen) => {
    setScreen(next);
    setVisited(previous => new Set([...previous, next]));
    setHistoryOpen(false);
    setNotice('');
    const path = screenPath(view, next);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  }, [view]);

  function newChat() { chat.reset(); setDraft(''); removeAttachment(); showScreen('home'); }
  async function signOut() {
    try { await authSignOut(); chat.stop(); showScreen('login'); }
    catch { setNotice('Sign out failed. Please try again.'); }
  }

  useEffect(() => {
    const back = () => {
      const next = parseRoute(window.location.pathname).screen;
      setScreen(next); setVisited(previous => new Set([...previous, next])); setHistoryOpen(false);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);

  const refreshModels = useCallback(async () => {
    const list = await listModels();
    setModels(list);
    setModel(current => list.some(item => item.id === current) ? current : '');
  }, []);
  useEffect(() => { void refreshModels(); }, [refreshModels]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduceMotion(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => playOrb(heroVideo.current, reduceMotion), [screen, reduceMotion]);
  useEffect(() => {
    if (screen === 'chat' && stickToBottom.current) scrollRegion.current?.scrollTo({ top: scrollRegion.current.scrollHeight, behavior: reduceMotion || chat.busy ? 'instant' : 'smooth' });
  }, [chat.messages, chat.busy, reduceMotion, screen]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !historyOpen && (screen === 'voice' || screen === 'chat')) showScreen('home');
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); setHistoryOpen(open => !open); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [screen, historyOpen, showScreen]);

  async function attach(file?: File) {
    if (!file) return;
    const version = ++fileRead.current;
    setFilePending(true); setNotice('');
    try { const result = await readTextAttachment(file); if (fileRead.current === version) setAttachment(result); }
    catch (cause) { if (fileRead.current === version) setNotice(cause instanceof Error ? cause.message : 'Could not read the file.'); }
    finally { if (fileRead.current === version) setFilePending(false); }
  }
  function submit() {
    if (filePending || chat.busy) return;
    if (!draft.trim() && !attachment) { showScreen('voice'); return; }
    if (chat.send(draft, model, attachment, screen === 'home')) {
      setDraft(''); setAttachment(undefined); setNotice(''); stickToBottom.current = true; showScreen('chat');
    }
  }
  function removeAttachment() { fileRead.current++; setFilePending(false); setAttachment(undefined); }

  const fileChip = attachment && <div className="attachment"><Paperclip /><span>{attachment.name}</span><button type="button" aria-label="Remove attachment" onClick={removeAttachment}><X /></button></div>;

  return <div className={'viewport-frame view-' + view + (isDesktop ? ' native-desktop' : '')}>
    <main className="stage"><div className="device"><div className={'surface ' + screen}>
      {/* Beams from the same top-left source the ground is already lit by.
        * Mounted once here rather than per screen, so every surface is lit by
        * one light instead of each inventing its own. */}
      <div className="light-rays" aria-hidden="true" />
      <input ref={fileInput} className="sr-only" type="file" accept={TEXT_FILE_ACCEPT} tabIndex={-1} onChange={event => { void attach(event.target.files?.[0]); event.target.value = ''; }} />
      <header className={'home-header app-header ' + (screen !== 'home' ? 'in-session' : '')}>
        <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
          <SheetTrigger className="history-trigger glass" aria-label="Open workspace navigation"><span className="menu-glyph" aria-hidden="true"><i /><i /><i /></span></SheetTrigger>
          <SheetContent side="left" className={'history-sheet ' + (view === 'mobile' ? 'mobile-sheet' : '')}>
            <SheetHeader><span className="brand-wordmark">Aira <span className="brand-byline">by AskDeepakAI</span></span><SheetTitle>Your workspace</SheetTitle><SheetDescription>Your ideas, conversations, and tools.</SheetDescription></SheetHeader>
            <nav className="workspace-navigation" aria-label="Workspace">
              {NAVIGATION.map(item => <button key={item.screen} aria-current={screen === item.screen ? 'page' : undefined} onClick={() => showScreen(item.screen)}><item.icon />{item.label}</button>)}
            </nav>
            <button className="new-chat-button warm-button" onClick={newChat}><Plus />New chat</button>
            <div className="history-scroll"><p className="history-label">RECENT CONVERSATIONS</p>
              <div className="history-list">{chat.conversations.length ? chat.conversations.map(conversation =>
                <div className="history-row" key={conversation.id}>
                  <button className={'history-item ' + (chat.currentId === conversation.id ? 'selected' : '')} onClick={() => { chat.open(conversation); setDraft(''); removeAttachment(); stickToBottom.current = true; showScreen('chat'); }}><MessageCircle /><span><strong>{conversation.title}</strong><small>{new Date(conversation.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span></button>
                  <button className="history-delete" aria-label={'Delete conversation: ' + conversation.title} onClick={() => chat.remove(conversation.id)}><Trash2 /></button>
                </div>)
                : <div className="history-empty"><MessageCircle /><p>A little space for big ideas.</p><span>Your conversations will appear here.</span></div>}
              </div>
            </div>
            <footer className="history-footer"><p>{chat.storageNotice || 'History is saved for this account on this device.'}</p><button className="history-account" onClick={signedIn ? () => void signOut() : () => showScreen('login')}>{signedIn ? <LogOut /> : <LogIn />}{signedIn ? 'Sign out' : 'Log in'}<span>{isDesktop ? 'Desktop' : 'Web'}</span></button></footer>
          </SheetContent>
        </Sheet>
        <button className="brand-home" onClick={() => showScreen('home')} aria-label="Aira home"><span className="brand-wordmark">Aira <span className="brand-byline">by AskDeepakAI</span></span><small>Your AI workspace</small></button>
        <nav className="app-header-actions" aria-label="Main navigation">
          {NAVIGATION.filter(item => item.screen !== 'home').map(item => <button key={item.screen} className={'header-cli ' + (screen === item.screen ? 'active' : '')} aria-label={item.label} aria-current={screen === item.screen ? 'page' : undefined} onClick={() => showScreen(item.screen)}><item.icon /><span>{item.label}</span></button>)}
          <button className="account-button glass" onClick={signedIn ? () => void signOut() : () => showScreen('login')} aria-label={signedIn ? 'Sign out' : 'Log in'}>{signedIn ? <LogOut /> : <LogIn />}<span>{signedIn ? 'Sign out' : 'Log in'}</span></button>
        </nav>
      </header>
      {notice && <div className="workspace-notice" role="alert"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}><X /></button></div>}
      {visited.has('cli') && <div hidden={screen !== 'cli'}><Suspense fallback={<PanelLoading />}><AgentPanel /></Suspense></div>}
      {visited.has('tasks') && <div hidden={screen !== 'tasks'}><Suspense fallback={<PanelLoading />}><TaskPanel /></Suspense></div>}
      {visited.has('browse') && <div hidden={screen !== 'browse'}><Suspense fallback={<PanelLoading />}><BrowserPanel active={screen === 'browse' && !historyOpen} /></Suspense></div>}
      {screen === 'connections' && <Suspense fallback={<PanelLoading />}><ConnectionsPanel onModelsChanged={refreshModels} /></Suspense>}
      {screen === 'login' && <Suspense fallback={<PanelLoading />}><Login onComplete={() => showScreen('home')} onBack={() => showScreen('home')} reduceMotion={reduceMotion} /></Suspense>}
      {screen === 'home' && <div className="screen-content" key="home">
        <section className="home-content"><h1>What are we<br />building today?</h1><div className="suggestions" aria-label="Prompt suggestions">{SUGGESTIONS.map(text => <button className="suggestion" key={text} onClick={() => { setDraft(text); textarea.current?.focus(); }}><Sparkles /><span>{text}</span></button>)}</div></section>
        <form className="home-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
          <textarea ref={textarea} aria-label="Ask AI a question or describe your idea" placeholder="Ask AI a question or describe your idea" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
          {fileChip}
          <div className="composer-actions">
            <button type="button" className="glass icon-button" aria-label="Attach text or code file" disabled={filePending} onClick={() => fileInput.current?.click()}>{filePending ? <Loader2 className="spin" /> : <Paperclip />}</button>
            <ModelPicker models={models} value={model} onChange={setModel} disabled={chat.busy} />
            {chat.busy ? <button key="stop" className="mic-button" type="button" aria-label="Stop response" onClick={event => { event.preventDefault(); chat.stop(); }}><Square /></button>
              : <button className="mic-button" type="submit" disabled={filePending} aria-label={draft.trim() || attachment ? 'Send message' : 'Start voice conversation'}>{draft.trim() || attachment ? <Send /> : <Mic />}</button>}
          </div>
          {chat.busy && <button type="button" className="background-chat" onClick={() => showScreen('chat')}>Aira is replying · Return to chat</button>}
        </form>
        <aside className="desktop-intro"><button className="desktop-orb-button" onClick={() => showScreen('voice')} aria-label="Start a voice conversation with Aira">{reduceMotion ? <img src="/assets/orb.jpg" alt="" /> : <video ref={heroVideo} src="/assets/orb.mp4" poster="/assets/orb.jpg" autoPlay loop muted playsInline aria-hidden="true" />}</button><span className="desktop-orb-caption">Meet Aira</span><h2>A thought away.</h2><p>Speak your next idea into life.</p><button className="desktop-voice-link" onClick={() => showScreen('voice')}><Mic />Start a conversation<span aria-hidden="true">↗</span></button></aside>
      </div>}
      {(screen === 'voice' || screen === 'chat') && <button className="close-chat glass" onClick={() => showScreen('home')}><X />{screen === 'voice' ? 'Close conversation' : 'Close chat'}</button>}
      {screen === 'voice' && <Suspense fallback={<PanelLoading />}><VoiceScreen reduceMotion={reduceMotion} /></Suspense>}
      {screen === 'chat' && <section className="chat-screen screen-content" aria-label="Chat">
        <div className="messages" ref={scrollRegion} onScroll={event => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} role="log" aria-live="polite" aria-relevant="additions text">
          {!chat.messages.length && <div className="chat-empty"><MessageCircle /><h2>A new conversation.</h2><p>Ask a question or attach a text file to get started.</p></div>}
          {chat.messages.map((message, index) => <div key={index} className={'message-row ' + message.role}>
            {message.role === 'assistant' && <img src="/assets/orb.jpg" className="avatar" alt="Aira" />}
            {message.role === 'assistant' ? <div className="message-bubble"><Suspense fallback={<p>{message.text}</p>}><Markdown>{message.text}</Markdown></Suspense></div>
              : <div className="message-bubble"><p>{message.text}</p>{message.attachment && <span className="message-file"><Paperclip />{message.attachment.name}</span>}</div>}
          </div>)}
          {chat.busy && <p className="working-status" role="status">{chat.messages.at(-1)?.role === 'assistant' ? 'Aira is responding…' : 'Aira is thinking…'}</p>}
          {chat.error && <div className="chat-error" role="alert"><p>{chat.error}</p><button type="button" onClick={() => chat.retry(model)} disabled={chat.busy}><RotateCcw />Retry response</button><button type="button" onClick={() => showScreen('connections')}><Settings2 />Connections</button></div>}
        </div>
        <form className="chat-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
          {fileChip}
          <div className="chat-input-row"><button className="chat-icon" type="button" aria-label="Attach text or code file" disabled={filePending} onClick={() => fileInput.current?.click()}>{filePending ? <Loader2 className="spin" /> : <Paperclip />}</button><input aria-label="Ask AI a question" placeholder="Ask AI a question" value={draft} onChange={event => setDraft(event.target.value)} />
            {chat.busy ? <button key="stop" className="chat-icon" type="button" onClick={event => { event.preventDefault(); chat.stop(); }} aria-label="Stop response"><Square /></button> : <button key="send" className="chat-icon" type="submit" disabled={filePending} aria-label={draft.trim() || attachment ? 'Send message' : 'Start voice conversation'}>{draft.trim() || attachment ? <Send /> : <Mic />}</button>}
          </div>
          <div className="chat-composer-meta"><ModelPicker models={models} value={model} onChange={setModel} disabled={chat.busy} /><span>{chat.answeredBy ? models.find(item => item.id === chat.answeredBy)?.label ?? chat.answeredBy : 'Choose a model or let Aira route'}{chat.busy ? ' · Responding' : ''}</span></div>
        </form>
      </section>}
    </div></div></main>
  </div>;
}

function PanelLoading() { return <div className="panel-loading screen-content" role="status"><Loader2 className="spin" />Opening your workspace…</div>; }
