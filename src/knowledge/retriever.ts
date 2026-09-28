import { normalizeToken, tokenize } from './normalize.js';
import { assertSharedChunks, type SharedChunk, type SharedHit } from './types.js';

// In-process BM25 retrieval (G4D) — zero dependencies.
//
// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/, with two
// deliberate changes. Both are the ones the Arabic finding forced.
//
// 1. `normalizeToken` is applied on BOTH the index path and the query path. The
//    quarantined code normalized inside the scoring loop via a redundant second
//    `normalizeArabic(term)` call on terms that `tokenize` had already
//    normalized — harmless only because the normalizer is idempotent, and it
//    lowercased nothing. That mattered: a chunk storing `EADDRINUSE` and a
//    user typing `eaddrinuse` were two different terms. Latin runs are now
//    case-folded and Arabic runs are orthographically unified, through one
//    function, on both sides.
//
// 2. The index holds `SharedChunk` ONLY. There is no `persona` member to filter
//    on and no second index to differ, so both personas retrieve from one
//    identical index. The quarantined `search(query, topK, scopes)` third
//    argument is gone because per-persona scoping is precisely what the parity
//    requirement eliminates.
//
// The minisearch swap-in point still stands, and is still the same interface:
// swap the index construction and scoring, keep `search()`'s signature and the
// `SharedHit` return shape. minisearch does not normalize Arabic, so
// `normalizeToken` must be passed to it via `processTerm`/`tokenize` at BOTH
// index and query time — that wiring is the entire Arabic correctness risk of
// the swap, and it is why the hand-rolled analyzer stays as the test oracle.
const K1 = 1.2;
const B = 0.75;

interface IndexedDoc {
  readonly chunk: SharedChunk;
  /** term -> term frequency, precomputed. */
  readonly tf: ReadonlyMap<string, number>;
  readonly length: number;
}

export class InMemoryRetriever {
  private readonly docs: IndexedDoc[] = [];
  private readonly docFreq = new Map<string, number>();
  private avgLen = 0;

  constructor(chunks: readonly SharedChunk[]) {
    // Fails loudly on any chunk that crossed a boundary carrying a persona key.
    assertSharedChunks(chunks);
    let total = 0;
    for (const chunk of chunks) {
      const terms = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const term of terms) {
        const key = normalizeToken(term);
        tf.set(key, (tf.get(key) ?? 0) + 1);
      }
      this.docs.push({ chunk, tf, length: terms.length });
      total += terms.length;
      for (const term of tf.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = this.docs.length === 0 ? 0 : total / this.docs.length;
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, topK: number): SharedHit[] {
    if (topK <= 0) return [];
    const queryTerms = new Set(tokenize(query).map(normalizeToken));
    if (queryTerms.size === 0) return [];
    const n = this.docs.length;
    const scored: SharedHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term);
        if (tf === undefined) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / Math.max(1, this.avgLen)));
        score += idf * norm;
      }
      if (score > 0) scored.push({ ...doc.chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
