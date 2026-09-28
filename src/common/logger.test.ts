import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  containsSecret,
  createLogger,
  GENERIC_SK_EXCLUSIONS,
  LIVE_PREFIXES,
  REDACTION_MARKER,
  redactObject,
  redactSecrets,
  redactString,
} from './logger.js';

// Every fixture is SYNTHETIC and built from a known-good prefix plus a run of
// filler characters. No real key value is read, echoed or committed here —
// `.env.local` holds live keys and is never opened by this file or by the code
// under test.
const synthetic = (prefix: string): string => `${prefix}${'A'.repeat(48)}`;

describe('secret redaction (I-2)', () => {
  test('redacts provider key material and bearer tokens', () => {
    expect(redactString(`key=${synthetic('sk-fish-')}`)).toBe(`key=${REDACTION_MARKER}`);
    expect(redactString('Authorization: Bearer hunter2-token')).toContain(REDACTION_MARKER);
    expect(redactString('password: s3cr3t value')).toContain(REDACTION_MARKER);
  });

  test('passes clean strings through untouched', () => {
    expect(redactString('session ses_9f3k complete green')).toBe('session ses_9f3k complete green');
    expect(containsSecret('all clear')).toBe(false);
    expect(containsSecret(synthetic('gsk_'))).toBe(true);
  });

  // One case per live pool, so a failure names the provider that regressed.
  // The old pattern list had NO `sk-or-v1-` entry at all, which is the gap
  // this whole change exists to close.
  for (const prefix of LIVE_PREFIXES) {
    test(`redacts the ${prefix}* pool`, () => {
      const key = synthetic(prefix);
      expect(redactString(`key=${key}`)).toBe(`key=${REDACTION_MARKER}`);
      expect(redactString(`pool groq exhausted, next ${key} at index 1`)).toBe(
        `pool groq exhausted, next ${REDACTION_MARKER} at index 1`,
      );
      expect(containsSecret(key)).toBe(true);
    });
  }

  // Anti-vacuity: the generic long-tail `sk-` fallback would happily match
  // `sk-or-v1-…` too, which would let a deleted specific pattern pass its own
  // test. These two assertions keep the specific patterns load-bearing and keep
  // the two lists from drifting apart.
  test('the generic sk- fallback does not shadow a specific prefix', () => {
    for (const tail of GENERIC_SK_EXCLUSIONS) {
      const key = `sk-${tail}${'A'.repeat(48)}`;
      expect(redactString(key), `generic fallback must skip sk-${tail}`).not.toBe(key);
    }
  });

  test('every sk- prefix is declared in both the pattern list and the exclusion list', () => {
    const skPrefixes = LIVE_PREFIXES.filter((p) => p.startsWith('sk-')).map((p) => p.slice(3));
    expect(skPrefixes.sort()).toEqual([...GENERIC_SK_EXCLUSIONS].sort());
  });

  test('leaves ordinary diagnostic prose untouched (no over-redaction)', () => {
    const clean = [
      'session ses_9f3k complete green',
      'key pool exhausted, advancing groq -> index 1',
      'serve 127.0.0.1:4096 (unreachable)',
      'BRAIN_REJECTED retryable=false remediation=KeyAdvanced',
      'voice=male-default briefings=bluf mic=armed',
      'rotating taskbar-icon cache for the explorer shell',
    ];
    for (const line of clean) {
      expect(redactString(line)).toBe(line);
      expect(containsSecret(line)).toBe(false);
    }
  });

  test('catches a secret assignment even when no provider prefix is present', () => {
    expect(containsSecret({ headers: { authorization: 'Basic Zm9vOmJhcg==' } })).toBe(true);
    expect(redactString('password: hunter2')).toBe(`password: ${REDACTION_MARKER}`);
    // The quote character survives, so a serialized document stays parseable.
    expect(redactString('{"apiKey":"hunter2"}')).toBe(`{"apiKey":"${REDACTION_MARKER}"}`);
    expect(JSON.parse(redactString('{"apiKey":"hunter2"}'))).toEqual({ apiKey: REDACTION_MARKER });
  });
});

