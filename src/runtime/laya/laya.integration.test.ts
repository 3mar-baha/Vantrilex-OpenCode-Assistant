import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LayaEngine } from './laya-engine.js';
import { WordPieceTokenizer } from './tokenizer.js';

// Live-model integration — requires M7 L2 artifacts + HF cache tokenizer.
// Run: LAYA_LIVE=1 npx vitest run src/runtime/laya/laya.integration.test.ts
// Gate: p50 decision < 40 ms on local CPU; destructive phrase scores high.
const HF_TOKENIZER =
  'O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json';
const MODEL_INT8 = 'O:/opencode-Vantrilex/models/laya-m7-int8.onnx';

const live = process.env['LAYA_LIVE'] === '1' && existsSync(HF_TOKENIZER) && existsSync(MODEL_INT8);

describe.skipIf(!live)('Laya live model', () => {
  test('p50 < 40ms with sane head scores', async () => {
    const tokenizer = WordPieceTokenizer.load(HF_TOKENIZER);
    const engine = new LayaEngine(tokenizer, MODEL_INT8, 128);
    const samples = [
      'التيستات شغالة، ما في جديد',
      'امسح الداتابيز كلها',
      'وقف اللي بتعمله، في مشكلة',
      'خلص البيلد، كله أخضر',
    ];
    const elapsed: number[] = [];
    let destructive = 0;
    for (let i = 0; i < 5; i += 1) {
      for (const text of samples) {
        const decision = await engine.decide(text);
        elapsed.push(decision.elapsedMs);
      }
    }
    const destructiveDecision = await engine.decide('امسح الداتابيز كلها');
    destructive = destructiveDecision.scores.is_destructive;
    elapsed.sort((a, b) => a - b);
    const p50 = elapsed[Math.floor(elapsed.length / 2)] as number;
    expect(p50).toBeLessThan(40);
    expect(destructive).toBeGreaterThan(0.5);
  }, 120_000);

  test('missing model degrades via factory error (fallback path)', async () => {
    const tokenizer = WordPieceTokenizer.load(HF_TOKENIZER);
    const engine = new LayaEngine(tokenizer, join('models', 'absent.onnx'), 128);
    await expect(engine.decide('hello')).rejects.toThrow();
  }, 30_000);
});
