import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { containsSecret, REDACTION_MARKER } from '../common/logger.js';
import {
  assertRedactionSafe,
  collectBundle,
  defaultBundleSources,
  hasResidualMaterial,
  parseDoctorFlags,
  RedactionTrip,
  insideTestRun,
  scrubLogLine,
  type BundleSources,
  type DiagnosticBundle,
  type DocsVerifyRun,
  type KeysRead,
  type TelemetryRead,
} from './bundle.js';

// M5 `doctor --bundle`. The artifact is designed to be pasted into a PUBLIC
// ticket, so redaction is the feature, not a nicety — which is why almost every
// test here is about what the bundle must NOT contain.
//
// The fake material is the `AAAA` shape already used in `ui-server.test.ts` and
// `coordinator.test.ts`. It matches the live redaction patterns (so a redaction
// that silently stopped working fails these tests) and is not shaped like a
// real credential (so a leak from this suite is not a leak at all).

const NOW = 1_759_000_000_000; // 2025-10-01T12:26:40Z — fixed, so daysSince* is stable.
const FAKE_GROQ = 'gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_OR = 'sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_FISH = 'sk-fish-AAAAAAAAAAAAAAAAAAAAAAAAAA';
/** Uppercase: the shared redactor's prefix patterns are case-SENSITIVE, so this
 *  one survives `redactString` entirely. The bundle carries its own stronger
 *  scrub precisely because of that hole. */
const FAKE_UPPER = 'SK-OR-V1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';

interface Harness {
  readonly sources: BundleSources;
  readonly logFiles: Map<string, string>;
  readonly readKeys: ReturnType<typeof vi.fn>;
  readonly readTelemetry: ReturnType<typeof vi.fn>;
  readonly runDocsVerify: ReturnType<typeof vi.fn>;
  readonly readTextFile: ReturnType<typeof vi.fn>;
}

function harness(over: Partial<BundleSources> = {}, logs: Record<string, string> = {}): Harness {
  const logFiles = new Map<string, string>(Object.entries(logs));
  const readTextFile = vi.fn((path: string): string | null => {
    for (const [name, text] of logFiles) if (path.endsWith(name)) return text;
    return null;
  });
  const readKeys = vi.fn((): KeysRead => ({
    path: join('C:', 'pools', 'keyring.dat'),
    present: true,
    error: null,
    pools: [
      { pool: 'groq', count: 1, material: [FAKE_GROQ], undecryptable: false },
      { pool: 'fish', count: 1, material: [FAKE_FISH], undecryptable: false },
      { pool: 'openrouter', count: 0, material: [], undecryptable: true },
    ],
  }));
  const readTelemetry = vi.fn((): TelemetryRead => ({
    path: join('C:', 'rt', 'voice-runtime.jsonl'),
    present: true,
    error: null,
    text: [
      JSON.stringify({
        timestamp: new Date(NOW - 86_400_000 * 9).toISOString(),
        seq: 0,
        subsystem: 'TTS',
        status: 'ERROR',
        latencyMs: 0,
        errorCode: 'TTS_CREDIT_402',
      }),
      JSON.stringify({
        timestamp: new Date(NOW - 1_000).toISOString(),
        seq: 1,
        subsystem: 'STT',
        status: 'OK',
        latencyMs: 726,
      }),
    ].join('\n'),
  }));
  const runDocsVerify = vi.fn(async (): Promise<DocsVerifyRun> => ({
    status: 'ran',
    informational: false,
    reason: null,
    exitCode: 0,
    total: 31,
    passed: 31,
    failed: 0,
    unverified: 0,
    failures: [],
    durationMs: 1234,
  }));
  const base: BundleSources = {
    now: () => NOW,
    runtimeDir: 'C:\\rt',
    ports: [
      { role: 'serve', port: 4096 },
      { role: 'ui-bridge', port: 4097 },
    ],
    servePassword: '',
    ipcToken: '',
    // The install identity the shell holds. `'K'` matches the marker fixture in
    // the daemon-classification block, so classification is decided by the
    // marker rather than short-circuited by "the CLI cannot know the key".
    ownerKey: 'K',
    probeServe: null,
    probeUiBridge: null,
    readConfig: () => ({
      servePort: 4096,
      voice: 'male-default',
      briefings: 'bluf',
      mic: 'armed',
      captureMode: 'push-to-talk',
      sttModel: 'whisper-large-v3-turbo',
      ttsModel: 's2.1-pro-free',
      brainModel: null,
      brainGoldenMs: 2000,
      brainCeilingMs: 5000,
      logLevel: 'info',
      vadModelPath: 'models/silero-vad.onnx',
      vadThreshold: 0.5,
      envPresent: { OPENCODE_SERVER_PASSWORD: true, GROQ_API_KEYS: false },
      error: null,
    }),
    readKeys,
    readOwnerMarker: () => ({ present: false, raw: null, error: null }),
    readTextFile,
    readTelemetry,
    runDocsVerify,
    pidAlive: () => true,
  };
  return { sources: { ...base, ...over }, logFiles, readKeys, readTelemetry, runDocsVerify, readTextFile };
}

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'tool',
  'generatedAt',
  'outcome',
  'exitCode',
  'header',
  'runtime',
  'ports',
  'daemon',
  'config',
  'keys',
  'logs',
  'telemetry',
  'docsVerify',
  'redactions',
  'notes',
];

function deepKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    `${path}.${k}`,
    ...deepKeys(v, `${path}.${k}`),
  ]);
}

