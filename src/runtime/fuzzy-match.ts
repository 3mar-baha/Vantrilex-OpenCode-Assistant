// Phase 5 — fuzzy model/agent resolution.
//
// The user speaks; the catalog holds machine ids. "ماوس سبارك", "muse spark" and
// "muse-spark" must all land on `muse-spark`.
//
// Two rules that matter more than the matching itself:
//   1. NEVER guess. If two candidates match equally well, return null. Silently
//      switching a heavy task to the wrong model because two names were close
//      is worse than asking.
//   2. Never interpret. This is string matching, so nothing here can be turned
//      into a command by a crafted input.
//
// Matching strategy, in order of confidence: exact → alias → prefix →
// subsequence. A candidate is only accepted if it is UNIQUE at the best tier
// that matched.

/** Arabic spellings a speaker actually produces, mapped to ascii. */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ني?موترون|نيموترون|نيموتورن/g, 'nemotron'],
  [/م[وو]س[\s-]*سبار[كخ]/g, 'muse-spark'],
  [/دوتس/g, 'dots'],
  [/ج?بتي-?opus|كل[اا]ود/g, 'claude-opus'],
  [/جي-?بي-?تي/g, 'gpt'],
  [/سيمسون|س[وو]ن/g, 'sonnet'],
];

/**
 * Canonical form for comparison: lowercase, separators and Arabic decoration
 * removed, alef/ya folded. Folding alef variants is CORRECT here (unlike in the
 * TTS sanitiser) because we are matching a sound, not spelling.
 */
export function normalizeForMatch(input: string): string {
  let s = input.normalize('NFKD');
  // Latin accents, Arabic harakat and tatweel.
  s = s.replace(/[\u0300-\u036f]/g, '').replace(/[\u064B-\u0652\u0670\u0640]/g, '');
  for (const [re, ascii] of TRANSLITERATIONS) s = s.replace(re, ascii);
  s = s
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
  // Everything that is not a letter or digit becomes nothing: separators,
  // punctuation, spaces and shell metacharacters all collapse together.
  s = s.replace(/[^\p{L}\p{N}]+/gu, '');
  return s.toLowerCase();
}

/** True when `needle` appears in `hay` in order, not necessarily adjacent. */
function isSubsequence(needle: string, hay: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * Resolve a spoken phrase to exactly one catalog entry, or null.
 *
 * `aliases` maps a normalized spoken form to a catalog id, for names that
 * normalisation alone cannot bridge.
 */
export function fuzzyPick(
  query: string,
  catalog: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string | null {
  const q = normalizeForMatch(query);
  if (q.length === 0 || catalog.length === 0) return null;

  const alias = aliases[q];
  if (alias !== undefined && catalog.includes(alias)) return alias;

  const norm = catalog.map((id) => ({ id, key: normalizeForMatch(id) }));

  // Tier 1: exact.
  const exact = norm.filter((c) => c.key === q);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;

  // Tier 2: prefix. Must be UNIQUE. If two ids both start with what was said,
  // we ask rather than guess — switching a heavy task to the wrong model is
  // worse than one extra question.
  const prefix = norm.filter((c) => c.key.startsWith(q));
  if (prefix.length === 1) return prefix[0]!.id;
  if (prefix.length > 1) return null;

  // Tier 3: substring.
  const sub = norm.filter((c) => c.key.includes(q));
  if (sub.length === 1) return sub[0]!.id;
  if (sub.length > 1) return null;

  // Tier 4: subsequence (spoken, letters dropped by STT).
  const seq = norm.filter((c) => isSubsequence(q, c.key));
  if (seq.length === 1) return seq[0]!.id;

  return null;
}

/** Every catalog entry, for "did you mean" style recovery without guessing. */
export function fuzzyCandidates(query: string, catalog: readonly string[]): string[] {
  const q = normalizeForMatch(query);
  if (q.length === 0) return [];
  return catalog.filter((id) => {
    const key = normalizeForMatch(id);
    return key.includes(q) || isSubsequence(q, key);
  });
}
