// Arabic orthographic normalization (G4D Tier-D prefilter + BM25 analyzer).
// Unicode facts re-derived from the standard ranges — no third-party source
// copied: TASHKEEL U+064B–U+0652, TATWEEL U+0640, SMALL HIGH LIGATURES, ALEF
// variants U+0622/U+0623/U+0625/U+0671, ALEF MAKSURA U+0649.

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

/** Whitespace/punctuation split on the normalized form. */
export function tokenize(input: string): string[] {
  return normalizeArabic(input)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
}
