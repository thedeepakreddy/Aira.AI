/**
 * Speech input and output for the voice screen.
 *
 * Uses the platform's own speech engines rather than a hosted service: no audio
 * leaves the machine, there is no per-minute cost, and it works with the
 * providers Aira already has. The trade is that recognition quality and voice
 * quality are whatever the OS provides — on macOS the "Enhanced" voices are
 * close to natural, which is why they are preferred explicitly below.
 *
 * A hosted transcriber or a premium TTS would slot in behind this same
 * interface later without the screen changing.
 */

// The Web Speech API is still prefixed in most engines and is not in lib.dom,
// so the minimum surface used here is declared rather than pulling in types.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechSupported = {
  get listening() {
    return recognitionCtor() !== null;
  },
  get speaking() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  },
};

// ── listening ────────────────────────────────────────────────────────────────

export interface ListenHandlers {
  /** Fires continuously as the user speaks, for live on-screen transcript. */
  onPartial(text: string): void;
  /** Fires once the engine decides an utterance is complete. */
  onFinal(text: string): void;
  onError(message: string): void;
}

export interface Listener {
  stop(): void;
}

/**
 * Listens continuously until stopped.
 *
 * Recognition engines end a session on their own after a pause, so `onend`
 * restarts it. Without that the conversation would silently stop listening
 * after the first lull, which reads as the app having frozen.
 */
export function listen(handlers: ListenHandlers): Listener | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  let stopped = false;
  let recognition: SpeechRecognitionLike | null = null;

  const begin = () => {
    if (stopped) return;
    const r = new Ctor();
    recognition = r;
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          const final = text.trim();
          if (final) handlers.onFinal(final);
        } else {
          interim += text;
        }
      }
      if (interim.trim()) handlers.onPartial(interim.trim());
    };

    r.onerror = (event) => {
      // `no-speech` and `aborted` are ordinary in a hands-free loop — someone
      // pausing to think is not an error worth showing.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopped = true;
        handlers.onError('Aira needs microphone access to listen.');
        return;
      }
      handlers.onError(`Speech recognition failed (${event.error}).`);
    };

    // Engines stop by themselves after a pause; keep the session alive.
    r.onend = () => {
      if (!stopped) begin();
    };

    try {
      r.start();
    } catch {
      // start() throws if a session is somehow already running; ignore.
    }
  };

  begin();

  return {
    stop() {
      stopped = true;
      recognition?.abort();
      recognition = null;
    },
  };
}

// ── speaking ─────────────────────────────────────────────────────────────────

let cachedVoice: SpeechSynthesisVoice | null = null;

/**
 * Picks the most natural available voice.
 *
 * macOS ships "Enhanced" and "Premium" variants that sound markedly less
 * synthetic than the defaults, so they are preferred by name; everything else
 * falls back to the platform default.
 */
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const all = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
  if (!all.length) return null;
  cachedVoice =
    all.find((v) => /premium/i.test(v.name)) ??
    all.find((v) => /enhanced/i.test(v.name)) ??
    all.find((v) => /samantha|ava|allison|zoe/i.test(v.name)) ??
    all.find((v) => v.default) ??
    all[0];
  return cachedVoice;
}

/** Voices load asynchronously; resolve once they exist. */
export function warmVoices(): void {
  if (!speechSupported.speaking) return;
  if (speechSynthesis.getVoices().length === 0) {
    speechSynthesis.addEventListener('voiceschanged', () => pickVoice(), { once: true });
  } else {
    pickVoice();
  }
}

export function speak(text: string, onDone: () => void): () => void {
  if (!speechSupported.speaking || !text.trim()) {
    onDone();
    return () => {};
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 1.02;
  utterance.pitch = 1;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  utterance.onend = finish;
  // An error must still advance the loop, or the conversation stalls silently.
  utterance.onerror = finish;

  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);

  return () => {
    finished = true;
    speechSynthesis.cancel();
  };
}

export function stopSpeaking(): void {
  if (speechSupported.speaking) speechSynthesis.cancel();
}
