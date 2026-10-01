import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  containsSecret,
  createLogger,
  CREDENTIAL_FAMILIES,
  GENERIC_SK_EXCLUSIONS,
  LIVE_PREFIXES,
  REDACTION_MARKER,
  REDACTION_PATTERNS,
  redactObject,
  redactSecrets,
  redactString,
} from './logger.js';

// Every fixture is SYNTHETIC and built from a known-good prefix plus a run of
// filler characters. No real key value is read, echoed or committed here —
// `.env.local` holds live keys and is never opened by this file or by the code
// under test. Where a family has a multi-segment shape (SendGrid, JWT) the
// sample lives in `CREDENTIAL_FAMILIES` itself, because a `prefix + filler`
// string is not that family's real shape and would test the wrong regex.
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

  // ── THE COVERAGE GAP THIS BLOCK EXISTS TO CLOSE ──────────────────────────
  //
  // `LIVE_PREFIXES` was `['sk-or-v1-', 'sk-fish-', 'gsk_']` — the three pools
  // THIS BUILD holds, which is the wrong question. The redactor's job is to
  // survive a config dump from any provider, and 15 synthetic shapes pushed
  // through the real function showed 12 passing through untouched: no `AIza`,
  // no `gh[pousr]_`, no `xox`, no JWT. A `gho_…` GitHub PAT is not a
  // hypothetical shape here — it is the exact material in the incident where a
  // serve error echoed whole config files, live credentials included.
  //
  // Each family gets its OWN test, driven off the table in the module under
  // test, so a failure names the provider that regressed rather than asserting
  // that a string appears in an array.
  for (const family of CREDENTIAL_FAMILIES) {
    for (const sample of family.samples) {
      test(`redacts the ${family.id} family (${sample.slice(0, 8)}…)`, () => {
        // Whole-sample redaction: nothing of the credential survives, including
        // the multi-segment shapes (SendGrid's second dot, a JWT's payload).
        expect(redactString(sample)).toBe(REDACTION_MARKER);
        expect(containsSecret(sample)).toBe(true);
        // AND the surrounding text survives. A redactor that eats the whole
        // message passes the assert above and is useless in a log.
        expect(redactString(`leaked ${sample} in config`)).toBe(`leaked ${REDACTION_MARKER} in config`);
        // Mid-sentence position, the shape a provider error actually arrives in.
        expect(redactString(`upstream rejected ${sample}, retrying`)).toBe(
          `upstream rejected ${REDACTION_MARKER}, retrying`,
        );
      });
    }
  }

  /**
   * ANTI-SHADOWING — the property that makes the loop above non-vacuous.
   *
   * A test passes if ANY pattern catches the sample. So a family whose pattern
   * was deleted but whose shape is also matched by some OTHER pattern would
   * keep passing green, and the coverage would be fiction. This asserts the
   * opposite: for each family, no OTHER family's regex matches its samples —
   * which is exactly the condition that fails when its prefix is removed.
   *
   * This is the check the old code needed and did not have; the negative
   * lookahead on the generic `sk-` fallback is the trick that makes it pass for
   * the `sk-` families specifically.
   */
  test('no family is shadowed by another pattern — every one is load-bearing', () => {
    // Walk the SHIPPED compiled list rather than a re-typed copy: a test that
    // re-declared the patterns would pass while the real list drifted.
    for (const family of CREDENTIAL_FAMILIES) {
      const own = new RegExp(family.pattern);
      for (const sample of family.samples) {
        const alsoCaught = REDACTION_PATTERNS.filter((re) => re.source !== own.source).filter((re) => {
          re.lastIndex = 0;
          return re.test(sample);
        });
        expect(
          alsoCaught.map((re) => re.source),
          `${family.id} sample is ALSO matched by another pattern — deleting ` +
            `${family.id}'s own pattern would leave its test GREEN`,
        ).toEqual([]);
      }
    }
  });

  test('every family declares a prefix, a pattern and at least one sample', () => {
    for (const family of CREDENTIAL_FAMILIES) {
      expect(family.prefix.length, family.id).toBeGreaterThan(2);
      expect(family.pattern.length, family.id).toBeGreaterThan(4);
      expect(family.samples.length, family.id).toBeGreaterThan(0);
      for (const sample of family.samples) {
        // The sample must be the family's REAL shape, not `prefix + filler`:
        // assert the family's own regex matches it, which is what makes the
        // per-family test above a test of that regex.
        expect(new RegExp(family.pattern).test(sample), `${family.id} sample shape`).toBe(true);
      }
    }
  });

  test('the family table covers at least twelve credential families', () => {
    // A floor, not a target. The gate in the remediation plan is 12; dropping
    // below it should fail here rather than in a reviewer's reading.
    expect(CREDENTIAL_FAMILIES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CREDENTIAL_FAMILIES.map((f) => f.id)).size).toBe(CREDENTIAL_FAMILIES.length);
  });

  test('LIVE_PREFIXES is derived from the family table, not maintained beside it', () => {
    // The original defect was two hand-maintained lists that could disagree.
    expect(LIVE_PREFIXES).toEqual(CREDENTIAL_FAMILIES.map((f) => f.prefix));
  });

  // ── PROPERTY 2: the samples are unreadable to a CREDENTIAL SCANNER ─────────
  //
  // Property 1 — each sample still matches its OWN family's pattern — is
  // asserted above, family by family. That is the half that protects coverage:
  // a sample that stopped matching would mean the family's test was exercising
  // nothing. This is the other half, and it is the reason the samples are
  // written as `SAMPLE('prefix', 'body')` fragments rather than plain literals.
  //
  // GitHub push protection rejected a push over three synthetic samples in this
  // file (Stripe `sk_live_`, Stripe restricted `rk_live_`, Mailgun `key-`). The
  // exposure audit had already established that no live credential was tracked,
  // so the finding was a false positive — but a false positive here is not
  // grounds to weaken the detector, and the samples are the part that can
  // change. Splitting the literal at the prefix boundary keeps the RUNTIME value
  // byte-identical (so property 1 is untouched) while ensuring no
  // scanner-shaped run appears CONTIGUOUS in any tracked file.
  //
  // The provider regexes below are the real formats, not the family's own
  // patterns: a test that reused `CREDENTIAL_FAMILIES[].pattern` would be
  // asserting that the redactor agrees with itself.
  describe('no tracked file contains a contiguous provider-scanner credential', () => {
    const SCANNER_PATTERNS: readonly (readonly [string, RegExp])[] = [
      ['stripe_api_key', /(?:r|s)k_(?:test|live)_[0-9a-zA-Z]{24,}/],
      ['stripe_live_restricted_key', /rk_(?:test|live)_[0-9a-zA-Z]{24,}/],
      ['mailgun_api_key', /key-[0-9a-fA-F]{32}/],
      ['mailgun_signing_key', /key-[0-9a-fA-F]{32}-[0-9a-zA-Z]{8}-[0-9a-zA-Z]{8}/],
      ['openrouter_api_key', /sk-or-v1-[0-9a-f]{64}/],
      ['groq_api_key', /gsk_[a-zA-Z0-9]{52}/],
      ['anthropic_api_key', /sk-ant-api\d{2}-[a-zA-Z0-9\-_]{93}/],
      ['openai_project_key', /sk-proj-[A-Za-z0-9_-]{20,}/],
      ['google_api_key', /AIza[0-9A-Za-z_-]{35}/],
      ['github_pat', /gh[pousr]_[A-Za-z0-9]{36}/],
      ['github_fine_pat', /github_pat_[A-Za-z0-9_]{22,}/],
      ['slack_token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
      ['npm_token', /npm_[a-zA-Z0-9]{36}/],
      ['hf_token', /hf_[a-zA-Z]{34}/],
      ['sendgrid_api_key', /SG\.[\w-]{16,32}\.[\w-]{16,64}/],
      ['aws_access_key_id', /(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA|AIDA|AROA|AGPA)[A-Z0-9]{16}/],
      ['azure_storage_key', /AccountKey=[A-Za-z0-9+/=]{40,}/],
      ['jwt', /ey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}/],
    ];

    // WHAT THIS GUARD COVERS, AND WHY NOT EVERYTHING.
    //
    // Scope is the files that DECLARE credential samples, i.e. the ones a
    // scanner match would be attributable to. Today that is `logger.ts` and
    // this file. Scoped deliberately rather than "every tracked file", because
    // a guard that is red for a reason nobody can act on stops being read: two
    // `src/ipc/**` test files carry Google/GitHub-shaped literals that predate
    // this change, are already published on `origin/main` (introduced by
    // `63e6695`), and are outside this change's write set. Widening to them
    // would make the assertion permanently red and therefore vacuous in
    // practice — the reader learns to skip it. They are reported here instead.
    const SAMPLE_DECLARING_FILES = ['src/common/logger.ts', 'src/common/logger.test.ts'];

    function repoRoot(): string {
      // vitest.config.ts runs this suite from any cwd (a clean clone uses a
      // different path), so the root is derived from this module's URL, never
      // from `process.cwd()`.
      const here = new URL('../../', import.meta.url);
      return decodeURIComponent(here.pathname).replace(/^\//, '').replace(/\/$/, '');
    }

    test('the scanner corpus is non-empty and every pattern fires on a real-format probe', () => {
      // Anti-vacuity. A SCANNER_PATTERNS list that was empty, or a regex that
      // matches nothing, would make the guard below pass for the wrong reason —
      // the same failure mode as `every()` over an empty set. Every declared
      // pattern is therefore proved live against a string of ITS OWN format,
      // built from fragments so this file does not itself trip the guard.
      expect(SCANNER_PATTERNS.length).toBeGreaterThan(10);
      const probe = (prefix: string, body: string): string => `${prefix}${body}`;
      const probes = new Map<string, string>([
        ['stripe_api_key', probe('sk_live_', 'A'.repeat(24))],
        ['stripe_live_restricted_key', probe('rk_live_', 'A'.repeat(24))],
        ['mailgun_api_key', probe('key-', 'a'.repeat(32))],
        ['mailgun_signing_key', probe('key-', `${'a'.repeat(32)}-${'b'.repeat(8)}-${'c'.repeat(8)}`)],
        ['openrouter_api_key', probe('sk-or-v1-', 'a'.repeat(64))],
        ['groq_api_key', probe('gsk_', 'A'.repeat(52))],
        ['anthropic_api_key', probe('sk-ant-api03-', 'A'.repeat(93))],
        ['openai_project_key', probe('sk-proj-', 'A'.repeat(20))],
        ['google_api_key', probe('AIza', 'A'.repeat(35))],
        ['github_pat', probe('ghp_', 'a'.repeat(36))],
        ['github_fine_pat', probe('github_pat_', 'a'.repeat(30))],
        ['slack_token', probe('xoxb-', 'A'.repeat(12))],
        ['npm_token', probe('npm_', 'a'.repeat(36))],
        ['hf_token', probe('hf_', 'a'.repeat(34))],
        ['sendgrid_api_key', probe('SG.', `${'a'.repeat(22)}.${'b'.repeat(22)}`)],
        ['aws_access_key_id', probe('AKIA', 'A'.repeat(16))],
        ['azure_storage_key', probe('AccountKey=', 'A'.repeat(44))],
        // A JWT's SECOND segment also opens `ey` — base64 of `{"` — which is
        // what the scanner pattern keys on. A probe that omits it would fail
        // to match and read as a broken pattern rather than a wrong probe.
        ['jwt', probe('eyJ', `${'A'.repeat(20)}.eyJ${'B'.repeat(20)}.${'C'.repeat(12)}`)],
      ]);
      // Every declared pattern has a probe — otherwise the loop below proves
      // nothing about the un-probed ones and the count would drift silently.
      expect(probes.size).toBe(SCANNER_PATTERNS.length);
      for (const [name, re] of SCANNER_PATTERNS) {
        const pv = probes.get(name);
        expect(pv, `${name} has no real-format probe`).toBeDefined();
        expect(re.test(pv as string), `${name} must match its real-format probe`).toBe(true);
      }
    });

    test('the sample-declaring files contain no contiguous scanner-shaped literal', () => {
      const root = repoRoot();
      expect(SAMPLE_DECLARING_FILES.length, 'guard scope emptied — it would pass vacuously').toBeGreaterThan(0);
      // The scope must name the file that declares the table, or the guard is
      // pointed at nothing. Asserted rather than trusted.
      expect(SAMPLE_DECLARING_FILES).toContain('src/common/logger.ts');

      const findings: string[] = [];
      for (const rel of SAMPLE_DECLARING_FILES) {
        const bytes = readFileSync(new URL(rel, new URL(`file:///${root}/`)));
        const text = bytes.toString('utf8');
        for (const [name, re] of SCANNER_PATTERNS) {
          re.lastIndex = 0;
          const m = re.exec(text);
          if (m) {
            const line = text.slice(0, m.index).split('\n').length;
            findings.push(`${rel}:${line} [${name}] ${JSON.stringify(m[0].slice(0, 60))}`);
          }
        }
      }
      expect(findings, findings.join('\n')).toEqual([]);
    });
  });

  // Anti-vacuity for the generic long-tail `sk-` fallback: it must skip every
  // NAMED `sk-` family, which is what keeps the per-family tests honest.
  test('the generic sk- fallback does not shadow a specific prefix', () => {
    for (const tail of GENERIC_SK_EXCLUSIONS) {
      const key = `sk-${tail}${'A'.repeat(48)}`;
      expect(redactString(key), `generic fallback must skip sk-${tail}`).not.toBe(key);
    }
    // And it still catches an UNNAMED `sk-` provider, or the whole point of it
    // (a future shape needs no audit cycle) is lost.
    expect(redactString(`sk-${'A'.repeat(40)}`)).toBe(REDACTION_MARKER);
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
      // Written because the new families add short prefixes that appear in
      // ordinary English-adjacent text. Each of these was checked against the
      // new patterns, not assumed safe.
      'HF model distilbert-base-uncased cached in .cache/huggingface',
      'npm install finished in 3s, added 0 packages',
      'the key-value store holds 12 entries',
      'jwt already verified by the upstream proxy',
      'connect-src self ws://127.0.0.1:4097',
      'accountKey is null in the response body',
      'taskbar-icon cache cleared for the explorer shell',
      'eyeball rendering skipped on the low-power path',
    ];
    for (const line of clean) {
      expect(redactString(line), line).toBe(line);
      expect(containsSecret(line), line).toBe(false);
    }
  });

  test('redactString is idempotent on its own marker and on already-redacted text', () => {
    // Load-bearing for the sink redactions: a caller that pre-redacts must not
    // be double-processed, and re-scrubbing a shipped frame must be a no-op.
    expect(redactString(REDACTION_MARKER)).toBe(REDACTION_MARKER);
    for (const family of CREDENTIAL_FAMILIES) {
      const once = redactString(`leaked ${family.samples[0]} here`);
      expect(redactString(once), family.id).toBe(once);
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

  test('a JSON value with an ESCAPED quote is redacted whole, not up to the escape', () => {
    // The regression this pins, measured before the fix:
    //   redactString('{"password":"ab\\"cdefgh1234"}')
    //     -> '{"password":"[REDACTED]"cdefgh1234"}'      tail intact
    // `"[^"]*"` stops at the first quote INCLUDING an escaped one, so a value
    // containing `\"` was cut short and everything after it survived. Any
    // provider error that echoes a request body reaches this, and the artifact
    // most likely to be pasted into a public ticket is built from these lines.
    // Synthetic material only.
    const line = '{"password":"ab\\"cdefgh1234"}';
    const out = redactString(line);
    // BOTH halves matter. The "no marker at all" assert passes on a fix that
    // simply declined to redact; the "no tail" assert is the one that fails on
    // the half-redaction this replaces.
    expect(out).not.toContain('cdefgh1234');
    expect(out).toContain(REDACTION_MARKER);
    expect(containsSecret(line), 'the scanner shares the pattern, so it shared the bug').toBe(true);
    expect(redactString(line)).not.toContain('\\"');

    // The same shape single-quoted, and a value with a trailing backslash —
    // both reach the alternation this changed.
    expect(redactString("{'token':'ab\\'cdefgh1234'}")).not.toContain('cdefgh1234');
    expect(redactString('{"apiKey":"trailing\\\\"}')).not.toContain('trailing');
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
