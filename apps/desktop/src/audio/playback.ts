// Renderer speech playback (P4b downlink). Strict FIFO: MP3 chunks decode in
// arrival order and play back-to-back; a corrupt chunk is skipped, never
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
  readonly onStart?: () => void;
  readonly onEnd?: () => void;
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

export class AudioPlayer {
  private readonly queue: Uint8Array[] = [];
  private draining = false;
  private started = false;
  private muted = false;
  private generation = 0;
  private droppedCount = 0;

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
      this.options.onStart?.();
    }
    void this.drain();
  }

  /**
   * Barge-in: drop everything queued and mark stopped. A chunk already inside
   * the sink finishes (hundreds of ms at most); the generation guard prevents
   * anything decoded after the stop from starting.
   */
  stop(): void {
    this.generation += 1;
    this.queue.length = 0;
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

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const gen = this.generation;
    try {
      for (;;) {
        if (gen !== this.generation) break;
        const next = this.queue.shift();
        if (next === undefined) break;
        try {
          const buffer = await this.options.decode(next);
          if (gen !== this.generation) break;
          this.options.sink.play(buffer);
        } catch {
          // Corrupt chunk: skip it, keep the queue flowing.
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

/** Production wiring: decode via AudioContext, play through the default output. */
export function createDefaultPlayer(events?: { onStart?(): void; onEnd?(): void }): AudioPlayer {
  if (typeof AudioContext === 'undefined') {
    throw new Error('audio output unavailable in this environment');
  }
  const context = new AudioContext();
  // One gain node for the whole player: every TTS source passes through it, so
  // peak control is a single number and does not depend on chunk count.
  const gain = context.createGain();
  gain.gain.value = PLAYBACK_GAIN;
  gain.connect(context.destination);
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
        source.start();
      },
    },
    dispose: () => {
      void context.close().catch(() => undefined);
    },
    ...(events?.onStart !== undefined ? { onStart: events.onStart } : {}),
    ...(events?.onEnd !== undefined ? { onEnd: events.onEnd } : {}),
  });
}