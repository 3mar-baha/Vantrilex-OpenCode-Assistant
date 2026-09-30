// Renderer speech playback (P4b downlink). Strict FIFO: downlink chunks are
// concatenated into contiguous payloads, decoded in arrival order and played
// back-to-back on a scheduling horizon; a corrupt payload is skipped, never
// stalling the queue. Decode and sink are injected so tests run hermetically;
// production wires a real AudioContext (see createDefaultPlayer).
export interface PlaybackDecoder {
  decode(bytes: Uint8Array): Promise<AudioBuffer>;
}

export interface PlaybackSink {
  play(buffer: AudioBuffer): void;
}

export interface AudioPlayerOptions {
  readonly decode: PlaybackDecoder['decode'];
  readonly sink: PlaybackSink;
  /**
   * ONCE per contiguous run — which in production is roughly per sentence,
   * not per utterance.
   *
   * M2 Pattern 3: `enqueue` fires this under `if (!this.started)`, and `started`
   * is cleared in `drain`'s `finally` and in `stop()`. Fish synthesises
   * sentence by sentence with multi-second gaps, so the queue empties between
   * sentences and a five-sentence reply fires this ~five times. Peer review:
   * claiming per-utterance was false (the latch is per queue residency, and
   * the sink does not wait for audio to finish). Harmless for the daemon —
   * its flag is sticky and the drain is idempotent — but the contract stated
   * here is per-run, and the E2E asserts that shape, not per-utterance.
   *
   * The optional id is a correlation token for logs, bounded to 64 chars by the
   * protocol. It is not a session handle and is never parsed.
   */
  readonly onStart?: (playbackId?: string) => void;
  readonly onEnd?: () => void;
  /**
   * Barge-in hook. `stop()` clears the QUEUE; this is the only handle on audio the
   * graph has already been handed, which `AudioPlayer` cannot reach — a
   * `source.start(when)` is owned by the AudioContext once it is called.
   *
   * Throwing here is contained, exactly as `drain`'s `onEnd` call is: a consumer
   * callback must not be able to wedge the player for every later chunk.
   */
  readonly onStop?: () => void;
  /**
   * Downlink OUTPUT energy, 0..1, for an audio-reactive visual.
   *
   * Deliberately NOT a renamed `onEnergy`. Capture's `onEnergy` (capture.ts:65)
   * is the UPLINK mic level, and the two are not interchangeable: that one is
   * mapped through `dbToWaveEnergy`, whose knee is pinned to `SPEECH_GATE_DB` —
   * a threshold about whether a frame gets transmitted. This one measures the
   * audio leaving the speakers. Two different questions, and at a call site
   * that passes both — an orb with an input ring and an output ring — one name
   * for them is precisely how a reader wires the microphone to the speaker ring.
   *
   * The value comes from the real graph through `levelSource`, never from queue
   * depth or chunk count. A queue-derived level would hold the orb lit through
   * the gaps Fish leaves between sentences, and lit after `stop()` — a player
   * making no sound at all, reporting that it is. A level is a measurement or
   * it is a lie, and this file's own audit culture is the reason that is worth
   * saying out loud.
   *
   * Zero is a real value here, not an absence: the level is pinned to exactly 0
   * when the run ends, because the last value of a reply that has stopped is
   * not zero and a consumer holding it would show a lit orb forever.
   *
   * Throwing here is contained, exactly as `onEnd` and `onStop` are: this
   * callback is reached from a sampler timer, and an uncaught throw there
   * rejects a floating promise and misses the teardown, with nothing pointing
   * at the cause.
   */
  readonly onLevel?: (level: number) => void;
  /**
   * The sampler that feeds `onLevel`: given a sink, start reporting and return
   * the handle that stops. Invoked once per contiguous run, so a run's smoothing
   * state is per-run — a new reply starts from zero instead of inheriting the
   * previous one's envelope.
   *
   * Absent means "nobody is listening", and then NO sampling happens: no
   * analyser read, no timer, per run. The production wiring supplies one built
   * on an `AnalyserNode` in the playback path; a caller with its own graph
   * supplies its own. Both halves are supplied together by `createDefaultPlayer`
   * so that "no consumer" and "no sampling" cannot come apart.
   */
  readonly levelSource?: PlaybackLevelSource;
  /** Release whatever the decode/sink pair owns (an AudioContext, say). */
  readonly dispose?: () => void;
}