describe('parseDoctorFlags', () => {
  test('a bare argv is a no-flag invocation and must not throw', () => {
    // `parseDoctorFlags()` with NO argument at all is the shape a caller that
    // forgot to slice argv[3..] would produce. It has to be the no-flag path,
    // not a crash: crashing would take the legacy `doctor` output down with it.
    expect(() => parseDoctorFlags()).not.toThrow();
    const flags = parseDoctorFlags();
    expect(flags.bundle).toBe(false);
    expect(flags.json).toBe(false);
    expect(flags.out).toBeNull();
    expect(flags.unknown).toEqual([]);
    expect(flags.error).toBeNull();
    expect(flags.legacy).toBe(true);
  });

  test('an empty argv is the same as a bare one', () => {
    expect(parseDoctorFlags([])).toEqual(parseDoctorFlags());
  });

  test('--bundle alone does not imply --json', () => {
    const flags = parseDoctorFlags(['--bundle']);
    expect(flags.bundle).toBe(true);
    expect(flags.json).toBe(false);
    expect(flags.legacy).toBe(false);
  });

  test('--bundle-out takes the NEXT argv, not a bare flag', () => {
    const flags = parseDoctorFlags(['--bundle', '--bundle-out', 'C:\\tmp\\b.json']);
    expect(flags.out).toBe('C:\\tmp\\b.json');
    expect(flags.bundle).toBe(true);
    expect(flags.error).toBeNull();
  });

  test('--bundle-out with no value is an error, not a silent null', () => {
    const flags = parseDoctorFlags(['--bundle-out']);
    expect(flags.error).toContain('--bundle-out');
    expect(flags.out).toBeNull();
  });

  test('--json alone is enough to ask for the JSON surface', () => {
    const flags = parseDoctorFlags(['--json']);
    expect(flags.json).toBe(true);
    expect(flags.legacy).toBe(false);
  });

  test('--bundle-out alone is not the legacy path', () => {
    // The path was asked for; printing the legacy report and ignoring it would
    // be the worst of both readings.
    const flags = parseDoctorFlags(['--bundle-out', 'b.json']);
    expect(flags.bundle).toBe(false);
    expect(flags.legacy).toBe(false);
  });

  test('an unknown flag is REPORTED, never ignored', () => {
    // Silently ignoring it would mean `doctor --bunlde` prints the legacy
    // report and the operator believes they collected a bundle.
    const flags = parseDoctorFlags(['--bunlde']);
    expect(flags.unknown).toEqual(['--bunlde']);
    expect(flags.error).toContain('--bunlde');
    expect(flags.legacy).toBe(false);
  });

  test('a bare positional argument is an unknown flag too', () => {
    expect(parseDoctorFlags(['what']).unknown).toEqual(['what']);
  });

  test('repeated flags do not throw and the last --bundle-out wins', () => {
    const flags = parseDoctorFlags(['--bundle-out', 'a.json', '--bundle-out', 'b.json', '--out-a']);
    expect(() => parseDoctorFlags(['--json', '--json', '--json'])).not.toThrow();
    expect(flags.out).toBe('b.json');
    expect(flags.unknown).toEqual(['--out-a']);
  });

  test('a flag-looking value after --bundle-out is an error, not a path', () => {
    // Writing the artifact to a file literally named `--json` because the path
    // was forgotten is a worse failure than refusing.
    const flags = parseDoctorFlags(['--bundle-out', '--json']);
    expect(flags.out).toBeNull();
    expect(flags.error).toContain('--bundle-out requires a path');
  });
});

describe('schema: every declared key is always present', () => {
  test('with EVERY source failing, no key is missing and nothing is undefined', async () => {
    const h = harness();
    const boom = (): never => {
      throw new Error('source exploded');
    };
    const { bundle } = await collectBundle({
      ...h.sources,
      now: () => NOW,
      readConfig: boom,
      readKeys: boom,
      readOwnerMarker: boom,
      readTelemetry: boom,
      runDocsVerify: boom,
      pidAlive: boom,
      readTextFile: () => 'x',
      probeServe: async () => {
        throw new Error('probe exploded');
      },
      probeUiBridge: async () => {
        throw new Error('probe exploded');
      },
    });
    for (const key of TOP_LEVEL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(bundle, key), `missing top-level key ${key}`).toBe(true);
    }
    // An unavailable SOURCE is null. A consumer diffing two bundles must not
    // have to tell "absent" from "failed" by key existence.
    expect(bundle.daemon).not.toBeUndefined();
    expect(bundle.config).toBeNull();
    expect(bundle.keys).toBeNull();
    expect(bundle.telemetry).toBeNull();
    expect(bundle.docsVerify).toBeNull();
    const serialised = JSON.stringify(bundle);
    expect(serialised).not.toContain(':undefined');
    // …and every nested entry is whole too.
    for (const path of deepKeys(bundle)) expect(path).not.toMatch(/\.$/);
    expect(bundle.ports).toHaveLength(2);
    for (const entry of bundle.ports) {
      for (const key of [
        'role',
        'port',
        'bindAddress',
        'ownerPid',
        'bound',
        'healthy',
        'probe',
        'status',
        'refusal',
        'detail',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(entry, key), `port entry missing ${key}`).toBe(true);
      }
    }
    expect(bundle.logs).toHaveLength(5);
    for (const entry of bundle.logs) {
      for (const key of [
        'name',
        'path',
        'present',
        'bytes',
        'lineCount',
        'included',
        'truncated',
        'binary',
        'lines',
        'scrubbed',
        'refused',
        'error',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(entry, key), `log entry missing ${key}`).toBe(true);
      }
    }
  });

  test('an absent source is null and a failing one is a populated entry with the error', async () => {
    const h = harness();
    const absent = await collectBundle({ ...h.sources, readKeys: null, readTelemetry: null });
    expect(absent.bundle.keys).toBeNull();
    expect(absent.bundle.telemetry).toBeNull();

    const failing = await collectBundle({
      ...h.sources,
      readKeys: () => ({
        path: 'C:\\pools\\keyring.dat',
        present: false,
        error: 'VAULT_CORRUPT: checksum mismatch',
        pools: [],
      }),
    });
    expect(failing.bundle.keys).not.toBeNull();
    expect(failing.bundle.keys?.error).toContain('VAULT_CORRUPT');
    expect(failing.bundle.keys?.present).toBe(false);
  });

  test('the schema version is pinned so a consumer can refuse a future shape', async () => {
    const h = harness();
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.tool).toBe('voxaura-doctor-bundle');
    expect(bundle.generatedAt).toBe(new Date(NOW).toISOString());
    expect(bundle.header.pasteSafe).toBe(true);
  });
});

