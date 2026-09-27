import { describe, expect, test } from 'vitest';
import { fuzzyPick, normalizeForMatch } from './fuzzy-match.js';

// Phase 5 — the user says "ماوس سبارك" or "muse spark" out loud; the catalog
// says `muse-spark`. The matcher has to bridge that gap WITHOUT ever falling
// back to "I could not find it, here is a list" as the first thing it tries,
// and without silently picking the wrong one when several candidates are close.
describe('normalizeForMatch', () => {
  test('is case, separator and whitespace insensitive', () => {
    const a = normalizeForMatch('muse-spark');
    expect(normalizeForMatch('MUSE_SPARK')).toBe(a);
    expect(normalizeForMatch('muse spark')).toBe(a);
    expect(normalizeForMatch('  Muse.Spark  ')).toBe(a);
  });

  test('strips Arabic diacritics and tatweel so spoken Arabic matches', () => {
    expect(normalizeForMatch('مُحَمَّد')).toBe(normalizeForMatch('محمد'));
    expect(normalizeForMatch('كتـــاب')).toBe(normalizeForMatch('كتاب'));
  });

  test('folds alef and ya variants that are pronounced the same', () => {
    // Unlike the TTS sanitiser, here folding is correct: these are the same
    // sound to a listener, and we are matching what was HEARD, not spelling.
    expect(normalizeForMatch('أ、湖北')).toBe(normalizeForMatch('ا、湖北'));
  });

  test('returns an empty string for empty or symbol-only input', () => {
    expect(normalizeForMatch('')).toBe('');
    expect(normalizeForMatch('   ')).toBe('');
    expect(normalizeForMatch('---')).toBe('');
  });
});

describe('fuzzyPick', () => {
  const catalog = ['muse-spark', 'nemotron', 'dots-3-note-preview', 'gpt-5', 'claude-opus-5'];

  test('an exact id wins', () => {
    expect(fuzzyPick('nemotron', catalog)).toBe('nemotron');
    expect(fuzzyPick('muse-spark', catalog)).toBe('muse-spark');
  });

  test('a spoken phrase resolves to the hyphenated id', () => {
    expect(fuzzyPick('muse spark', catalog)).toBe('muse-spark');
    expect(fuzzyPick('muse_spark', catalog)).toBe('muse-spark');
    expect(fuzzyPick('MUSE SPARK', catalog)).toBe('muse-spark');
  });

  test('a partial name resolves when it is unambiguous', () => {
    expect(fuzzyPick('nemot', catalog)).toBe('nemotron');
    expect(fuzzyPick('opus', catalog)).toBe('claude-opus-5');
  });

  test('a known transliteration alias resolves', () => {
    // "نيموترون" is how a speaker pronounces nemotron.
    expect(fuzzyPick('نيموترون', catalog)).toBe('nemotron');
    expect(fuzzyPick('موس سبارك', catalog)).toBe('muse-spark');
  });

  test('returns null when nothing is close enough', () => {
    // Guessing here would silently switch a model the user did not ask for.
    expect(fuzzyPick('completely-unrelated-token', catalog)).toBeNull();
    expect(fuzzyPick('', catalog)).toBeNull();
  });

  test('returns null rather than guessing when two candidates are equally good', () => {
    const ambiguous = ['alpha-model', 'alpha-model-2'];
    expect(fuzzyPick('alpha', ambiguous)).toBeNull();
  });

  test('ranks by match quality, not catalog order', () => {
    // A catalog containing both a prefix and a longer id must prefer the
    // stronger match regardless of ordering.
    expect(fuzzyPick('opus-5', ['gpt-5', 'claude-opus-5'])).toBe('claude-opus-5');
    expect(fuzzyPick('opus-5', ['claude-opus-5', 'gpt-5'])).toBe('claude-opus-5');
  });

  test('works for agents as well as models', () => {
    const agents = ['explore', 'build', 'plan'];
    expect(fuzzyPick('build', agents)).toBe('build');
    expect(fuzzyPick('expl', agents)).toBe('explore');
    expect(fuzzyPick('nope', agents)).toBeNull();
  });

  test('an empty catalog yields null instead of throwing', () => {
    expect(fuzzyPick('anything', [])).toBeNull();
  });

  test('never returns a candidate outside the catalog', () => {
    for (const q of ['muse', 'gpt', 'claude', 'dots', 'zzz', '../etc']) {
      const got = fuzzyPick(q, catalog);
      if (got !== null) expect(catalog).toContain(got);
    }
  });

  test('injection-shaped input is matched, never interpreted', () => {
    expect(fuzzyPick('; rm -rf /', catalog)).toBeNull();
    expect(fuzzyPick('$(whoami)', catalog)).toBeNull();
  });
});
