import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Loader2, RotateCcw } from 'lucide-react';
import { streamChat, type ChatMessage } from '@/lib/gateway';
import { listen, speak, stopSpeaking, speechSupported, warmVoices, type Listener } from '@/lib/voice';
import { localSpeechStatus, startLocalSpeech, stopLocalSpeech, record, transcribeLocally } from '@/lib/local-speech';
import { playOrb } from '@/lib/orb';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export default function VoiceScreen({ reduceMotion }: { reduceMotion: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  /** Whether this session is transcribing on the device. Drives the privacy line. */
  const [local, setLocal] = useState(false);
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
    /*
     * Local transcription when this machine can do it.
     *
     * Resolved once per session rather than per turn: starting the speech
     * service takes a moment, and doing it between every sentence would put
     * that moment in the middle of a conversation.
     */
    let localPort: number | null = null;
    let recorder: { stop: () => Promise<Float32Array> } | null = null;

    async function prepareLocal() {
      const status = await localSpeechStatus();
      if (!status?.installed || !status.model) return;
      try {
        const started = status.running ? status : await startLocalSpeech();
        localPort = started.port ?? null;
      } catch {
        // Whisper present but unwilling. The platform recogniser still works,
        // and a voice screen that refuses to listen is not a privacy feature.
        localPort = null;
      }
    }

    const stopListening = () => {
      listener?.stop(); listener = null;
      // A recording in flight is abandoned rather than transcribed: it was
      // interrupted, so whatever is in it is half a sentence.
      recorder?.stop().catch(() => undefined); recorder = null;
    };

    function startListening() {
      if (!live || paused) return;
      stopListening();
      updatePhase('listening');

      if (localPort !== null) {
        // Recorded here and transcribed after the turn, rather than streamed.
        // The screen still says "listening" throughout, so what is lost is
        // words appearing early — not the sense of being heard.
        void (async () => {
          try {
            recorder = await record(() => { void finishLocalTurn(); });
          } catch {
            // No microphone permission. The platform recogniser asks for it in
            // its own way, so fall through and let it try.
            localPort = null;
            startListening();
          }
        })();
        return;
      }

      listener = listen({
        onPartial: text => { if (live && !paused) setHeard(text); },
        onFinal: text => { if (live && !paused && currentPhase === 'listening') void respond(text); },
        onError: message => { if (live) { stopListening(); setError(message); updatePhase('idle'); } },
      });
      if (!listener) { setError('Speech recognition is unavailable here. Use chat or open Aira in a browser with speech support.'); updatePhase('idle'); }
    }

    /** Ends a locally-recorded turn and hands what was said to the model. */
    async function finishLocalTurn() {
      const active = recorder;
      if (!active || localPort === null) return;
      recorder = null;
      updatePhase('thinking');
      try {
        const samples = await active.stop();
        // Under a quarter second is a slip of the hand, not a sentence.
        if (samples.length < 4_000) { startListening(); return; }
        const said = await transcribeLocally(localPort, samples);
        if (!said.trim()) { startListening(); return; }
        setHeard(said);
        await respond(said);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        updatePhase('idle');
      }
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
    // Resolved before the first turn, so a session that can transcribe locally
    // does so from the start rather than switching over mid-conversation.
    void prepareLocal().then(() => {
      if (!live) return;
      setLocal(localPort !== null);
      startListening();
    });
    return () => {
      live = false; paused = true; stopListening(); controller?.abort(); cancelSpeech?.(); stopSpeaking();
      // The speech service outlives this screen otherwise, holding the weights
      // in memory for a conversation that ended.
      void stopLocalSpeech();
      controls.current = null;
    };
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
      <small className="voice-privacy">{local
        ? 'Transcribed on this device. Your voice does not leave it.'
        : 'Speech is handled by your browser or operating system. Its speech service may process audio online.'}</small>
    </div>
  </section>;
}
