import { afterEach, describe, expect, test, vi } from 'vitest';
import { SessionInventory, type InventoryEvent } from './inventory.js';

// Phase 1 TDD — periodic session discovery over listSessions(). Hermetic:
// stub client + fake timers, no network, no daemon.
interface StubSession {
  sessionId: string;
  state: string;
}

function stubClient(lists: StubSession[][], opts?: { failAt?: number }): {
  client: { listSessions: () => Promise<StubSession[]> };
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      listSessions: async () => {
        calls += 1;
        if (opts?.failAt !== undefined && calls >= opts.failAt) {
          throw new Error('serve down');
        }
        const next = lists[Math.min(calls - 1, lists.length - 1)]!;
        return next.map((s) => ({ ...s }));
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionInventory snapshot + diffs', () => {
  test('initial poll populates the snapshot and emits added events', async () => {
    const { client } = stubClient([[{ sessionId: 'a', state: 'running' }, { sessionId: 'b', state: 'idle' }]]);
    const events: InventoryEvent[] = [];
    const inv = new SessionInventory(client, { onEvent: (e) => void events.push(e) });
    try {
      await inv.pollOnce();
      expect(inv.snapshot().map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
      expect(events.filter((e) => e.kind === 'added').map((e) => (e as { sessionId: string }).sessionId).sort())
        .toEqual(['a', 'b']);
    } finally {
      inv.dispose();
    }
  });

  test('second poll emits added/removed/updated, not re-added', async () => {
    const { client } = stubClient([
      [
        { sessionId: 'a', state: 'running' },
        { sessionId: 'b', state: 'idle' },
      ],
      [
        { sessionId: 'a', state: 'complete' },
        { sessionId: 'c', state: 'running' },
      ],
    ]);
    const events: InventoryEvent[] = [];
    const inv = new SessionInventory(client, { onEvent: (e) => void events.push(e) });
    try {
      await inv.pollOnce();
      events.length = 0;
      await inv.pollOnce();
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toEqual(['added', 'removed', 'updated']);
    } finally {
      inv.dispose();
    }
  });

  test('listSessions failure keeps the snapshot and emits error (degraded, not death)', async () => {
    const { client } = stubClient([[{ sessionId: 'a', state: 'running' }]], { failAt: 2 });
    const events: InventoryEvent[] = [];
    const inv = new SessionInventory(client, { onEvent: (e) => void events.push(e) });
    try {
      await inv.pollOnce();
      await inv.pollOnce();
      expect(inv.snapshot().map((s) => s.sessionId)).toEqual(['a']);
      expect(events.some((e) => e.kind === 'error')).toBe(true);
    } finally {
      inv.dispose();
    }
  });
});

describe('SessionInventory interval', () => {
  test('start() polls on interval; slow serve never overlaps polls', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = {
      listSessions: async (): Promise<StubSession[]> => {
        calls += 1;
        if (calls === 1) await gate;
        return [];
      },
    };
    const inv = new SessionInventory(client, { intervalMs: 1000 });
    try {
      inv.start();
      await vi.advanceTimersByTimeAsync(50); // first poll starts, blocks on gate
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(5000); // ticks fire while blocked
      expect(calls).toBe(1); // no overlap
      release();
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      inv.dispose();
    }
  });

  test('dispose() stops the timer', async () => {
    vi.useFakeTimers();
    const { client, calls } = stubClient([[]]);
    const inv = new SessionInventory(client, { intervalMs: 100 });
    inv.start();
    await vi.advanceTimersByTimeAsync(350);
    const seen = calls();
    expect(seen).toBeGreaterThanOrEqual(1);
    inv.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls()).toBe(seen);
  });
});