/**
 * A downlink energy sampler. Given a sink for levels, start reporting and
 * return the handle that stops reporting.
 *
 * The stop handle is part of the contract rather than a convenience: the level
 * it stops is the value a consumer is holding, so a caller that fails to stop
 * has a visible defect rather than a wasted timer. `AudioPlayer` calls it on
 * every path that ends a run — `stop()` and the drain's own teardown — so a
 * sampler only has to be correct, not defensive about being stopped.
 */
export type PlaybackLevelSource = (emit: (level: number) => void) => () => void;

/**
 * L1: the downlink queue used to be an unbounded array, so a decode slower than
 * the downlink grew the heap for as long as the assistant kept talking. 32
 * chunks is roughly several seconds of speech — far more than any honest
 * sentence-level backlog, and small enough to be irrelevant when it is hit.
 */
export const PLAYBACK_QUEUE_CAP = 32;

/**
 * Granularity of the coalescing tick in `gather`. Zero still means a real
 * macrotask boundary (`setTimeout(0)`), which is the whole point: the wait is for
 * a separate WebSocket delivery to land, not for elapsed time. Raising it trades
 * fewer decode boundaries for added latency at the tail of every sentence.
 */
const COALESCE_TICK_MS = 0;

/**
 * HARD bound on coalescing ticks per payload. Without it `gather` is a livelock
 * waiting to happen: its exit condition is "the queue is empty after a tick", so
 * a producer fast enough to refill the queue within one tick never lets it exit,
 * `gather` never returns, and NOT ONE payload is ever decoded. That is strictly
 * worse than the inter-fragment crackle coalescing exists to remove — a total
 * audio outage instead of a cosmetic one — so forward progress is mandatory and
 * the TICK COUNT is the thing bounded, not the queue (already capped by
 * PLAYBACK_QUEUE_CAP).
 *
 * 2: one tick for the in-flight burst, one for siblings sharing the same
 * WebSocket drain, then emit whatever has accumulated. `parts` is bounded as a
 * consequence, at (MAX_COALESCE_TICKS + 1) * PLAYBACK_QUEUE_CAP.
 */
export const MAX_COALESCE_TICKS = 2;

export class AudioPlayer {
  private readonly queue: Uint8Array[] = [];
  private draining = false;
  private started = false;
  private muted = false;
  private generation = 0;
  private droppedCount = 0;
  /** Monotonic per-utterance correlation id (M2 Pattern 3). Rendered as `pb-<n>`. */
  private runCount = 0;
  /** Non-null exactly while a run is being sampled. See `startLevel`. */
  private stopLevel: (() => void) | null = null;

  constructor(private readonly options: AudioPlayerOptions) {}

  get playing(): boolean {
    // Visible playback state, not the internal drain flag: after stop() a
    // stale in-flight decode must not read as still playing.
    return this.started;
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Chunks discarded by the queue cap. Non-zero means audio was lost. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Assistant mute — the `bot-toggle` control in the HUD.
   *
   * The gate belongs HERE, at the front door, rather than at the renderer's
   * call site: `onAudio` is not the only way a chunk can reach a sink, and a
   * gate that covers one entry point is a gate that leaks. Muting returns
   * BEFORE `started` flips, so the speaking indicator never claims audible
   * speech that is not happening.
   *
   * It also flushes: a mute that lets the current sentence finish is not a
   * mute, and leaving the queue primed means un-muting would replay speech the
   * user muted out seconds ago.
   *
   * Deliberately silent on the wire. This used to be paired with a
   * `{kind:'mute'}` command, which the daemon answers `ok:true` while doing
   * nothing at all (`src/orchestrator/command-router.ts:227-230`) and then pays
   * an Inkling call to narrate silencing a microphone it never silenced. A mute
   * the daemon does not own cannot honestly be reported by the daemon.
   */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    if (muted) this.stop();
  }