describe('redaction: four surfaces, one rule', () => {
  test('no surface of the serialised bundle carries key material', async () => {
    const h = harness(
      {},
      {
        'daemon.log': [
          'daemon: started with apiKey=' + FAKE_OR,
          'groq said 401 for gsk_' + FAKE_GROQ.slice(4),
          'Authorization: Bearer ' + FAKE_FISH,
          'nothing secret on this line',
        ].join('\n'),
        'opencode.log': 'serve stderr: fish ' + FAKE_FISH + ' rejected',
        'supervisor.log': 'supervisor: password: ' + 'A'.repeat(24),
      },
    );
    const { bundle } = await collectBundle({
      ...h.sources,
      readTelemetry: () => ({
        path: 'C:\\rt\\voice-runtime.jsonl',
        present: true,
        error: null,
        text: [
          JSON.stringify({
            timestamp: new Date(NOW).toISOString(),
            seq: 7,
            subsystem: 'BRAIN',
            status: 'ERROR',
            latencyMs: 12,
            errorCode: 'BRAIN_FAILED',
            detail: '401 with ' + FAKE_OR,
          }),
          '{torn row with ' + FAKE_GROQ + ' and no closing brace',
        ].join('\n'),
      }),
    });
    const serialised = JSON.stringify(bundle);
    // Surface 1: logs. Surface 2: telemetry rows (parsed AND torn raw).
    // Surface 3: keys — fingerprints only, never material. Surface 4: config,
    // env booleans and every error/detail string the sources hand back.
    for (const fake of [FAKE_GROQ, FAKE_OR, FAKE_FISH, FAKE_UPPER]) {
      expect(serialised, `bundle leaked ${fake.slice(0, 12)}`).not.toContain(fake);
    }
    // The substring form matters too: the pools are stored as one long run.
    expect(serialised).not.toContain('gsk_AAAA');
    expect(serialised).not.toContain('sk-or-v1-AAAA');
    // …and the deliberate tells of a WORKING scrub are still there: the bundle
    // must not have been emptied to achieve "clean".
    expect(bundle.logs.find((l) => l.name === 'daemon.log')?.lines).toHaveLength(4);
    expect(bundle.redactions.scrubbed).toBeGreaterThan(0);
    expect(bundle.keys?.pools.find((p) => p.pool === 'groq')?.fingerprints[0]?.fingerprint).toMatch(
      /^sha256:[0-9a-f]{10}$/,
    );
    expect(bundle.telemetry?.rows[0]?.subsystem).toBe('BRAIN');
    // The torn row is kept (it is evidence) and is flagged, not parsed.
    expect(bundle.telemetry?.rows[1]?.unparsed).toBe(true);
  });

  test('the whole-bundle assertion runs on the FINISHED bundle', async () => {
    const h = harness({}, { 'daemon.log': 'apiKey=' + FAKE_OR });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.redactions.wholeBundleSafe).toBe(true);
    expect(() => assertRedactionSafe(bundle)).not.toThrow();
  });

  test('assertRedactionSafe trips on a bundle that was never scrubbed', () => {
    // The tripwire is the only thing standing between a future source that
    // forgets the read-boundary scrub and a public ticket. Proved non-vacuous
    // by feeding it a poisoned bundle directly: an UPPERCASE key, which the
    // shared redactor's case-sensitive prefix patterns do not touch.
    const poisoned = {
      logs: [{ name: 'daemon.log', lines: ['boom ' + FAKE_UPPER] }],
    } as unknown as DiagnosticBundle;
    expect(() => assertRedactionSafe(poisoned)).toThrow(RedactionTrip);
    // …and it must also trip on the lowercase family, i.e. the check is not
    // accidentally narrower than the redactor it is auditing.
    const poisoned2 = {
      logs: [{ name: 'daemon.log', lines: ['boom ' + FAKE_OR] }],
    } as unknown as DiagnosticBundle;
    expect(() => assertRedactionSafe(poisoned2)).toThrow(RedactionTrip);
  });

  test('a correctly scrubbed bundle is NOT a false positive', () => {
    // MEASURED, not assumed: `containsSecret('token: AAAA')` is TRUE even after
    // `redactString` has scrubbed it, because the marker `[REDACTED]` is itself a
    // legal value for the assignment pattern. A naive `containsSecret(bundle) ===
    // false` assertion would therefore REJECT a perfectly redacted bundle. The
    // check used here strips the marker before scanning, which keeps the real
    // assertion (no material) and drops the artefact (the marker's own shape).
    const scrubbed = { logs: [{ name: 'daemon.log', lines: ['apiKey=' + REDACTION_MARKER] }] };
    expect(containsSecret('apiKey=' + REDACTION_MARKER)).toBe(true); // the artefact
    expect(() => assertRedactionSafe(scrubbed as unknown as DiagnosticBundle)).not.toThrow();
  });

  test('key material only ever enters createHash', async () => {
    const h = harness();
    const { bundle } = await collectBundle(h.sources);
    const groq = bundle.keys?.pools.find((p) => p.pool === 'groq');
    const expected = createHash('sha256').update(FAKE_GROQ).digest('hex').slice(0, 10);
    expect(groq?.fingerprints[0]).toEqual({ index: 0, fingerprint: `sha256:${expected}` });
    // The key count is reported; the keys are not.
    expect(groq?.count).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain(FAKE_GROQ);
    // The source handed over 1+1 keys and the bundle reports 2 pools, so the
    // material really did flow through the fingerprint path.
    expect(bundle.keys?.pools.filter((p) => p.count > 0)).toHaveLength(2);
  });

  test('a short key is refused a fingerprint: 16 bytes is the entropy floor', async () => {
    const short = 'AAAA'; // 4 bytes — dictionary-attackable, so a 40-bit prefix
    // of its hash would be a real disclosure.
    const h = harness({
      readKeys: () => ({
        path: 'k',
        present: true,
        error: null,
        pools: [
          { pool: 'groq', count: 2, material: [short, 'B'.repeat(16)], undecryptable: false },
          { pool: 'fish', count: 0, material: [], undecryptable: false },
          { pool: 'openrouter', count: 0, material: [], undecryptable: false },
        ],
      }),
    });
    const { bundle } = await collectBundle(h.sources);
    const groq = bundle.keys?.pools.find((p) => p.pool === 'groq');
    expect(groq?.fingerprints[0]).toEqual({ index: 0, fingerprint: null, reason: 'below-entropy-floor' });
    expect(groq?.fingerprints[1]?.fingerprint).toMatch(/^sha256:[0-9a-f]{10}$/);
    expect(groq?.suppressedByEntropyFloor).toBe(1);
    expect(bundle.keys?.entropyFloorBytes).toBe(16);
  });

  test('an undecryptable pool is named, not folded into the count', async () => {
    const h = harness();
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.keys?.undecryptable).toEqual(['openrouter']);
    expect(bundle.keys?.pools.find((p) => p.pool === 'openrouter')).toMatchObject({
      count: 0,
      undecryptable: true,
    });
  });
});

