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
  /** Release whatever the decode/sink pair owns (an AudioContext, say). */
  readonly dispose?: () => void;
}

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
    // Before the `started` check, and unconditionally: halting committed speech
    // and dropping the scheduling horizon are part of stopping, whether or not a
    // run was latched, and `dispose()`/`setMuted(true)` both route through here.
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
          this.options.onEnd?.();
        } else if (this.queue.length > 0) {
          void this.drain().catch(() => undefined);
        }
      } catch {
        // A consumer callback must not reject the floating drain promise.
      }
    }
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

/** Production wiring: decode via AudioContext, play through the default output. */
export function createDefaultPlayer(events?: { onStart?(playbackId?: string): void; onEnd?(): void }): AudioPlayer {
  if (typeof AudioContext === 'undefined') {
    throw new Error('audio output unavailable in this environment');
  }
  const context = new AudioContext();
  // One gain node for the whole player: every TTS source passes through it, so
  // peak control is a single number and does not depend on chunk count.
  const gain = context.createGain();
  gain.gain.value = PLAYBACK_GAIN;
  gain.connect(context.destination);
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
  });
}