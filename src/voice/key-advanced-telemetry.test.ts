import { describe, expect, test } from 'vitest';
import { Keyring, keyAdvanced, withKey } from './keyring.js';
import { OrchestratorError } from '../common/errors.js';

// L16: `remediationAttempted: 'KeyAdvanced'` was in the telemetry schema with no
// producer, so a key rotation was invisible — the pool advanced and the ledger
// said only that something failed. `keyAdvanced` is what makes the row honest,
// and it has to distinguish "we rotated and may recover" from "we rotated
// nothing", or it is worse than the hardcoded 'None' it replaced.

const pools = { groq: ['K1-g', 'K2-g'], fish: ['K1-f'], openrouter: ['K1-o', 'K2-o'] };

class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`provider said ${status}`);
    this.status = status;
  }
}

describe('keyAdvanced reports only a real rotation', () => {
  test('a 401 marks the error as advanced', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const err = await withKey(ring, 'openrouter', () => Promise.reject(new FakeApiError(401))).catch(
        (e: unknown) => e,
      );
      expect(keyAdvanced(err)).toBe(true);
    } finally {
      ring.destroy();
    }
  });

  test('a 429 marks the error as advanced', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const err = await withKey(ring, 'openrouter', () => Promise.reject(new FakeApiError(429))).catch(
        (e: unknown) => e,
      );
      expect(keyAdvanced(err)).toBe(true);
    } finally {
      ring.destroy();
    }
  });

  test('a timeout does NOT claim a rotation that never happened', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const err = await withKey(ring, 'openrouter', () =>
        Promise.reject(new OrchestratorError('BRAIN_TIMEOUT', true, 'slow')),
      ).catch((e: unknown) => e);
      // The dangerous failure mode: claiming remediation on an unremediated
      // failure would make the ledger say the problem was handled.
      expect(keyAdvanced(err)).toBe(false);
    } finally {
      ring.destroy();
    }
  });

  test('a single-key pool logs the attempt but must not claim remediation', async () => {
    // fish has one key, so forceAdvance burns the remaining slots and records
    // K1 -> K1. The log entry is real and useful (the pool is exhausted), but no
    // different credential will be tried, so the telemetry row must not say the
    // key was advanced. This is the case that makes `from !== to` the right test
    // instead of "the log grew".
    const ring = Keyring.fromKeys(pools);
    try {
      const before = ring.rolloverLog.length;
      const err = await withKey(ring, 'fish', () => Promise.reject(new FakeApiError(401))).catch(
        (e: unknown) => e,
      );
      expect(ring.rolloverLog.length).toBe(before + 1);
      const entry = ring.rolloverLog[before];
      expect(entry?.from).toBe('K1');
      expect(entry?.to).toBe('K1');
      expect(keyAdvanced(err)).toBe(false);
    } finally {
      ring.destroy();
    }
  });

  test('a non-error value is not advanced', () => {
    for (const v of [undefined, null, 'x', 42, {}]) {
      expect(keyAdvanced(v), String(v)).toBe(false);
    }
  });

  test('the marker is not enumerable, so it cannot leak into a log line', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const err = (await withKey(ring, 'openrouter', () => Promise.reject(new FakeApiError(401))).catch(
        (e: unknown) => e,
      )) as object;
      // A symbol-keyed property is invisible to JSON.stringify, spread and
      // Object.keys. If this ever became enumerable it would appear in a
      // telemetry line and in every diff of an error object.
      expect(Object.keys(err)).not.toContain('keyAdvanced');
      expect(JSON.stringify(err)).not.toContain('KeyAdvanced');
      expect({ ...err }).not.toHaveProperty('keyAdvanced');
    } finally {
      ring.destroy();
    }
  });
});
