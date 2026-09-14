import test from 'node:test';
import assert from 'node:assert/strict';
import { toWav, toBase64 } from '../src/lib/local-speech.ts';

const read = (wav, offset, length) =>
  String.fromCharCode(...wav.subarray(offset, offset + length));
const u32 = (wav, offset) => new DataView(wav.buffer).getUint32(offset, true);
const u16 = (wav, offset) => new DataView(wav.buffer).getUint16(offset, true);
const i16 = (wav, offset) => new DataView(wav.buffer).getInt16(offset, true);

test('the header is a WAV the service will accept', () => {
  const wav = toWav(new Float32Array([0, 0, 0, 0]));
  assert.equal(read(wav, 0, 4), 'RIFF');
  assert.equal(read(wav, 8, 4), 'WAVE');
  assert.equal(read(wav, 12, 4), 'fmt ');
  assert.equal(read(wav, 36, 4), 'data');
});

test('it is 16 kHz mono PCM, which is what the model wants', () => {
  const wav = toWav(new Float32Array(10));
  assert.equal(u16(wav, 20), 1, 'PCM');
  assert.equal(u16(wav, 22), 1, 'mono');
  assert.equal(u32(wav, 24), 16000);
  assert.equal(u16(wav, 34), 16, 'bits per sample');
});

test('the declared sizes match the data', () => {
  const wav = toWav(new Float32Array(100));
  assert.equal(u32(wav, 40), 200, 'data chunk is two bytes a sample');
  assert.equal(u32(wav, 4), 36 + 200, 'riff size counts everything after it');
  assert.equal(wav.length, 44 + 200);
});

test('samples outside the range clip rather than wrap', () => {
  // A wrap is heard as a crack, which sounds like a fault in the microphone
  // rather than loudness in the speaker.
  const wav = toWav(new Float32Array([2, -2]));
  assert.equal(i16(wav, 44), 32767);
  assert.equal(i16(wav, 46), -32768);
});

test('silence encodes as silence', () => {
  const wav = toWav(new Float32Array([0, 0]));
  assert.equal(i16(wav, 44), 0);
  assert.equal(i16(wav, 46), 0);
});

test('a long recording encodes without blowing the stack', () => {
  // Spreading a large array into String.fromCharCode overflows somewhere above
  // a hundred thousand samples, which is about six seconds of speech.
  const long = toWav(new Float32Array(400_000));
  const encoded = toBase64(long);
  assert.ok(encoded.length > 100_000);
  assert.doesNotThrow(() => atob(encoded.slice(0, 1000)));
});

test('base64 round-trips the bytes exactly', () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const back = Uint8Array.from(atob(toBase64(bytes)), c => c.charCodeAt(0));
  assert.deepEqual([...back], [...bytes]);
});

import { level, turnEnded } from '../src/lib/local-speech.ts';

test('loudness tells a room from a voice', () => {
  assert.equal(level(new Float32Array(100)), 0, 'silence is zero');
  const quiet = level(new Float32Array(100).fill(0.002));
  const speech = level(new Float32Array(100).fill(0.25));
  assert.ok(quiet < 0.012, 'a quiet room is under the threshold');
  assert.ok(speech > 0.012, 'a voice is over it');
});

test('a pause for thought does not end the turn', () => {
  // Being interrupted mid-sentence is worse than waiting, so the wait is at the
  // patient end deliberately.
  assert.equal(turnEnded(900, 3000), false, 'a second of quiet is a pause');
  assert.equal(turnEnded(1500, 3000), true, 'a second and a half is a finish');
});

test('a turn cannot end before it has begun', () => {
  // Otherwise a slow start reads as silence and the turn ends on nothing.
  assert.equal(turnEnded(5000, 200), false);
  assert.equal(turnEnded(5000, 700), true);
});

import { deniedMessage } from '../src/lib/voice.ts';

test('a refused microphone says where to turn it back on', () => {
  // The OS prompt appears once. After that the refusal is silent, and a user
  // left with "Aira cannot hear you" has no reason to guess at System Settings.
  const mac = deniedMessage('MacIntel');
  assert.match(mac, /System Settings/);
  assert.match(mac, /Microphone/);
  assert.match(deniedMessage('Win32'), /Settings/);
});

test('an unknown platform still gets somewhere to go', () => {
  assert.match(deniedMessage('Linux x86_64'), /privacy settings/i);
});
