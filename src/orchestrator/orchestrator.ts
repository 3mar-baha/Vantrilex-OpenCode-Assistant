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
      enqueued = this.queue.enqueue({
        sessionId: envelope.sessionId as SessionId,
        eventId: envelope.id,
        tier: 'T1',
        outcome: payload.outcome ?? 'unknown',
        text: payload.summaryText ?? `${envelope.sessionId} ${envelope.type}`,
      });
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
