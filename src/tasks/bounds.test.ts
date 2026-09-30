import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_CONCURRENCY,
  MAX_HISTORY,
  MAX_PENDING,
  TaskQueue,
  type TaskEvent,
  type TaskQueueOptions,
} from './engine.js';
import { taskId, type TaskId } from './types.js';

// The two bounds, at the boundary, plus the third one nobody asks for and
// everybody forgets: retained history. A queue with a bounded pending list that
// keeps every finished record forever has moved the unbounded-growth bug into
// the snapshot file, and the file is what gets read on every start.
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Never finishes. The stand-in for the hung `onnxruntime-node` call. */
const hang = () => new Promise<unknown>(() => {});

/**
 * Wait for the queue to be IDLE — running AND pending empty.
 *
 * Polling only `pending` is a trap this file hit once: a task moves from
 * pending to running, so pending hits 0 while work is still in flight and the
 * wait returns early. Throwing on timeout turns a stall into a named failure
 * instead of a mystery assertion three lines later.
 */
async function idle(q: TaskQueue, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const s = q.stats();
    if (s.running === 0 && s.pending === 0) return;
    await sleep(2);
  }
  throw new Error(`queue never went idle: ${JSON.stringify(q.stats())}`);
}

describe('the exported bounds are constants with the documented relationship', () => {
  test('both bounds are positive integers, and the defaults ARE those constants', () => {
    // If someone edits a constant and not this test, this is the first failure.
    expect(Number.isInteger(MAX_CONCURRENCY)).toBe(true);
    expect(MAX_CONCURRENCY).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_PENDING)).toBe(true);
    expect(MAX_PENDING).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_HISTORY)).toBe(true);
    expect(MAX_HISTORY).toBeGreaterThan(0);

    const q = queue({ executor: hang });
    for (let i = 0; i < MAX_CONCURRENCY; i += 1) expect(q.enqueue(spec(`r${i}`)).ok).toBe(true);
    expect(q.stats().running).toBe(MAX_CONCURRENCY);
    for (let i = 0; i < MAX_PENDING; i += 1) expect(q.enqueue(spec(`w${i}`)).ok).toBe(true);
    expect(q.enqueue(spec('overflow'))).toMatchObject({ ok: false, code: 'queue-full' });
  });

  test('a zero, negative or fractional bound is refused at construction, not tolerated', () => {
    // A bound of 0 is the "silent wedge": the queue accepts work forever and
    // runs none of it. Throwing is the only honest answer.
    expect(() => new TaskQueue({ executor: hang, maxConcurrency: 0 })).toThrow(RangeError);
    expect(() => new TaskQueue({ executor: hang, maxPending: 0 })).toThrow(RangeError);
    expect(() => new TaskQueue({ executor: hang, maxHistory: -1 })).toThrow(RangeError);
    expect(() => new TaskQueue({ executor: hang, maxConcurrency: 1.5 })).toThrow(RangeError);
  });
});

describe('bound 1 — concurrency', () => {
  test('peak concurrency is exactly the bound under a burst of 20', async () => {
    // GUARD G10. Break: make `drain` ignore `maxConcurrency` — peak becomes 20
    // and this fails. Break: serialise with `< 1` — peak becomes 1 and it fails
    // the other way. `toBe(2)` is doing both jobs.
    let live = 0;
    let peak = 0;
    const executor = async () => {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(2);
      live -= 1;
    };
    const q = queue({ executor, maxConcurrency: 2, maxPending: 64 });
    for (let i = 0; i < 20; i += 1) expect(q.enqueue(spec(`t${i}`)).ok).toBe(true);
    expect(q.stats().running).toBe(2);
    expect(q.stats().pending).toBe(18);

    await idle(q);

    expect(peak).toBe(2);
    expect(q.list().filter((t) => t.state === 'done')).toHaveLength(20);
  });

  test('a slot is reused, not leaked: 20 tasks through 2 slots each run exactly once', async () => {
    const order: string[] = [];
    const executor = async (task: { label: string }) => {
      order.push(task.label);
      await sleep(1);
    };
    const q = queue({ executor, maxConcurrency: 2, maxPending: 64 });
    for (let i = 0; i < 20; i += 1) q.enqueue(spec(`t${i}`));
    await idle(q);
    expect(order).toHaveLength(20);
    expect(new Set(order).size).toBe(20);
  });
});

