// Laya System-1 (M7 L3) — public surface.
//
// READ THIS BEFORE IMPORTING FROM HERE.
// `laya-engine.ts` statically imports `onnxruntime-node`, a native module the
// Windows sidecar does not bundle. Because this barrel re-exports it, a STATIC
// `import ... from './runtime/laya/index.js'` anywhere in the daemon's import
// graph is fatal at module-load time — the v0.6.0 failure class.
//
// From the daemon, import ONLY `loader.js` and only through `import()`:
//
//   layaLoad = import('./runtime/laya/loader.js')
//     .then((m) => m.loadLayaAdvisory())
//     .catch(() => null);
//
// `loader.js` is safe even statically: it reaches the engine via `import()`.
// This barrel is not. `src/policy/laya-sidecar-safety.test.ts` enforces it.
export { LAYA_HEADS, LAYA_OPERATING_LENGTH } from './constants.js';
export type { LayaHead } from './constants.js';
export { loadLayaAdvisory, LAYA_MODEL_PATH_DEFAULT } from './loader.js';
export type { LayaAdvisory, LoadLayaOptions } from './loader.js';
export { emitLayaTelemetry, layaTelemetryRow } from './telemetry.js';
export type { LayaTelemetryFacts, LayaTelemetryRow, LayaTelemetrySink } from './telemetry.js';
export type { LayaTokenizer, TokenizerJson } from './tokenizer.js';
export { LayaBpeTokenizer } from './tokenizer.js';
export type { LayaDecision } from './types.js';
// The engine + its ORT-dependent types. Re-exported for tooling and tests only.
export type { LayaSession } from './laya-engine.js';
export { LayaEngine } from './laya-engine.js';
