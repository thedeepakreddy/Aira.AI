/**
 * Transcribing on this machine instead of the vendor's.
 *
 * The voice screen's recogniser is the browser's, which on most engines sends
 * audio to the vendor's service. This is the desktop alternative: record here,
 * transcribe with whisper.cpp locally, and nothing leaves.
 *
 * It is an addition, not a replacement. Whisper may not be installed, the
 * weights may not be downloaded, and the service may fail to start — all normal
 * states, all of which fall back to the platform recogniser. A voice screen
 * that refuses to listen is not a privacy feature.
 *
 * The trade worth knowing: this transcribes an utterance after it ends, where
 * the browser's recogniser streams words as you speak. Accuracy and privacy for
 * interim results. The screen shows "listening" throughout either way, so what
 * the user loses is the words appearing early, not the sense of being heard.
 */

import { invoke, isDesktop } from './bridge.ts';

export interface LocalSpeechStatus {
  installed: boolean;
  model: string | null;
  running: boolean;
  port: number | null;
  /** What the user would do next, in their words. */
  note: string;
}

/** Whether local transcription can run right now, and what is missing if not. */
export async function localSpeechStatus(): Promise<LocalSpeechStatus | null> {
  if (!isDesktop) return null;
  try {
    return await invoke<LocalSpeechStatus>('voice_status');
  } catch {
    return null;
  }
}

export async function startLocalSpeech(): Promise<LocalSpeechStatus> {
  return invoke<LocalSpeechStatus>('voice_start');
}

export async function stopLocalSpeech(): Promise<void> {
  await invoke<void>('voice_stop').catch(() => undefined);
}

/** Fetches the weights. Slow and large, so only ever on an explicit request. */
export async function fetchSpeechModel(): Promise<string> {
  return invoke<string>('voice_fetch_model');
}

/**
 * 16 kHz mono, which is what the model wants.
 *
 * Resampling here rather than sending whatever the microphone produced: the
 * service would do it anyway, and a 48 kHz stereo recording is six times the
 * bytes across the bridge for no gain in accuracy.
 */
const SAMPLE_RATE = 16_000;

/** Minimal WAV header. The service accepts a file, and this is the simplest one. */
export function toWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: string | number, value?: string) => {
    if (typeof offset === 'string') return;
    for (let i = 0; i < (value ?? '').length; i++) view.setUint8(offset + i, (value ?? '').charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling: a sample outside [-1, 1] wraps rather than
    // clipping, which is heard as a crack rather than as loudness.
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(bytes);
}

/** Base64 for the bridge, which carries JSON rather than bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading a large array into String.fromCharCode overflows the
  // call stack somewhere above a hundred thousand samples.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The context's real rate, which a browser may not honour the request for. */
function sampleRateOf(context: AudioContext): number {
  return context.sampleRate || SAMPLE_RATE;
}

export async function transcribeLocally(port: number, samples: Float32Array): Promise<string> {
  return invoke<string>('voice_transcribe', { port, audio: toBase64(toWav(samples)) });
}

/**
 * How quiet, and for how long, counts as "they have finished".
 *
 * Energy rather than a speech model: a proper voice-activity detector is better
 * at telling breath from speech, and this only has to tell speech from a room.
 * The threshold is well under conversational level and above the noise floor of
 * a laptop microphone in a normal room.
 *
 * The wait is the part that matters. Too short and it cuts people off mid
 * sentence — a pause for thought is longer than most people expect; too long
 * and the reply feels laggy. This is at the patient end on purpose, because
 * being interrupted is worse than waiting.
 */
const SILENCE_LEVEL = 0.012;
const SILENCE_MS = 1_400;
/** Nothing ends a turn before this, so a slow start is not read as silence. */
const MIN_SPEECH_MS = 600;

/** Root mean square of a block — loudness, roughly, and cheap. */
export function level(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Decides whether a run of quiet blocks means the speaker has finished.
 *
 * Separated from the audio plumbing so the rule can be tested without a
 * microphone, which is the only way to be sure about the thing that decides
 * when to interrupt someone.
 */
export function turnEnded(quietMs: number, spokenMs: number): boolean {
  return spokenMs >= MIN_SPEECH_MS && quietMs >= SILENCE_MS;
}

/**
 * Records until told to stop, resampling to what the model wants.
 *
 * Returns a stop function that resolves with the audio — rather than taking a
 * callback — so the caller's "stop speaking" handler and its "here is what you
 * said" handler are the same piece of code.
 *
 * `onSilence` fires when the speaker appears to have finished, which is what
 * makes this a conversation rather than a walkie-talkie.
 */
export async function record(onSilence?: () => void): Promise<{ stop: () => Promise<Float32Array> }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated in favour of AudioWorklet, which needs a
  // separate module file; for a few seconds of dictation the difference is not
  // audible and the worklet's loading rules are a real cost in a bundled app.
  const node = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];

  let quietMs = 0;
  let spokenMs = 0;
  let ended = false;

  node.onaudioprocess = (event) => {
    const block = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(block);
    if (!onSilence || ended) return;
    const blockMs = (block.length / sampleRateOf(context)) * 1000;
    spokenMs += blockMs;
    quietMs = level(block) < SILENCE_LEVEL ? quietMs + blockMs : 0;
    if (turnEnded(quietMs, spokenMs)) {
      ended = true;
      onSilence();
    }
  };
  source.connect(node);
  node.connect(context.destination);

  return {
    stop: async () => {
      node.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const all = new Float32Array(total);
      let at = 0;
      for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
      return all;
    },
  };
}
