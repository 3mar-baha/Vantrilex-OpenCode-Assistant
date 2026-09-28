import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createLogger, REDACTION_MARKER } from '../common/logger.js';
import { TelemetryWriter } from './writer.js';

// Synthetic key material only. `.env.local` holds live keys and is never read.
const SYNTHETIC = `sk-or-v1-${'A'.repeat(48)}`;
const UUID = '123e4567-e89b-12d3-a456-426614174000';

/**
 * W2b: redaction wired into the path that ACTUALLY RUNS.
 *
 * `daemon.ts` constructs a `TelemetryWriter` on every boot
 * (`new TelemetryWriter(join(homedir(), '.opencode-voice-runtime',
 * 'voice-runtime.jsonl'))`), so `record()` is the one place a secret can reach a
 * file on disk that outlives the process. The closed enum unions are what make
 * injection impossible, but `sessionId` is only `z.string().min(1)`.
 */
describe('TelemetryWriter redaction', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  function tmpdir_(): string {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-redaction-'));
    dirs.push(dir);
    return dir;
  }

  test('never writes provider key material to voice-runtime.jsonl', async () => {
    const dir = tmpdir_();
    const file = join(dir, 'voice-runtime.jsonl');
    // A long flush window keeps the unref'd timer from racing the assertions.
    const w = new TelemetryWriter(file, { flushMs: 60_000 });
    try {
      w.record({
        sessionId: `ses_${SYNTHETIC}`,
        eventId: UUID,
        subsystem: 'BRAIN',
        status: 'ERROR',
        latencyMs: 12,
        errorCode: 'BRAIN_FAILED',
      });
      await w.flush();

      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toContain('sk-or-v1-');
      expect(raw).toContain(REDACTION_MARKER);
      // Redaction must not corrupt the document: the row still parses, and the
      // field the value came from is still identifiable.
      const row = JSON.parse(raw.trim()) as { sessionId: string; subsystem: string; seq: number };
      expect(row.sessionId).toBe(`ses_${REDACTION_MARKER}`);
      expect(row.subsystem).toBe('BRAIN');
      expect(row.seq).toBe(0);
    } finally {
      await w.close();
    }
  });

  test('leaves clean rows byte-identical to what the writer produced before', async () => {
    const dir = tmpdir_();
    const file = join(dir, 'voice-runtime.jsonl');
    const w = new TelemetryWriter(file, { flushMs: 60_000 });
    try {
      w.record({
        sessionId: 'ses_9f3k',
        eventId: UUID,
        subsystem: 'STT',
        status: 'OK',
        latencyMs: 25,
        remediationAttempted: 'KeyAdvanced',
      });
      await w.flush();
      const row = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
      expect(row).toMatchObject({
        seq: 0,
        sessionId: 'ses_9f3k',
        eventId: UUID,
        subsystem: 'STT',
        status: 'OK',
        latencyMs: 25,
        remediationAttempted: 'KeyAdvanced',
      });
      expect(row).not.toHaveProperty(REDACTION_MARKER);
    } finally {
      await w.close();
    }
  });

  test('a failed append emits one redacted diagnostic instead of failing silently', async () => {
    const dir = tmpdir_();
    const file = join(dir, 'voice-runtime.jsonl');
    // A directory at the target path: existsSync() is true so rotation is a
    // no-op, then appendFileSync throws EISDIR — a deterministic write failure.
    mkdirSync(file);
    const lines: string[] = [];
    const w = new TelemetryWriter(file, {
      flushMs: 60_000,
      logger: createLogger('warn', { write: (line) => lines.push(line) }),
    });
    try {
      w.record({
        sessionId: `ses_${SYNTHETIC}`,
        eventId: UUID,
        subsystem: 'BRAIN',
        status: 'ERROR',
        latencyMs: 12,
      });
      await expect(w.flush()).rejects.toThrow();

      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('sk-or-v1-');
      const parsed = JSON.parse(lines[0] as string) as {
        level: string;
        msg: string;
        args: { file: string; rows: number; error: { message: string; stack: string } }[];
      };
      expect(parsed.level).toBe('warn');
      expect(parsed.msg).toBe('telemetry flush failed; batch dropped');
      expect(parsed.args[0]!.file).toBe(file);
      expect(parsed.args[0]!.rows).toBe(1);
      expect(parsed.args[0]!.error.stack).not.toContain('sk-or-v1-');
    } finally {
      await w.close();
    }
  });

  test('the writer is silent on the happy path', async () => {
    const dir = tmpdir_();
    const file = join(dir, 'voice-runtime.jsonl');
    const lines: string[] = [];
    const w = new TelemetryWriter(file, {
      flushMs: 60_000,
      logger: createLogger('warn', { write: (line) => lines.push(line) }),
    });
    try {
      w.record({ sessionId: 'ses_1', eventId: UUID, subsystem: 'LAYA', status: 'OK', latencyMs: 3 });
      await w.flush();
      expect(lines).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
