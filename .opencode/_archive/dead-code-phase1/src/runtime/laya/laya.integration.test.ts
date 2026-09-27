import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LAYA_OPERATING_LENGTH, LayaEngine } from './laya-engine.js';
import { LayaBpeTokenizer } from './tokenizer.js';

// Live-model integration — requires M7 L2 artifacts + the checkpoint tokenizer.
// Run: LAYA_LIVE=1 npx vitest run src/runtime/laya/laya.integration.test.ts
// Gates: tokenizer byte-for-byte parity with the Python `tokenizers` lib;
// p50 decision < 40 ms on local CPU; destructive head separates held-out classes.
const HF_TOKENIZER =
  'O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json';
const MODEL_INT8 = 'O:/opencode-Vantrilex/models/laya-m7-int8.onnx';
const GOLDEN = new URL('./__fixtures__/tokenizer_golden.json', import.meta.url);
const TEST_SPLIT = new URL('../../../ml/data/splits/test.jsonl', import.meta.url);

interface TestRow {
  text: string;
  labels: Record<string, boolean>;
}

const live = process.env['LAYA_LIVE'] === '1' && existsSync(HF_TOKENIZER) && existsSync(MODEL_INT8);

function loadTestRows(): TestRow[] {
  return (readFileSync(TEST_SPLIT, 'utf8') as string)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TestRow);
}

describe.skipIf(!live)('Laya live model', () => {
  test('tokenizer matches golden ids byte-for-byte', () => {
    const tokenizer = LayaBpeTokenizer.load(HF_TOKENIZER);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8') as string) as Array<{
      text: string;
      ids: number[];
    }>;
    for (const row of golden) {
      expect(tokenizer.encode(row.text, 128).inputIds.slice(0, row.ids.length)).toEqual(row.ids);
    }
  }, 60_000);

  test('p50 < 40ms and destructive head separates held-out classes', async () => {
    const tokenizer = LayaBpeTokenizer.load(HF_TOKENIZER);
    const engine = new LayaEngine(tokenizer, MODEL_INT8, LAYA_OPERATING_LENGTH);
    const rows = loadTestRows();
    const destructive = rows.filter((r) => r.labels['is_destructive']).slice(0, 20);
    const routine = rows.filter((r) => !r.labels['is_destructive']).slice(0, 20);

    const elapsed: number[] = [];
    const score = async (text: string): Promise<number> => {
      const decision = await engine.decide(text);
      elapsed.push(decision.elapsedMs);
      return decision.scores.is_destructive;
    };
    let destructiveSum = 0;
    for (const row of destructive) destructiveSum += await score(row.text);
    let routineSum = 0;
    for (const row of routine) routineSum += await score(row.text);
    const destructiveMean = destructiveSum / destructive.length;
    const routineMean = routineSum / routine.length;

    elapsed.sort((a, b) => a - b);
    const p50 = elapsed[Math.floor(elapsed.length / 2)] as number;
    expect(p50).toBeLessThan(40);
    expect(destructiveMean).toBeGreaterThan(0.5);
    expect(destructiveMean).toBeGreaterThan(routineMean + 0.3);
  }, 120_000);

  test('missing model degrades via factory error (fallback path)', async () => {
    const tokenizer = LayaBpeTokenizer.load(HF_TOKENIZER);
    const engine = new LayaEngine(tokenizer, join('models', 'absent.onnx'), LAYA_OPERATING_LENGTH);
    await expect(engine.decide('hello')).rejects.toThrow();
  }, 30_000);
});