// Voice activity detection for barge-in/ducking (P4b follow-up). Pure DSP:
// normalized RMS energy of an Int16 mono frame, gated against a threshold
// calibrated so room tone stays silent and voice bursts trip it. The daemon
// never sees ducked frames; barge-in frames go up immediately with an abort.

/**
 * THE speech gate, in dBFS.
 *
 * This is the same -30 the daemon compares windows against
 * (`SPEECH_GATE_DB` in `src/voice/ingest.ts`) and the same -30 the C.6
 * calibration wizard judges a room with. There are two build roots here — the
 * daemon compiles under `src/` with NodeNext, the renderer under `apps/desktop`
 * with Vite — so this constant CANNOT be imported across the boundary. It is
 * quoted, and the drift is caught by `uplink-gate.test.ts` rather than by a
 * compiler.
 *
 * It was three separate literals before this constant existed: the default
 * parameter of `isSpeechFrame`, the default parameter of `bargePolicy`, and
 * `GATE_DB` in `calibration-meter.ts`. Three copies of one number across one
 * boundary is a silent-drift generator, not a style choice.
 */
export const SPEECH_GATE_DB = -30;

/** The dBFS floor `frameEnergyDb` reports for true digital silence. */
export const SILENCE_DB = -100;

/**
 * dB span over which the wave's amplitude is mapped, below and above the gate.
 *
 * Below the gate the wave gets the bottom 40% of its range, above it the top
 * 60%. Anchoring the knee ON the gate is the point: the thread reaches 40% at
 * exactly the level at which the frame starts being transmitted, so what the
 * user sees and what the wire does are one measurement.
 */
const BELOW_GATE_SPAN_DB = 20;
const KNEE = 0.4;

/** RMS energy in dBFS (silence floors at -100). */
export function frameEnergyDb(frame: Int16Array): number {
  if (frame.length === 0) return -100;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const v = (frame[i] as number) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}

/**
 * Speech gate: amplitude 4000/32768 ≈ -18 dBFS trips at the -30 dB default.
 */
export function isSpeechFrame(frame: Int16Array, thresholdDb = SPEECH_GATE_DB): boolean {
  return frameEnergyDb(frame) > thresholdDb;
}

/**
 * A2 — dBFS to the wave's 0..1 amplitude, anchored on the shared gate.
 *
 * Deliberately NOT the `min(1, rms * 4)` the HUD used before. That scale has
 * no stated relationship to the gate: at it, normal speech (≈ -25 dBFS) rendered
 * at 0.22 of the thread's height, and a slammed door clipped to the ceiling
 * while a whole normal sentence never left the bottom fifth. The wizard
 * reported dBFS, the gate compared dBFS, and the wave drew something else —
 * three opinions about one room.
 *
 * Monotone, clamped, total, and finite on every input including NaN.
 */
export function dbToWaveEnergy(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(SILENCE_DB, Math.min(0, db));
  const below = (clamped - (SPEECH_GATE_DB - BELOW_GATE_SPAN_DB)) / BELOW_GATE_SPAN_DB;
  if (clamped <= SPEECH_GATE_DB) return Math.max(0, Math.min(KNEE, below * KNEE));
  const above = (clamped - SPEECH_GATE_DB) / BELOW_GATE_SPAN_DB;
  return Math.max(0, Math.min(1, KNEE + above * (1 - KNEE)));
}

