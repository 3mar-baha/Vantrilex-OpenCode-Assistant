import { describe, expect, test } from 'vitest';
import {
  fishErrorMessage,
  fishErrorDetail,
  fishHeaders,
  fishRequestBody,
  TTS_MODEL,
  FishCreditError,
  FishHttpTransport,
} from './tts.js';
import { Keyring } from './keyring.js';

// R3: every Fish failure status used to collapse to `TTS failed: HTTP ${status}`.
// That is a restatement, not a diagnostic, and it hid the single most expensive
// mistake of the v0.7.x cycle: a 402 that reads like a code fault.
//
// R2: latency is now `balanced` rather than the `normal` default.
// R7: the free tier is a promotion with an end date, recorded on TTS_MODEL.

describe('a Fish status produces an actionable message (R3)', () => {
  test('402 says out of credit and NOT that the key is bad', () => {
    const msg = fishErrorMessage(402);
    expect(msg).toContain('out of credit');
    expect(msg).toContain('402');
    // The correction that matters: someone must not go key-shopping for a
    // balance problem. L17 correctly does not rotate on 402 for this reason.
    expect(msg).not.toMatch(/invalid|revoked|rotate it/);
  });

  test('401 and 403 name the key as the cause, since the pool does rotate', () => {
    for (const s of [401, 403]) {
      const msg = fishErrorMessage(s);
      expect(msg).toContain(String(s));
      expect(msg).toMatch(/invalid|revoked/);
    }
  });

  test('429 is distinguishable from an auth failure', () => {
    const msg = fishErrorMessage(429);
    expect(msg).toContain('rate limited');
    expect(msg).not.toMatch(/invalid|revoked|credit/);
  });

  test('404 points at the voice model, which is the actual cause', () => {
    expect(fishErrorMessage(404)).toContain('reference_id');
  });

  test('5xx is called out as a provider fault and marked retryable', () => {
    expect(fishErrorMessage(503)).toMatch(/provider error/);
    expect(fishErrorMessage(503)).toMatch(/safe to retry/);
  });

  test('an unrecognised status still degrades to something readable', () => {
    expect(fishErrorMessage(418)).toContain('418');
    expect(fishErrorMessage(418).length).toBeGreaterThan(0);
  });

  test('422 includes the field-level detail when one is supplied', () => {
    const msg = fishErrorMessage(422, 'chunk_length: must be between 100 and 300');
    expect(msg).toContain('422');
    expect(msg).toContain('chunk_length');
  });

  test('no message ever echoes key material', () => {
    // The mapping is a closed union, so this is structural rather than a
    // coincidence: there is no path by which response text reaches 401/402.
    for (const s of [401, 402, 403, 404, 429, 500, 503]) {
      expect(fishErrorMessage(s), String(s)).not.toMatch(/sk-|gsk_|Bearer /);
    }
  });
});

describe('only 422 bodies are read, and only for field names (R3)', () => {
  const res = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  test('a 422 array yields loc and msg', async () => {
    const r = res(422, [{ loc: ['body', 'chunk_length'], msg: 'ensure this value is less than or equal to 300' }]);
    const d = await fishErrorDetail(r);
    expect(d).toContain('body.chunk_length');
    expect(d).toContain('less than or equal to 300');
  });

  test('the detail is bounded so it cannot flood a log line', async () => {
    const r = res(422, [{ loc: ['body', 'x'], msg: 'y'.repeat(5000) }]);
    const d = await fishErrorDetail(r);
    expect(d).not.toBeNull();
    expect((d as string).length).toBeLessThanOrEqual(120);
  });

  test('a 402 body is NOT read - it is account metadata, not our fault', async () => {
    // This is the boundary that matters. 402 bodies carry balance and account
    // detail; reading them would put that in a log line and a UI banner.
    const r = res(402, { status: 402, message: 'Insufficient API credit', balance: 0, account: 'x@y' });
    expect(await fishErrorDetail(r)).toBeNull();
  });

  test('a malformed or non-array 422 body degrades to null', async () => {
    expect(await fishErrorDetail(res(422, { status: 422, message: 'bad' }))).toBeNull();
    expect(await fishErrorDetail(res(422, []))).toBeNull();
    expect(await fishErrorDetail(new Response('not json', { status: 422 }))).toBeNull();
  });
});

