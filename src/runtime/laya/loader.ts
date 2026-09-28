import { existsSync } from 'node:fs';
import { LAYA_HEADS, LAYA_OPERATING_LENGTH } from './constants.js';
import type { LayaHead } from './constants.js';
import { LayaBpeTokenizer } from './tokenizer.js';
import { emitLayaTelemetry, type LayaTelemetrySink } from './telemetry.js';
import type { LayaDecision } from './types.js';

// The ONE sanctioned door to the Laya engine.
//
// Why this file exists and why it looks the way it does:
//
//   `laya-engine.ts` statically imports `onnxruntime-node`, a NATIVE module the
//   Windows sidecar does not bundle. In v0.6.0 a single static import of such a
//   module anywhere in the daemon's import graph killed the whole module graph
//   with ERR_MODULE_NOT_FOUND, so 4097 never bound — with every gate green,
//   because E2E drives a stub daemon (src/policy/sidecar-safety.test.ts:5-14).
//
//   `vad.ts` solved this by being loaded through `import('./runtime/vad.js')`
//   at daemon.ts:338. This module is the same idea one level more defensive:
//
//   1. `loadLayaAdvisory()` reaches the engine through `await import(...)`, so
//      a MISSING native package is a rejected promise the caller `.catch()`es —
//      lazy and catchable, not fatal. That is the whole point of v0.6.1.
//   2. This file holds NO specifier-bearing edge to `laya-engine.js` at all —
//      not even an erased `import type` — so even a static
//      `import { loadLayaAdvisory } from './runtime/laya/loader.js'` in the
//      daemon is survivable. Two layers, so one careless re-export cannot
//      re-arm the v0.6.0 failure. The `LayaDecision` type was moved to
//      ./types.js for exactly this reason.
//
// Verified in `src/policy/laya-sidecar-safety.test.ts`, which walks the daemon's
// real import graph and fails if `laya-engine.ts` ever becomes statically
// reachable. Do not "simplify" the dynamic import away.

/** Structural face of the engine, so no consumer needs the ORT types. */
export interface LayaAdvisory {
  /** `null` when the advisory model is unavailable; the caller then speaks. */
  decide(text: string): Promise<LayaDecision | null>;
  readonly heads: readonly LayaHead[];
  readonly operatingLength: number;
}

export interface LoadLayaOptions {
  /** Defaults to `LAYA_MODEL_PATH`, then `models/laya-m7-int8.onnx`. */
  readonly modelPath?: string;
  /**
   * Required and NOT defaulted to a repo path. The checkpoint tokenizer.json is
   * a ~40 MB HuggingFace artifact that is not vendored here (see the archived
   * integration test's HF_TOKENIZER path). Absent it there is nothing to load,
   * and `null` is the honest answer.
   */
  readonly tokenizerPath?: string;
  /** Defaults to `LAYA_TOKENIZER_PATH`. */
  readonly env?: NodeJS.ProcessEnv;
  /** daemon.ts's `record`. `null` disables telemetry rather than crashing. */
  readonly sink?: LayaTelemetrySink | null;
}

export const LAYA_MODEL_PATH_DEFAULT = 'models/laya-m7-int8.onnx';

function resolveModelPath(options: LoadLayaOptions): string {
  return options.modelPath ?? options.env?.['LAYA_MODEL_PATH'] ?? LAYA_MODEL_PATH_DEFAULT;
}

function resolveTokenizerPath(options: LoadLayaOptions): string | null {
  return options.tokenizerPath ?? options.env?.['LAYA_TOKENIZER_PATH'] ?? null;
}

/**
 * Build the advisory façade, or `null` if anything is missing.
 *
 * Never throws. A missing ONNX model, an absent tokenizer and a missing native
 * binary are all ordinary states for a shipped build, and Laya is advisory:
 * the caller is expected to speak regardless.
 */
export async function loadLayaAdvisory(options: LoadLayaOptions = {}): Promise<LayaAdvisory | null> {
  const startedAt = Date.now();
  const sink = options.sink ?? null;
  const modelPath = resolveModelPath(options);
  const tokenizerPath = resolveTokenizerPath(options);
  if (tokenizerPath === null || !existsSync(modelPath)) {
    emitLayaTelemetry(sink, {
      unavailable: true,
      latencyMs: Date.now() - startedAt,
      sanitizedErrorClass: 'OnnxError',
    });
    return null;
  }

  let engine: {
    decide(text: string): Promise<LayaDecision>;
  };
  try {
    const mod = await import('./laya-engine.js');
    // The tokenizer is dependency-free (node:fs only), so it is loaded eagerly
    // and cheaply; only the ORT-backed engine is deferred.
    const tokenizer = LayaBpeTokenizer.load(tokenizerPath);
    engine = new mod.LayaEngine(tokenizer, modelPath, LAYA_OPERATING_LENGTH);
  } catch {
    // The native binding is missing, the graph is corrupt, the vocab is the
    // wrong shape. All of it is "advisory unavailable", not a daemon failure.
    emitLayaTelemetry(sink, {
      unavailable: true,
      latencyMs: Date.now() - startedAt,
      sanitizedErrorClass: 'OnnxError',
    });
    return null;
  }

  return {
    heads: LAYA_HEADS,
    operatingLength: LAYA_OPERATING_LENGTH,
    async decide(text: string): Promise<LayaDecision | null> {
      const at = Date.now();
      try {
        const decision = await engine.decide(text);
        const missing = LAYA_HEADS.filter((head) => decision.scores[head] === undefined);
        emitLayaTelemetry(sink, {
          ok: missing.length === 0,
          latencyMs: decision.elapsedMs,
          ...(missing.length > 0 ? { missingHeads: missing } : {}),
        });
        return decision;
      } catch (err) {
        // Fail OPEN (the engine's own design, laya-engine.ts:80-82): an engine
        // error means the LLM path speaks, it does not mean the daemon dies.
        emitLayaTelemetry(sink, {
          latencyMs: Date.now() - at,
          sanitizedErrorClass: err instanceof Error && err.name === 'Error' ? 'OnnxError' : 'Unknown',
        });
        return null;
      }
    },
  };
}