describe('a source that was not injected is never read', () => {
  test('the vault and telemetry paths never reach the generic file reader', async () => {
    // The failure this guards is a bundle that opens the operator's keyring.dat
    // as a side effect of being asked for DIAGNOSTICS. Asserted as an EXACT set
    // of paths rather than as "no bad path seen", because a "not.toContain"
    // check passes just as well when the spy never fired at all — and this
    // repo's rule is that an injection which silently no-ops proves nothing.
    const h = harness({}, { 'daemon.log': 'one\ntwo' });
    const { bundle } = await collectBundle({
      ...h.sources,
      readKeys: null,
      readTelemetry: null,
    });
    const paths = h.readTextFile.mock.calls.map((c) => String(c[0]));
    expect(paths).toEqual([
      join('C:\\rt', 'daemon.log'),
      join('C:\\rt', 'daemon-stdout.log'),
      join('C:\\rt', 'opencode.log'),
      join('C:\\rt', 'opencode-stdout.log'),
      join('C:\\rt', 'supervisor.log'),
    ]);
    expect(bundle.logs.find((l) => l.name === 'daemon.log')?.lines).toHaveLength(2);
    for (const p of paths) {
      expect(p).not.toContain('keyring.dat');
      expect(p).not.toContain('voice-runtime.jsonl');
    }
    expect(bundle.keys).toBeNull();
    expect(bundle.telemetry).toBeNull();
  });

  test('an absent source is null, and the KEY is still present', async () => {
    // The schema rule in its sharpest form: a consumer reading `keys` gets
    // `null` — "this run could not read the vault" — rather than a missing
    // property that would read as "no keys were saved" if it used `?? 0`.
    const h = harness();
    const { bundle } = await collectBundle({ ...h.sources, readKeys: null });
    expect(Object.prototype.hasOwnProperty.call(bundle, 'keys')).toBe(true);
    expect(bundle.keys).toBeNull();
  });

  test('an injected source IS read exactly once (non-vacuity control)', async () => {
    const h = harness();
    await collectBundle(h.sources);
    expect(h.readKeys).toHaveBeenCalledTimes(1);
    expect(h.readTelemetry).toHaveBeenCalledTimes(1);
    expect(h.runDocsVerify).toHaveBeenCalledTimes(1);
  });
});

describe('logs: the four shapes that break naive readers', () => {
  test('an empty file is present with zero lines, not absent', async () => {
    const h = harness({}, { 'daemon.log': '' });
    const { bundle } = await collectBundle(h.sources);
    const entry = bundle.logs.find((l) => l.name === 'daemon.log');
    expect(entry).toMatchObject({ present: true, bytes: 0, lineCount: 0, included: 0, lines: [] });
  });

  test('a missing file is present:false with an empty line list', async () => {
    const h = harness({});
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.logs).toHaveLength(5);
    for (const entry of bundle.logs) expect(entry.present).toBe(false);
    expect(bundle.logs.map((l) => l.name)).toEqual([
      'daemon.log',
      'daemon-stdout.log',
      'opencode.log',
      'opencode-stdout.log',
      'supervisor.log',
    ]);
  });

  test('a torn final line (no newline) is kept — it is the interesting one', async () => {
    const h = harness({}, { 'daemon.log': 'complete line\nhalf a line with no newline' });
    const { bundle } = await collectBundle(h.sources);
    const entry = bundle.logs.find((l) => l.name === 'daemon.log');
    expect(entry?.lines).toEqual(['complete line', 'half a line with no newline']);
  });

  test('binary content is flagged and kept, never silently dropped', async () => {
    const h = harness({}, { 'opencode.log': 'before\u0000\u0001\u0002after\n' });
    const { bundle } = await collectBundle(h.sources);
    const entry = bundle.logs.find((l) => l.name === 'opencode.log');
    expect(entry?.binary).toBe(true);
    expect(entry?.lines).toHaveLength(1);
    // Control characters are exactly what this asserts absent, so
    // `no-control-regex` is inverted for the line — the rule would forbid the
    // detector. Same reasoning as the two constants in `bundle.ts`.
    expect(JSON.stringify(bundle)).not.toMatch(/[\u0000-\u0008]/); // oxlint-disable-line no-control-regex
  });

  test('10k lines collapse to the last 200 and say so', async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n');
    const h = harness({}, { 'daemon.log': many });
    const { bundle } = await collectBundle(h.sources);
    const entry = bundle.logs.find((l) => l.name === 'daemon.log');
    expect(entry?.lineCount).toBe(10_000);
    expect(entry?.included).toBe(200);
    expect(entry?.truncated).toBe(true);
    expect(entry?.lines[0]).toBe('line 9800');
    expect(entry?.lines.at(-1)).toBe('line 9999');
  });

  test('a line is capped at 2000 characters', () => {
    const long = 'x'.repeat(5000);
    const scrubbed = scrubLogLine(long);
    expect(scrubbed.text.length).toBeLessThanOrEqual(2000);
    expect(scrubbed.capped).toBe(true);
  });

  test('a bracketed value is consumed whole, so nothing survives beside the marker', () => {
    // Found by probing the shipped bundle, not by reading it. The unquoted
    // value class `[^\s,;)}\]]+` STOPS at `]`, so a value that contains one
    // was redacted only up to it and the tail shipped into an artifact whose
    // entire purpose is to be pasted into a public ticket:
    //
    //   scrubLogLine('daemon: x-api-key: [value-with-bracket inside]')
    //     was -> 'daemon: x-api-key: [REDACTED] inside]'   refused: false
    //
    // and the `[REDACTION-REFUSED]` net did not fire either, because
    // `isNoiseOnly` treats the captured `[REDACTED` as pure noise. Both the
    // shared redactor and this bundle's own scan now carry a bracketed-value
    // alternative, so the value is consumed as a unit.
    const scrubbed = scrubLogLine('daemon: x-api-key: [value-with-bracket inside]');
    expect(scrubbed.text).not.toContain('inside');
    expect(scrubbed.text).toContain('[REDACTED]');
    expect(scrubbed.refused).toBe(false);

    // The already-marker form must still read as fully redacted, or every
    // honest `[REDACTED]` would look like residual material and refuse the line.
    const clean = scrubLogLine('daemon: apiKey=[REDACTED]');
    expect(clean.refused).toBe(false);
    expect(clean.text).toBe('daemon: apiKey=[REDACTED]');
  });

  test('a clean line whose marker is followed by a word is NOT refused', () => {
    // The regression from removing the escape-artefact check. That check
    // existed for a real defect (the shared redactor cutting a JSON value short
    // at an inner quote) which is now FIXED, so the check only produced false
    // positives: `"[REDACTED]"auth` — what a clean `"key":"value","kind":"auth"`
    // fragment reduces to — matched it and refused a perfectly good line. A
    // refusal the reader learns to ignore is worse than no refusal at all.
    const clean = scrubLogLine('daemon: {"kind":"auth","apiKey":"[REDACTED]"}');
    expect(clean.refused).toBe(false);
    expect(clean.text).toContain('[REDACTED]');
  });

  test('the refusal arm still exists and is wired to the oracle', () => {
    // The oracle itself: material-level, so it fires on things a pattern-based
    // check would miss and stays quiet on a correctly redacted value.
    expect(hasResidualMaterial('Bearer Zm9vYmFyYmF6cXV1eA==')).toBe(true);
    expect(hasResidualMaterial('SK-OR-V1-AAAABBBBCCCC')).toBe(true);
    expect(hasResidualMaterial('apiKey=[REDACTED]')).toBe(false);
    expect(scrubLogLine('apiKey=[REDACTED]').text).toBe('apiKey=[REDACTED]');
  });

  test('an escaped quote inside a JSON value is now SCRUBBED, not refused', () => {
    // The regression that fix 0b11ba9 removed, pinned so it cannot return.
    // Before: '{"password":"[REDACTED]"cdefgh1234"}' — the tail survived and
    // the line had to be refused wholesale. After: the whole value is consumed
    // and the line ships.
    const scrubbed = scrubLogLine('{"password":"ab\\"cdefgh1234"}');
    expect(scrubbed.text).not.toContain('cdefgh1234');
    expect(scrubbed.refused).toBe(false);
    expect(scrubbed.scrubbed).toBe(true);
  });

  test('an uppercase provider key is SCRUBBED by the bundle\'s own sweep, not refused', () => {
    // `redactString`'s prefix patterns have no `i` flag, so the shared redactor
    // leaves this alone — a real hole, and the reason this bundle carries a
    // case-insensitive sweep of its own. Scrubbing (not refusing) is correct
    // here: the sweep consumes the whole run, so there is nothing left to
    // refuse, and refusing would throw away a diagnosable line.
    const out = scrubLogLine('serve rejected ' + FAKE_UPPER);
    expect(out.text).not.toContain('SK-OR-V1-');
    expect(out.text).toContain(REDACTION_MARKER);
    expect(out.refused).toBe(false);
    expect(out.scrubbed).toBe(true);
  });

  test('a scrubbed line that keeps its field label is NOT a false positive', () => {
    // `containsSecret('apiKey=[REDACTED]')` is TRUE — the label survives and the
    // marker is a legal value for the assignment pattern. Refusing that line
    // would throw away the label, which is the part that makes it diagnosable.
    const out = scrubLogLine('apiKey=' + REDACTION_MARKER);
    expect(out.refused).toBe(false);
    expect(out.text).toContain('apiKey=');
  });

  test('a refused line does not stop the rest of the file being collected', async () => {
    // The property is bundle-or-nothing: one line the bundle cannot prove safe
    // is replaced, and every other line still ships. A bundle that refused to
    // exist would be worse than one missing a line, so this is load-bearing.
    //
    // The trigger is REAL, not mocked and not contrived. After `0b11ba9` the
    // shipped redactors cover every credential shape a brute-force sweep could
    // assemble, so what is left is a line the bundle cannot PROVE safe for a
    // structural reason: the 2000-char cap truncates in the middle of the
    // redaction marker, leaving `apiKey=[REDAC` — which reads as an assignment
    // still holding a value. Refusing is the correct answer there, and it is
    // the one shape that still reaches the arm.
    const long = `${'a'.repeat(1990)} apiKey=secretvalue123`;
    const line = scrubLogLine(long);
    expect(line.capped).toBe(true);
    expect(line.refused, 'a marker cut in half by the cap cannot be proven safe').toBe(true);
    expect(line.text).toBe('[REDACTION-REFUSED]');

    const h = harness({}, { 'daemon.log': `ok line\n${long}\nok again` });
    const { bundle, notes } = await collectBundle(h.sources);
    const entry = bundle.logs.find((l) => l.name === 'daemon.log');
    expect(entry?.lines).toEqual(['ok line', '[REDACTION-REFUSED]', 'ok again']);
    expect(entry?.refused).toBe(1);
    expect(bundle.redactions.refused).toBe(1);
    expect(notes.join(' ')).toContain('redaction');
  });
});

