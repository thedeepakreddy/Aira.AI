import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Loader2, RotateCcw } from 'lucide-react';
import { streamChat, type ChatMessage } from '@/lib/gateway';
import { listen, speak, stopSpeaking, speechSupported, warmVoices, type Listener } from '@/lib/voice';
import { playOrb } from '@/lib/orb';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export default function VoiceScreen({ reduceMotion }: { reduceMotion: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const orb = useRef<HTMLVideoElement>(null);
  const controls = useRef<{ pause: () => void; resume: () => void } | null>(null);

  useEffect(() => {
    let live = true;
    let paused = false;
    let currentPhase: Phase = 'idle';
    let listener: Listener | null = null;
    let controller: AbortController | null = null;
    let cancelSpeech: (() => void) | undefined;
    const history: ChatMessage[] = [];
    const conversationId = crypto.randomUUID();
    const updatePhase = (next: Phase) => { currentPhase = next; if (live) setPhase(next); };
    const stopListening = () => { listener?.stop(); listener = null; };

    function startListening() {
      if (!live || paused) return;
      stopListening();
      updatePhase('listening');
      listener = listen({
        onPartial: text => { if (live && !paused) setHeard(text); },
        onFinal: text => { if (live && !paused && currentPhase === 'listening') void respond(text); },
        onError: message => { if (live) { stopListening(); setError(message); updatePhase('idle'); } },
      });
      if (!listener) { setError('Speech recognition is unavailable here. Use chat or open Aira in a browser with speech support.'); updatePhase('idle'); }
    }

    async function respond(said: string) {
      stopListening(); updatePhase('thinking');
      setHeard(said); setReply(''); setError('');
      const request = new AbortController(); controller = request;
      const turn: ChatMessage[] = [...history, { role: 'user', content: said }];
      let answer = '';
      let failure = false;
      try {
        for await (const event of streamChat({ messages: turn, surface: 'voice', conversationId, signal: request.signal })) {
          if (!live || paused || request.signal.aborted || controller !== request) return;
          if (event.type === 'text') { answer += event.text; setReply(answer); }
          else if (event.type === 'error') { failure = true; setError(event.message); }
        }
      } catch {
        if (!request.signal.aborted) { failure = true; setError('Aira could not answer. Tap retry to continue.'); }
      }
      if (!live || paused || request.signal.aborted || controller !== request) return;
      controller = null;
      if (failure || !answer.trim()) { if (!failure) setError('No response was received. Tap retry to continue.'); updatePhase('idle'); return; }
      history.push({ role: 'user', content: said }, { role: 'assistant', content: answer });
      if (history.length > 40) history.splice(0, history.length - 40);
      updatePhase('speaking');
      cancelSpeech = speak(answer, () => { if (live && !paused) startListening(); });
    }

    controls.current = {
      pause() {
        paused = true; stopListening(); controller?.abort(); controller = null;
        cancelSpeech?.(); stopSpeaking(); updatePhase('idle'); setMuted(true);
      },
      resume() { paused = false; setMuted(false); setError(''); startListening(); },
    };
    warmVoices();
    startListening();
    return () => { live = false; paused = true; stopListening(); controller?.abort(); cancelSpeech?.(); stopSpeaking(); controls.current = null; };
  }, []);

  useEffect(() => playOrb(orb.current, reduceMotion), [reduceMotion]);
  const status = error || (muted ? 'Paused — tap the microphone to resume' : phase === 'listening' ? 'Aira is listening…' : phase === 'thinking' ? 'Aira is thinking…' : phase === 'speaking' ? 'Aira is speaking…' : 'Ready when you are');
  const shown = phase === 'speaking' || phase === 'thinking' || (phase === 'idle' && reply) ? reply : heard;

  return <section className="voice-screen screen-content" aria-label="Voice conversation">
    <div className={'orb-wrap ' + (phase === 'speaking' ? 'is-speaking' : muted ? 'is-paused' : '')}>
      {reduceMotion ? <img className="orb-still" src="/assets/orb.jpg" alt="Aira" /> : <video ref={orb} className="orb-video" src="/assets/orb.mp4" poster="/assets/orb.jpg" loop muted playsInline preload="auto" aria-hidden="true" />}
    </div>
    <p className={'listening-status ' + (error ? 'is-error' : '')} aria-live="polite">{status}</p>
    <div className={'transcript live ' + (phase === 'speaking' || phase === 'thinking' ? 'from-aira' : '')}>{shown || (phase === 'listening' && !muted ? 'Say something…' : '')}</div>
    <div className="voice-actions">
      <span className="voice-secondary voice-phase" aria-hidden="true">{phase === 'thinking' ? <Loader2 className="spin" /> : null}</span>
      <div className="mic-orbit"><button className="mic-button voice-mic" onClick={() => muted ? controls.current?.resume() : controls.current?.pause()} aria-label={muted ? 'Resume the conversation' : 'Pause the conversation'} aria-pressed={!muted}>{muted ? <MicOff /> : <Mic />}</button></div>
      {error && speechSupported.listening ? <button className="voice-secondary" aria-label="Retry voice recognition" onClick={() => controls.current?.resume()}><RotateCcw /></button> : <span className="voice-secondary" aria-hidden="true" />}
      <small className="voice-privacy">Speech is handled by your browser or operating system. Its speech service may process audio online.</small>
    </div>
  </section>;
}
