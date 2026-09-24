import { existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';

// Silero VAD over the existing onnxruntime-node (G4A) — no new native dep.
// Model: onnx-community/silero-vad (MIT), onnx/model.onnx → models/silero-vad.onnx
// (gitignored). IO is bound adaptively by shape so v4/v5 exports both work;
// anything unrecognized throws VadModelError instead of misreading tensors.
export const VAD_SAMPLE_RATE = 16000;
export const VAD_WINDOW_SAMPLES = 512;
const VAD_STATE_SHAPE = [2, 1, 128] as const;
const VAD_MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/blob/main/onnx/model.onnx';

export class VadModelMissing extends Error {
  constructor(path: string) {
    super(`VAD model missing at ${path} — download ${VAD_MODEL_URL} to models/silero-vad.onnx`);
    this.name = 'VadModelMissing';
  }
}

export class VadModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VadModelError';
  }
}

/** Minimal structural surface — real InferenceSession satisfies it; tests stub it. */
export interface VadSession {
  readonly inputNames: string[];
  readonly outputNames: string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, { data: ArrayLike<number>; dims: number[] }>>;
}

interface VadBinding {
  readonly audio: string;
  readonly stateIn: string;
  readonly srIn: string;
  readonly probOut: string;
  readonly stateOut: string;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class SileroVad {
  private state: Float32Array = new Float32Array(2 * 1 * 128);
  private readonly binding: VadBinding;

  constructor(
    private readonly session: VadSession,
    private readonly options: { threshold?: number } = {},
  ) {
    this.binding = SileroVad.bind(session);
  }

  get threshold(): number {
    return this.options.threshold ?? 0.5;
  }

  static async load(modelPath: string, options: { threshold?: number } = {}): Promise<SileroVad> {
    if (!existsSync(modelPath)) throw new VadModelMissing(modelPath);
    let session: ort.InferenceSession;
    try {
      session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    } catch (err) {
      throw new VadModelError(`VAD session failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    return new SileroVad(session as unknown as VadSession, options);
  }

  /** Speech probability for one 512-sample 16 kHz window. */
  async prob(window: Float32Array): Promise<number> {
    if (window.byteLength !== VAD_WINDOW_SAMPLES * 4) {
      throw new VadModelError(`VAD window must be ${VAD_WINDOW_SAMPLES} float32 samples`);
    }
    const feeds: Record<string, ort.Tensor> = {
      [this.binding.audio]: new ort.Tensor('float32', window, [1, VAD_WINDOW_SAMPLES]),
      [this.binding.stateIn]: new ort.Tensor('float32', this.state, [...VAD_STATE_SHAPE]),
      [this.binding.srIn]: new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [1]),
    };
    const out = await this.session.run(feeds);
    const probTensor = out[this.binding.probOut];
    const stateTensor = out[this.binding.stateOut];
    if (probTensor === undefined || stateTensor === undefined) {
      throw new VadModelError('VAD graph returned no probability/state tensors');
    }
    const raw = Number(probTensor.data[0]);
    this.state = Float32Array.from(stateTensor.data as ArrayLike<number>);
    // Defensive normalization: v4+ exports probabilities; older graphs export
    // logits. Values inside [0,1] pass through untouched (pinned by test).
    return raw >= 0 && raw <= 1 ? raw : sigmoid(raw);
  }

  async isSpeech(window: Float32Array): Promise<boolean> {
    return (await this.prob(window)) >= this.threshold;
  }

  /** Clear recurrent state between utterances. */
  reset(): void {
    this.state = new Float32Array(2 * 1 * 128);
  }

  /** No-op: node ORT sessions are GC-owned; present for lifecycle symmetry. */
  async dispose(): Promise<void> {}

  private static bind(session: VadSession): VadBinding {
    const sessionAny = session as unknown as {
      inputNames: string[];
      outputNames: string[];
      inputMetadata?: Array<{ name: string; type: string; dimensions?: unknown }>;
      outputMetadata?: Array<{ name: string; type: string; dimensions?: unknown }>;
    };
    const inputs = Array.isArray(sessionAny.inputMetadata) ? sessionAny.inputMetadata : [];
    const outputs = Array.isArray(sessionAny.outputMetadata) ? sessionAny.outputMetadata : [];
    const dimsOf = (m: { dimensions?: unknown }): number[] | null => {
      if (!Array.isArray(m.dimensions)) return null;
      const nums = m.dimensions.map((d) => (typeof d === 'string' ? Number.parseInt(d, 10) : d));
      if (nums.some((d) => typeof d !== 'number' || !Number.isInteger(d))) return null;
      return nums as number[];
    };
    // Primary path: metadata-driven shape matching.
    const audioMeta = inputs.find(
      (m) => m.type === 'tensor(float)' && (dimsOf(m) ?? []).join(',') === `1,${VAD_WINDOW_SAMPLES}`,
    );
    const stateMeta = inputs.find((m) => m.type === 'tensor(float)' && (dimsOf(m) ?? []).length === 3);
    const srMeta = inputs.find((m) => typeof m.type === 'string' && m.type.startsWith('tensor(int'));
    const probMeta = outputs.find((m) => ((dimsOf(m) ?? []).length ?? 99) <= 2);
    const stateOutMeta = outputs.find((m) => (dimsOf(m) ?? []).length === 3);
    const names = (list: string[], fallback: string): string => {
      if (fallback !== '') return fallback;
      const hit = list[0];
      if (hit === undefined) throw new VadModelError('VAD graph IO unrecognizable');
      return hit;
    };
    // Metadata may be absent (stubs) — fall back to conventional positions.
    const inNames = session.inputNames;
    const outNames = session.outputNames;
    return {
      audio: audioMeta?.name ?? names(inNames, ''),
      stateIn: stateMeta?.name ?? names(inNames.slice(1, 2), ''),
      srIn: srMeta?.name ?? names(inNames.slice(2, 3), ''),
      probOut: probMeta?.name ?? names(outNames.slice(0, 1), ''),
      stateOut: stateOutMeta?.name ?? names(outNames.slice(1, 2), ''),
    };
  }
}