describe('non-string arguments', () => {
  // THE bug. The old hook was `typeof arg === 'string' ? redactSecrets(arg) :
  // arg`, so any object holding a key was written verbatim. This is the case
  // that makes a deep walk necessary rather than merely tidy.
  test('scrubs a key held inside an object argument', () => {
    const payload = { provider: 'openrouter', apiKey: synthetic('sk-or-v1-') };
    const out = redactObject(payload);
    expect(out['apiKey']).toBe(REDACTION_MARKER);
    expect(out['provider']).toBe('openrouter');
    expect(containsSecret(payload)).toBe(true);
    expect(JSON.stringify(redactSecrets([payload]))).not.toContain('sk-or-v1-');
  });

  test('walks nested objects, arrays, Maps and Sets', () => {
    const input = {
      headers: new Map([['x-api-key', synthetic('sk-fish-')]]),
      attempts: [{ key: synthetic('gsk_') }, 'fine'],
      pool: new Set([synthetic('sk-or-v1-')]),
    };
    const out = redactObject(input) as unknown as {
      headers: Record<string, unknown>;
      attempts: { key: string }[];
      pool: string[];
    };
    expect(out.headers['x-api-key']).toBe(REDACTION_MARKER);
    expect(out.attempts[0]!.key).toBe(REDACTION_MARKER);
    expect(out.attempts[1]).toBe('fine');
    expect(out.pool[0]).toBe(REDACTION_MARKER);
    expect(JSON.stringify(out)).not.toMatch(/sk-or-v1-|sk-fish-|gsk_/);
  });

  test('scrubs an Error message and stack', () => {
    const err = new Error(`upstream rejected ${synthetic('sk-or-v1-')}`);
    const out = redactObject({ err }) as { err: { name: string; message: string; stack: string } };
    expect(out.err.name).toBe('Error');
    expect(out.err.message).toContain(REDACTION_MARKER);
    expect(out.err.message).not.toContain('sk-or-v1-');
    expect(out.err.stack).not.toContain('sk-or-v1-');
    expect(containsSecret(err)).toBe(true);
  });

  test('a self-referencing object does not throw or hang', () => {
    const cyclic: Record<string, unknown> = { apiKey: synthetic('gsk_') };
    cyclic['self'] = cyclic;
    const out = redactObject(cyclic);
    expect(out['apiKey']).toBe(REDACTION_MARKER);
    expect(out['self']).toBe('[CIRCULAR]');
  });

  test('an over-deep object truncates instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = { leaf: synthetic('sk-or-v1-') };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    const serialized = JSON.stringify(redactSecrets(deep));
    expect(serialized).toContain('[TRUNCATED]');
    expect(serialized).not.toContain('sk-or-v1-');
  });

  test('non-throwing across every primitive and exotic shape', () => {
    const shapes: unknown[] = [
      null,
      undefined,
      0,
      -1.5,
      NaN,
      true,
      10n,
      Symbol('s'),
      () => 'x',
      new Date(0),
      new Uint8Array([1, 2, 3]),
      Buffer.from('x'),
    ];
    for (const shape of shapes) {
      expect(() => redactSecrets(shape)).not.toThrow();
      expect(() => containsSecret(shape)).not.toThrow();
    }
  });
});

describe('createLogger', () => {
  function capturing(level: 'debug' | 'info' | 'warn' | 'error' = 'info'): {
    lines: string[];
    log: ReturnType<typeof createLogger>;
  } {
    const lines: string[] = [];
    return { lines, log: createLogger(level, { write: (line) => lines.push(line) }) };
  }

  // The pino hook this replaces did `typeof arg === 'string' ? redact(arg) :
  // arg`, so logging a request object wrote its apiKey field straight to the
  // log. This is the direct regression test for it.
  test('redacts an object argument before it reaches the sink', () => {
    const { lines, log } = capturing();
    log.info('provider rejected', { apiKey: synthetic('sk-or-v1-'), attempt: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('sk-or-v1-');
    const parsed = JSON.parse(lines[0] as string) as {
      msg: string;
      args: { apiKey: string; attempt: number }[];
    };
    expect(parsed.msg).toBe('provider rejected');
    expect(parsed.args[0]!.apiKey).toBe(REDACTION_MARKER);
    expect(parsed.args[0]!.attempt).toBe(2);
  });

  test('redacts an Error argument', () => {
    const { lines, log } = capturing();
    log.error('flush failed', new Error(`auth ${synthetic('gsk_')} rejected`));
    const parsed = JSON.parse(lines[0] as string) as { args: { message: string; stack: string }[] };
    expect(parsed.args[0]!.message).not.toContain('gsk_');
    expect(parsed.args[0]!.stack).not.toContain('gsk_');
  });

  test('honours the level threshold and merges child bindings', () => {
    const { lines, log } = capturing('warn');
    log.debug('dropped');
    log.info('dropped');
    log.warn('kept', { apiKey: synthetic('sk-fish-') });
    expect(lines).toHaveLength(1);
    log.child({ scope: 'telemetry' }).error('boom');
    const child = JSON.parse(lines[1] as string) as { level: string; scope: string };
    expect(child.level).toBe('error');
    expect(child.scope).toBe('telemetry');
  });

  test('a sink that throws cannot take down the caller', () => {
    const log = createLogger('info', {
      write: () => {
        throw new Error('sink exploded');
      },
    });
    expect(() => void log.info('still fine', { apiKey: synthetic('sk-or-v1-') })).not.toThrow();
  });
});

describe('the logger has no runtime dependency', () => {
  test('imports nothing at runtime, so pino cannot creep back in', () => {
    const src = readFileSync(new URL('./logger.ts', import.meta.url), 'utf8');
    // Anchored to the start of a line so the file's own prose about the
    // removal — which necessarily quotes the old import — cannot satisfy or
    // break the guard. Only executable code is inspected.
    const runtimeImports = src.match(/^\s*import\s+(?!type\b)[^;]*from\s+'[^']+';/gm) ?? [];
    expect(runtimeImports).toEqual([]);
    expect(src).not.toMatch(/^\s*import\s+[^;]*['"]pino['"]/m);
    expect(src).not.toMatch(/^\s*(?:const|let|var)\s+\w+\s*=\s*pino\b/m);
  });

  test('pino is no longer a declared dependency', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain('pino');
  });
});
