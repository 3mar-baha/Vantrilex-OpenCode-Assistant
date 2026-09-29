import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger, redactObject, type Logger } from '../common/logger.js';

// Machine diagnostics bus — G4C. Target: ~/.opencode/logs/voice-runtime.jsonl.
// Anti-injection invariant: there is NO transcript or free-text field anywhere
// in this schema, so adversarial voice input cannot reach OpenCode agents
// through this channel. Closed unions only; seq is writer-assigned monotonic.
export const SanitizedErrorClassSchema = z.enum([
  'FetchError',
  'AbortError',
  'TimeoutError',
  'ZodError',
  'OnnxError',
  'AudioDecodeError',
  'AudioDeviceError',
  'AuthError',
  'QuotaExceeded',
  'ContractDrift',
  'Unknown',
]);
export type SanitizedErrorClass = z.infer<typeof SanitizedErrorClassSchema>;

export const RemediationSchema = z.enum([
  'None',
  'KeyAdvanced',
  'ReconnectedSSE',
  'ReconnectedWS',
  'QueuePurged',
  'PlaybackAborted',
  'ServeRestarted',
  'ModelThrottled',
  'CacheBypassed',
  // M2-6a (D2): the intake re-ask. A ~2 s BRAIN row may be one call or two;
  // this member says which, so a re-ask never silently doubles a latency.
  'Reasked',
]);
export type RemediationAttempted = z.infer<typeof RemediationSchema>;

const SubsystemSchema = z.enum(['STT', 'BRAIN', 'TTS', 'LAYA', 'LAUNCHER', 'KEYRING']);
const StatusSchema = z.enum(['OK', 'DEGRADED', 'ERROR']);
const ErrorCodeSchema = z.enum([
  'SERVE_UNREACHABLE',
  'CONTRACT_DRIFT',
  'SSE_DISCONNECTED',
  'SESSION_NOT_FOUND',
  'STT_FAILED',
  'BRAIN_TIMEOUT',
  // Added when the writer was finally wired to the daemon. The closed union
  // predated instrumentation and had no honest code for a STT stall, a brain
  // failure, or a keyless daemon. Reusing BRAIN_TIMEOUT for all three would
  // have put a lie in the data, which is the one thing this file must not do.
  'STT_TIMEOUT',
  'BRAIN_FAILED',
  'KEYS_MISSING',
  'TTS_FAILED',
  // Credit faults are their own codes, not TTS_FAILED. The fix is to top up,
  // not to rotate a key, and telemetry that folds the two together hides a
  // renewal from whoever is watching the dashboard. 402 = empty balance,
  // 429 = fair-use window exhausted.
  'TTS_CREDIT_402',
  'TTS_CREDIT_429',
  'AUDIO_DEVICE_MISSING',
  'VAULT_CORRUPT',
  'POOL_EXHAUSTED',
  'RATE_LIMITED',
  'APPROVAL_EXPIRED',
  'CONFIG_INVALID',
  'ALREADY_RUNNING',
  'HIGH_STAKES_CONFIRM_REQUIRED',
]);

const RecordInputSchema = z.object({
  sessionId: z.string().min(1),
  eventId: z.string().uuid(),
  subsystem: SubsystemSchema,
  status: StatusSchema,
  latencyMs: z.number().nonnegative(),
  errorCode: ErrorCodeSchema.optional(),
  sanitizedErrorClass: SanitizedErrorClassSchema.optional(),
  remediationAttempted: RemediationSchema.optional(),
});
export type TelemetryInput = z.infer<typeof RecordInputSchema>;

export interface TelemetryWriterOptions {
  readonly flushMs?: number;
  readonly maxBytes?: number;
  /**
   * Diagnostic sink for writer-level failures. Defaults to a redacting stderr
   * logger. Injectable so a test can assert what was said without capturing
   * the process's streams.
   */
  readonly logger?: Logger;
}

export class TelemetryWriter {
  private seq = 0;
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly maxBytes: number;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    options: TelemetryWriterOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 500;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.logger = options.logger ?? createLogger('warn', { bindings: { scope: 'telemetry' } });
  }

  /**
   * Validate (throws on any unvalidated value) and buffer one row.
   *
   * The schema closes every enum and has no free-text field, which is what makes
   * injection impossible on this channel — but `sessionId` is `z.string().min(1)`,
   * so a caller that passes a session id derived from an error string could still
   * land provider key material in `~/.opencode-voice-runtime/voice-runtime.jsonl`,
   * a file that persists on disk indefinitely. The row is therefore redacted
   * STRUCTURALLY, before `JSON.stringify`, which also guarantees the scrubbed
   * field values stay quoted and the line stays parseable JSONL.
   */
  record(input: TelemetryInput): number {
    const parsed = RecordInputSchema.parse(input);
    const row = JSON.stringify(redactObject({
      timestamp: new Date().toISOString(),
      seq: this.seq,
      ...parsed,
    }));
    this.pending.push(row);
    const assigned = this.seq;
    this.seq += 1;
    if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.flushMs);
      this.timer.unref();
    }
    return assigned;
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    this.rotateIfNeeded();
    const batch = this.pending.join('\n') + '\n';
    this.pending = [];
    try {
      appendFileSync(this.file, batch, 'utf8');
    } catch (err) {
      // The batch is already dequeued, so these rows are gone. Both the daemon's
      // timer (`.catch(() => undefined)`) and `close()` swallow this, which made
      // a full disk or a revoked ACL in `~/.opencode-voice-runtime/` completely
      // silent. One redacted line per failure is bounded and diagnosable.
      this.logger.warn('telemetry flush failed; batch dropped', {
        file: this.file,
        rows: batch.split('\n').length - 1,
        error: err,
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) {
      writeFileSync(this.file, '', 'utf8');
      return;
    }
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size >= this.maxBytes) {
      try {
        renameSync(this.file, `${this.file}.1`);
      } catch {
        // rotation is best-effort; the append below still lands
      }
    }
  }
}
