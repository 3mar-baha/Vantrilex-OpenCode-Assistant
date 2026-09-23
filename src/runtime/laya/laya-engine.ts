import * as ort from 'onnxruntime-node';
import { nowIso } from '../../common/brands.js';
import type { LayaTokenizer } from './tokenizer.js';

// Local Laya System-1 engine — M7 L3. Executes the fine-tuned ONNX model on CPU
// via onnxruntime-node. Advisory-only: every decision is schema-gated downstream
// (FR-12 confirmation still mandatory for destructive acts).
//
// Operating length 32 tokens: the corpus p99 is 32 (max 35) and masked mean
// pooling makes logits invariant to pad length, so 32 is the latency-optimal
// point that still covers 99% of utterances — p50 25.8 ms vs 66.4 ms at 128
// (docs/09 ADR-008, ml/l2_report.json).
export const LAYA_OPERATING_LENGTH = 32;
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
  private sessionPromise: Promise<LayaSession> | null = null;
  private inflight = 0;

  constructor(
    private readonly tokenizer: LayaTokenizer,
    private readonly modelPath: string,
    private readonly maxLength = LAYA_OPERATING_LENGTH,
    private readonly sessionFactory?: (path: string) => Promise<LayaSession>,
    private readonly maxInflight = 4,
  ) {}

  private async getSession(): Promise<LayaSession> {
    if (this.session !== null) return this.session;
    // Cache the in-flight promise so concurrent decisions share one session
    // instead of each racing to build their own (a real memory blow-up risk).
    if (this.sessionPromise === null) {
      const pending = this.createSession();
      // Self-heal: a rejected load must not poison the engine forever. Clear
      // the cached promise so the next decision retries instead of bricking.
      // (Unconditional clear is safe: no newer promise can be installed while
      // this handler runs, and every sharer already holds this same promise.)
      this.sessionPromise = pending.catch((err: unknown) => {
        this.sessionPromise = null;
        throw err;
      });
    }
    const session = await this.sessionPromise;
    this.session = session;
    return session;
  }

  private async createSession(): Promise<LayaSession> {
    if (this.sessionFactory !== undefined) {
      return this.sessionFactory(this.modelPath);
    }
    const real = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 0,
    });
    return {
      run: (feeds) => real.run(feeds) as Promise<Record<string, ort.Tensor>>,
    };
  }

  async decide(text: string): Promise<LayaDecision> {
    // Concurrency cap + stale-packet debounce: the ORT CPU session effectively
    // serializes concurrent runs (~2.6 s each under 20-way load), so bursts must
    // shed fast rather than queue. Over-cap calls reject immediately; callers
    // already treat engine errors as fail-open (speak). Increment is atomic
    // (no await precedes it).
    if (this.inflight >= this.maxInflight) {
      throw new Error(`LAYA_CONCURRENCY_LIMIT: ${this.inflight} in flight (max ${this.maxInflight})`);
    }
    this.inflight += 1;
    try {
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
    } finally {
      this.inflight -= 1;
    }
  }
}
