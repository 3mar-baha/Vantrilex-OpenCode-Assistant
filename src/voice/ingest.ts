// PCM ingest windowing (P4 voice capture). The renderer streams 16 kHz mono
// Int16 chunks (~100 ms / 3200 bytes, see AUDIO_FRAME_BYTES in ipc/protocol);
// this accumulator emits exact 5 s transcription windows, keeps the remainder,
// and drops whole windows past the cap so a runaway mic cannot grow memory
// without bound. Window + cap mirror the live-loop STT geometry.
export const WINDOW_BYTES = 160_000;
// At most six windows are ever held; older audio is shed before emission.
export const MAX_BUFFERED_BYTES = WINDOW_BYTES * 6;

/**
 * M3 B.3 — backpressure watermarks, reported as EDGES through `onWatermark`.
 *
 * The accumulator is transport-blind: it never learns what a shell did with a
 * pause, and it must not. All it can report is "I am accumulating faster than
 * anyone is draining me", which is the only fact a sender can act on.
 *
 * Two thresholds, deliberately far apart (8x). A single threshold re-announces
 * on every chunk while the level sits at the boundary, so a stream hovering
 * there drops and resumes in lockstep with the accumulator — a pause/resume
 * storm on the one channel that was already congested. Hysteresis means the
 * level has to genuinely recover (drain 224 KiB, ~7 s of audio) before the
 * resume is announced.
 *
 * The ordering is the safety property, and it is arithmetic rather than
 * intent: PAUSE (256 KiB) is announced at 27% of the shed cap (937.5 KiB), so
 * the audio a paused stream would have buffered anyway — frames already on the
 * wire when the pause is written — is absorbed by 704 KiB of headroom instead
 * of being discarded at the daemon, where nothing would report it.
 *
 * REACHABILITY, measured rather than assumed: **this watermark cannot fire on
 * the live path today, and saying otherwise would be the `layaReady: true`
 * defect in a new place.** `push()` emits every whole window synchronously, so
 * the accumulator self-drains; `MAX_AUDIO_BYTES` (64 KiB) caps a single push;
 * and the shell sends `AUDIO_FRAME_BYTES` (3,200 B) per 100 ms. The transient
 * ceiling is therefore `(WINDOW_BYTES - 1) + MAX_AUDIO_BYTES` = 225,535 B —
 * 36,609 B short of PAUSE_BYTES. A burst probe at both the 3,200 B and 65,536 B
 * chunk sizes produced zero `pause` events.
 *
 * The adjacent worry is bounded too, and by arithmetic rather than by a cap:
 * `ui.onAudio` is fire-and-forget, so `pushChunk` calls CAN overlap, but a
 * window is only produced once per `WINDOW_BYTES / 32 KB·s⁻¹` = 5.0 s of audio,
 * and STT's hard ceiling is 15 s — so at most 3 can be in flight, ~469 KiB. The
 * watermark is a bound on a future sender that batches, or a future change that
 * makes the emit path asynchronous. It is not a fix for a live fault, because
 * there is not one.
 */
export const PAUSE_BYTES = 256 * 1024;
export const RESUME_BYTES = 32 * 1024;

/** Edge-triggered watermark transition. See `PAUSE_BYTES`. */
export type WatermarkState = 'pause' | 'resume';

