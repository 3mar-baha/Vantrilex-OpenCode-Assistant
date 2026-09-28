import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LAYA_HEADS, LAYA_OPERATING_LENGTH } from './constants.js';
import { LAYA_MODEL_PATH_DEFAULT, loadLayaAdvisory } from './loader.js';
import { emitLayaTelemetry, layaTelemetryRow } from './telemetry.js';
import type { LayaTelemetrySink } from './telemetry.js';
import type { TelemetryInput } from '../../telemetry/index.js';

// The seam (`loader.ts`) is the only thing the daemon is meant to call, so these
// tests are about the three states a shipped build is actually in:
//
//   1. no model / no tokenizer  -> `null`, one DEGRADED telemetry row, no throw
//   2. model + tokenizer present -> a façade that never throws from `decide`
//   3. the native graph fails at decide time -> `null` from decide, still no throw
//
// Case 1 is the one an installed build takes: neither the 40 MB HF tokenizer nor
// a bundled native binary is shipped, so a loader that threw here would be a
// second v0.6.0 wearing a different hat.

type Row = Omit<TelemetryInput, 'sessionId' | 'eventId'>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'voxaura-laya-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function collector(): { rows: Row[]; sink: LayaTelemetrySink } {
  const rows: Row[] = [];
  return { rows, sink: (input) => void rows.push(input) };
}

/** A minimal but structurally valid checkpoint tokenizer spec. */
function writeTokenizer(name = 'tokenizer.json'): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      model: { type: 'BPE', vocab: { '<pad>': 0, '<eos>': 1, '<bos>': 2, '<unk>': 3, '▁a': 4, a: 5 }, merges: [], byte_fallback: true },
      post_processor: { special_tokens: { '<bos>': { ids: [2] }, '<eos>': { ids: [1] } } },
    }),
    'utf8',
  );
  return path;
}

describe('loadLayaAdvisory fail-soft contract', () => {
  test('no tokenizer path is an ordinary state, not an exception', async () => {
    const { rows, sink } = collector();
    // Deliberately no tokenizerPath and no LAYA_TOKENIZER_PATH: this is what the
    // installed build does, every time.
    const loaded = await loadLayaAdvisory({ env: {}, modelPath: join(dir, 'laya.onnx'), sink });
    expect(loaded).toBeNull();
    expect(rows).toEqual([
      {
        subsystem: 'LAYA',
        status: 'DEGRADED',
        latencyMs: expect.any(Number) as number,
        errorCode: 'CONFIG_INVALID',
        sanitizedErrorClass: 'OnnxError',
      },
    ]);
  });

  test('a missing model file degrades instead of throwing', async () => {
    const { rows, sink } = collector();
    const loaded = await loadLayaAdvisory({
      env: {},
      tokenizerPath: writeTokenizer(),
      modelPath: join(dir, 'definitely-absent.onnx'),
      sink,
    });
    expect(loaded).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('DEGRADED');
  });

  test('a corrupt tokenizer degrades instead of throwing', async () => {
    // The dynamic import succeeds here; the failure is `JSON.parse` inside the
    // try. If that try were removed, an operator with a truncated download would
    // take the whole daemon down over an advisory head.
    const { rows, sink } = collector();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ this is not json', 'utf8');
    const loaded = await loadLayaAdvisory({
      env: {},
      tokenizerPath: bad,
      modelPath: join(dir, 'laya.onnx'),
      sink,
    });
    expect(loaded).toBeNull();
    expect(rows[0]?.sanitizedErrorClass).toBe('OnnxError');
  });

  test('a present model and tokenizer yield a façade that names the heads', async () => {
    const { rows, sink } = collector();
    const model = join(dir, 'laya.onnx');
    writeFileSync(model, 'not-really-onnx', 'utf8');
    const loaded = await loadLayaAdvisory({ env: {}, tokenizerPath: writeTokenizer(), modelPath: model, sink });
    expect(loaded).not.toBeNull();
    expect(loaded?.heads).toEqual(LAYA_HEADS);
    expect(loaded?.operatingLength).toBe(LAYA_OPERATING_LENGTH);
    // Construction alone must not report anything: no decision was made.
    expect(rows).toEqual([]);
  });

  test('decide() fails OPEN when the graph cannot load — the caller speaks', async () => {
    const { rows, sink } = collector();
    const model = join(dir, 'laya.onnx');
    writeFileSync(model, 'not-really-onnx', 'utf8');
    const loaded = await loadLayaAdvisory({ env: {}, tokenizerPath: writeTokenizer(), modelPath: model, sink });
    expect(loaded).not.toBeNull();
    // The real ORT session is created lazily inside decide(), so a garbage graph
    // throws HERE, not at load time. The façade must absorb it.
    const decision = await loaded?.decide('احذف الملفات');
    expect(decision).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subsystem).toBe('LAYA');
    expect(rows[0]?.status).toBe('DEGRADED');
  });

  test('env vars are the documented override, and the default path is the repo one', async () => {
    expect(LAYA_MODEL_PATH_DEFAULT).toBe('models/laya-m7-int8.onnx');
    const { sink } = collector();
    // Both env vars honoured: a valid model file plus a valid tokenizer, named
    // only through the environment, must produce a façade. Anything less would
    // be satisfied by a loader that ignores the environment entirely.
    const model = join(dir, 'from-env.onnx');
    writeFileSync(model, 'not-really-onnx', 'utf8');
    const fromEnv = await loadLayaAdvisory({
      env: { LAYA_TOKENIZER_PATH: writeTokenizer('env-tokenizer.json'), LAYA_MODEL_PATH: model },
      sink,
    });
    expect(fromEnv).not.toBeNull();
    // The default model path really is `models/laya-m7-int8.onnx` relative to the
    // repo. That file is gitignored, so the outcome is whatever existsSync says
    // — asserted rather than assumed, because "the default works" is exactly the
    // claim a packaged build would get wrong.
    const defaultPresent = existsSync(LAYA_MODEL_PATH_DEFAULT);
    const viaDefault = await loadLayaAdvisory({ env: { LAYA_TOKENIZER_PATH: writeTokenizer() }, sink });
    expect(viaDefault === null).toBe(!defaultPresent);
  });

  test('a null sink is a valid configuration, not a crash', async () => {
    await expect(loadLayaAdvisory({ env: {}, sink: null })).resolves.toBeNull();
  });

  test('a throwing sink cannot break the loader', async () => {
    const exploding: LayaTelemetrySink = () => {
      throw new Error('the diagnostics bus is down');
    };
    await expect(loadLayaAdvisory({ env: {}, sink: exploding })).resolves.toBeNull();
  });
});

