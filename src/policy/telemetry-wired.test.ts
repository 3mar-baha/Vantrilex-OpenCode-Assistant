import { describe, expect, test } from 'vitest';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelemetryWriter } from '../telemetry/index.js';

// The diagnostics bus (audit §3.4) was fully built, schema-validated and unit
// tested, and then never called by anything. It was dead in exactly the same way
// `SileroVad` was: the feature existed, the tests passed, the wiring did not.
//
// These tests exist so it cannot silently go back to that state.

// One source of truth, read once — the daemon is the only thing that should be
// instrumenting, and reading it is cheaper than booting the whole control plane.
const DAEMON = readFileSync('src/daemon.ts', 'utf8');

describe('telemetry is wired into the daemon (was dead code)', () => {
  test('the daemon constructs a real TelemetryWriter', () => {
    expect(DAEMON).toMatch(/new\s+TelemetryWriter\(/);
    // Into the runtime dir, next to the logs an operator already looks at.
    expect(DAEMON).toMatch(/\.opencode-voice-runtime/);
  });

  test('every voice subsystem in the loop reports a latency', () => {
    // Without a latency the file answers "did it fail?" but never "is it
    // slow?", which is the question a user actually asks about a voice app.
    for (const subsystem of ['STT', 'BRAIN', 'TTS']) {
      expect(DAEMON).toMatch(new RegExp(`subsystem:\\s*'${subsystem}'`));
    }
    expect(DAEMON.match(/latencyMs/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  test('the four real failure paths are recorded, not just the happy path', () => {
    // Each of these was a path that produced a UI notice and nothing else, so
    // a bug report could never be reconstructed after the fact.
    for (const code of ['STT_FAILED', 'STT_TIMEOUT', 'BRAIN_FAILED', 'TTS_FAILED', 'KEYS_MISSING']) {
      expect(DAEMON).toContain(`errorCode: '${code}'`);
    }
    expect(DAEMON).toMatch(/status:\s*'ERROR'/);
    expect(DAEMON).toMatch(/status:\s*'DEGRADED'/);
  });

  test('telemetry can never break the voice loop it measures', () => {
    // record() is the only door to the writer, and it swallows everything. A
    // diagnostics bus that can crash the product is worse than no bus.
    const recordBody = DAEMON.match(/const record = \([\s\S]*?\n  };/);
    expect(recordBody).not.toBeNull();
    expect(recordBody?.[0]).toMatch(/catch\s*\{/);
    // And the writer's own parse is strict, so only schema-valid rows land.
    expect(DAEMON).toMatch(/sanitizedErrorClass:\s*classify\(err\)/);
  });

  test('the buffer is flushed on shutdown', () => {
    // The rows explaining why the user quit are the last ones buffered.
    expect(DAEMON).toMatch(/telemetry\.close\(\)/);
  });
});

describe('the recorded rows are actually usable on disk', () => {
  test('a full STT/BRAIN/TTS turn lands as valid JSONL in the runtime dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-telemetry-'));
    const file = join(dir, 'voice-runtime.jsonl');
    const w = new TelemetryWriter(file, { flushMs: 1 });
    try {
      w.record({
        sessionId: 'ses_x',
        eventId: '00000000-0000-4000-8000-000000000001',
        subsystem: 'STT',
        status: 'OK',
        latencyMs: 812,
      });
      w.record({
        sessionId: 'ses_x',
        eventId: '00000000-0000-4000-8000-000000000002',
        subsystem: 'BRAIN',
        status: 'ERROR',
        latencyMs: 30000,
        errorCode: 'BRAIN_FAILED',
        sanitizedErrorClass: 'QuotaExceeded',
      });
      w.record({
        sessionId: 'none',
        eventId: '00000000-0000-4000-8000-000000000003',
        subsystem: 'KEYRING',
        status: 'DEGRADED',
        latencyMs: 0,
        errorCode: 'KEYS_MISSING',
        sanitizedErrorClass: 'AuthError',
      });
      await w.close();

      const rows = (await readdir(dir))
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n'))
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      expect(rows).toHaveLength(3);
      // Monotonic writer-assigned seq is what makes the file diffable.
      expect(rows.map((r) => r['seq'])).toEqual([0, 1, 2]);
      expect(rows.map((r) => r['subsystem'])).toEqual(['STT', 'BRAIN', 'KEYRING']);
      // A keyless daemon is the common case and must be greppable.
      expect(rows[2]?.['errorCode']).toBe('KEYS_MISSING');
      // Latency is the signal the file exists to carry.
      expect(rows[0]?.['latencyMs']).toBe(812);
      // The anti-injection invariant: no field anywhere can hold a transcript.
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/transcript|utterance|prompt|reply/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unvalidated value is refused rather than silently written', () => {
    // The daemon's `record` swallows errors, so the LAST line of defence is
    // that the schema itself rejects a bad row at the boundary.
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-telemetry-bad-'));
    try {
      const w = new TelemetryWriter(join(dir, 'x.jsonl'), { flushMs: 1 });
      expect(() =>
        w.record({
          sessionId: 'ses_x',
          eventId: 'not-a-uuid',
          subsystem: 'STT',
          status: 'OK',
          latencyMs: 1,
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
