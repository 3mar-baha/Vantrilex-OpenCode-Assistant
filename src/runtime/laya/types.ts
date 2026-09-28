import type { LayaHead } from './constants.js';

// Dependency-free Laya types.
//
// These live apart from `laya-engine.ts` for the same reason `constants.ts`
// does: `loader.ts` — the one module the daemon is allowed to name — needs
// `LayaDecision` to describe its return value, and it must not hold ANY
// specifier-bearing edge to the engine, not even an erased `import type`.
//
// An `import type` is safe (TypeScript erases it unconditionally), so a graph
// walker that counts it as a runtime edge is being conservative, not wrong. But
// "safe if you know the rule" is a worse property than "there is nothing there":
// the whole point of the v0.6.1 fix is that a reader of `loader.ts` can see the
// safety without knowing a compiler subtlety. So the edge is removed instead of
// exempted. See `src/policy/laya-sidecar-safety.test.ts`.

export interface LayaDecision {
  readonly scores: Record<LayaHead, number>;
  /** Wall-clock cost of this decision, tokenizer included. */
  readonly elapsedMs: number;
  readonly at: string;
}
