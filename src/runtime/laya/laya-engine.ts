import * as ort from 'onnxruntime-node';
import { nowIso } from '../../common/brands.js';
import type { WordPieceTokenizer } from './tokenizer.js';

// Local Laya System-1 engine — M7 L3. Executes the fine-tuned ONNX model on CPU
// via onnxruntime-node. Advisory-only: every decision is schema-gated downstream
// (FR-12 confirmation still mandatory for destructive acts).
export const LAYA_HEADS = ['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop'] as const;
export type LayaHead = (typeof LAYA_HEADS)[number];

export interface LayaDecision {
  readonly scores: Record<LayaHead, number>;
  readonly elapsedMs: number;
  readonly at: string;
}

export interface LayaSession {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class LayaEngine {
  private session: LayaSession | null = null;

  constructor(
    private readonly tokenizer: WordPieceTokenizer,
    private readonly modelPath: string,
    private readonly maxLength = 128,
    private readonly sessionFactory?: (path: string) => Promise<LayaSession>,
  ) {}

  private async getSession(): Promise<LayaSession> {
    if (this.session === null) {
      if (this.sessionFactory !== undefined) {
        this.session = await this.sessionFactory(this.modelPath);
      } else {
        const real = await ort.InferenceSession.create(this.modelPath, {
          executionProviders: ['cpu'],
          intraOpNumThreads: 0,
        });
        this.session = {
          run: (feeds) => real.run(feeds) as Promise<Record<string, ort.Tensor>>,
        };
      }
    }
    return this.session;
  }

  async decide(text: string): Promise<LayaDecision> {
    const started = Date.now();
    const { inputIds, attentionMask } = this.tokenizer.encode(text, this.maxLength);
    const session = await this.getSession();
    const outputs = await session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(inputIds.map((id) => BigInt(id))), [1, this.maxLength]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(attentionMask.map((m) => BigInt(m))), [1, this.maxLength]),
    });
    const scores = {} as Record<LayaHead, number>;
    for (const head of LAYA_HEADS) {
      const tensor = outputs[`logit_${head}`];
      const raw = tensor === undefined ? 0 : Number((tensor.data as Float32Array | number[])[0] ?? 0);
      scores[head] = sigmoid(raw);
    }
    return { scores, elapsedMs: Date.now() - started, at: nowIso() };
  }
}
