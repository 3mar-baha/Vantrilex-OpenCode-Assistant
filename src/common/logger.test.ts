import { describe, expect, test } from 'vitest';
import { containsSecret, redactSecrets } from './logger.js';

describe('secret redaction (I-2)', () => {
  test('redacts provider key material and bearer tokens', () => {
    expect(redactSecrets('key=sk-fish-abc123XYZ')).toBe('key=[REDACTED]');
    expect(redactSecrets('Authorization: Bearer hunter2-token')).toContain('[REDACTED]');
    expect(redactSecrets('password: s3cr3t value')).toContain('[REDACTED]');
  });

  test('passes clean strings through untouched', () => {
    expect(redactSecrets('session ses_9f3k complete green')).toBe('session ses_9f3k complete green');
    expect(containsSecret('all clear')).toBe(false);
    expect(containsSecret('gsk_deadbeef01')).toBe(true);
  });
});