export interface AudioIngestOptions {
  /**
   * Fires ONCE per transition, never on level: 'pause' when the buffer first
   * reaches `PAUSE_BYTES`, 'resume' when it next falls back to `RESUME_BYTES`.
   * Absent means the accumulator reports nothing and behaves exactly as before.
   */
  readonly onWatermark?: (state: WatermarkState) => void;
}

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
  /**
   * Latched, not derived. The edge is the event, so the state has to survive the
   * level dipping back and re-crossing — without the latch every chunk above
   * PAUSE_BYTES would re-announce a pause the shell has already applied.
   */
  private paused = false;
  private readonly onWatermark: ((state: WatermarkState) => void) | undefined;

  constructor(options: AudioIngestOptions = {}) {
    this.onWatermark = options.onWatermark;
  }

  /** Bytes currently held awaiting a full window. */
  get bufferedBytes(): number {
    return this.buffered.byteLength;
  }

  /** Whole windows discarded by the overflow cap (backpressure signal). */
  get droppedWindows(): number {
    return this.dropped;
  }

  /**
   * Report a watermark TRANSITION, if this mutation caused one. Called after
   * EVERY mutation of the buffer, not once at the end of `push`: the emit loop
   * drains in 160 KB steps, so the level can cross a watermark in the middle of
   * a burst and be back below it by the time `push` returns. Evaluating only at
   * the exit would miss both the up-edge and the down-edge of such a burst.
   */
  private evaluateWatermark(): void {
    const level = this.buffered.byteLength;
    if (!this.paused) {
      if (level < PAUSE_BYTES) return;
      this.paused = true;
      this.announce('pause');
      return;
    }
    if (level > RESUME_BYTES) return;
    this.paused = false;
    this.announce('resume');
  }

  /**
   * The latch is set BEFORE this runs, so a throw from the callback would leave
   * the accumulator believing it announced something it never did — the same
   * half-applied state the deadlock rules exist to prevent, one layer down. The
   * callback runs re-entrantly from the synchronous half of `pushChunk` (it
   * reaches `ui.flow()` -> `JSON.stringify` -> a socket write), so it is
   * user-supplied code on this class's hot path and earns the guard.
   *
   * Swallowed, not rethrown: this class has no logger and no error channel, and
   * a watermark that cannot be delivered must not take the audio path with it.
   * The failure is not silent in effect — a missed pause is recovered by the
   * next transition, and the shed cap still bounds the buffer either way.
   * (Peer review.)
   */
  private announce(state: WatermarkState): void {
    try {
      this.onWatermark?.(state);
    } catch {
      // best-effort, see above
    }
  }

  /** Append a chunk; returns zero or more complete 5 s windows. */
  push(chunk: Uint8Array<ArrayBufferLike>): Array<Uint8Array<ArrayBufferLike>> {
    if (chunk.byteLength === 0) return [];
    this.buffered = concat(this.buffered, chunk);
    this.evaluateWatermark();
    // Shed oldest whole windows while over the cap — never partial frames.
    while (this.buffered.byteLength > MAX_BUFFERED_BYTES) {
      this.buffered = this.buffered.subarray(WINDOW_BYTES);
      this.dropped += 1;
      this.evaluateWatermark();
    }
    const out: Array<Uint8Array<ArrayBufferLike>> = [];
    while (this.buffered.byteLength >= WINDOW_BYTES) {
      out.push(this.buffered.subarray(0, WINDOW_BYTES));
      this.buffered = this.buffered.subarray(WINDOW_BYTES);
      this.evaluateWatermark();
    }
    return out;
  }

  /** Discard buffered audio (session switch, mute, shutdown). */
  reset(): void {
    this.buffered = new Uint8Array(0);
    // DEADLOCK RULE — the reason this item is the riskiest in M3.
    //
    // `reset` runs from `AudioPipeline.cancel()` (barge-in, session switch) and
    // from mute. It empties the buffer, and an empty buffer is below RESUME_BYTES,
    // so `evaluateWatermark` clears the latch here. It has to: an accumulator left
    // `paused` while holding zero bytes can never produce another up-edge, and
    // because the shell is now dropping its uplink, no bytes arrive to produce the
    // down-edge either. Both halves are stuck — the daemon never resumes the
    // sender and the sender never sends — and nothing in the system can recover,
    // for the rest of the session.
    //
    // This is also why the reset emits the matching 'resume': the transition is
    // real, the accumulator is no longer holding anything, and a shell left
    // discarding audio because of a buffer that no longer exists would be
    // discarding it forever.
    this.evaluateWatermark();
  }
}