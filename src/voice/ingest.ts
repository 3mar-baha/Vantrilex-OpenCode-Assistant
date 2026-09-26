// PCM ingest windowing (P4 voice capture). The renderer streams 16 kHz mono
// Int16 chunks (~100 ms / 3200 bytes, see AUDIO_FRAME_BYTES in ipc/protocol);
// this accumulator emits exact 5 s transcription windows, keeps the remainder,
// and drops whole windows past the cap so a runaway mic cannot grow memory
// without bound. Window + cap mirror the live-loop STT geometry.
export const WINDOW_BYTES = 160_000;
// At most six windows are ever held; older audio is shed before emission.
const MAX_BUFFERED_BYTES = WINDOW_BYTES * 6;

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