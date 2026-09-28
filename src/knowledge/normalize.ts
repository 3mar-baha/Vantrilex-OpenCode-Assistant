// Arabic orthographic normalization (G4D Tier-D prefilter + BM25 analyzer).
// Unicode facts re-derived from the standard ranges — no third-party source
// copied: TASHKEEL U+064B–U+0652, TATWEEL U+0640, SMALL HIGH LIGATURES, ALEF
// variants U+0622/U+0623/U+0625/U+0671, ALEF MAKSURA U+0649.
//
// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/ in the
// dialect-locked Ammani phase. Verified live, not merely revived: this module is
// now inside `rootDir: "src"`, so `tsc` typechecks it and `retriever.ts` calls
// it on BOTH the index path and the query path.
//
// RANGES ARE WRITTEN AS \u ESCAPES, NOT AS DASH LITERALS. The restored comment
// claimed this class was `U+064B-U+0652`; the actual literal `U+064B-U+0672` is
// a range that swallows the ARABIC-INDIC DIGITS U+0660-U+0669, plus U+066B and
// U+066C. So `المنفذ ٤٠٩٦ مشغول` normalized to `المنفذ  مشغول` and the port
// number was deleted from the query before scoring - a silent recall failure in
// exactly the product this project cares about (a user asking "is port 4096
// busy", in the numerals an Arabic speaker actually types). Found by forensic
// audit, reproduced, then fixed.
//
// An explicit escape list makes the exclusion auditable: the GAPS are the
// comment. U+0671 (wasla alef) stays in the stripped class because the restored
// normalization test asserts it is removed.
const TASHKEEL = /[\u064B-\u065F\u066A\u066D-\u0672]/g; // harakat + wasla alef, NOT the digits
const TATWEEL = /\u0640/g; // U+0640 ARABIC TATWEEL
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g; // alef + hamza variants
const ALEF_MAKSURA = /\u0649/g; // U+0649 alef maksura -> yeh

/**
 * NFKC + strip tashkeel/tatweel + unify alef/yeh forms. Idempotent.
 *
 * Digits are NOT normalized. The buggy range deleted Arabic-Indic digits
 * outright; folding `٤٠٩٦` to ASCII `4096` would also be wrong, because the
 * corpus stores whatever form the author wrote and a half-folded pair is worse
 * than an honest miss. Preserving both forms is the correct trade: recall for
 * "المنفذ 4096" comes from the Latin `4096` in the same chunk, and recall for
 * "المنفذ ٤٠٩٦" comes from the digit surviving to be tokenized.
 */
export function normalizeArabic(input: string): string {
  return input
    .normalize('NFKC')
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
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