describe('latency is tuned and the free tier is pinned (R2, R7)', () => {
  test('latency is balanced, not the default', () => {
    expect(fishRequestBody('مرحبا', 'ref-1')['latency']).toBe('balanced');
  });

  test('the free model is unchanged and still header-borne', () => {
    expect(TTS_MODEL).toBe('s2.1-pro-free');
    expect(fishHeaders('k')['model']).toBe('s2.1-pro-free');
    expect(fishRequestBody('مرحبا', 'ref-1')).not.toHaveProperty('model');
  });

  test('normalize stays on - the STT round-trip showed it does not mangle Arabic', () => {
    // R5: synthesized with normalize on and off, transcribed both, compared the
    // digits. Arabic-Indic numerals came through unchanged either way, and for
    // Western digits normalize=true was strictly better ("42" transcribed back
    // as 42; false garbled it). The spec notes normalize is "for EN/ZH", but the
    // measurement says it helps Arabic too.
    expect(fishRequestBody('مرحبا', 'ref-1')['normalize']).toBe(true);
  });

  test('chunk parameters stay inside the documented 100-300 / 0-100 ranges', () => {
    const b = fishRequestBody('مرحبا', 'ref-1');
    expect(b['chunk_length']).toBeGreaterThanOrEqual(100);
    expect(b['chunk_length']).toBeLessThanOrEqual(300);
    expect(b['min_chunk_length']).toBeGreaterThanOrEqual(0);
    expect(b['min_chunk_length']).toBeLessThanOrEqual(100);
  });
});

/**
 * A.3: a 429 is a CREDIT fault, not a credential fault, and the two have
 * opposite fixes. `release` advanced the pool on 429/401/403, and
 * `synthesizeStream` released BEFORE branching on the status — so a rate limit
 * burned a perfectly good key and changed nothing, ten times over.
 *
 * 401/403 are asserted here too, on purpose. A fix that stops rotating on 429
 * by stopping rotating on auth faults is an overcorrection, and it would be
 * invisible without these: the 429 test passes either way.
 */
describe('a credit fault does not burn a key, an auth fault still does (A.3)', () => {
  // A bodyless failure response, which is what a real provider rejection
  // usually looks like to us: the status is the whole signal.
  const failing = (status: number): typeof fetch =>
    (async () => ({ ok: false, status, body: null })) as unknown as typeof fetch;

  // All three pools must be non-empty: `fromKeys` is fail-closed per pool
  // (keyring.ts:52), and only `fish` is exercised here.
  const ring = (): Keyring => Keyring.fromKeys({ groq: ['g1'], fish: ['k1', 'k2'], openrouter: ['o1'] });

  test('a null body is handled before any body is read (precondition)', async () => {
    // Not assumed: `fishErrorDetail` must not touch `.json()` on these.
    for (const status of [401, 402, 403, 429, 500]) {
      expect(await fishErrorDetail(failing(status)('https://example.invalid/tts') as unknown as Response), String(status)).toBeNull();
    }
  });

  test('429 throws FishCreditError and leaves the pool untouched', async () => {
    const keys = ring();
    try {
      const t = new FishHttpTransport(keys, 'https://example.invalid/tts', { fetchImpl: failing(429) });
      const err = await t.synthesize('مرحبا', 'ref-1').then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(FishCreditError);
      expect((err as FishCreditError).status).toBe(429);
      expect((err as FishCreditError).isCreditFault).toBe(true);
      // The defect: the key was good and is now retired.
      expect(keys.rolloverLog).toHaveLength(0);
      const next = keys.acquire('fish');
      expect(next.keyId).toBe('K1');
      keys.release(next, true);
    } finally {
      keys.destroy();
    }
  });

  test('401 and 403 DO still rotate, with reason auth-failed (anti-overcorrection)', async () => {
    for (const status of [401, 403]) {
      const keys = ring();
      try {
        const t = new FishHttpTransport(keys, 'https://example.invalid/tts', { fetchImpl: failing(status) });
        const err = await t.synthesize('مرحبا', 'ref-1').then(() => null, (e: unknown) => e);

        // A rejected credential is exactly the case the pool exists to handle.
        expect(err, String(status)).not.toBeInstanceOf(FishCreditError);
        expect(keys.rolloverLog).toHaveLength(1);
        expect(keys.rolloverLog[0]?.reason).toBe('auth-failed');
        const next = keys.acquire('fish');
        expect(next.keyId, String(status)).toBe('K2');
        keys.release(next, true);
      } finally {
        keys.destroy();
      }
    }
  });

  test('402 does not rotate (pinned: unchanged behaviour, not an accident)', async () => {
    const keys = ring();
    try {
      const t = new FishHttpTransport(keys, 'https://example.invalid/tts', { fetchImpl: failing(402) });
      const err = await t.synthesize('مرحبا', 'ref-1').then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(FishCreditError);
      expect((err as FishCreditError).status).toBe(402);
      expect(keys.rolloverLog).toHaveLength(0);
      keys.release(keys.acquire('fish'), true);
    } finally {
      keys.destroy();
    }
  });

  test('500 does not rotate and is not typed as a credit fault', async () => {
    const keys = ring();
    try {
      const t = new FishHttpTransport(keys, 'https://example.invalid/tts', { fetchImpl: failing(500) });
      const err = await t.synthesize('مرحبا', 'ref-1').then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(FishCreditError);
      // A provider fault says nothing about the key, so the key stays in play.
      expect(keys.rolloverLog).toHaveLength(0);
      keys.release(keys.acquire('fish'), true);
    } finally {
      keys.destroy();
    }
  });
});
