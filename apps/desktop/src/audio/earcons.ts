// Voxaura earcons — procedural Web Audio cues, zero audio assets.
// Rendered once into cached AudioBuffers; the abort contract cuts scheduled
// earcons through the same AudioContext as TTS playback.
export type EarconKind = 'arm' | 'disarm' | 'abort' | 'kareem-done' | 'nour-done';

interface EarconRecipe {
  readonly frequency: number;
  readonly endFrequency: number;
  readonly durationMs: number;
  readonly type: OscillatorType;
}

const RECIPES: Record<EarconKind, EarconRecipe> = {
  arm: { frequency: 1800, endFrequency: 1800, durationMs: 40, type: 'triangle' },
  disarm: { frequency: 900, endFrequency: 700, durationMs: 60, type: 'triangle' },
  abort: { frequency: 120, endFrequency: 60, durationMs: 180, type: 'sine' },
  'kareem-done': { frequency: 659.25, endFrequency: 987.77, durationMs: 220, type: 'sine' },
  'nour-done': { frequency: 987.77, endFrequency: 1318.5, durationMs: 220, type: 'sine' },
};

export function earconRecipe(kind: EarconKind): EarconRecipe {
  return RECIPES[kind];
}

/** Render a cue into a buffer — pure DSP, runs in tests without hardware. */
export function renderEarcon(
  ctx: { sampleRate: number; createBuffer: (ch: number, len: number, rate: number) => { getChannelData: (ch: number) => Float32Array } },
  kind: EarconKind,
): { getChannelData: (ch: number) => Float32Array } {
  const recipe = RECIPES[kind];
  const length = Math.floor((ctx.sampleRate * recipe.durationMs) / 1000);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const t = i / length;
    const freq = recipe.frequency + (recipe.endFrequency - recipe.frequency) * t;
    const phase = (2 * Math.PI * freq * i) / ctx.sampleRate;
    const envelope = Math.sin(Math.PI * t) ** 2; // raised-cosine, click-free
    data[i] = Math.sin(phase) * envelope * 0.5;
  }
  return buffer;
}

export class EarconPlayer {
  private readonly cache = new Map<EarconKind, AudioBuffer>();
  private context: AudioContext | null = null;

  constructor(private readonly factory: () => AudioContext = () => new AudioContext()) {}

  /** Prime on first trusted gesture (autoplay policy). */
  unlock(): void {
    if (this.context === null) this.context = this.factory();
    if (this.context.state === 'suspended') void this.context.resume();
  }

  play(kind: EarconKind): void {
    if (this.context === null) return; // locked: silent by design
    let buffer = this.cache.get(kind);
    if (buffer === undefined) {
      const rendered = renderEarcon(
        {
          sampleRate: this.context.sampleRate,
          createBuffer: (ch, len, rate) => this.context!.createBuffer(ch, len, rate),
        },
        kind,
      );
      buffer = rendered as AudioBuffer;
      this.cache.set(kind, buffer);
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.start();
  }

  /** Abort path: drop every scheduled source by suspending the context. */
  abort(): void {
    if (this.context !== null) void this.context.suspend();
  }
}