  enqueue(bytes: Uint8Array): void {
    if (this.muted) return;
    if (bytes.byteLength === 0) return;
    this.queue.push(bytes);
    // Drop the OLDEST on overflow: the tail is what the user is waiting to
    // hear, and dropping it would truncate the reply mid-sentence.
    while (this.queue.length > PLAYBACK_QUEUE_CAP) {
      this.queue.shift();
      this.droppedCount += 1;
    }
    if (!this.started) {
      this.started = true;
      this.runCount += 1;
      // M2 Pattern 3: ONCE per contiguous run. `started` clears when the queue
      // empties or `stop()` is called — and Fish gaps empty it between
      // sentences — so this is roughly per sentence, not per utterance.
      // Peer review corrected the stronger claim; the daemon side is
      // unaffected (sticky flag, idempotent drain).
      this.options.onStart?.(`pb-${this.runCount}`);
      this.startLevel();
    }
    void this.drain();
  }

  /**
   * Barge-in: drop everything queued, halt what the graph has already committed
   * to, and mark stopped. The generation guard prevents anything decoded after
   * the stop from starting.
   *
   * `onStop` is what makes this a real interrupt rather than a queue clear. The
   * comment here used to claim already-started audio "finishes (hundreds of ms at
   * most)" — true of one fragment, false of a run, because the horizon schedules a
   * run's sources CONTIGUOUSLY and a five-sentence reply is seconds of committed
   * audio. The result was barge-in that did not interrupt: the daemon stopped
   * generating while the renderer played on. `App.tsx` barge-in is the caller.
   */
  stop(): void {
    this.generation += 1;
    this.queue.length = 0;
    // Both of the calls below are before the `started` check, and both are
    // unconditional. For `onStop`: halting committed speech and dropping the
    // scheduling horizon are part of stopping, whether or not a run was latched,
    // and `dispose()`/`setMuted(true)` both route through here. For `endLevel`:
    // a barge-in, a mute and a dispose must all leave the reported level at
    // zero, and a stopped player still reporting output energy is the visible
    // defect the level seam exists to prevent. `endLevel` is itself fully
    // contained, so calling it on the teardown path cannot become a second way
    // to strand this one.
    this.endLevel();
    try {
      this.options.onStop?.();
    } catch {
      // Contained for the same reason `drain`'s `onEnd` call is.
    }
    if (this.started) {
      this.started = false;
      this.options.onEnd?.();
    }
  }

  /**
   * Terminal: stop playback and release the sink's resources. The window
   * auto-sizes to content and can be reopened many times per session, so an
   * un-closed AudioContext is a real leak rather than a theoretical one.
   */
  dispose(): void {
    this.stop();
    this.options.dispose?.();
  }

