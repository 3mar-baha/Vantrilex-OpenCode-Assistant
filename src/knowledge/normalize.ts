// Arabic orthographic normalization (G4D Tier-D prefilter + BM25 analyzer).
// Unicode facts re-derived from the standard ranges — no third-party source
// copied: TASHKEEL U+064B–U+0652, TATWEEL U+0640, SMALL HIGH LIGATURES, ALEF
// variants U+0622/U+0623/U+0625/U+0671, ALEF MAKSURA U+0649.
//
// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/ in the
// dialect-locked Ammani phase. Verified live, not merely revived: this module is
// now inside `rootDir: "src"`, so `tsc` typechecks it and `retriever.ts` calls
// it on BOTH the index path and the query path.
const TASHKEEL_TATWEEL = /[ً-ٲٰـ]/g;
const ALEF_VARIANTS = /[آأإٱ]/g;
const ALEF_MAKSURA = /ى/g;

/** NFKC + strip tashkeel/tatweel + unify alef/yeh forms. Idempotent. */
export function normalizeArabic(input: string): string {
  return input
    .normalize('NFKC')
    .replace(TASHKEEL_TATWEEL, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(ALEF_MAKSURA, 'ي');
}

/**
 * Idempotence is load-bearing, not incidental: `retriever.ts` normalizes on the
 * index path and again on the query path. A non-idempotent normalizer would make
 * an indexed term unfindable by its own query. Verified by test, not by comment.
 */
export function isIdempotent(input: string): boolean {
  const once = normalizeArabic(input);
  return normalizeArabic(once) === once;
}

/** Whitespace/punctuation split on the normalized form. */
export function tokenize(input: string): string[] {
  return normalizeArabic(input)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Latin tokens are lowercased but otherwise preserved verbatim.
 *
 * The product rule is that code identifiers, paths, logs, error codes, sessions
 * and commands stay in English inside an Arabic sentence. Normalizing those
 * through `normalizeArabic` is a no-op for ASCII, but case-folding them is
 * *required*: a query for `EADDRINUSE` must reach a chunk that stores it in
 * lower case, and vice versa. NFKC is deliberately not applied to the Latin run,
 * so `ﬁ` and `²` in identifiers are not silently rewritten.
 */
export function normalizeToken(term: string): string {
  return /[\u0600-\u06FF]/.test(term) ? normalizeArabic(term) : term.toLowerCase();
}
