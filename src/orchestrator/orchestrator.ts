import { nowIso } from '../common/brands.js';
import type { SessionId } from '../common/brands.js';
import type { ServeClient } from '../runtime/client.js';
import { LifecycleEventType, parseSseFrame, type EventEnvelope } from './events.js';
import { Ledger } from './ledger.js';
import { SpeechQueue } from './queue.js';

// Orchestrator core — docs/04 §4.3/§4.4.2, docs/25 §25.3A/§25.4. Native-fetch SSE
// reader (no dep API risk); staggered reconnect (50ms base, ±30ms jitter, 2.5s cap);
// append-before-effect ledger; tiered speech queue.
export interface Speaker {
  speak(text: string): Promise<void>;
}

/** Advisory System-1 gate (M7 Laya). Absent advisor = prior behavior, unchanged. */
export interface SpeechAdvisor {
  shouldSpeak(text: string): Promise<boolean>;
  isDestructive(text: string): Promise<boolean>;
}

/** FR-12 band policy: scores in [0.35, 0.70) are ambiguous, ≥0.70 destructive.
 * Both escalate to an explicit confirmation briefing instead of routine speech. */
export const FR12_AMBIGUOUS_MIN = 0.35;
export const FR12_DESTRUCTIVE_MIN = 0.70;

/** Advisor extension exposing the raw score. Optional: advisors without it
 * keep legacy boolean-only behavior. */
export interface ScoringAdvisor extends SpeechAdvisor {
  destructiveScore(text: string): Promise<number>;
}

function asScoringAdvisor(advisor: SpeechAdvisor | undefined): ScoringAdvisor | undefined {
  if (advisor === undefined) return undefined;
  const candidate = advisor as Partial<ScoringAdvisor>;
  return typeof candidate.destructiveScore === 'function' ? candidate as ScoringAdvisor : undefined;
}

export class Orchestrator {
  private cursor: string | null = null;
  private readonly seen = new Set<string>();
  private stopped = false;
  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readonly queue = new SpeechQueue();
  private readonly ledger: Ledger;

  constructor(
    private readonly client: ServeClient,
    dataDir: string,
    private readonly speaker: Speaker,
    private readonly advisor?: SpeechAdvisor,
  ) {
    this.ledger = new Ledger(dataDir);
  }

  get speechQueue(): SpeechQueue {
    return this.queue;
  }

  stop(): void {
    this.stopped = true;
    void this.activeReader?.cancel().catch(() => undefined);
  }

  /** Subscribe with staggered reconnect; resolves only on stop() or fatal auth. */
  async subscribe(baseUrl: string, password: string): Promise<void> {
    let backoffMs = 50;
    while (!this.stopped) {
      try {
        await this.runStream(baseUrl, password);
        backoffMs = 50;
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof Error && err.message === 'FATAL_AUTH') throw err;
        const jitter = (Math.random() * 60 - 30);
        await new Promise((resolve) => setTimeout(resolve, Math.min(2500, Math.max(0, backoffMs + jitter))));
        backoffMs = Math.min(2500, backoffMs * 2);
      }
    }
  }

  private async runStream(baseUrl: string, password: string): Promise<void> {
    const url = this.cursor === null ? `${baseUrl}/event` : `${baseUrl}/event`;
    const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${password}` };
    if (this.cursor !== null) headers['Last-Event-ID'] = this.cursor;
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) throw new Error('FATAL_AUTH');
    if (!res.ok || res.body === null) throw new Error(`stream HTTP ${res.status}`);
    const reader = res.body.getReader();
    this.activeReader = reader;
    const decoder = new TextDecoder();
    let buf = '';
    let eventType = '';
    let eventId = '';
    let data = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined as unknown as Uint8Array }));
      if (done || value === undefined || this.stopped) {
        await reader.cancel().catch(() => undefined);
        this.activeReader = null;
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') {
          const envelope = parseSseFrame(eventType, eventId, data);
          eventType = '';
          eventId = '';
          data = '';
          if (envelope !== null) await this.handleEnvelope(envelope, false);
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('id:')) {
          eventId = line.slice(3).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trim();
        }
      }
    }
  }

  /** Validate → dedupe → append → route. Exported for tests and replay. */
  async handleEnvelope(envelope: EventEnvelope, gap: boolean): Promise<void> {
    if (this.seen.has(envelope.id)) {
      this.ledger.append({ event: envelope, receivedAt: nowIso(), briefingEnqueued: false, gap, duplicate: true });
      return;
    }
    this.seen.add(envelope.id);
    this.cursor = envelope.cursor;
    const parsed = LifecycleEventType.safeParse(envelope.type);
    if (!parsed.success) {
      this.ledger.append({ event: envelope, receivedAt: nowIso(), briefingEnqueued: false, gap });
      return;
    }
    let enqueued = false;
    if (envelope.type === 'session:complete' || envelope.type === 'session:idle' || envelope.type === 'step:complete') {
      const payload = envelope.payload as { outcome?: string; summaryText?: string };
      const text = payload.summaryText ?? `${envelope.sessionId} ${envelope.type}`;
      // Advisory Laya gate: silence only when the advisor votes against speech.
      const advisorAllows = this.advisor === undefined || (await this.advisor.shouldSpeak(text).catch(() => true));
      if (!advisorAllows) {
        this.ledger.append({ event: envelope, receivedAt: nowIso(), briefingEnqueued: false, gap });
        return;
      }
      // FR-12 destructive tripwire: when the advisor exposes a raw score, the
      // ambiguity band [0.35, 0.70) and destructive scores ≥0.70 escalate to an
      // explicit T2 confirmation briefing instead of routine T1 speech. Nothing
      // here executes a system command — the briefing ASKS, then waits.
      // Unknown scores (advisor error) stay on the routine path (fail-open).
      const scorer = asScoringAdvisor(this.advisor);
      let destructiveScore: number | null = null;
      if (scorer !== undefined) {
        try {
          destructiveScore = await scorer.destructiveScore(text);
        } catch {
          destructiveScore = null;
        }
      }
      if (destructiveScore !== null && destructiveScore >= FR12_AMBIGUOUS_MIN) {
        const confirmation = destructiveScore >= FR12_DESTRUCTIVE_MIN
          ? `Confirm before acting — destructive intent detected (${destructiveScore.toFixed(2)}): ${text}`
          : `Confirm before acting — ambiguous intent (${destructiveScore.toFixed(2)}), please confirm: ${text}`;
        enqueued = this.queue.enqueue({
          sessionId: envelope.sessionId as SessionId,
          eventId: envelope.id,
          tier: 'T2',
          outcome: payload.outcome ?? 'unknown',
          text: confirmation,
        });
      } else {
        enqueued = this.queue.enqueue({
          sessionId: envelope.sessionId as SessionId,
          eventId: envelope.id,
          tier: 'T1',
          outcome: payload.outcome ?? 'unknown',
          text,
        });
      }
    }
    this.ledger.append({ event: envelope, receivedAt: nowIso(), briefingEnqueued: enqueued, gap });
    if (enqueued) {
      const job = this.queue.dequeue();
      if (job !== null && !('digest' in job)) {
        await this.speaker.speak(job.text).catch(() => undefined);
      } else if (job !== null) {
        await this.speaker.speak(job.digest.text).catch(() => undefined);
      }
    }
  }

  /** Reconcile ledger-tracked sessions vs serve list (restart recovery, docs/10 §10.2). */
  async reconcile(): Promise<Array<{ sessionId: string; state: string }>> {
    return this.client.listSessions();
  }
}