describe('telemetry: derived from the jsonl, never from a rebuilt monitor', () => {
  test('histograms and daysSinceFirstFault come from the row timestamps', async () => {
    const h = harness();
    const { bundle } = await collectBundle(h.sources);
    const t = bundle.telemetry;
    expect(t?.totalRows).toBe(2);
    expect(t?.returned).toBe(2);
    expect(t?.codeHistogram).toEqual({ TTS_CREDIT_402: 1 });
    expect(t?.subsystemHistogram).toEqual({ TTS: 1, STT: 1 });
    expect(t?.statusHistogram).toEqual({ ERROR: 1, OK: 1 });
    // 9 days before NOW, from the ROW — not from any monitor object.
    expect(t?.daysSinceFirstFault).toBe(9);
    expect(t?.firstFaultAt).toBe(new Date(NOW - 86_400_000 * 9).toISOString());
  });

  test('no fault means null, never 0 — 0 days would read as "just broke"', async () => {
    const h = harness({
      readTelemetry: () => ({
        path: 'p',
        present: true,
        error: null,
        text: JSON.stringify({
          timestamp: new Date(NOW).toISOString(),
          seq: 0,
          subsystem: 'STT',
          status: 'OK',
          latencyMs: 5,
        }),
      }),
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.telemetry?.daysSinceFirstFault).toBeNull();
    expect(bundle.telemetry?.firstFaultAt).toBeNull();
  });

  test('only the last 50 rows are carried, and the count is honest about it', async () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({
        timestamp: new Date(NOW - i * 1000).toISOString(),
        seq: i,
        subsystem: 'STT',
        status: 'OK',
        latencyMs: i,
      }),
    ).join('\n');
    const h = harness({
      readTelemetry: () => ({ path: 'p', present: true, error: null, text: rows }),
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.telemetry?.totalRows).toBe(80);
    expect(bundle.telemetry?.rows).toHaveLength(50);
    expect(bundle.telemetry?.rows[0]?.seq).toBe(30);
    expect(bundle.telemetry?.rows.at(-1)?.seq).toBe(79);
  });
});

