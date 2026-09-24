import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { DispatchProvenance } from '../runtime/client.js';

// Cross-session dispatch backpressure (Phase 2) — bounded per-session FIFO.
// Busy and retryable-transient failures back off exponentially; non-retryable
// failures and exhausted attempts drop WITH a report (never silently).
// Overlap-safe: a drain already in flight makes concurrent drains no-op.
export interface PendingDispatch {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly provenance: DispatchProvenance;
}

export interface DispatchOutcome {
  readonly ok: boolean;
  readonly sessionId: SessionId;
  readonly receipt?: string;
  readonly queued?: true;
  readonly dropped?: true;
  readonly detail?: string;
}

export interface DispatchClient {
  dispatchPrompt(
    sessionId: SessionId,
    text: string,
    provenance: DispatchProvenance,
  ): Promise<{ state: string; receipt: string }>;
}

interface Queued extends PendingDispatch {
  attempts: number;
  nextDueMs: number;
}

export interface DispatchQueueOptions {
  readonly maxPending?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_ATTEMPTS = 5;

export class DispatchQueue {
  private readonly pending: Queued[] = [];
  private readonly maxPending: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private draining = false;

  constructor(options: DispatchQueueOptions = {}) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Enqueue; false when full (caller decides — never silent). */
  enqueue(item: PendingDispatch): boolean {
    if (this.pending.length >= this.maxPending) return false;
    this.pending.push({ ...item, attempts: 0, nextDueMs: this.now() });
    return true;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  async drainDue(client: DispatchClient, nowMs?: number): Promise<DispatchOutcome[]> {
    if (this.draining) return [];
    this.draining = true;
    try {
      const now = nowMs ?? this.now();
      const outcomes: DispatchOutcome[] = [];
      const remaining: Queued[] = [];
      for (const item of this.pending) {
        if (item.nextDueMs > now) {
          remaining.push(item);
          continue;
        }
        try {
          const sent = await client.dispatchPrompt(item.sessionId, item.text, item.provenance);
          outcomes.push({ ok: true, sessionId: item.sessionId, receipt: sent.receipt });
        } catch (err) {
          const retryable = err instanceof OrchestratorError ? err.retryable : true;
          const attempts = item.attempts + 1;
          if (!retryable || attempts >= this.maxAttempts) {
            outcomes.push({
              ok: false,
              sessionId: item.sessionId,
              dropped: true,
              detail: err instanceof Error ? err.message : 'unknown',
            });
          } else {
            const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempts - 1));
            remaining.push({ ...item, attempts, nextDueMs: now + delay });
            outcomes.push({ ok: false, sessionId: item.sessionId, queued: true });
          }
        }
      }
      this.pending.length = 0;
      this.pending.push(...remaining);
      return outcomes;
    } finally {
      this.draining = false;
    }
  }
}