  /**
   * Collect a CONTIGUOUS run of queued chunks into ONE payload.
   *
   * The downlink is a single MP3 stream (`tts.ts:453` requests `format: 'mp3'`)
   * sliced into ≤32 KiB transport fragments, and `decodeAudioData` is a whole-FILE
   * decoder. Every MP3 fragment carries encoder delay/padding, so handing it one
   * fragment at a time pays that tax at every boundary and the reply crackles;
   * concatenating first and decoding once is the fix. Note this is NOT a sample
   * rate problem — `decodeAudioData` resamples to the AudioContext rate, so there
   * was never a mismatch to correct. The axis is decoder frame continuity.
   *
   * After draining the queue it yields ONE macrotask tick, so a burst that has not
   * landed yet joins this payload instead of forcing a second decode of a
   * fragment. A macrotask and not a microtask, deliberately: each fragment arrives
   * in its own WebSocket message — its own macrotask — so only a macrotask
   * boundary lets a burst accumulate. A tick and not a wait-for-quiet: a sustained
   * stream never leaves the queue empty, so wait-for-quiet would stall the tail of
   * every sentence forever.
   *
   * The `await` below is a new suspension point, and it opens a window a barge-in
   * can land in. Nothing local guards it: `drain` re-checks the generation the
   * instant `gather` returns, which is the single place the window is covered —
   * a second check here was written first, removed as indistinguishable from it,
   * and is deliberately not reinstated.
   */
  private async gather(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let tick = 0; ; tick += 1) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next !== undefined) parts.push(next);
      }
      if (parts.length === 0) break;
      // The bound, checked BEFORE the await: emitting a full batch is always
      // better than waiting for a quieter queue a sustained producer will never
      // offer. See MAX_COALESCE_TICKS.
      if (tick >= MAX_COALESCE_TICKS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, COALESCE_TICK_MS));
      // Still empty after the tick: this batch was the whole burst.
      if (this.queue.length === 0) break;
    }
    if (parts.length === 1) return parts[0] as Uint8Array;
    let total = 0;
    for (const part of parts) total += part.byteLength;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const gen = this.generation;
    try {
      for (;;) {
        if (gen !== this.generation) break;
        if (this.queue.length === 0) break;
        const payload = await this.gather();
        if (payload.byteLength === 0) break;
        try {
          const buffer = await this.options.decode(payload);
          // The generation guard. One place, not two: a `stop()` landing inside
          // the coalesce tick, inside the decode, or between two payloads is the
          // same stale-generation case and the loop-top check above cannot see
          // the latter two. A second check immediately after `gather` was written
          // and removed — BG6 proved it indistinguishable from this one.
          if (gen !== this.generation) break;
          this.options.sink.play(buffer);
        } catch {
          // Corrupt payload: skip it, keep the queue flowing. `break` here would
          // behave identically, because the `finally` below re-drains a non-empty
          // queue — verified by injection, not assumed (BG7).
        }
      }
    } finally {
      this.draining = false;
      // F-01: this is a `finally`, and the only statement here that can throw
      // is the caller-supplied `onEnd`. Because `drain()` runs as a floating
      // promise, a throwing consumer callback would reject it and surface as an
      // unhandled rejection — in the WebView2 renderer a global
      // `unhandledrejection` plus a missed UI reset, with nothing pointing at
      // the cause.
      //
      // `draining` is reset BEFORE the try, not inside it: leaving it true would
      // wedge the player permanently, which is a worse failure than the one this
      // prevents. The queue is already consistent at this point, so swallowing a
      // consumer throw is safe.
      try {
        if (this.queue.length === 0 && this.started) {
          this.started = false;
          // Before `onEnd`, so a consumer that reacts to "the reply is over" by
          // reading the level sees the zero, not the last envelope value.
          this.endLevel();
          this.options.onEnd?.();
        } else if (this.queue.length > 0) {
          void this.drain().catch(() => undefined);
        }
      } catch {
        // A consumer callback must not reject the floating drain promise.
      }
    }
  }

  /**
   * The ONE place a level reaches the consumer, so the containment guarantee has
   * exactly one implementation. `drain`'s `onEnd` call and `stop`'s `onStop` call
   * each wrap their own call site; a third call site with a third hand-copied
   * try/catch is how one of them eventually loses it.
   */
  private emitLevel(level: number): void {
    try {
      this.options.onLevel?.(level);
    } catch {
      // Contained, as documented on the option.
    }
  }

  /**
   * Begin sampling for a run. A no-op unless BOTH halves of the contract are
   * present, which is what keeps a player nobody is watching from running a
   * 60 Hz timer for a value with no reader.
   *
   * Re-entrant-safe by construction rather than by a guard here: `stopLevel`
   * non-null is the "already sampling" test, and every path that sets it also
   * clears it.
   */
  private startLevel(): void {
    if (this.stopLevel !== null) return;
    const source = this.options.levelSource;
    if (source === undefined) return;
    try {
      this.stopLevel = source((level) => this.emitLevel(level));
    } catch {
      // A sampler that cannot start is a missing level, not a broken player.
      // The alternative — letting this throw out of `enqueue` — would take the
      // whole enqueue path down over an optional visual.
    }
  }

  /**
   * Stop sampling and publish a terminal zero. The two halves are ONE fix:
   * stopping without the zero leaves the consumer holding the last value it was
   * given, and the last value of a reply that has finished is not zero.
   */
  private endLevel(): void {
    const stop = this.stopLevel;
    this.stopLevel = null;
    if (stop === null) return;
    try {
      stop();
    } catch {
      // Contained for the same reason `drain`'s `onEnd` call is: this runs on
      // the barge-in path, where a throw would strand the queue clear above.
    }
    this.emitLevel(0);
  }
}

/**
 * Renderer headroom. The TTS request already asks Fish for -2 dB (see
 * `fishRequestBody`); this is the deterministic client-side backstop so a
 * provider change can never make the reply jump to full scale and read as
 * shouting. Measured, not guessed: 0.9 linear ≈ -0.9 dB.
 */
export const PLAYBACK_GAIN = 0.9;

