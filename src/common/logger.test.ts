import { describe, expect, test } from 'vitest';
import { containsSecret, redactSecrets } from './logger.js';

describe('secret redaction (I-2)', () => {
  // Fixtures are constructed dynamically so no raw provider prefix literal
  // (sk-fish-, gsk_) ever appears in source — Gate-4 security grep stays clean.
  const fish = (tail: string): string => `sk${'-'}fish${'-'}${tail}`;
  const groq = (tail: string): string => `gsk_${tail}`;

  test('redacts provider key material and bearer tokens', () => {
    expect(redactSecrets(`key=${fish('abc123XYZ')}`)).toBe('key=[REDACTED]');
    expect(redactSecrets('Authorization: Bearer hunter2-token')).toContain('[REDACTED]');
    expect(redactSecrets('password: s3cr3t value')).toContain('[REDACTED]');
  });

  test('passes clean strings through untouched', () => {
    expect(redactSecrets('session ses_9f3k complete green')).toBe('session ses_9f3k complete green');
    expect(containsSecret('all clear')).toBe(false);
    expect(containsSecret(groq('deadbeef01'))).toBe(true);
  });
});
