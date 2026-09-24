import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TelemetryWriter } from './writer.js';

// G4C — machine diagnostics bus. No transcripts, no free text: injection is
// impossible by construction (there is no text field to inject into).
describe('TelemetryWriter', () => {
  let dirs: string[] = [];
  afterEach(() => {
    dirs = [];
  });

  function writer(opts?: { flushMs?: number; maxBytes?: number }): { w: TelemetryWriter; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-'));
    dirs.push(dir);
    return { w: new TelemetryWriter(join(dir, 'voice-runtime.jsonl'), opts), dir };
  }

  test('assigns monotonic seq and flushes JSONL rows', async () => {
    const { w, dir } = writer({ flushMs: 10 });
    try {
      w.record({
        sessionId: 'ses_1', eventId: '123e4567-e89b-12d3-a456-426614174000',
        subsystem: 'LAYA', status: 'OK', latencyMs: 25,
      });
      w.record({
        sessionId: 'ses_1', eventId: '123e4567-e89b-12d3-a456-426614174001',
        subsystem: 'TTS', status: 'ERROR', latencyMs: 900,
        errorCode: 'TTS_FAILED', sanitizedErrorClass: 'QuotaExceeded',
        remediationAttempted: 'KeyAdvanced',
      });
      await w.flush();
      const lines = readFileSync(join(dir, 'voice-runtime.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const rows = lines.map((l) => JSON.parse(l) as { seq: number; timestamp: string });
      expect(rows[0]!.seq).toBe(0);
      expect(rows[1]!.seq).toBe(1);
      expect(typeof rows[0]!.timestamp).toBe('string');
    } finally {
      await w.close();
    }
  });

  test('rejects unvalidated enums, bad UUIDs, and negative latencies', async () => {
    const { w } = writer({ flushMs: 10 });
    try {
      expect(() =>
        w.record({
          sessionId: 'ses_1', eventId: 'not-a-uuid', subsystem: 'LAYA', status: 'OK', latencyMs: 1,
        }),
      ).toThrow();
      expect(() =>
        w.record({
          sessionId: 'ses_1', eventId: '123e4567-e89b-12d3-a456-426614174000',
          subsystem: 'HACKER' as never, status: 'OK', latencyMs: 1,
        }),
      ).toThrow();
      expect(() =>
        w.record({
          sessionId: 'ses_1', eventId: '123e4567-e89b-12d3-a456-426614174000',
          subsystem: 'LAYA', status: 'OK', latencyMs: -5,
        }),
      ).toThrow();
    } finally {
      await w.close();
    }
  });

  test('rotates at the byte cap instead of growing forever', async () => {
    const { w, dir } = writer({ flushMs: 5, maxBytes: 300 });
    try {
      for (let batch = 0; batch < 2; batch += 1) {
        for (let i = 0; i < 5; i += 1) {
          w.record({
            sessionId: 'ses_1',
            eventId: `123e4567-e89b-12d3-a456-4266141740${batch}${i}`.slice(0, 36),
            subsystem: 'STT',
            status: 'OK',
            latencyMs: i,
          });
        }
        await w.flush();
      }
      const files = readdirSync(dir);
      expect(files.some((f) => f.endsWith('.1'))).toBe(true);
    } finally {
      await w.close();
    }
  });

  test('close() flushes and stops the timer (no hanging handles)', async () => {
    const { w, dir } = writer({ flushMs: 5 });
    w.record({
      sessionId: 's', eventId: '123e4567-e89b-12d3-a456-426614174000',
      subsystem: 'KEYRING', status: 'DEGRADED', latencyMs: 3,
      remediationAttempted: 'KeyAdvanced',
    });
    await w.close();
    const lines = readFileSync(join(dir, 'voice-runtime.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
