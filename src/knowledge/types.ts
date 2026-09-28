import type { PersonaId } from '../common/brands.js';

// ── Tier structure ───────────────────────────────────────────────────────────
// Information Parity, Stylistic Divergence.
//
// The quarantined design modelled this as a single `RagChunk` with a required
// `persona: 'shared' | 'kareem' | 'nour'` field. That is the right *shape* but a
// weak *guarantee*: `shared` is a label a future author could simply get wrong,
// and persona chunks shared one index, so a single mislabelled chunk would have
// quietly given one persona a fact the other could not retrieve.
//
// The restructure below makes asymmetry unrepresentable instead of merely
// discouraged. Two changes, both structural:
//
//   1. `SharedChunk` has NO `persona` member. It is not filterable by persona,
//      so it cannot diverge. Verified by `SHARED_HAS_NO_PERSONA` below, which is
//      enforced by `tsc` because this file is in `src/` — a guard placed in a
//      `.test.ts` would be enforced nowhere, because `tsconfig.json` excludes
//      `**/*.test.ts` and Vitest does not typecheck.
//   2. `StylisticExample` has NO `text` member. It is never indexed and never
//      retrieved, so there is no field in which a fact, a number, a capability
//      or a lexicon entry could be smuggled. Styling is selected by `when`,
//      not by search — which is why the two personas cannot disagree about what
//      is true: they query one identical index, and only the wrapper differs.

/** Tier 1 — shared ground truth. Carries no persona, by design and by type. */
export interface SharedChunk {
  readonly id: string;
  /** Provenance: repo path or upstream reference. Never a secret. */
  readonly source: string;
  readonly text: string;
}

export interface SharedHit extends SharedChunk {
  readonly score: number;
}

/**
 * Tier 2 / Tier 3 — styling only. Deliberately has no `text`, `fact`, `value`
 * or `capability` field, so no fact can be placed in one.
 */
export interface StylisticExample {
  readonly id: string;
  readonly persona: PersonaId;
  /** Condition under which this construction applies, in plain English. */
  readonly when: string;
  /** How the persona says it. Ammani; technical terms stay in English. */
  readonly say: string;
}

/**
 * COMPILE-TIME parity proof. If a `persona` member is ever added to
 * `SharedChunk`, the `false` literal stops typechecking and `npm run typecheck`
 * fails. Deliberately a value assignment, not `@ts-expect-error`, so the failure
 * is loud rather than silently inverted.
 */
type HasPersona = 'persona' extends keyof SharedChunk ? true : false;
export const SHARED_HAS_NO_PERSONA: HasPersona = false;

/** Runtime mirror of the compile-time proof, for data that crossed a boundary. */
export class KnowledgeParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeParityError';
  }
}

/**
 * Throws if any Tier 1 chunk carries a persona key at runtime.
 *
 * The type already forbids this, so this catches the cases the type cannot:
 * `as unknown as SharedChunk` casts, chunks loaded from JSON, and objects
 * spread from a wider source. Cheap, and it makes the guarantee hold at the
 * point the data is actually consumed rather than only at the type boundary.
 */
export function assertSharedChunks(chunks: readonly SharedChunk[]): void {
  for (const chunk of chunks) {
    if (Object.prototype.hasOwnProperty.call(chunk, 'persona')) {
      throw new KnowledgeParityError(
        `Tier 1 chunk "${chunk.id}" carries a persona key. Tier 1 is shared truth and must not be persona-scoped; move it to a StylisticExample or drop the key.`,
      );
    }
  }
}

/**
 * The parity invariant, stated once so a reviewer has a single thing to check:
 * every persona retrieves from ONE index built from `SharedChunk` only. There is
 * no per-persona index, so there is no mechanism by which one persona could be
 * given knowledge the other lacks.
 */
export const PARITY_INVARIANT =
  'One index, SharedChunk only. Styling is selected by `when`, never retrieved. No per-persona index exists.';
