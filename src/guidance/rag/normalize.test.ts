import { describe, expect, test } from 'vitest';
import { normalizeArabic, tokenize } from './normalize.js';

// G4D — Arabic orthographic normalization before Tier-D matching and BM25.
// Codepoints re-derived from published Unicode ranges (no GPL source copied).
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
