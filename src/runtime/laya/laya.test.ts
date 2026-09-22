import { describe, expect, test } from 'vitest';
import { Tensor } from 'onnxruntime-node';
import { LayaEngine } from './laya-engine.js';
import { WordPieceTokenizer } from './tokenizer.js';

const SPEC = {
  model: {
    type: 'WordPiece',
    vocab: {
      '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3,
      'hello': 4, 'world': 5, '##s': 6, 'التيستات': 7, 'خضرا': 8,
    },
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    cls_token: '[CLS]',
    sep_token: '[SEP]',
  },
};

describe('WordPiece tokenizer', () => {
  test('encodes with CLS/SEP, mask, and subword splits', () => {
    const tokenizer = new WordPieceTokenizer(SPEC);
    const { inputIds, attentionMask } = tokenizer.encode('hello worlds', 8);
    expect(inputIds[0]).toBe(2);
    expect(inputIds.slice(1, 4)).toEqual([4, 5, 6]);
    expect(attentionMask.slice(0, 5)).toEqual([1, 1, 1, 1, 1]);
    expect(attentionMask[7]).toBe(0);
    const arabic = tokenizer.encode('التيستات خضرا', 8);
    expect(arabic.inputIds.slice(1, 3)).toEqual([7, 8]);
  });

  test('unknown words map to UNK, never throw', () => {
    const tokenizer = new WordPieceTokenizer(SPEC);
    const { inputIds } = tokenizer.encode('zzzzz', 6);
    expect(inputIds).toContain(1);
  });
});

describe('LayaEngine with stubbed session', () => {
  test('decide returns sigmoid scores for all heads, fast', async () => {
    const tokenizer = new WordPieceTokenizer(SPEC);
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
});