describe('docsVerify runs live, or is labelled skipped', () => {
  test('skipped is INFORMATIONAL, and says why', async () => {
    const h = harness({
      runDocsVerify: async () => ({
        status: 'skipped',
        informational: true,
        reason: 'scripts/docs-verify.mjs is not in this payload',
        exitCode: null,
        total: null,
        passed: null,
        failed: null,
        unverified: null,
        failures: [],
        durationMs: null,
      }),
    });
    const { bundle, notes } = await collectBundle(h.sources);
    expect(bundle.docsVerify?.status).toBe('skipped');
    expect(bundle.docsVerify?.informational).toBe(true);
    expect(notes.join(' ')).toContain('informational');
  });

  test('a live run reports counts and never a remembered pass', async () => {
    const h = harness();
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.docsVerify).toMatchObject({ status: 'ran', total: 31, passed: 31, failed: 0 });
    expect(h.runDocsVerify).toHaveBeenCalledTimes(1);
  });

  test('a failing live run is "failed" and names the contradicting claims', async () => {
    const h = harness({
      runDocsVerify: async () => ({
        status: 'failed',
        informational: false,
        reason: 'exit 1',
        exitCode: 1,
        total: 31,
        passed: 29,
        failed: 1,
        unverified: 1,
        failures: ['dead modules', 'test count'],
        durationMs: 90,
      }),
    });
    const { bundle, outcome } = await collectBundle(h.sources);
    expect(bundle.docsVerify?.status).toBe('failed');
    expect(bundle.docsVerify?.failures).toEqual(['dead modules', 'test count']);
    expect(outcome).toBe('degraded');
  });

  // The runner spawns a real child process, so these use real (stub) scripts in
  // a temp dir. They never touch scripts/docs-verify.mjs: that script derives
  // its test-count claims by RUNNING the suite, so invoking it from inside the
  // suite re-enters it (measured as a fork bomb before the guard was added).
  function stubScript(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-dv-'));
    const path = join(dir, 'dv.mjs');
    writeFileSync(path, body, 'utf8');
    return path;
  }

  function sourcesWithScript(script: string): BundleSources {
    return defaultBundleSources({
      env: {} as NodeJS.ProcessEnv,
      cwd: mkdtempSync(join(tmpdir(), 'voxaura-diag-')),
      home: mkdtempSync(join(tmpdir(), 'voxaura-home-')),
      readTextFile: () => null,
      docsVerifyScript: script,
    });
  }

  test('a real child process that emits valid JSON is parsed, not guessed', async () => {
    const script = stubScript(
      'console.log(JSON.stringify({total: 31, passed: 30, failed: 1, unverified: 0, failedNames: ["dead modules"]})); process.exit(1);',
    );
    const { bundle } = await collectBundle(sourcesWithScript(script));
    expect(bundle.docsVerify).toMatchObject({
      status: 'failed',
      exitCode: 1,
      total: 31,
      passed: 30,
      failed: 1,
      unverified: 0,
      failures: ['dead modules'],
    });
    expect(bundle.docsVerify?.durationMs).not.toBeNull();
  });

  test('a clean run is "ran" and the counts are the child\'s, not a constant', async () => {
    const script = stubScript(
      'console.log(JSON.stringify({total: 44, passed: 44, failed: 0, unverified: 0, failedNames: []})); process.exit(0);',
    );
    const { bundle } = await collectBundle(sourcesWithScript(script));
    expect(bundle.docsVerify).toMatchObject({ status: 'ran', total: 44, passed: 44, failed: 0 });
  });

  test('a banner line before the JSON does not become a health finding', async () => {
    // `--json` mode is contractually one document, but a warning line must not
    // turn "the tree drifted" into "the tool could not read the result".
    const script = stubScript(
      'console.log("docs:verify — deriving truth from the tree…"); console.log(JSON.stringify({total: 31, passed: 31, failed: 0, unverified: 0, failedNames: []})); process.exit(0);',
    );
    const { bundle } = await collectBundle(sourcesWithScript(script));
    expect(bundle.docsVerify).toMatchObject({ status: 'ran', total: 31, failed: 0 });
  });

  test('a child that prints prose instead of JSON is "failed", never a silent pass', async () => {
    const script = stubScript('console.log("docs:verify passed — 31 claim(s) match the code."); process.exit(0);');
    const { bundle, outcome } = await collectBundle(sourcesWithScript(script));
    expect(bundle.docsVerify?.status).toBe('failed');
    expect(bundle.docsVerify?.reason).toContain('did not emit JSON');
    expect(outcome).toBe('degraded');
  });

  test('JSON of the wrong shape is "failed", not a partial read', async () => {
    const script = stubScript('console.log(JSON.stringify({ok: true})); process.exit(0);');
    const { bundle } = await collectBundle(sourcesWithScript(script));
    expect(bundle.docsVerify?.status).toBe('failed');
    expect(bundle.docsVerify?.reason).toContain('shape');
  });

  test('UNVERIFIED alone is a failure, exactly as the gate treats it', async () => {
    const script = stubScript(
      'console.log(JSON.stringify({total: 31, passed: 30, failed: 0, unverified: 1, failedNames: ["earcon count"]})); process.exit(1);',
    );
    const { bundle } = await collectBundle(sourcesWithScript(script));
    expect(bundle.docsVerify?.status).toBe('failed');
    expect(bundle.docsVerify?.unverified).toBe(1);
  });

  test('a missing script is informational "skipped", and a bundle is still collected', async () => {
    const { bundle, exitCode } = await collectBundle(
      sourcesWithScript(join(tmpdir(), 'voxaura-does-not-exist', 'docs-verify.mjs')),
    );
    expect(bundle.docsVerify?.status).toBe('skipped');
    expect(bundle.docsVerify?.informational).toBe(true);
    expect(bundle.docsVerify?.reason).toContain('not in this payload');
    expect(exitCode).toBe(1);
  });

  test('insideTestRun is a pure decision over its inputs', () => {
    // The guard is environment-conditional, so the only way to test it is to
    // give it the environment. Without this, forcing the guard either way is
    // INVISIBLE from inside a test run — measured: mutating it to `return true`
    // broke nothing, which is the vacuity this closes.
    expect(insideTestRun({ VITEST: 'true' }, ['node', 'x'])).toBe(true);
    expect(insideTestRun({}, ['node', 'C:\\x\\node_modules\\vitest\\vitest.mjs'])).toBe(true);
    expect(insideTestRun({}, ['node', 'O:\\opencode-Vantrilex\\dist\\cli.js'])).toBe(false);
  });

  test('the resolved docs-verify script is the repository one, and it is NOT spawned', async () => {
    // The guard that stops the fork bomb. Asserted through the real default
    // wiring, so it fails loudly if the guard is ever removed — and it is also
    // the landed-confirmation that the vitest-env detection works at all.
    const s = defaultBundleSources({
      env: {} as NodeJS.ProcessEnv,
      cwd: mkdtempSync(join(tmpdir(), 'voxaura-diag-')),
      home: mkdtempSync(join(tmpdir(), 'voxaura-home-')),
      readTextFile: () => null,
    });
    expect(s.docsVerifyScript).toBe(join('O:\\opencode-Vantrilex', 'scripts', 'docs-verify.mjs'));
    const { bundle } = await collectBundle(s);
    expect(bundle.docsVerify?.status).toBe('skipped');
    expect(bundle.docsVerify?.reason).toContain('test run');
  });
});

