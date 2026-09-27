// PCM ingest windowing (P4 voice capture). The renderer streams 16 kHz mono
// Int16 chunks (~100 ms / 3200 bytes, see AUDIO_FRAME_BYTES in ipc/protocol);
// this accumulator emits exact 5 s transcription windows, keeps the remainder,
// and drops whole windows past the cap so a runaway mic cannot grow memory
// without bound. Window + cap mirror the live-loop STT geometry.
export const WINDOW_BYTES = 160_000;
// At most six windows are ever held; older audio is shed before emission.
const MAX_BUFFERED_BYTES = WINDOW_BYTES * 6;

/**
 * Silence gate (D1). Whisper hallucinates on ambient noise, the brain then
 * reasons about the invented text, and the assistant speaks it back — a
 * self-feeding loop. Room tone must never reach the STT provider.
 *
 * `SPEECH_GATE_DB` is deliberately identical to the renderer's barge-in
 * threshold (`apps/desktop/src/audio/vad.ts:20`) so one number describes "this
 * is speech" on both sides of the WS-4097 boundary.
 */
export const SPEECH_GATE_DB = -30;

/** RMS energy in dBFS for a 16-bit LE mono PCM window; silence floors at -100. */
export function windowRmsDb(pcm: Uint8Array): number {
  // DataView, not an Int16Array view: an odd byteLength or an odd byteOffset
  // (both reachable from arbitrary chunk boundaries) would throw on a typed
  // array view. Reading LE sample-wise tolerates both.
  const count = Math.floor(pcm.byteLength / 2);
  if (count === 0) return -100;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / count);
  if (rms <= 0) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}

/** Energy gate: true when the window is loud enough to be worth transcribing. */
export function isLoudWindow(pcm: Uint8Array, thresholdDb: number = SPEECH_GATE_DB): boolean {
  return windowRmsDb(pcm) > thresholdDb;
}

/**
 * A slice of Int16LE PCM as normalised float32, the input Silero expects.
 *
 * DataView again rather than an Int16Array view, for the same offset/length
 * tolerance. A short or out-of-range window yields fewer samples rather than
 * throwing: a malformed uplink frame must degrade, not crash the gate.
 */
export function bytesToFloat32(pcm: Uint8Array, byteOffset: number, samples: number): Float32Array {
  const out = new Float32Array(samples);
  const start = Math.max(0, byteOffset);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples; i += 1) {
    const at = start + i * 2;
    if (at + 2 > pcm.byteLength) break;
    out[i] = view.getInt16(at, true) / 32768;
  }
  return out;
}

// Integer compare helper kept explicit so the windowing math stays reviewable.
function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export class AudioIngest {
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private dropped = 0;

  /** Bytes currently held awaiting a full window. */
  get bufferedBytes(): number {
    return this.buffered.byteLength;
  }

  /** Whole windows discarded by the overflow cap (backpressure signal). */
  get droppedWindows(): number {
    return this.dropped;
  }

  /** Append a chunk; returns zero or more complete 5 s windows. */
  push(chunk: Uint8Array<ArrayBufferLike>): Array<Uint8Array<ArrayBufferLike>> {
    if (chunk.byteLength === 0) return [];
    this.buffered = concat(this.buffered, chunk);
    // Shed oldest whole windows while over the cap — never partial frames.
    while (this.buffered.byteLength > MAX_BUFFERED_BYTES) {
      this.buffered = this.buffered.subarray(WINDOW_BYTES);
      this.dropped += 1;
    }
    const out: Array<Uint8Array<ArrayBufferLike>> = [];
    while (this.buffered.byteLength >= WINDOW_BYTES) {
      out.push(this.buffered.subarray(0, WINDOW_BYTES));
      this.buffered = this.buffered.subarray(WINDOW_BYTES);
    }
    return out;
  }

  /** Discard buffered audio (session switch, mute, shutdown). */
  reset(): void {
    this.buffered = new Uint8Array(0);
  }
}