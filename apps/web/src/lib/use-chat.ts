import { useCallback, useEffect, useRef, useState } from 'react';
import { createStreamBuffer } from './stream-buffer.ts';
import { streamChat } from './gateway';
import { messageContent, type TextAttachment } from './attachments';
import { HISTORY_KEY, historyKey, parseHistory, saveConversation, type Conversation, type Message } from './workspace-state';

/** One account owns this hook for its entire lifetime; Workspace keys it by user id. */
export function useChat(userId: string | null) {
  const key = historyKey(userId);
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    try { return parseHistory(localStorage.getItem(key) ?? (userId ? null : localStorage.getItem(HISTORY_KEY))); }
    catch { return []; }
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageNotice, setStorageNotice] = useState('');
  const [answeredBy, setAnsweredBy] = useState('');
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
    setBusy(true); setError(''); setAnsweredBy('');
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
      for await (const event of streamChat({
        messages: history.map(message => ({ role: message.role, content: messageContent(message) })),
        surface: 'chat', model: model || undefined, conversationId: id, signal: controller.signal,
      })) {
        if (controller.signal.aborted || request.current !== controller) return;
        if (event.type === 'start') setAnsweredBy(event.model);
        if (event.type === 'text') {
          buffer.push('reply', event.text);
        } else if (event.type === 'error') {
          // The advice says whose problem it is. A billing failure that reads
          // as an Aira outage sends the only person who can fix it looking in
          // the wrong place.
          setError(event.advice ? `${event.message} ${event.advice}` : event.message);
        }
      }
      } finally {
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

  function open(conversation: Conversation) { stop(); setCurrentId(conversation.id); setMessages(conversation.messages); setError(''); setAnsweredBy(''); }
  function reset() { stop(); setCurrentId(null); setMessages([]); messagesRef.current = []; setError(''); setAnsweredBy(''); }
  function remove(id: string) { if (id === currentId) reset(); setConversations(previous => previous.filter(conversation => conversation.id !== id)); }
  return { conversations, messages, currentId, busy, error, storageNotice, answeredBy, send, stop, retry, open, reset, remove };
}
