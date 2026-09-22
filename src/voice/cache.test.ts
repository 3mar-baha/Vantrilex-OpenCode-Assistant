import { describe, expect, test } from 'vitest';
import { cacheKey, normalizeForCache } from './cache.js';

describe('cache key derivation', () => {
  test('punctuation is prosody: distinct keys', () => {
    expect(cacheKey('done.', 'male-default')).not.toBe(cacheKey('done', 'male-default'));
  });

  test('whitespace collapses; voices separate', () => {
    expect(cacheKey('  done   now ', 'male-default')).toBe(cacheKey('done now', 'male-default'));
    expect(cacheKey('done', 'male-default')).not.toBe(cacheKey('done', 'female-toggle'));
  });

  test('normalization is stable', () => {
    expect(normalizeForCache('  a   b ')).toBe('a b');
  });
});
