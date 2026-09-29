import { describe, expect, test } from 'vitest';
import { Keyring, withKey } from './keyring.js';
import { httpStatusOf, OrchestratorError } from '../common/errors.js';

// L17: `ring.release(key, ok, status)` advances the pool only on 429/401/403,
// but every daemon and CLI call site passed an unconditional `true`. A revoked
// key therefore never rotated — the same dead credential was retried until
// voice stopped working, and a key that is present but invalid was
// indistinguishable from a healthy one.
//
// These tests exercise the real Keyring, not a mock: the assertion that matters
// is which keyId the NEXT acquire returns, because that is the only observable
// consequence of the release.

const pools = { groq: ['K1-g', 'K2-g', 'K3-g'], fish: ['K1-f'], openrouter: ['K1-o', 'K2-o'] };

/** groq-sdk's APIError exposes `readonly status`; STT failures arrive this way. */
class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`provider said ${status}`);
    this.name = 'APIError';
    this.status = status;
  }
}

describe('httpStatusOf recovers the status a rotation depends on', () => {
  test('an auth rejection maps to 401 regardless of 401 vs 403', () => {
    // brain.ts collapses both into BRAIN_AUTH; rotation is identical either way.
    expect(httpStatusOf(new OrchestratorError('BRAIN_AUTH', false, 'x'))).toBe(401);
  });

  test('a rate limit maps to 429', () => {
    expect(httpStatusOf(new OrchestratorError('RATE_LIMITED', false, 'x'))).toBe(429);
  });

  // A.4: 402 is out of credit, and it is deliberately NOT collapsed into 429.
  // If it were, `release` would advance the pool on an empty balance — the key
  // is perfectly valid, only the funds are gone — and the user would be walked
  // through every credential in the pool for nothing.
  test('an out-of-credit error maps to 402, not 429', () => {
    expect(httpStatusOf(new OrchestratorError('BRAIN_CREDIT', false, 'x'))).toBe(402);
  });

  test('provider, timeout and parse failures map to nothing', () => {
    // These must NOT rotate: a 5xx or an empty completion says nothing about
    // whether the key is valid, and burning a pool on them would strand the
    // user on a worse key than the one already working.
    for (const code of ['BRAIN_REJECTED', 'BRAIN_TIMEOUT', 'STT_FAILED', 'SERVE_UNREACHABLE'] as const) {
      expect(httpStatusOf(new OrchestratorError(code, true, 'x')), code).toBeUndefined();
    }
  });

  test('a groq-sdk APIError status is read directly', () => {
    expect(httpStatusOf(new FakeApiError(401))).toBe(401);
    expect(httpStatusOf(new FakeApiError(429))).toBe(429);
    expect(httpStatusOf(new FakeApiError(500))).toBe(500);
  });

  test('a wrapped payload status is read', () => {
    expect(httpStatusOf({ error: { status: 403 } })).toBe(403);
  });

  test('a non-numeric status is ignored rather than coerced', () => {
    // Coercing "401" or NaN here would rotate on garbage.
    expect(httpStatusOf({ status: '401' })).toBeUndefined();
    expect(httpStatusOf({ error: { status: null } })).toBeUndefined();
  });

  test('non-objects yield nothing instead of throwing', () => {
    for (const v of [undefined, null, 'boom', 42, true]) {
      expect(httpStatusOf(v), String(v)).toBeUndefined();
    }
  });
});

