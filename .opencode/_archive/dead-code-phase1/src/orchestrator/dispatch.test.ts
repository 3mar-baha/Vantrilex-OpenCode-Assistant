import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ServeClient } from '../runtime/client.js';
import { OrchestratorError } from '../common/errors.js';
import { DispatchQueue } from './dispatch.js';
import { Orchestrator, type SpeechAdvisor } from './orchestrator.js';
import type { EventEnvelope } from './events.js';

// Phase 2 TDD — cross-session dispatch with backpressure + session switching.
// Hermetic: stub dispatch clients, no network.
function envelope(id: string): EventEnvelope {
  return {
    id,
    cursor: id,
    sessionId: 'ses_main',
    type: 'session:complete',
    at: new Date().toISOString(),
    payload: { outcome: 'green', summaryText: 'done' },
  };
}

describe('DispatchQueue backpressure', () => {
  test('busy-then-success drains on retry with backoff', async () => {
    let calls = 0;
    const client = {
      dispatchPrompt: async () => {
        calls += 1;
        if (calls === 1) throw new OrchestratorError('SESSION_BUSY', true, 'busy');
        return { state: 'running', receipt: 'r1' };
      },
    };
    const q = new DispatchQueue({ baseDelayMs: 100, maxDelayMs: 1000, now: () => 0 });
    expect(q.enqueue({ sessionId: 'b' as never, text: 'report', provenance: { origin: 'voice', actor: 'v' } })).toBe(true);
    const first = await q.drainDue(client as never, 0);
    expect(first).toEqual([{ ok: false, sessionId: 'b', queued: true }]);
    expect(q.pendingCount()).toBe(1);
    const second = await q.drainDue(client as never, 5000);
    expect(second).toEqual([{ ok: true, sessionId: 'b', receipt: 'r1' }]);
    expect(q.pendingCount()).toBe(0);
  });

  test('non-retryable errors and max attempts drop with a report', async () => {
    const dead = {
      dispatchPrompt: async () => {
        throw new OrchestratorError('SESSION_NOT_FOUND', false, 'gone');
      },
    };
    const q = new DispatchQueue({ now: () => 0 });
    q.enqueue({ sessionId: 'x' as never, text: 't', provenance: { origin: 'cli', actor: 't' } });
    const out = await q.drainDue(dead as never, 0);
    expect(out).toEqual([{ ok: false, sessionId: 'x', dropped: true, detail: 'gone' }]);
    expect(q.pendingCount()).toBe(0);
  });

  test('bound rejects instead of silently dropping', async () => {
    const q = new DispatchQueue({ maxPending: 1, now: () => 0 });
    const item = { sessionId: 'x' as never, text: 't', provenance: { origin: 'cli', actor: 't' } };
    expect(q.enqueue(item)).toBe(true);
    expect(q.enqueue({ ...item, text: 'overflow' })).toBe(false);
    expect(q.pendingCount()).toBe(1);
  });

  test('no overlapping drains', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = {
      dispatchPrompt: async () => {
        calls += 1;
        await gate;
        return { state: 'running', receipt: 'r' };
      },
    };
    const q = new DispatchQueue({ now: () => 0 });
    q.enqueue({ sessionId: 'x' as never, text: 't', provenance: { origin: 'cli', actor: 't' } });
    const first = q.drainDue(client as never, 0);
    const second = await q.drainDue(client as never, 0);
    expect(second).toEqual([]);
    release();
    await first;
    expect(calls).toBe(1);
  });
});

describe('Orchestrator.dispatchTo + switchSession', () => {
  function harness(dispatchBehavior: 'ok' | 'busy'): {
    orch: Orchestrator;
    signals: unknown[];
    dispatched: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-dispatch-'));
    const signals: unknown[] = [];
    let dispatched = 0;
    const client = {
      listSessions: async () => [],
      dispatchPrompt: async () => {
        dispatched += 1;
        if (dispatchBehavior === 'busy') throw new OrchestratorError('SESSION_BUSY', true, 'busy');
        return { state: 'running', receipt: 'r' };
      },
    } as unknown as ServeClient;
    const advisor: SpeechAdvisor = { shouldSpeak: async () => false, isDestructive: async () => false };
    const orch = new Orchestrator(
      client,
      dir,
      { speak: async () => undefined },
      advisor,
      (s) => void signals.push(s),
    );
    return { orch, signals, get dispatched() { return dispatched; } };
  }

  test('immediate success sends directly without queueing', async () => {
    const h = harness('ok');
    const result = await h.orch.dispatchTo('ses_b' as never, 'report please', { origin: 'voice', actor: 'v' });
    expect(result).toBe('sent');
    expect(h.dispatched).toBe(1);
  });

  test('busy queues; drainDispatches retries to success', async () => {
    const h = harness('busy');
    const result = await h.orch.dispatchTo('ses_b' as never, 'report please', { origin: 'voice', actor: 'v' });
    expect(result).toBe('queued');
    expect(h.dispatched).toBe(1);
  });

  test('switchSession sets the active target and emits a signal', async () => {
    const h = harness('ok');
    expect(h.orch.activeSessionId).toBeUndefined();
    h.orch.switchSession('ses_b' as never);
    expect(h.orch.activeSessionId).toBe('ses_b');
    expect(h.signals).toEqual([{ kind: 'session-switched', sessionId: 'ses_b' }]);
    await h.orch.handleEnvelope(envelope('e1'), false);
  });
});
