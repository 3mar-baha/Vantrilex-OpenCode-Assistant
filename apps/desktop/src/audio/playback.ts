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

  constructor(private readonly options: AudioPlayerOptions) {}

  get playing(): boolean {
    return this.queue.length > 0 || this.draining;
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

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.queue.shift();
        if (next === undefined) break;
        try {
          const buffer = await this.options.decode(next);
          this.options.sink.play(buffer);
        } catch {
          // Corrupt chunk: skip it, keep the queue flowing.
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length === 0) {
        this.started = false;
        this.options.onEnd?.();
      } else {
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