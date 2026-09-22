import { nowIso } from '../common/brands.js';
import type { SessionId } from '../common/brands.js';

// Speech queue — docs/02 §2.1/§2.3.2. FIFO with identity prefixes, failure-first
// preemption, depth>3 digest collapse. Audio never overlaps: the speaker drains
// one job at a time; playback itself is P4 (this queue only orders).
export type BriefingTier = 'T1' | 'T2';

export interface BriefingJob {
  readonly sessionId: SessionId;
  readonly eventId: string;
  readonly tier: BriefingTier;
  readonly outcome: string;
  readonly text: string;
  readonly enqueuedAt: string;
}

export class SpeechQueue {
  private readonly pending: BriefingJob[] = [];
  private readonly seenEventIds = new Set<string>();

  /** Enqueue exactly once per event id (E-4/E-10 dedupe). Returns false on duplicate. */
  enqueue(job: Omit<BriefingJob, 'enqueuedAt'>): boolean {
    if (this.seenEventIds.has(job.eventId)) return false;
    this.seenEventIds.add(job.eventId);
    const full: BriefingJob = { ...job, enqueuedAt: nowIso() };
    if (job.tier === 'T2') {
      const firstT1 = this.pending.findIndex((j) => j.tier === 'T1');
      if (firstT1 === -1) this.pending.unshift(full);
      else this.pending.splice(firstT1 + 1, 0, full);
    } else {
      this.pending.push(full);
    }
    return true;
  }

  /** Drain one job; collapses stale T1 tail into a digest when depth > 3. */
  dequeue(): BriefingJob | { digest: BriefingJob } | null {
    const next = this.pending.shift();
    if (next === undefined) return null;
    if (next.tier === 'T1' && this.pending.length > 3) {
      const collapsed = this.pending.splice(0, this.pending.length - 2);
      const digest: BriefingJob = {
        sessionId: next.sessionId,
        eventId: `digest-${next.eventId}`,
        tier: 'T1',
        outcome: 'unknown',
        text: `${collapsed.length + 1} sessions finished — see ledger for detail.`,
        enqueuedAt: nowIso(),
      };
      return { digest };
    }
    return next;
  }

  get depth(): number {
    return this.pending.length;
  }
}