describe('layaTelemetryRow mapping', () => {
  test('a healthy decision is OK and carries no error code', () => {
    const row = layaTelemetryRow({ ok: true, latencyMs: 25 });
    expect(row).toEqual({ subsystem: 'LAYA', status: 'OK', latencyMs: 25 });
    // No code: the closed union (writer.ts:38-61) has no LAYA member and
    // writer.ts:45-48 forbids borrowing a sibling subsystem's code.
    expect('errorCode' in row).toBe(false);
  });

  test('missing heads are DEGRADED / ContractDrift, never a silent OK', () => {
    // laya-engine.ts scores a missing `logit_*` as 0.0, which downstream reads
    // as "confidently not destructive". That is the dangerous case, not a null.
    const row = layaTelemetryRow({ ok: true, latencyMs: 11, missingHeads: ['barge_in'] });
    expect(row.status).toBe('DEGRADED');
    expect(row.sanitizedErrorClass).toBe('ContractDrift');
  });

  test('unavailable is DEGRADED + CONFIG_INVALID, never ERROR', () => {
    // Laya is advisory. An ERROR row would page someone for a missing optional
    // model, which is exactly the "a lie in the data" the writer forbids.
    const row = layaTelemetryRow({ unavailable: true, latencyMs: 0 });
    expect(row.status).toBe('DEGRADED');
    expect(row.errorCode).toBe('CONFIG_INVALID');
    expect(row.sanitizedErrorClass).toBe('OnnxError');
  });

  test('a row can never carry text — the anti-injection invariant holds', () => {
    const row = layaTelemetryRow({ ok: false, latencyMs: 3, sanitizedErrorClass: 'OnnxError' });
    const keys = Object.keys(row).sort();
    expect(keys).toEqual(['latencyMs', 'sanitizedErrorClass', 'status', 'subsystem']);
    // Mirrors src/policy/telemetry-wired.test.ts:109.
    expect(JSON.stringify(row)).not.toMatch(/transcript|utterance|prompt|reply|text/i);
  });

  test('emitLayaTelemetry with a null sink emits nothing and does not throw', () => {
    expect(() => emitLayaTelemetry(null, { ok: true, latencyMs: 1 })).not.toThrow();
  });
});
