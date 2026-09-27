import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

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
}

export class TelemetryWriter {
  private seq = 0;
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly flushMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly file: string,
    options: TelemetryWriterOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 500;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  }

  /** Validate (throws on any unvalidated value) and buffer one row. */
  record(input: TelemetryInput): number {
    const parsed = RecordInputSchema.parse(input);
    const row = JSON.stringify({
      timestamp: new Date().toISOString(),
      seq: this.seq,
      ...parsed,
    });
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
    appendFileSync(this.file, batch, 'utf8');
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
