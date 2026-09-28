import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LAYA_OPERATING_LENGTH } from './constants.js';
import { LayaEngine } from './laya-engine.js';
import { LayaBpeTokenizer } from './tokenizer.js';

// Live-model integration — opt-in, never in the default gate.
//
// Run:  LAYA_LIVE=1 LAYA_TOKENIZER_PATH=<checkpoint tokenizer.json> npx vitest run src/runtime/laya
//
// Gated on purpose. The HF checkpoint tokenizer.json is a ~40 MB artifact that is
// not vendored (see `.hf_cache/`), the model is gitignored, and `onnxruntime-node`
// is a native binding. The repo convention is the same one `src/runtime/vad.test.ts`
// uses — an early `return`, not `skipIf` — so the suite stays "0 skipped" and the
// number a reader compares against keeps meaning something.
//
// UNVERIFIED unless you run it: the p50 budget below is inherited from
// `ml/l2_report.json` via the archived test. Nothing in `src/` re-measured it.

const TOKENIZER = process.env['LAYA_TOKENIZER_PATH'] ?? '';
const MODEL = process.env['LAYA_MODEL_PATH'] ?? 'models/laya-m7-int8.onnx';
const GOLDEN = new URL('./__fixtures__/tokenizer_golden.json', import.meta.url);
const TEST_SPLIT = new URL('../../../ml/data/splits/test.jsonl', import.meta.url);

const live = process.env['LAYA_LIVE'] === '1' && existsSync(TOKENIZER) && existsSync(MODEL);

interface TestRow {
  readonly text: string;
  readonly labels: Record<string, boolean>;
}

function loadTestRows(): TestRow[] {
  return (readFileSync(TEST_SPLIT, 'utf8') as string)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TestRow);
}

describe('Laya live model (opt-in: LAYA_LIVE=1)', () => {
  test('tokenizer matches the Python `tokenizers` output byte-for-byte', () => {
    if (!live) return;
    const tokenizer = LayaBpeTokenizer.load(TOKENIZER);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8') as string) as Array<{
      readonly text: string;
      readonly ids: number[];
    }>;
    expect(golden.length).toBeGreaterThan(0);
    for (const row of golden) {
      expect(tokenizer.encode(row.text, 128).inputIds.slice(0, row.ids.length)).toEqual(row.ids);
    }
  }, 60_000);

  test('p50 decision < 40 ms and the destructive head separates held-out classes', async () => {
    if (!live) return;
    const tokenizer = LayaBpeTokenizer.load(TOKENIZER);
    const engine = new LayaEngine(tokenizer, MODEL, LAYA_OPERATING_LENGTH);
    const rows = loadTestRows();
    expect(rows.length).toBeGreaterThan(0);
    const destructive = rows.filter((r) => r.labels['is_destructive'] === true).slice(0, 20);
    const routine = rows.filter((r) => r.labels['is_destructive'] !== true).slice(0, 20);
    if (destructive.length === 0 || routine.length === 0) return;

    const elapsed: number[] = [];
    let destructiveSum = 0;
    for (const row of destructive) {
      const d = await engine.decide(row.text);
      elapsed.push(d.elapsedMs);
      destructiveSum += d.scores.is_destructive;
    }
    let routineSum = 0;
    for (const row of routine) {
      const d = await engine.decide(row.text);
      elapsed.push(d.elapsedMs);
      routineSum += d.scores.is_destructive;
    }

    elapsed.sort((a, b) => a - b);
    const p50 = elapsed[Math.floor(elapsed.length / 2)] as number;
    const destructiveMean = destructiveSum / destructive.length;
    const routineMean = routineSum / routine.length;
    // Printed so a run leaves a real number in CI output rather than only a
    // pass/fail. Compare against ml/l2_report.json before trusting the budget.
    console.log(
      `LAYA live: n=${elapsed.length} p50=${p50.toFixed(1)}ms destructiveMean=${destructiveMean.toFixed(3)} routineMean=${routineMean.toFixed(3)}`,
    );
    expect(p50).toBeLessThan(40);
    expect(destructiveMean).toBeGreaterThan(0.5);
    expect(destructiveMean).toBeGreaterThan(routineMean + 0.3);
  }, 120_000);

  test('a missing model surfaces as a rejected decision, not a silent 0.0', async () => {
    if (!live) return;
    const tokenizer = LayaBpeTokenizer.load(TOKENIZER);
    const engine = new LayaEngine(tokenizer, join('models', 'absent.onnx'), LAYA_OPERATING_LENGTH);
    await expect(engine.decide('hello')).rejects.toThrow();
  }, 30_000);
});