/**
 * Scheduling lead for every source, in seconds. `drain` AWAITS the decode before
 * the sink runs, so a bare `source.start()` — "now" — is already in the past by
 * the time the audio graph reaches it, and a decode slower than the downlink
 * underruns audibly between payloads. 30 ms is enough to cover a graph update and
 * short enough to be imperceptible as added latency on the first syllable.
 */
export const PLAYBACK_START_LEAD_S = 0.03;

/**
 * Analyser window for the level read, in samples. 512 is 256 samples — about
 * 5.3 ms at 48 kHz — long enough for a stable RMS and short enough that the
 * first read after a source starts is already a real measurement rather than a
 * half-filled buffer. The cost is a 256-tap loop, once per `LEVEL_FRAME_MS`.
 */
const LEVEL_FFT_SIZE = 512;

/**
 * Frame period of the level sampler, in ms. 16 is ~60 Hz, the cadence the orb
 * itself repaints at, so a value the consumer holds is at most one paint stale.
 *
 * A `setTimeout` chain rather than `requestAnimationFrame`, and that is the one
 * real trade-off in this seam. rAF is the right clock for something being
 * PAINTED and it stops when the window is hidden, which is free battery. But a
 * level that stops being sampled stops being corrected: a reply that ends while
 * the window is occluded leaves the consumer holding the last non-zero value it
 * was given, and the orb stays lit for a window nobody can see — reported
 * speech that stopped minutes ago. A timer keeps the reading honest regardless
 * of visibility, and the loop is alive only between a run starting and it
 * ending: a few seconds per reply, and `stop()` cancels it as well as the run's
 * own teardown, so a barge-in leaves no timer behind.
 */
export const LEVEL_FRAME_MS = 16;

/** One nominal frame in seconds — the seed and the floor for the smoothing step. */
const LEVEL_FRAME_S = LEVEL_FRAME_MS / 1000;

/**
 * Attack 40 ms, release 200 ms — a 5:1 ratio.
 *
 * Speech plosives and sibilants are 10–20 ms, so anything faster than 40 ms
 * tracks individual sample peaks and the orb strobes; anything slower misses the
 * onset and the reply looks like it starts late. The release is the longer half
 * for the opposite reason: Fish leaves gaps between sentences, and a release as
 * fast as the attack would drop the orb dark between words and flicker it
 * through a reply that never stopped talking. 200 ms bridges an inter-word gap
 * and still puts the orb visibly out within a quarter second of the last
 * syllable — which is also why the run publishes an explicit zero when it ends
 * rather than waiting for this release to arrive there.
 *
 * 5:1 is the standard envelope-follower ratio (5 ms up, 25–40 ms down on a
 * hardware meter), scaled up to an element a person watches rather than a needle.
 */
const LEVEL_ATTACK_S = 0.04;
const LEVEL_RELEASE_S = 0.2;

/**
 * dBFS span the level is mapped across. The floor is the noise floor of a
 * decoded MP3 reply: below it the reply is a pause or already over, and the orb
 * should be dark rather than flickering on dither. The ceiling is full scale,
 * which a float sample reaches only for a square wave — so the mapping does not
 * peg in practice, and a full-scale sine (−3 dBFS) reads about 0.95.
 *
 * Deliberately NOT capture's `dbToWaveEnergy` (vad.ts:70). That mapping's knee
 * is pinned to `SPEECH_GATE_DB`, which answers "should this frame be
 * transmitted" — a question about the uplink with no meaning for audio leaving
 * the speakers. The honest cost of not sharing it: the orb's input and output
 * rings are no longer on an identical scale and must not be compared
 * numerically. They are the same units, not the same calibration — which is a
 * large part of why this option is `onLevel` and not `onEnergy`.
 */
const LEVEL_FLOOR_DB = -60;
const LEVEL_CEILING_DB = 0;

/**
 * Levels below this are reported as exactly 0, and equal consecutive readings
 * are not re-emitted. 1/512 is about 0.2% — below it two consumers cannot tell
 * the values apart by display. The dead zone is what makes "silence" an exact
 * `0` rather than a number too small to see, which one screen rounds away and
 * the next does not.
 */
const LEVEL_EPSILON = 1 / 512;