/** View raw uplink bytes (Int16LE) as samples without copying. */
export function bytesToSamples(bytes: Uint8Array): Int16Array {
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

/**
 * Barge-in policy: what the uplink does with one frame while TTS is playing.
 */
export type BargeDecision = 'duck' | 'barge' | 'send';

export function bargePolicy(speaking: boolean, frame: Uint8Array, thresholdDb = SPEECH_GATE_DB): BargeDecision {
  if (!speaking) return 'send';
  return isSpeechFrame(bytesToSamples(frame), thresholdDb) ? 'barge' : 'duck';
}

/**
 * A1 — what the renderer does with ONE uplink frame. See `UplinkGate`.
 *
 * `send` is the only thing the caller acts on; `barge` additionally means
 * "stop playback and tell the daemon to stop speaking"; `droppedByGate` exists
 * so the HUD/test can prove the silence gate fired rather than assuming it.
 */
export interface UplinkVerdict {
  readonly send: boolean;
  readonly barge: boolean;
  readonly droppedByGate: boolean;
  /** dBFS for this frame, or null when it could not be measured. */
  readonly energyDb: number | null;
}

export interface UplinkOptions {
  /** The assistant is speaking: quiet frames are ducked, not gated. */
  readonly speaking: boolean;
  /**
   * EXPLICIT user action — press-to-talk, a held barge control, a push-to-open
   * session. Never gated and never ducked, whatever the energy says.
   */
  readonly forced?: boolean;
}

/**
 * Post-utterance frames still transmitted so the daemon can close its window.
 *
 * THE ACCUMULATION PROBLEM. `AudioIngest` (src/voice/ingest.ts) emits only
 * COMPLETE `WINDOW_BYTES` (160,000 B) windows, which is exactly 5 s of 16 kHz
 * mono Int16, and nothing on the path flushes a partial one. Gating every
 * below-gate frame would therefore starve the accumulator: a 3-second utterance
 * would put 96,000 B in a 160,000 B buffer and NEVER reach STT. One-shot voice
 * would simply stop working, which is a worse defect than the one this gate
 * exists to close.
 *
 * So the wire carries the speech and a bounded tail after it, then goes quiet.
 * Fifty 100 ms frames is one whole window; 56 gives the 5.6 s the geometry
 * needs plus a frame of margin for a frame that straddles a boundary.
 *
 * THE HONEST LIMIT, stated because it contradicts a literal reading of "no
 * bytes in silence": post-utterance room tone IS transmitted, for at most
 * 5.6 s per utterance. It is still strictly less than today, where 100% of room
 * audio is transmitted continuously — a 10-minute session with five utterances
 * goes from ~36 MB of ambient audio on the wire to ~200 KB.
 */
export const WINDOW_TAIL_FRAMES = 56;

/**
 * A1 — the LOCAL UPLINK GATE. Silence drops the frame; the mic stays open.
 *
 * NOT the B.3 backpressure watermark, and the two must never be conflated.
 * That one is daemon-driven and congestion-triggered (`hello.uplinkPaused`,
 * `flow` frames, applied inside `VoxauraBridge.sendPcm`). This one is local and
 * energy-triggered, the daemon cannot observe it, and it cannot be paused by
 * the daemon. Two different questions: "is the far end behind?" and "is anyone
 * speaking?".
 *
 * THE ORDER OF THE ARMS IS THE SAFETY PROPERTY.
 *   1. `forced`    — an explicit user action transmits. Unconditional. A gate
 *                    that can swallow a press-to-talk is a gate that has taken
 *                    the microphone away from a user who is speaking.
 *   2. undecidable — a frame whose energy cannot be measured transmits. Fail
 *                    OPEN, always: silence is the safe failure direction for a
 *                    privacy gate, because the cost of a wrong drop is a user
 *                    who is talking and is not heard, and the cost of a wrong
 *                    send is audio the user already agreed to send when they
 *                    unmuted.
 *   3. speaking    — the pre-existing duck/barge split, unchanged.
 *   4. silence     — drop, unless a tail is owed to the daemon's window.
 */
export class UplinkGate {
  /** Frames of post-utterance audio still owed to the daemon's 5 s window. */
  private tail = 0;
  private dropped = 0;
  private sent = 0;

  /** Tail budget remaining. Exposed so a test can prove the tail is bounded. */
  get burstFrames(): number {
    return this.tail;
  }

  /** Frames this gate has dropped for silence. The daemon has no such counter. */
  get droppedFrames(): number {
    return this.dropped;
  }

  /** Frames this gate has passed on (including forced and undecidable ones). */
  get sentFrames(): number {
    return this.sent;
  }

  /** Drop the tail. Called on mute, session switch and daemon restart. */
  reset(): void {
    this.tail = 0;
  }

  /**
   * `bytesToSamples` throws on an odd `byteOffset` or a length that is not a
   * whole number of samples — both reachable from a capture boundary. Measured
   * or unmeasurable, never thrown: this is on the microphone's hot path and a
   * throw here would be caught by `capture.ts` and turned into `onError`,
   * reporting a broken microphone for a buffer alignment problem.
   */
  private measure(frame: Uint8Array): number | null {
    try {
      return frameEnergyDb(bytesToSamples(frame));
    } catch {
      return null;
    }
  }

  private arm(): void {
    this.tail = WINDOW_TAIL_FRAMES;
  }

  decide(frame: Uint8Array, opts: UplinkOptions): UplinkVerdict {
    // 1. An explicit user action outranks everything below it.
    if (opts.forced === true) {
      this.sent += 1;
      return { send: true, barge: false, droppedByGate: false, energyDb: null };
    }

    // 2. Fail open on an undecidable reading.
    const energyDb = this.measure(frame);
    if (energyDb === null) {
      this.sent += 1;
      return { send: true, barge: false, droppedByGate: false, energyDb: null };
    }

    // 3. The pre-existing barge policy. Its duck arm must NOT consume tail
    //    budget: speaker echo during playback would otherwise eat the window
    //    the user's own speech is still filling.
    if (opts.speaking) {
      const decision = bargePolicy(true, frame);
      if (decision === 'duck') {
        this.dropped += 1;
        return { send: false, barge: false, droppedByGate: false, energyDb };
      }
      this.arm();
      this.sent += 1;
      return { send: true, barge: true, droppedByGate: false, energyDb };
    }

    // 4. The gate itself.
    if (energyDb > SPEECH_GATE_DB) {
      this.arm();
      this.sent += 1;
      return { send: true, barge: false, droppedByGate: false, energyDb };
    }
    if (this.tail > 0) {
      this.tail -= 1;
      this.sent += 1;
      return { send: true, barge: false, droppedByGate: false, energyDb };
    }
    this.dropped += 1;
    return { send: false, barge: false, droppedByGate: true, energyDb };
  }
}

/**
 * The stateless form, for one frame with no tail history. `UplinkGate` is what
 * ships; this exists so the policy can be read (and tested) as a table.
 */
export function uplinkVerdict(frame: Uint8Array, opts: UplinkOptions): UplinkVerdict {
  return new UplinkGate().decide(frame, opts);
}

/**
 * L19 — when the microphone hardware should be acquired or released.
 *
 * The mic used to stay hot for as long as the window merely lost focus, which
 * for a voice-first HUD is a standing privacy and battery cost the user never
 * asked for. The rule is deliberately narrow:
 *
 *  - a **hidden** window releases the hardware unconditionally, because the
 *    user cannot see that it is listening;
 *  - a **visible** window re-acquires it only if the user had not muted;
 *  - the user's own mute choice is never overridden in either direction.
 *
 * `muted` is the user's toggle, NOT whether a track currently exists — the
 * distinction is what makes minimise/restore non-destructive.
 */
export type MicPolicy = 'release' | 'start' | 'none';

export function micPolicy(visibility: 'visible' | 'hidden', muted: boolean): MicPolicy {
  if (visibility === 'hidden') return 'release';
  return muted ? 'none' : 'start';
}

/**
 * SEC-7 — say WHY the microphone failed, not just that it did.
 *
 * `getUserMedia` rejects with a `DOMException` whose `name` is the only thing
 * that distinguishes the causes, and they need completely different responses:
 *
 *  - `NotAllowedError` — permission was refused. In a packaged Tauri build this
 *    is the live risk: wry registers a WebView2 `PermissionRequested` handler
 *    that leaves the microphone in `PERMISSION_STATE_DEFAULT` (it only
 *    explicitly allows clipboard reads), and `tauri-runtime-wry` exposes no
 *    passthrough to change that. Whether WebView2 then prompts or silently
 *    denies could not be verified from here, so the user has to be able to tell
 *    us which it was.
 *  - `NotFoundError` — no microphone at all. Nothing to fix in permissions.
 *  - `NotReadableError` — the device exists but another app holds it.
 *
 * Collapsing all three into one generic Arabic sentence made "voice is dead"
 * undiagnosable from a user's report alone.
 */
export function micFailureNotice(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'رُفض إذن الميكروفون — فعّله من إعدادات ويندوز ثم أعد المحاولة';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'لا يوجد ميكروفون متصل بالجهاز';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'الميكروفون مستخدم من تطبيق آخر — أغلقه ثم أعد المحاولة';
    default:
      return 'تعذّر الوصول إلى الميكروفون';
  }
}