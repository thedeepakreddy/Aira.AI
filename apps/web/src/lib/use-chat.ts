import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamBuffer } from './stream-buffer.ts';
import { streamChat, type ChatMessage } from './gateway';
import { browseFor, supervisor as browserSupervisor } from './browser';
import { messageContent, type TextAttachment } from './attachments';
import { HISTORY_KEY, historyKey, parseHistory, saveConversation, type Conversation, type Message } from './workspace-state';

/** One account owns this hook for its entire lifetime; Workspace keys it by user id. */
/**
 * How many times a turn may go and look something up.
 *
 * Two. A model that has searched twice and still wants to search is not
 * converging, and every round is a real browser session and a second charge for
 * the same question.
 */
const MAX_BROWSE_ROUNDS = 2;

/**
 * Whether this caller can actually perform a browse.
 *
 * Asked rather than assumed, because the answer differs by where the app is
 * running and changes while it runs. Any failure is "no": the gateway then
 * withholds both the tool and the instruction to use it, which is the safe
 * direction — a stale answer beats an invented citation.
 */
async function browsingAvailable(): Promise<boolean> {
  try {
    const status = await browserSupervisor.status();
    return Boolean(status.python ?? status.running);
  } catch {
    return false;
  }
}

/** The task out of a tool call's arguments, whatever shape they arrived in. */
function readTask(args: string): string {
  try {
    const parsed = JSON.parse(args) as { task?: unknown };
    return typeof parsed.task === 'string' ? parsed.task : '';
  } catch {
    // A model that emitted something unparseable still meant the text.
    return args.slice(0, 500);
  }
}

