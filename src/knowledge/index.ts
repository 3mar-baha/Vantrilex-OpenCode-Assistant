// Public surface of the knowledge layer.
//
// Reachability note: this module exists so `cli.ts` has a single stable import,
// and it is reachable from the composition root. The knowledge layer is NOT
// wired into the live narration path yet — that is a separate, reviewed step
// (`docs/personas/WIRING.md`), and claiming otherwise would be the exact
// "documented as shipped while unreachable" defect this project keeps hunting.
export { normalizeArabic, normalizeToken, tokenize, isIdempotent } from './normalize.js';
export { InMemoryRetriever } from './retriever.js';
export { screenText, guardText, REFUSAL_AR, type GuardVerdict } from './guard.js';
export { KAREEM, NOUR, PERSONAS, shieldHolds, type PersonaProfile } from './personas.js';
export {
  SHARED_CHUNKS,
  STYLISTIC_EXAMPLES,
  buildIndex,
  sharedDigest,
  verifyKnowledge,
  assertParity,
  type KnowledgeReport,
} from './build.js';
export {
  SHARED_HAS_NO_PERSONA,
  PARITY_INVARIANT,
  KnowledgeParityError,
  assertSharedChunks,
  type SharedChunk,
  type SharedHit,
  type StylisticExample,
} from './types.js';
export { ARCHITECTURE_CHUNKS } from './shared/architecture.js';
export { CAPABILITIES_CHUNKS } from './shared/capabilities.js';
export { COMMAND_CHUNKS } from './shared/commands.js';
export { FAILURE_CHUNKS } from './shared/failures.js';
export { LEXICON_CHUNKS } from './shared/lexicon.js';
export { NOUR_EXAMPLES } from './styles/nour.js';
export { KAREEM_EXAMPLES } from './styles/kareem.js';
