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
}

export class AudioPlayer {
  private readonly queue: Uint8Array[] = [];
  private draining = false;
  private started = false;
  private generation = 0;

  constructor(private readonly options: AudioPlayerOptions) {}

  get playing(): boolean {
    // Visible playback state, not the internal drain flag: after stop() a
    // stale in-flight decode must not read as still playing.
    return this.started;
  }

  get queued(): number {
    return this.queue.length;
  }

  enqueue(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.queue.push(bytes);
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
      if (this.queue.length === 0 && this.started) {
        this.started = false;
        this.options.onEnd?.();
      } else if (this.queue.length > 0) {
        void this.drain();
      }
    }
  }
}

/** Production wiring: decode via AudioContext, play through the default output. */
export function createDefaultPlayer(events?: { onStart?(): void; onEnd?(): void }): AudioPlayer {
  if (typeof AudioContext === 'undefined') {
    throw new Error('audio output unavailable in this environment');
  }
  const context = new AudioContext();
  return new AudioPlayer({
    decode: async (bytes: Uint8Array) => {
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      return context.decodeAudioData(copy);
    },
    sink: {
      play: (buffer: AudioBuffer) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start();
      },
    },
    ...(events?.onStart !== undefined ? { onStart: events.onStart } : {}),
    ...(events?.onEnd !== undefined ? { onEnd: events.onEnd } : {}),
  });
}