export function useChat(userId: string | null) {
  const key = historyKey(userId);
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    try { return parseHistory(localStorage.getItem(key) ?? (userId ? null : localStorage.getItem(HISTORY_KEY))); }
    catch { return []; }
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** True while a browse is running, which takes tens of seconds. */
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [answeredBy, setAnsweredBy] = useState('');
  /**
   * The model that was asked first, when it could not answer and another one
   * took over. Empty on an ordinary turn — this is only worth saying when
   * what replied is not what was chosen.
   */
  const [stoodInFor, setStoodInFor] = useState('');
  const request = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  const historyRef = useRef(conversations);
  messagesRef.current = messages;
  historyRef.current = conversations;

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
  }, []);

  useEffect(() => {
    if (currentId && messages.length) setConversations(previous => saveConversation(previous, currentId, messages, Date.now()));
  }, [messages, currentId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(key, JSON.stringify(conversations)); }
      catch { setStorageNotice('Storage is unavailable or full. New history stays in this session.'); }
    }, 250);
    return () => clearTimeout(timer);
  }, [conversations, key]);

  useEffect(() => {
    const flush = () => { try { localStorage.setItem(key, JSON.stringify(historyRef.current)); } catch { /* Already surfaced during the session. */ } };
    window.addEventListener('pagehide', flush);
    return () => { request.current?.abort(); flush(); window.removeEventListener('pagehide', flush); };
  }, [key]);

  async function run(history: Message[], id: string, model: string) {
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setAnsweredBy(''); setStoodInFor('');
    try {
      // Deltas are batched to a frame. Appending per token rebuilt the whole
      // message list sixty times a second, and the cost grew with the length
      // of the answer.
      const buffer = createStreamBuffer<'reply'>(batch => {
        const delta = batch.get('reply');
        if (!delta || controller.signal.aborted || request.current !== controller) return;
        setMessages(previous => {
          const last = previous[previous.length - 1];
          if (!last || last.role !== 'assistant') return [...previous, { role: 'assistant', text: delta }];
          return previous.map((message, index) => index === previous.length - 1 ? { ...message, text: message.text + delta } : message);
        });
      });
      try {
      /*
       * The browse loop.
       *
       * A turn can end with the model asking to look something up rather than
       * answering. When that happens the browse runs here — the caller owns the
       * browser, the gateway only declares the tool — and the conversation is
       * sent again with the result appended.
       *
       * Bounded: two rounds. A model that has searched twice and still wants to
       * search is not converging, and every round is a real browser session and
       * a second charge for the same question.
       */
      const conversation: ChatMessage[] = history.map(message => ({ role: message.role, content: messageContent(message) }));
      const canBrowse = await browsingAvailable();

      for (let round = 0; round <= MAX_BROWSE_ROUNDS; round++) {
        const asked: Array<{ id: string; name: string; arguments: string }> = [];

        for await (const event of streamChat({
          messages: conversation,
          surface: 'chat', model: model || undefined, conversationId: id,
          signal: controller.signal, canBrowse,
        })) {
          if (controller.signal.aborted || request.current !== controller) return;
          if (event.type === 'start') setAnsweredBy(event.model);
          if (event.type === 'fallback') setStoodInFor(event.from);
          if (event.type === 'text') {
            buffer.push('reply', event.text);
          } else if (event.type === 'tool_call') {
            asked.push(event.call);
          } else if (event.type === 'error') {
            // The advice says whose problem it is. A billing failure that reads
            // as an Aira outage sends the only person who can fix it looking in
            // the wrong place.
            setError(event.advice ? `${event.message} ${event.advice}` : event.message);
          }
        }

        const browses = asked.filter(call => call.name === 'browse_web');
        if (!browses.length || round === MAX_BROWSE_ROUNDS) break;

        // Shown while it runs: a browse takes tens of seconds, and a chat that
        // sits silent for that long reads as broken.
        setSearching(true);
        conversation.push({ role: 'assistant', content: '', toolCalls: asked });
        for (const call of browses) {
          const task = readTask(call.arguments);
          const answer = await browseFor(task, 12, controller.signal);
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            // Attributed and delimited: this is a web page's words, and the
            // model must not read them as the user's.
            content: answer.urls.length
              ? `${answer.text}\n\nPages read: ${answer.urls.slice(0, 8).join(', ')}`
              : answer.text,
          });
        }
        setSearching(false);
        if (controller.signal.aborted || request.current !== controller) return;
      }
      } finally {
        setSearching(false);
        // The last tokens are still in the buffer when the stream ends.
        if (!controller.signal.aborted) buffer.finish(); else buffer.dispose();
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Aira could not finish this response. Please retry.');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  function send(text: string, model: string, attachment?: TextAttachment, fresh = false): boolean {
    if (request.current || (!text.trim() && !attachment)) return false;
    const id = fresh || !currentId ? crypto.randomUUID() : currentId;
    const next: Message[] = [...(fresh ? [] : messagesRef.current), { role: 'user', text: text.trim() || 'Please review the attached file.', ...(attachment ? { attachment } : {}) }];
    setCurrentId(id); setMessages(next); messagesRef.current = next;
    void run(next, id, model);
    return true;
  }

  function retry(model: string) {
    if (request.current || !currentId) return;
    const lastUser = messagesRef.current.map(message => message.role).lastIndexOf('user');
    if (lastUser < 0) return;
    const next = messagesRef.current.slice(0, lastUser + 1);
    setMessages(next); messagesRef.current = next;
    void run(next, currentId, model);
  }

  function open(conversation: Conversation) { stop(); setCurrentId(conversation.id); setMessages(conversation.messages); setError(''); setAnsweredBy(''); setStoodInFor(''); }
  function reset() { stop(); setCurrentId(null); setMessages([]); messagesRef.current = []; setError(''); setAnsweredBy(''); setStoodInFor(''); }
  function remove(id: string) { if (id === currentId) reset(); setConversations(previous => previous.filter(conversation => conversation.id !== id)); }
  return { conversations, messages, currentId, busy, searching, error, storageNotice, answeredBy, stoodInFor, send, stop, retry, open, reset, remove };
}
