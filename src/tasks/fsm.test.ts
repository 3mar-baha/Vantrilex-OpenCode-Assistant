import { afterEach, describe, expect, test } from 'vitest';
import { TaskQueue, type TaskEvent, type TaskQueueOptions } from './engine.js';
import { canTransition, isTerminal, LEGAL_TRANSITIONS, TERMINAL_STATES, taskId, type TaskId, type TaskState } from './types.js';

// The FSM. Everything here is about ONE property: a task reaches a terminal
// state exactly once and stays there. The engine's `settle` consults
// `LEGAL_TRANSITIONS`, so the table and the queue are the same rule, not two
// rules that happen to agree.
function controlled() {
  const started: string[] = [];
  const gates = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; sawAbort: () => boolean }
  >();
  const executor = (task: { label: string }, signal: AbortSignal) => {
    started.push(task.label);
    return new Promise<unknown>((resolve, reject) => {
      gates.set(task.label, {
        resolve: () => resolve('ok'),
        reject,
        sawAbort: () => signal.aborted,
      });
    });
  };
  return { executor, gates, started };
}

const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Every task here is on a 60s deadline. `close` clears the timers so a pending
// deadline cannot hold the worker's event loop open after the file finishes.
const open: TaskQueue[] = [];
type QueueOpts = Omit<TaskQueueOptions, 'executor'> & { executor: TaskQueueOptions['executor'] };
function queue(options: QueueOpts): TaskQueue {
  const q = new TaskQueue(options);
  open.push(q);
  return q;
}
afterEach(() => {
  for (const q of open.splice(0)) q.close();
});

const spec = (label: string) => ({ kind: 'test-suite', label, timeoutMs: 60_000 });
const idOf = (r: { ok: boolean; id?: unknown }): TaskId => taskId(String(r.id));