/**
 * Byte time-domain samples to a 0..1 level.
 *
 * Byte time domain, not byte frequency: the byte FREQUENCY data is 0–255 with
 * 0 as the floor, so silence reads as 0 there while a quiet passage reads as an
 * arbitrary non-zero — the raw signal cannot be recovered from it and a level
 * derived from it is not a level at all. The time domain is 128-centred around
 * zero, so the RMS below is the RMS of the signal.
 *
 * Monotone, clamped, total, and finite on every input including a zero-length
 * buffer — the same guarantees `dbToWaveEnergy` makes, for the same reason:
 * this runs on a timer, and a NaN reaching a consumer is a value that can never
 * be compared to anything again.
 */
function levelFromTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = ((samples[i] as number) - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(LEVEL_FLOOR_DB, Math.min(LEVEL_CEILING_DB, db));
  return Math.max(0, Math.min(1, (clamped - LEVEL_FLOOR_DB) / (LEVEL_CEILING_DB - LEVEL_FLOOR_DB)));
}

/**
 * The production sampler: reads the `AnalyserNode` sitting in the player's own
 * output path, smooths it, and reports 0..1.
 *
 * Every per-run piece of state (the smoothed value, the last emitted value, the
 * `stopped` flag) lives in this closure, not outside it, which is what makes
 * "a new run starts from zero" true by construction rather than by a reset
 * somebody has to remember to add.
 */
