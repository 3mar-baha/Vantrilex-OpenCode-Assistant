import { describe, expect, test } from 'vitest';
import { fishErrorMessage, fishErrorDetail, fishHeaders, fishRequestBody, TTS_MODEL } from './tts.js';

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