describe('withKey reports the real outcome to the pool', () => {
  test('a success returns the value and does not rotate', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const out = await withKey(ring, 'groq', (k) => Promise.resolve(k.keyId));
      expect(out).toBe('K1');
      expect(ring.acquire('groq').keyId).toBe('K1');
      expect(ring.rolloverLog).toHaveLength(0);
    } finally {
      ring.destroy();
    }
  });

  test('a 401 rotates past the dead key', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      await expect(
        withKey(ring, 'openrouter', () => Promise.reject(new FakeApiError(401))),
      ).rejects.toThrow('provider said 401');
      // The whole point: the next call does NOT reuse the rejected key.
      expect(ring.acquire('openrouter').keyId).toBe('K2');
      expect(ring.rolloverLog.at(-1)?.reason).toBe('auth-failed');
    } finally {
      ring.destroy();
    }
  });

  test('a 403 rotates too, and is logged as an auth failure not a rate limit', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      await withKey(ring, 'openrouter', () => Promise.reject(new FakeApiError(403))).catch(() => undefined);
      expect(ring.rolloverLog.at(-1)?.reason).toBe('auth-failed');
    } finally {
      ring.destroy();
    }
  });

  test('a 429 rotates and is labelled rate-limited', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      await withKey(ring, 'openrouter', () => Promise.reject(new FakeApiError(429))).catch(() => undefined);
      expect(ring.acquire('openrouter').keyId).toBe('K2');
      expect(ring.rolloverLog.at(-1)?.reason).toBe('rate-limited');
    } finally {
      ring.destroy();
    }
  });

  test('a brain auth error rotates the openrouter pool', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      await withKey(ring, 'openrouter', () =>
        Promise.reject(new OrchestratorError('BRAIN_AUTH', false, 'rejected')),
      ).catch(() => undefined);
      expect(ring.acquire('openrouter').keyId).toBe('K2');
    } finally {
      ring.destroy();
    }
  });

  // A.4: the observable consequence of the 402 -> undefined decision. Compared
  // against 429 in the same test because the difference between them is the
  // whole point: 429 rotates, 402 must not.
  test('an out-of-credit error does NOT rotate, while 429 does', async () => {
    const empty = Keyring.fromKeys(pools);
    try {
      await withKey(empty, 'openrouter', () =>
        Promise.reject(new OrchestratorError('BRAIN_CREDIT', false, 'no funds')),
      ).catch(() => undefined);
      expect(empty.rolloverLog).toHaveLength(0);
      expect(empty.acquire('openrouter').keyId).toBe('K1');
    } finally {
      empty.destroy();
    }

    const limited = Keyring.fromKeys(pools);
    try {
      await withKey(limited, 'openrouter', () =>
        Promise.reject(new OrchestratorError('RATE_LIMITED', false, 'throttled')),
      ).catch(() => undefined);
      expect(limited.rolloverLog.length).toBeGreaterThan(0);
      expect(limited.acquire('openrouter').keyId).toBe('K2');
    } finally {
      limited.destroy();
    }
  });

  test('a non-key failure does NOT rotate, and does not strand the pool', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      // A timeout is the most common real failure. If it rotated, a flaky
      // network would walk the user through every key in the pool.
      await withKey(ring, 'groq', () =>
        Promise.reject(new OrchestratorError('BRAIN_TIMEOUT', true, 'slow')),
      ).catch(() => undefined);
      expect(ring.acquire('groq').keyId).toBe('K1');
      expect(ring.rolloverLog).toHaveLength(0);
    } finally {
      ring.destroy();
    }
  });

  test('a 500 does not rotate — the key is not the problem', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      await withKey(ring, 'groq', () => Promise.reject(new FakeApiError(500))).catch(() => undefined);
      expect(ring.acquire('groq').keyId).toBe('K1');
    } finally {
      ring.destroy();
    }
  });

  test('the error is rethrown unchanged, so callers still see it', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const boom = new FakeApiError(401);
      await expect(withKey(ring, 'groq', () => Promise.reject(boom))).rejects.toBe(boom);
    } finally {
      ring.destroy();
    }
  });

  test('key material is zeroed on the failure path too', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      let seen: Buffer | null = null;
      await withKey(ring, 'groq', (k) => {
        seen = k.material;
        expect(seen.toString('utf8')).toBe('K1-g');
        return Promise.reject(new FakeApiError(401));
      }).catch(() => undefined);
      // Security boundary: release() must wipe the caller's buffer even when the
      // call failed, or the secret outlives the request that used it. fill(0)
      // writes NUL bytes rather than truncating, so the check is "no secret
      // left", not "empty string".
      const after = (seen as unknown as Buffer).toString('utf8');
      expect(after).not.toContain('K1-g');
      // Every byte zero, whatever the key length is — asserting a fixed length
      // would encode the length of the test fixture into the assertion.
      expect([...(seen as unknown as Buffer)].every((b) => b === 0)).toBe(true);
      expect((seen as unknown as Buffer).length).toBeGreaterThan(0);
    } finally {
      ring.destroy();
    }
  });

  test('a synchronous throw inside the callback is handled like any failure', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      await expect(
        withKey(ring, 'openrouter', () => {
          throw new FakeApiError(401);
        }),
      ).rejects.toThrow('provider said 401');
      expect(ring.acquire('openrouter').keyId).toBe('K2');
    } finally {
      ring.destroy();
    }
  });

  test('a rejected non-promise value still releases safely', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      // Defensive: a caller returning undefined by mistake must not skip release.
      const out = await withKey(ring, 'groq', () => Promise.resolve(undefined));
      expect(out).toBeUndefined();
      expect(ring.rolloverLog).toHaveLength(0);
    } finally {
      ring.destroy();
    }
  });
});