describe('task FSM — the transition table', () => {
  test('no terminal state has an outgoing edge, so nothing can be resurrected', () => {
    for (const state of TERMINAL_STATES) {
      expect(LEGAL_TRANSITIONS[state]).toEqual([]);
      for (const target of ['queued', 'running', 'done', 'failed', 'cancelled'] as TaskState[]) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  test('the only edges are queued→running|cancelled and running→done|failed|cancelled', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('queued', 'cancelled')).toBe(true);
    expect(canTransition('running', 'done')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
    // A task that never got a slot did not FAIL — it was refused or cancelled.
    expect(canTransition('queued', 'failed')).toBe(false);
    expect(canTransition('queued', 'done')).toBe(false);
  });

  test('isTerminal covers exactly the three terminal states', () => {
    expect(TERMINAL_STATES).toEqual(['done', 'failed', 'cancelled']);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    for (const s of TERMINAL_STATES) expect(isTerminal(s)).toBe(true);
  });
});

describe('terminal is terminal — in the queue, not just the table', () => {
  test('a task that already completed is NOT overwritten by a second settlement', async () => {
    // GUARD G2. Break: delete the `canTransition` check in `settle`.
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    const r = q.enqueue(spec('suite'));
    expect(r.ok).toBe(true);
    c.gates.get('suite')!.resolve();
    await flush();
    expect(q.get(idOf(r))!.state).toBe('done');
    expect(q.stats().lateSettlements).toBe(0);

    // The illegal path itself: a second settle for a finished task.
    const late = (q as unknown as { settle: (id: string, next: TaskState) => boolean }).settle(
      idOf(r),
      'failed',
    );
    expect(late).toBe(false);
    expect(q.get(idOf(r))!.state).toBe('done');
    expect(q.get(idOf(r))!.failure).toBeNull();
    expect(q.stats().lateSettlements).toBe(1);
  });

  test('a cancelled task that later resolves stays cancelled, and the abort reached the executor', async () => {
    // GUARD G3. The real-world form: the user cancels while the executor is in
    // flight and the executor finishes anyway.
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    const r = q.enqueue(spec('build'));

    expect(q.cancel(idOf(r))).toBe(true);
    expect(q.get(idOf(r))!.state).toBe('cancelled');
    expect(c.gates.get('build')!.sawAbort()).toBe(true);

    c.gates.get('build')!.resolve();
    await flush();

    expect(q.get(idOf(r))!.state).toBe('cancelled');
    expect(q.get(idOf(r))!.settledAt).not.toBeNull();
    expect(q.stats().lateSettlements).toBe(1);
  });

  test('cancelling an already-terminal task returns false and changes nothing', async () => {
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    const r = q.enqueue(spec('server'));
    c.gates.get('server')!.resolve();
    await flush();

    expect(q.cancel(idOf(r))).toBe(false);
    expect(q.get(idOf(r))!.state).toBe('done');
    expect(q.stats().lateSettlements).toBe(0);
  });

  test('exactly one settled event is emitted per task', async () => {
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    const events: TaskEvent[] = [];
    q.subscribe((e) => events.push(e));

    const r = q.enqueue(spec('suite'));
    c.gates.get('suite')!.resolve();
    await flush();
    c.gates.get('suite')!.resolve();
    await flush();

    const settled = events.filter((e) => e.type === 'settled');
    expect(settled).toHaveLength(1);
    expect((settled[0] as { code: string }).code).toBe('ok');
    expect(q.get(idOf(r))!.state).toBe('done');
  });

  test('a throwing subscriber cannot abort the transition that emitted to it', async () => {
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    q.subscribe(() => {
      throw new Error('subscriber is broken');
    });
    const seen: TaskState[] = [];
    q.subscribe((e) => {
      if (e.type === 'settled') seen.push(e.task.state);
    });

    const r = q.enqueue(spec('suite'));
    c.gates.get('suite')!.resolve();
    await flush();

    expect(seen).toEqual(['done']);
    expect(q.get(idOf(r))!.state).toBe('done');
    expect(q.stats().listenerErrors).toBeGreaterThan(0);
  });
});

describe('FIFO', () => {
  test('tasks start in enqueue order and the order survives settlement', async () => {
    // GUARD G7. Break: `drain()` takes from the END of `waiting` (LIFO).
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    for (const label of ['a', 'b', 'c', 'd']) expect(q.enqueue(spec(label)).ok).toBe(true);
    expect(c.started).toEqual(['a']);

    c.gates.get('a')!.resolve();
    await flush();
    expect(c.started).toEqual(['a', 'b']);

    c.gates.get('b')!.resolve();
    await flush();
    c.gates.get('c')!.resolve();
    await flush();
    expect(c.started).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the started order is seq order even when every timestamp is identical', async () => {
    // A frozen clock makes enqueuedAt identical for every task, so a queue that
    // ordered by timestamp instead of seq would look correct here by luck.
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1, now: () => 1000 });
    const order: number[] = [];
    q.subscribe((e) => {
      if (e.type === 'started') order.push(e.task.seq);
    });
    for (const label of ['a', 'b', 'c']) q.enqueue(spec(label));
    c.gates.get('a')!.resolve();
    await flush();
    c.gates.get('b')!.resolve();
    await flush();
    expect(order).toEqual([1, 2, 3]);
  });

  test('a cancelled waiter never starts and does not disturb the order of the rest', async () => {
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    const a = q.enqueue(spec('a'));
    const b = q.enqueue(spec('b'));
    const d = q.enqueue(spec('d'));

    expect(q.cancel(idOf(b))).toBe(true);
    c.gates.get('a')!.resolve();
    await flush();

    expect(c.started).toEqual(['a', 'd']);
    expect(q.get(idOf(b))!.startedAt).toBeNull();
    expect(q.get(idOf(a))!.state).toBe('done');
    expect(q.get(idOf(d))!.state).toBe('running');
  });
});

describe('records handed out are copies', () => {
  test('get() is frozen and mutating the caller payload does not rewrite history', async () => {
    // GUARD G5. A shared mutable payload would let a caller silently change a
    // record that has already been written to disk.
    const c = controlled();
    const q = queue({ executor: c.executor, maxConcurrency: 1 });
    const payload: Record<string, unknown> = { suite: 'vantrilex' };
    const r = q.enqueue({ ...spec('suite'), payload });
    payload.suite = 'TAMPERED';
    payload.extra = 'x';

    const record = q.get(idOf(r))!;
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.payload).toEqual({ suite: 'vantrilex' });
    // Deep, not shallow: two records share one payload object, so freezing
    // only the record would let a consumer write through one into the other.
    expect(() => {
      (record.payload as Record<string, unknown>).suite = 'TAMPERED';
    }).toThrow();
    expect(q.get(idOf(r))!.payload).toEqual({ suite: 'vantrilex' });
    c.gates.get('suite')!.resolve();
    await flush();
  });

  test('unknown ids are absent, not invented', () => {
    const q = queue({ executor: () => new Promise(() => {}) });
    expect(q.get(taskId('nope'))).toBeUndefined();
    expect(q.cancel(taskId('nope'))).toBe(false);
    expect(q.list()).toEqual([]);
  });
});