describe('bound 2 — pending depth', () => {
  test('at the boundary: the Nth waiter is admitted, the N+1st is refused', () => {
    // GUARD G11. Break: `waiting.length >= maxPending` → `>`, which admits
    // maxPending+1 and this fails.
    const q = queue({ executor: hang, maxConcurrency: 1, maxPending: 2 });

    expect(q.enqueue(spec('running')).ok).toBe(true);
    expect(q.enqueue(spec('wait-1')).ok).toBe(true);
    expect(q.enqueue(spec('wait-2')).ok).toBe(true);
    expect(q.stats().pending).toBe(2);

    expect(q.enqueue(spec('refused'))).toMatchObject({ ok: false, code: 'queue-full' });
  });

  test('a refused enqueue creates NO record — refused is not the same as waiting', () => {
    const q = queue({ executor: hang, maxConcurrency: 1, maxPending: 1 });
    q.enqueue(spec('running'));
    q.enqueue(spec('waiting'));
    expect(q.enqueue(spec('refused')).ok).toBe(false);

    expect(q.list().map((t) => t.label)).toEqual(['running', 'waiting']);
  });

  test('the refusal is observable: an event fires and the detail states both numbers', () => {
    const events: TaskEvent[] = [];
    const q = queue({ executor: hang, maxConcurrency: 1, maxPending: 1 });
    q.subscribe((e) => events.push(e));
    q.enqueue(spec('running'));
    q.enqueue(spec('waiting'));
    q.enqueue(spec('refused'));

    const rejected = events.filter((e) => e.type === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ type: 'rejected', code: 'queue-full', label: 'refused' });
    expect((q.enqueue(spec('again')) as { detail: string }).detail).toBe(
      'pending queue is full (1 waiting, 1 running)',
    );
  });

  test('the bound is on LIVE pending, not lifetime enqueues: a freed slot admits again', async () => {
    // Break: make the bound a lifetime counter and the queue is permanently
    // wedged after N enqueues no matter how much work has drained.
    const q = queue({
      executor: async () => {
        await sleep(1);
      },
      maxConcurrency: 1,
      maxPending: 1,
    });
    for (let i = 0; i < 10; i += 1) {
      expect(q.enqueue(spec(`t${i}`)).ok).toBe(true);
      expect(q.enqueue(spec(`t${i}-b`)).ok).toBe(true);
      await idle(q);
    }
    expect(q.list().filter((t) => t.state === 'done')).toHaveLength(20);
    expect(q.stats().evictedFromHistory).toBe(0);
  });

  test('total live records never exceed concurrency + pending', () => {
    // The composed bound. A caller may only reason about memory if the SUM is
    // capped, not each half separately.
    const q = queue({ executor: hang, maxConcurrency: 2, maxPending: 3 });
    for (let i = 0; i < 40; i += 1) q.enqueue(spec(`t${i}`));
    const s = q.stats();
    expect(s.running).toBe(2);
    expect(s.pending).toBe(3);
    expect(s.running + s.pending).toBeLessThanOrEqual(5);
    expect(q.list()).toHaveLength(5);
  });
});

describe('bound 3 — retained history', () => {
  test('history is capped and the oldest terminals are the ones evicted', async () => {
    // GUARD G14. Break: delete the `trimHistory` call in `settle` and this
    // fails with a list of 12 instead of 4.
    const q = queue({ executor: async () => {}, maxConcurrency: 1, maxPending: 32, maxHistory: 4 });
    for (let i = 0; i < 12; i += 1) expect(q.enqueue(spec(`t${i}`)).ok).toBe(true);
    await idle(q);

    expect(q.list().map((t) => t.label)).toEqual(['t8', 't9', 't10', 't11']);
    expect(q.stats().evictedFromHistory).toBe(8);
  });

  test('eviction never touches a task that has not finished', () => {
    // GUARD G15. A trim that ignored the terminal check would delete the user's
    // queued work to satisfy a history bound — the bound would be destroying
    // exactly the state it is supposed to protect.
    //
    // Built with cancel rather than a fast executor: terminals must accumulate
    // WHILE a task is still queued, and only a cancel can settle one while the
    // single slot is occupied by a hang.
    const q = queue({ executor: hang, maxConcurrency: 1, maxPending: 8, maxHistory: 1 });
    const hangTask = q.enqueue(spec('hang'));
    const w1 = q.enqueue(spec('w1'));
    const w2 = q.enqueue(spec('w2'));
    const w3 = q.enqueue(spec('w3'));
    expect(q.cancel(idOf(w1))).toBe(true);
    expect(q.cancel(idOf(w2))).toBe(true);

    expect(q.list().map((t) => t.label)).toEqual(['hang', 'w2', 'w3']);
    expect(q.get(idOf(hangTask))!.state).toBe('running');
    expect(q.get(idOf(w3))!.state).toBe('queued');
    expect(q.get(idOf(w1))).toBeUndefined();
    expect(q.stats().evictedFromHistory).toBe(1);
  });

  test('a history-bound queue keeps exactly the newest records', async () => {
    const q = queue({ executor: async () => {}, maxConcurrency: 1, maxPending: 32, maxHistory: 3 });
    for (let i = 0; i < 9; i += 1) q.enqueue(spec(`t${i}`));
    await idle(q);
    expect(q.list().map((t) => t.label)).toEqual(['t6', 't7', 't8']);
  });
});

describe('admission edge cases', () => {
  test('a cyclic payload is refused at the edge, not at flush time', () => {
    // A cycle survives `structuredClone`, so the JSON round-trip is the only
    // thing that catches it. Without the check the throw would land inside a
    // state transition, where it is a wedged queue rather than a rejected
    // request.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const q = queue({ executor: hang });
    expect(q.enqueue({ ...spec('cyclic'), payload: cyclic })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
    expect(q.list()).toHaveLength(0);
  });

  test('a function in a payload is refused too', () => {
    const q = queue({ executor: hang });
    expect(q.enqueue({ ...spec('fn'), payload: { run: () => 1 } })).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    });
  });

  test('after close the queue refuses new work and says so', () => {
    const q = queue({ executor: hang });
    q.close();
    expect(q.stats().closed).toBe(true);
    expect(q.enqueue(spec('late'))).toMatchObject({ ok: false, code: 'queue-closed' });
    expect(q.list()).toHaveLength(0);
  });

  test('close leaves a running task running and a queued task queued', async () => {
    // `close` does not cancel. It stops admission and drops the deadlines; what
    // the executor does next is its own business, and the next load reports an
    // interrupted `running` as failed.
    const q = queue({ executor: hang, maxConcurrency: 1 });
    const a = q.enqueue(spec('a'));
    const b = q.enqueue(spec('b'));
    q.close();
    await sleep(10);
    expect(q.get(idOf(a))!.state).toBe('running');
    expect(q.get(idOf(b))!.state).toBe('queued');
  });
});
