import { describe, expect, test } from 'vitest';
import { isIdempotent, normalizeArabic, normalizeToken, tokenize } from './normalize.js';

// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/.
// The 5 original cases are kept verbatim. `normalizeToken` is new and is the
// fix the Arabic finding forced: the quarantined analyzer lowercased nothing,
// so a chunk storing EADDRINUSE and a user typing eaddrinuse were two terms.
describe('normalizeArabic', () => {
  test('strips tashkeel, tatweel, and small alef', () => {
    expect(normalizeArabic('مَرحَباًـٱ')).toBe('مرحبا');
  });

  test('unifies alef variants and alef-maksura', () => {
    expect(normalizeArabic('أحمد إسلام آمنوا الّي')).toBe('احمد اسلام امنوا الي');
  });

  test('NFKC folding applies (compatibility forms)', () => {
    expect(normalizeArabic('ﻻ')).toBe('لا');
  });

  test('Tier-D evasion with diacritics collapses to the base form', () => {
    expect(normalizeArabic('قَتَلَ')).toBe('قتل');
    expect(normalizeArabic('قـتـل')).toBe('قتل');
  });
});

describe('tokenize', () => {
  test('splits on whitespace/punctuation, drops empties', () => {
    expect(tokenize('بدي احجز، تكسي! من المطار؟')).toEqual(['بدي', 'احجز', 'تكسي', 'من', 'المطار']);
  });
});

describe('normalizeArabic idempotence', () => {
  // load-bearing: the retriever normalizes on the index path AND the query path.
  // A non-idempotent normalizer would make an indexed term unfindable by its
  // own query, which is a silent recall failure with no error.
  test('normalizing twice equals normalizing once', () => {
    for (const s of ['أحمد', 'إسلام', 'آمنوا', 'الّي', 'قَتَلَ', 'مَرحَباًـٱ', 'ﻻ', 'ى']) {
      expect(isIdempotent(s)).toBe(true);
    }
  });
});

describe('normalizeToken', () => {
  test('Arabic runs are orthographically unified', () => {
    // آ / أ / إ / ا collapse. An earlier draft of this test used
    // `الّي` vs `اللي` and failed: normalizeArabic maps ALEF MAKSURA ى -> ي, so
    // `الّي` becomes `الي`, while `اللي` (which already ends in U+064A) is
    // correctly left alone. The two spellings are genuinely distinct inputs,
    // so that was a bad example, not a bug in the normalizer. These are the
    // pairs the rule is actually for.
    expect(normalizeToken('أحمد')).toBe(normalizeToken('آحمد'));
    expect(normalizeToken('الّذي')).toBe(normalizeToken('الذي'));
    expect(normalizeToken('إسلام')).toBe(normalizeToken('اسلام'));
  });

  test('Latin runs are case-folded so identifiers match either way', () => {
    expect(normalizeToken('EADDRINUSE')).toBe('eaddrinuse');
    expect(normalizeToken('Vitest')).toBe('vitest');
  });

  test('a Latin identifier is NOT Arabic-normalized', () => {
    // regression guard: routing everything through normalizeArabic would be a
    // no-op for ASCII, but the separation is what keeps the two path honest.
    expect(normalizeToken('mp3')).toBe('mp3');
    expect(normalizeToken('s2.1-pro-free')).toBe('s2.1-pro-free');
  });
});

describe('known normalization boundaries (measured, not assumed)', () => {
  // Both of these were found by querying the built CLI, not by reading the
  // regexes. They are pinned here so a future change to the normalizer has to
  // make a deliberate decision instead of silently moving the boundary.
  test('taa marbuta is NOT collapsed to heh', () => {
    // `الاعتمادية` and `الاعتماديه` are different tokens. Collapsing them is a
    // real recall win for typed Arabic, but ة and ه are distinct letters and
    // merging them produces false matches. Voxaura is voice-driven — the
    // narrator generates the query, the user does not type it — so the recall
    // loss is small and the false-positive risk is not worth it. Revisit only
    // with a measurement, not a hunch.
    expect(normalizeArabic('الاعتمادية')).not.toBe(normalizeArabic('الاعتماديه'));
  });

  test('there is no stemming: plural does not match singular', () => {
    // BM25 scores exact normalized tokens. `الاعتماديات` (plural) does not
    // reach a chunk storing `الاعتمادية` (singular). Fixing this means adding a
    // stemmer, which is a real dependency and was explicitly ruled out; the
    // corpus is written to contain the forms the narrator actually emits.
    expect(normalizeArabic('الاعتماديات')).not.toBe(normalizeArabic('الاعتمادية'));
  });
});