function analyserLevelSource(analyser: AnalyserNode): PlaybackLevelSource {
  return (emit) => {
    const samples = new Uint8Array(analyser.fftSize);
    let smoothed = 0;
    let last = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Seeded one nominal frame in the PAST, so the first tick smooths like every
    // other tick instead of jumping straight to the raw measurement — which
    // would be the strobe the smoothing exists to remove, on the first frame.
    let at = performance.now() - LEVEL_FRAME_MS;
    const tick = (): void => {
      if (stopped) return;
      const now = performance.now();
      const elapsed = (now - at) / 1000;
      at = now;
      // Clamped at both ends, and never zero. The smoothing factor is derived
      // from `elapsed`, so a zero or negative step makes the smoothing a no-op
      // and the orb strobes on raw RMS; a suspended tab or a long GC pause
      // returns after a much larger gap, where a single factor≈1 step pops.
      // Between the bounds the smoothing is exact and frame-rate independent —
      // 30 Hz, 60 Hz and 144 Hz walk the same trajectory, which a fixed
      // per-frame constant could not claim.
      const dt = Math.max(LEVEL_FRAME_S, Math.min(LEVEL_FRAME_S * 4, elapsed));
      analyser.getByteTimeDomainData(samples);
      const target = levelFromTimeDomain(samples);
      const tau = target > smoothed ? LEVEL_ATTACK_S : LEVEL_RELEASE_S;
      smoothed += (target - smoothed) * (1 - Math.exp(-dt / tau));
      // Snap the bottom of the release to a TRUE zero, so silence is reported
      // as `0` and not as a number too small for the consumer to see. Without it
      // the tail emits values like 0.0004 indefinitely after every reply.
      if (smoothed < LEVEL_EPSILON) smoothed = 0;
      // Emitted on CHANGE only. A run of identical levels — which is what
      // silence is, and what most of a reply's inter-word gaps are — would
      // otherwise be a 60 Hz callback stream that can only ever tell the consumer
      // what it already knows. Withholding a leading zero loses nothing: a
      // consumer's own starting value is zero, and the run's teardown emits a
      // terminal zero regardless.
      if (smoothed !== last) {
        last = smoothed;
        emit(smoothed);
      }
      timer = setTimeout(tick, LEVEL_FRAME_MS);
    };
    timer = setTimeout(tick, LEVEL_FRAME_MS);
    return () => {
      // Both halves, and the flag is the load-bearing one: clearing the handle
      // cannot un-queue a timer that is already in the macrotask queue, so a
      // tick firing after `stop()` would publish one more level — and if it
      // published a non-zero one, the orb would stay lit through the barge-in
      // that was supposed to have stopped it.
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  };
}

/** Production wiring: decode via AudioContext, play through the default output. */
export function createDefaultPlayer(events?: {
  onStart?(playbackId?: string): void;
  onEnd?(): void;
  onLevel?(level: number): void;
}): AudioPlayer {
  if (typeof AudioContext === 'undefined') {
    throw new Error('audio output unavailable in this environment');
  }
  const context = new AudioContext();
  // One gain node for the whole player: every TTS source passes through it, so
  // peak control is a single number and does not depend on chunk count.
  const gain = context.createGain();
  gain.gain.value = PLAYBACK_GAIN;
  // The analyser sits BETWEEN the gain node and the output, which is the only
  // place that reports what a listener hears: pre-gain energy would make the
  // orb's brightness disagree with PLAYBACK_GAIN. It observes — nothing is
  // routed through it that does not also reach the speakers — so it cannot
  // colour the audio it measures.
  const analyser = context.createAnalyser();
  analyser.fftSize = LEVEL_FFT_SIZE;
  // 0, and explicitly: `smoothingTimeConstant` smooths the FREQUENCY data and
  // has no effect on `getByteTimeDomainData`, which is what this reads. Left at
  // the 0.8 default it would advertise a smoothing that is not happening, in a
  // file that smooths deliberately and documents how.
  analyser.smoothingTimeConstant = 0;
  gain.connect(analyser);
  analyser.connect(context.destination);
  // The scheduling horizon: where the next source begins. Starts at 0, meaning
  // "nothing scheduled yet", so the first source of a reply schedules from
  // `currentTime` rather than from a value carried over from the last one.
  let scheduledUntil = 0;
  // Sources handed to the graph and not yet ended. A `source.start(when)` that has
  // fired is owned by the AudioContext, so this set is the ONLY handle a barge-in
  // has on speech that is already audible.
  const live = new Set<AudioBufferSourceNode>();
  return new AudioPlayer({
    decode: async (bytes: Uint8Array) => {
      // Autoplay policy starts a context 'suspended'. Without this the first
      // reply is silently dropped and only an unrelated user gesture revives
      // it — which reads as "the assistant sometimes says nothing".
      if (context.state === 'suspended') await context.resume();
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      return context.decodeAudioData(copy);
    },
    sink: {
      play: (buffer: AudioBuffer) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        // Schedule AHEAD on a horizon instead of starting at "now" after the
        // await. `Math.max` is what makes this degrade: with nothing queued ahead
        // — or with a stale horizon the clock has already passed — this collapses
        // to `currentTime + lead`, which is plain correct behaviour.
        const startAt = Math.max(scheduledUntil, context.currentTime) + PLAYBACK_START_LEAD_S;
        // `duration` is the horizon's unit. A structural stand-in (a test decode
        // shim) carries none, so guard rather than accumulate NaN: Web Audio
        // coerces a NaN `when` to 0 and starts every source at once.
        scheduledUntil = startAt + (Number.isFinite(buffer.duration) ? buffer.duration : 0);
        source.start(startAt);
        // Registered AFTER `start`, and dropped on `ended` so a long-lived
        // renderer does not accumulate every source it has ever played.
        live.add(source);
        source.onended = () => live.delete(source);
      },
    },
    onStop: () => {
      // Barge-in: halt the speech that is already audible, then drop the horizon
      // with it. These are ONE fix. Leaving `scheduledUntil` in place would
      // schedule the NEXT reply at the end of the speech the user just cancelled
      // — with `Math.max` that means a barge-in mid-utterance is followed by a
      // wait out the remainder of the interrupted run, which is barge-in wearing a
      // different hat. Resetting it is safe precisely BECAUSE the sources are
      // halted first: otherwise new speech would overlap speech still playing.
      for (const source of live) {
        try {
          source.stop();
        } catch {
          // Never started, or already ended. Either way there is nothing to halt.
        }
      }
      live.clear();
      scheduledUntil = 0;
    },
    dispose: () => {
      void context.close().catch(() => undefined);
    },
    ...(events?.onStart !== undefined ? { onStart: events.onStart } : {}),
    ...(events?.onEnd !== undefined ? { onEnd: events.onEnd } : {}),
    // Both halves or neither, in one spread. Splitting them would let a caller
    // get a level nobody reads (a 60 Hz timer per run for a value with no
    // consumer) or a consumer with no level (an option that reads as wired and
    // is not — the A.14 class). Conditional because of
    // `exactOptionalPropertyTypes`: `{ onLevel: undefined }` is not assignable
    // to an optional property.
    ...(events?.onLevel !== undefined
      ? { onLevel: events.onLevel, levelSource: analyserLevelSource(analyser) }
      : {}),
  });
}