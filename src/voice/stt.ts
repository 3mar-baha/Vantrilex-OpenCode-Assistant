import Groq from 'groq-sdk';
import { nowIso } from '../common/brands.js';

// STT engine — docs/18 §18.2, docs/06 §6.4. 16kHz mono 16-bit PCM chunked into
// 5.0 s windows with 0.5 s overlap; Groq Whisper `whisper-large-v3-turbo`.
// The Whisper client is injectable so tests run with zero network.
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const CHUNK_MS = 5000;
export const OVERLAP_MS = 500;
export const CHUNK_BYTES = ((SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000);
export const OVERLAP_BYTES = ((SAMPLE_RATE * BYTES_PER_SAMPLE * OVERLAP_MS) / 1000);

export interface AudioChunk {
  readonly index: number;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly bytes: Uint8Array;
}

export interface Transcript {
  readonly text: string;
  readonly chunkCount: number;
  readonly roundTripMs: number;
  /**
   * Whisper's own "this was not speech" confidence, averaged across segments
   * (`verbose_json` already returns it — we were discarding it). Absent means
   * the provider did not report it, which is NOT the same as zero.
   */
  readonly noSpeechProb?: number;
}

/** One `verbose_json` segment, as far as the gate cares. */
export interface WhisperSegment {
  readonly no_speech_prob?: unknown;
}

/**
 * Mean of the well-formed `no_speech_prob` values. Undefined when nothing
 * usable was reported — callers must treat undefined as "unknown", never 0,
 * because 0 means "maximally confident speech" and would defeat the gate.
 */
export function meanNoSpeechProb(segments: Array<WhisperSegment | undefined> | undefined): number | undefined {
  if (!Array.isArray(segments) || segments.length === 0) return undefined;
  const values: number[] = [];
  for (const seg of segments) {
    const v = seg?.no_speech_prob;
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function chunkPcm(pcm: Uint8Array, startsAtMs = 0): AudioChunk[] {
  const chunks: AudioChunk[] = [];
  if (pcm.byteLength === 0) return chunks;
  const step = CHUNK_BYTES - OVERLAP_BYTES;
  let offset = 0;
  let index = 0;
  while (offset < pcm.byteLength) {
    const end = Math.min(offset + CHUNK_BYTES, pcm.byteLength);
    const slice = pcm.slice(offset, end);
    const startMs = startsAtMs + Math.floor((offset / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000);
    chunks.push({
      index,
      startsAtMs: startMs,
      endsAtMs: startMs + Math.floor((slice.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000),
      bytes: slice,
    });
    if (end >= pcm.byteLength) break;
    offset += step;
    index += 1;
  }
  return chunks;
}

export interface WhisperClient {
  transcribe(chunk: AudioChunk): Promise<WhisperResult | string>;
}

export interface WhisperResult {
  readonly text: string;
  readonly noSpeechProb?: number;
}

export class GroqWhisperClient implements WhisperClient {
  private readonly client: Groq;

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey });
  }

  async transcribe(chunk: AudioChunk): Promise<WhisperResult> {
    const wav = pcmToWav(chunk.bytes);
    const file = new File([Buffer.from(wav)], `chunk-${chunk.index}.wav`, { type: 'audio/wav' });
    const res = await this.client.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      language: 'ar',
      response_format: 'verbose_json',
    });
    const segments = (res as { segments?: unknown }).segments as WhisperSegment[] | undefined;
    const noSpeechProb = meanNoSpeechProb(segments);
    // exactOptionalPropertyTypes: omit the key rather than assign undefined.
    return noSpeechProb === undefined ? { text: res.text } : { text: res.text, noSpeechProb };
  }
}

function pcmToWav(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** Hard abort for one transcription window. */
export const STT_TIMEOUT_MS = 15_000;

/**
 * Distinguishable from a provider 4xx/5xx so the daemon can say "we gave up"
 * instead of "Groq refused", and so a key-rotation path is not triggered by a
 * slow network.
 */
export class SttTimeoutError extends Error {
  constructor(ms: number) {
    super(`STT request timed out after ${ms}ms`);
    this.name = 'SttTimeoutError';
  }
}

export interface TranscribeOptions {
  readonly timeoutMs?: number;
}

/**
 * Transcribe a window with a hard bound.
 *
 * D5: this had no timeout at all. `AudioPipeline.pushChunk` awaits windows
 * serially, so a single hung Whisper request stopped every later window from
 * being processed and left the HUD in `thinking` forever.
 *
 * The bound is enforced by racing, not by handing the SDK an abort signal: the
 * guarantee we want is "this call returns within `timeoutMs`", and that has to
 * hold even if the client ignores cancellation.
 */
export async function transcribeStream(
  pcm: Uint8Array,
  client: WhisperClient,
  startedAt: string = nowIso(),
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const timeoutMs = options.timeoutMs ?? STT_TIMEOUT_MS;
  const chunks = chunkPcm(pcm);
  const texts: string[] = [];
  const probs: number[] = [];
  for (const chunk of chunks) {
    const res = await withTimeout(client.transcribe(chunk), timeoutMs);
    if (typeof res === 'string') {
      texts.push(res);
      continue;
    }
    texts.push(res.text);
    if (res.noSpeechProb !== undefined) probs.push(res.noSpeechProb);
  }
  const text = texts.map((t) => t.trim()).filter((t) => t.length > 0).join(' ');
  // Max, not mean: one chunk Whisper is sure was noise taints the window, and
  // a window is only transcribed when the caller decides it is worth one call.
  const noSpeechProb = probs.length === 0 ? undefined : Math.max(...probs);
  return {
    text,
    chunkCount: chunks.length,
    roundTripMs: Date.parse(nowIso()) - Date.parse(startedAt),
    ...(noSpeechProb === undefined ? {} : { noSpeechProb }),
  };
}

/** Reject with `SttTimeoutError` if `work` has not settled within `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SttTimeoutError(ms)), ms);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
