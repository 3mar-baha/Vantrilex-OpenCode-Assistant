import { describe, expect, test } from 'vitest';
import { Tensor } from 'onnxruntime-node';
import { LayaEngine } from './laya-engine.js';
import { LAYA_HEADS, LAYA_OPERATING_LENGTH } from './constants.js';
import { LayaBpeTokenizer, type TokenizerJson } from './tokenizer.js';

// Hermetic BPE spec mirroring the checkpoint shape (Metaspace + byte-fallback)
// without depending on the 40 MB checkpoint tokenizer.json. Byte-for-byte parity
// against the real tokenizer is asserted in laya.integration.test.ts.
//
// Note: this file loads `onnxruntime-node` (through laya-engine.ts) because it
// constructs the engine directly. That is safe in a test process and is exactly
// what `src/runtime/vad.test.ts` already does; it is NOT safe in the sidecar,
// which is why `loader.ts` defers the same module behind `import()`.
const SPEC: TokenizerJson = {
  model: {
    type: 'BPE',
    vocab: {
      '<pad>': 0, '<eos>': 1, '<bos>': 2, '<unk>': 3,
      '▁': 4, h: 5, e: 6, l: 7, o: 8, '▁hello': 9, w: 10, r: 11, d: 12,
      '▁world': 13, '<0x73>': 14,
    },
    merges: [
      ['▁', 'h'], ['▁h', 'e'], ['▁he', 'l'], ['▁hel', 'l'], ['▁hell', 'o'],
      ['▁', 'w'], ['▁w', 'o'], ['▁wo', 'r'], ['▁wor', 'l'], ['▁worl', 'd'],
    ],
    byte_fallback: true,
    unk_token: '<unk>',
  },
  normalizer: { type: 'Replace', pattern: { String: ' ' }, content: '▁' },
  pre_tokenizer: { type: 'Metaspace', replacement: '▁', prepend_scheme: 'always', split: true },
  post_processor: { special_tokens: { '<bos>': { ids: [2] }, '<eos>': { ids: [1] } } },
};

describe('LayaBpeTokenizer', () => {
  test('merges, adds bos/eos, pads, and masks', () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    const { inputIds, attentionMask } = tokenizer.encode('hello world', 8);
    expect(inputIds).toEqual([2, 9, 13, 1, 0, 0, 0, 0]);
    expect(attentionMask).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });

  test('byte-fallback for out-of-vocab characters', () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    const { inputIds } = tokenizer.encode('hellos', 6);
    expect(inputIds.slice(0, 4)).toEqual([2, 9, 14, 1]);
  });

  test('empty input yields bos/eos only', () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    const { inputIds, attentionMask } = tokenizer.encode('', 4);
    expect(inputIds).toEqual([2, 1, 0, 0]);
    expect(attentionMask).toEqual([1, 1, 0, 0]);
  });

  test('truncates to maxLength keeping the mask aligned', () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    const { inputIds, attentionMask } = tokenizer.encode('hello world', 3);
    expect(inputIds).toEqual([2, 9, 13]);
    expect(attentionMask).toEqual([1, 1, 1]);
  });

  test('a non-BPE checkpoint is refused rather than silently mis-encoded', () => {
    // The merged Symbolizer path and a WordPiece path produce different ids.
    // Encoding with the wrong algorithm is worse than not encoding at all.
    expect(() => new LayaBpeTokenizer({ ...SPEC, model: { ...SPEC.model, type: 'WordPiece' } })).toThrow(
      /unsupported tokenizer model/,
    );
  });
});

describe('Laya constants (restored from quarantine)', () => {
  test('four advisory heads at the 32-token operating length', () => {
    // These are the contract the shell and the FR-12 gate are written against.
    expect(LAYA_HEADS).toEqual(['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop']);
    expect(LAYA_OPERATING_LENGTH).toBe(32);
  });
});

describe('LayaEngine with stubbed session', () => {
  const allHeads = (value: number): Record<string, Tensor> => ({
    logit_should_speak: new Tensor('float32', [value], [1]),
    logit_is_destructive: new Tensor('float32', [-value], [1]),
    logit_barge_in: new Tensor('float32', [0.0], [1]),
    logit_stuck_in_loop: new Tensor('float32', [0.0], [1]),
  });

  test('decide returns sigmoid scores for all heads', async () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    const engine = new LayaEngine(tokenizer, 'models/laya-m7-int8.onnx', 8, async () => ({
      run: async () => ({
        logit_should_speak: new Tensor('float32', [2.0], [1]),
        logit_is_destructive: new Tensor('float32', [-2.0], [1]),
        logit_barge_in: new Tensor('float32', [0.0], [1]),
        logit_stuck_in_loop: new Tensor('float32', [-1.0], [1]),
      }),
    }));
    const decision = await engine.decide('hello world');
    expect(decision.scores.should_speak).toBeGreaterThan(0.85);
    expect(decision.scores.is_destructive).toBeLessThan(0.15);
    expect(decision.scores.barge_in).toBeCloseTo(0.5, 5);
    expect(decision.elapsedMs).toBeLessThan(40);
  });

  test('every declared head is always present, even if the graph omits one', async () => {
    // A graph missing `logit_barge_in` must not leave a hole in the record: the
    // loader's contract-drift check needs every declared key to be *present*.
    const tokenizer = new LayaBpeTokenizer(SPEC);
    const engine = new LayaEngine(tokenizer, 'models/laya-m7-int8.onnx', 8, async () => ({
      run: async () => ({ logit_should_speak: new Tensor('float32', [1.0], [1]) }),
    }));
    const decision = await engine.decide('hello');
    expect(Object.keys(decision.scores).sort()).toEqual([...LAYA_HEADS].sort());
  });

  test('self-heals: retries session creation after a transient failure', async () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    let calls = 0;
    const engine = new LayaEngine(tokenizer, 'models/laya-m7-int8.onnx', 8, async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient load failure');
      return { run: async () => allHeads(2.0) };
    });
    await expect(engine.decide('first')).rejects.toThrow('transient load failure');
    const retry = await engine.decide('second');
    expect(calls).toBe(2);
    expect(retry.scores.should_speak).toBeGreaterThan(0.85);
  });

  test('concurrency cap sheds bursts fast instead of queueing', async () => {
    const tokenizer = new LayaBpeTokenizer(SPEC);
    let factoryCalls = 0;
    const engine = new LayaEngine(tokenizer, 'models/laya-m7-int8.onnx', 8, async () => {
      factoryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { run: async () => allHeads(1.0) };
    }, 2);
    const timed = Array.from({ length: 5 }, (_, i) => {
      const startedAt = Date.now();
      return engine.decide(`burst ${i}`).then(
        (d) => ({ ok: true as const, ms: Date.now() - startedAt, decision: d }),
        (e: unknown) => ({ ok: false as const, ms: Date.now() - startedAt, error: e }),
      );
    });
    const outcomes = await Promise.all(timed);
    const succeeded = outcomes.filter((o) => o.ok);
    const rejected = outcomes.filter((o) => !o.ok);
    expect(factoryCalls).toBe(1);
    expect(succeeded).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      if (r.ok) continue;
      expect(String(r.error)).toContain('LAYA_CONCURRENCY_LIMIT');
      // Shed load must fail fast — nowhere near the 100 ms session latency.
      expect(r.ms).toBeLessThan(50);
    }
    // Engine stays usable after the burst.
    const after = await engine.decide('after burst');
    expect(after.scores.should_speak).toBeGreaterThan(0.5);
  });
});