describe('daemon classification mirrors the shell, labelled as a mirror', () => {
  const marker = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ v: 1, pid: 4242, ipcPort: 4097, contractVersion: '3.1.0', ownerKey: 'K', ...over });

  test('a closed port is Cold and the mirror says spawn', async () => {
    const h = harness({
      readOwnerMarker: () => ({ present: false, raw: null, error: null }),
      probeUiBridge: async () => ({
        bound: false,
        healthy: false,
        status: null,
        refusal: 'unreachable',
        detail: 'ECONNREFUSED',
      }),
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.daemon?.classification).toBe('Cold');
    expect(bundle.daemon?.bringUp).toMatchObject({ derivedBy: 'cli', action: 'spawn' });
  });

  test('our marker + a 101 handshake is Ours/adopt, and the pid is checked', async () => {
    const h = harness({
      readOwnerMarker: () => ({ present: true, raw: marker(), error: null }),
      probeUiBridge: async () => ({
        bound: true,
        healthy: true,
        status: 101,
        refusal: 'none',
        detail: null,
      }),
      pidAlive: () => true,
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.daemon?.classification).toBe('Ours');
    expect(bundle.daemon?.pid).toBe(4242);
    expect(bundle.daemon?.pidAlive).toBe(true);
    expect(bundle.daemon?.ownerKeyMatch).toBe(true);
    expect(bundle.daemon?.bringUp?.action).toBe('adopt');
    expect(bundle.daemon?.contractMatches).toBe(true);
  });

  test('a dead pid in our own marker is Foreign — the silent-adoption case', async () => {
    const h = harness({
      readOwnerMarker: () => ({ present: true, raw: marker(), error: null }),
      probeUiBridge: async () => ({
        bound: true,
        healthy: true,
        status: 101,
        refusal: 'none',
        detail: null,
      }),
      pidAlive: () => false,
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.daemon?.classification).toBe('Foreign');
    expect(bundle.daemon?.reason).toContain('not running');
    expect(bundle.daemon?.bringUp?.action).toBe('refuse');
  });

  test('a contract version mismatch is a THREE-WAY signal, not just "Foreign"', async () => {
    const h = harness({
      readOwnerMarker: () => ({ present: true, raw: marker({ contractVersion: '9.9.9' }), error: null }),
      probeUiBridge: async () => ({
        bound: true,
        healthy: true,
        status: 101,
        refusal: 'none',
        detail: null,
      }),
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.daemon?.classification).toBe('Ours');
    expect(bundle.daemon?.contractVersion).toBe('9.9.9');
    expect(bundle.daemon?.contractMatches).toBe(false);
    expect(bundle.daemon?.expectedContractVersion).not.toBeNull();
  });

  test('an unreadable marker is Foreign with the reason, never a crash', async () => {
    const h = harness({
      readOwnerMarker: () => ({ present: true, raw: '{"v":1,"pid":', error: 'unexpected end of JSON' }),
      probeUiBridge: async () => ({
        bound: true,
        healthy: true,
        status: 101,
        refusal: 'none',
        detail: null,
      }),
    });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.daemon?.classification).toBe('Foreign');
    expect(bundle.daemon?.ownerMarkerError).toContain('JSON');
  });

  test('no marker reader AND no port probe leaves daemon null, not a guess', async () => {
    const h = harness({ readOwnerMarker: null, probeUiBridge: null });
    const { bundle } = await collectBundle(h.sources);
    expect(bundle.daemon).toBeNull();
  });
});

describe('ports carry the status code, because 401 is not unreachable', () => {
  test('401 is reachable-but-unauthenticated, the L17 discriminator', async () => {
    const h = harness({
      servePassword: 'p',
      probeServe: async () => ({ healthy: false, status: 401, refusal: 'unauthenticated', detail: null }),
    });
    const { bundle } = await collectBundle(h.sources);
    const serve = bundle.ports.find((p) => p.role === 'serve');
    expect(serve?.status).toBe(401);
    expect(serve?.refusal).toBe('unauthenticated');
    expect(serve?.bound).toBe(true);
    expect(serve?.healthy).toBe(false);
  });

  test('no status at all is unreachable, which is a different diagnosis', async () => {
    const h = harness({
      servePassword: 'p',
      probeServe: async () => ({ healthy: false, status: null, refusal: 'unreachable', detail: 'ECONNREFUSED' }),
    });
    const { bundle } = await collectBundle(h.sources);
    const serve = bundle.ports.find((p) => p.role === 'serve');
    expect(serve?.status).toBeNull();
    expect(serve?.refusal).toBe('unreachable');
    expect(serve?.bound).toBe(false);
  });

  test('a missing probe is "not-probed", never "healthy"', async () => {
    const h = harness({ probeServe: null, probeUiBridge: null });
    const { bundle, outcome } = await collectBundle(h.sources);
    for (const entry of bundle.ports) {
      expect(entry.probe).toBe('none');
      expect(entry.refusal).toBe('not-probed');
      expect(entry.healthy).toBe(false);
    }
    expect(outcome).toBe('degraded');
  });

  test('the serve password is never echoed into a probe detail', async () => {
    const h = harness({
      servePassword: 'super-secret-password',
      probeServe: async () => ({
        healthy: false,
        status: 401,
        refusal: 'unauthenticated',
        detail: 'GET /api/session with password: super-secret-password',
      }),
    });
    const { bundle } = await collectBundle(h.sources);
    expect(JSON.stringify(bundle)).not.toContain('super-secret-password');
    expect(bundle.ports.find((p) => p.role === 'serve')?.detail).toContain(REDACTION_MARKER);
  });
});

describe('outcome and exit code', () => {
  test('healthy is 0, degraded-but-collected is 1', async () => {
    const h = harness({
      servePassword: 'p',
      probeServe: async () => ({ healthy: true, status: 200, refusal: 'none', detail: null }),
      probeUiBridge: async () => ({ bound: true, healthy: true, status: 101, refusal: 'none', detail: null }),
      readOwnerMarker: () => ({
        present: true,
        raw: JSON.stringify({
          v: 1,
          pid: 4242,
          ipcPort: 4097,
          contractVersion: '3.1.0',
          ownerKey: 'K',
        }),
        error: null,
      }),
      readKeys: () => ({
        path: 'k',
        present: true,
        error: null,
        pools: [
          { pool: 'groq', count: 1, material: [FAKE_GROQ], undecryptable: false },
          { pool: 'fish', count: 1, material: [FAKE_FISH], undecryptable: false },
          { pool: 'openrouter', count: 1, material: [FAKE_OR], undecryptable: false },
        ],
      }),
      readTelemetry: () => ({ path: 'p', present: true, error: null, text: '' }),
    });
    const ok = await collectBundle(h.sources);
    expect(ok.outcome).toBe('healthy');
    expect(ok.exitCode).toBe(0);
    const bad = await collectBundle({ ...h.sources, probeServe: null });
    expect(bad.outcome).toBe('degraded');
    expect(bad.exitCode).toBe(1);
  });

  test('the JSON body disambiguates the exit-2 collision with usage errors', async () => {
    // `cli.ts` already exits 2 for bad usage, so an exit code alone cannot say
    // whether the CLI or the COLLECTION failed. The body has to.
    const { bundle, outcome, exitCode } = await collectBundle(harness().sources);
    expect(exitCode).toBe(1);
    expect(bundle.outcome).toBe(outcome);
    expect(bundle.tool).toBe('voxaura-doctor-bundle');
  });
});

describe('the module itself', () => {
  test('imports nothing that can start a daemon', () => {
    // The whole reason this module exists is to be runnable when the daemon is
    // DOWN, so a transitive `daemon.ts` import would defeat it. Anchored on the
    // file's own text, with a positive control so an unread path or a renamed
    // import cannot make the negative vacuous.
    const src = readFileSync(join(import.meta.dirname, 'bundle.ts'), 'utf8');
    expect(src.length).toBeGreaterThan(1000); // landed-confirmation
    expect(src).toContain("from '../common/logger.js'");
    expect(src).not.toMatch(/from '\.\.\/daemon\.js'/);
    expect(src).not.toMatch(/import\(['"]\.\.\/daemon\.js['"]\)/);
    expect(src).not.toMatch(/from '\.\.\/ipc\/ui-server\.js'/);
  });

  test('default sources resolve the same paths the daemon does', () => {
    // A mirror that drifts is a wrong answer presented confidently, so this is
    // checked against the daemon's OWN exported resolvers rather than against a
    // copy of them.
    const env = { VOXAURA_VAULT_DIR: 'C:\\vault-root' } as NodeJS.ProcessEnv;
    const sources = defaultBundleSources({
      env,
      cwd: 'C:\\work',
      home: 'C:\\Users\\u',
      readTextFile: () => null,
    });
    expect(sources.vaultPath).toBe(join('C:\\vault-root', 'keyring.dat'));
    expect(sources.ipcTokenPath).toBe(join('C:\\Users\\u', '.opencode-voice-runtime', 'ipc.token'));
    expect(sources.runtimeDir).toBe(join('C:\\Users\\u', '.opencode-voice-runtime'));
    const overridden = defaultBundleSources({
      env: { VOICE_RUNTIME_DIR: 'C:\\rt2' } as NodeJS.ProcessEnv,
      cwd: 'C:\\work',
      home: 'C:\\Users\\u',
      readTextFile: () => null,
    });
    expect(overridden.runtimeDir).toBe('C:\\rt2');
  });

  test('the default source wiring never throws on a bare env', async () => {
    const sources = defaultBundleSources({
      env: {} as NodeJS.ProcessEnv,
      cwd: mkdtempSync(join(tmpdir(), 'voxaura-diag-')),
      home: mkdtempSync(join(tmpdir(), 'voxaura-home-')),
      readTextFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    });
    const { bundle } = await collectBundle(sources);
    expect(bundle.exitCode).toBeLessThanOrEqual(1);
    expect(bundle.ports.map((p) => p.role)).toEqual(['serve', 'ui-bridge']);
  });

  test('an env value is reported as a BOOLEAN and never as a value', async () => {
    const sources = defaultBundleSources({
      env: { GROQ_API_KEYS: FAKE_GROQ, OPENROUTER_API_KEYS: '' } as NodeJS.ProcessEnv,
      cwd: mkdtempSync(join(tmpdir(), 'voxaura-diag-')),
      home: mkdtempSync(join(tmpdir(), 'voxaura-home-')),
      readTextFile: () => null,
    });
    const { bundle } = await collectBundle(sources);
    expect(bundle.config?.envPresent['GROQ_API_KEYS']).toBe(true);
    expect(bundle.config?.envPresent['OPENROUTER_API_KEYS']).toBe(false);
    expect(JSON.stringify(bundle)).not.toContain(FAKE_GROQ);
  });
});

describe('scrubLogLine', () => {
  test('a clean line is returned untouched and not counted as scrubbed', () => {
    const out = scrubLogLine('daemon: started on 127.0.0.1:4097');
    expect(out.text).toBe('daemon: started on 127.0.0.1:4097');
    expect(out.scrubbed).toBe(false);
    expect(out.refused).toBe(false);
    expect(out.capped).toBe(false);
  });

  test('a tab, a CR and a quote survive so the line stays diagnosable', () => {
    const out = scrubLogLine('ts\t2026-01-01 "warn" ready\r');
    expect(out.text).toContain('\t');
    expect(out.text).toContain('"warn"');
  });
});

describe('written artifacts', () => {
  test('renderBundle is deterministic for a fixed clock', async () => {
    const { renderBundle } = await import('./bundle.js');
    const h = harness({}, { 'daemon.log': 'x' });
    const a = renderBundle((await collectBundle(h.sources)).bundle);
    const b = renderBundle((await collectBundle(h.sources)).bundle);
    expect(a).toBe(b);
    expect(() => JSON.parse(a) as unknown).not.toThrow();
  });

  test('a temp dir really is writable, so the CLI write path is testable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-out-'));
    const p = join(dir, 'b.json');
    writeFileSync(p, 'x');
    expect(readFileSync(p, 'utf8')).toBe('x');
  });
});
