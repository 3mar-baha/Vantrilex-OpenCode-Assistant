import { normalizeArabic, tokenize } from './normalize.js';

// In-process BM25 retrieval (G4D) — zero dependencies. The approved minisearch
// integration is deferred: the root npm tree cannot accept new packages
// (full-tree re-resolution times out on native rebuilds), so retrieval ships
// as ~70 lines of dependency-free BM25 with the identical top-K contract.
// Swap-in point: replace InMemoryRetriever with a minisearch index behind
// this interface when the toolchain allows installs.
export type RagPersonaScope = 'shared' | 'kareem' | 'nour';

export interface RagChunk {
  readonly id: string;
  readonly persona: RagPersonaScope;
  readonly source: string;
  readonly text: string;
}

export interface RagHit extends RagChunk {
  readonly score: number;
}

const K1 = 1.2;
const B = 0.75;

export class InMemoryRetriever {
  private readonly docs: Array<{ chunk: RagChunk; terms: string[] }> = [];
  private readonly docFreq = new Map<string, number>();
  private avgLen = 0;

  constructor(chunks: readonly RagChunk[]) {
    let total = 0;
    for (const chunk of chunks) {
      const terms = tokenize(chunk.text);
      this.docs.push({ chunk, terms });
      total += terms.length;
      for (const term of new Set(terms)) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = this.docs.length === 0 ? 0 : total / this.docs.length;
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, topK: number, scopes?: readonly RagPersonaScope[]): RagHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || topK <= 0) return [];
    const allowed = scopes === undefined ? undefined : new Set<string>([...scopes, 'shared']);
    const scored: RagHit[] = [];
    for (const { chunk, terms: doc } of this.docs) {
      if (allowed !== undefined && !allowed.has(chunk.persona)) continue;
      let score = 0;
      for (const term of new Set(terms)) {
        const tf = doc.filter((t) => t === normalizeArabic(term)).length;
        if (tf === 0) continue;
        const df = this.docFreq.get(normalizeArabic(term)) ?? 0;
        const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * doc.length) / Math.max(1, this.avgLen)));
        score += idf * norm;
      }
      if (score > 0) scored.push({ ...chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
