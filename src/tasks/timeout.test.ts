import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_TASK_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
  TaskQueue,
  type TaskQueueOptions,
} from './engine.js';
import { taskId, type TaskId } from './types.js';

// Every task is on a clock, and the clock is the whole anti-vadGate mechanism.
// The defect being designed against: `vadGate` in `src/daemon.ts` runs ~156
// serial awaits with no timeout, so one hung `onnxruntime-node` call holds the
// push path forever. A task queue has the identical shape — an awaited promise
// with no deadline — and the same consequence if it is left unbounded: a
// permanently occupied concurrency slot, and a queue that stops draining.
//
// Most tests here set `minTimeoutMs: 20` so the real `setTimeout` path runs at
// test speed. The 1s default floor is asserted separately, in its own test, so
// a fast suite never becomes an argument that the floor is not enforced.
const FAST_FLOOR = 20;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const idOf = (r: { ok: boolean; id?: unknown }): TaskId => taskId(String(r.id));

/**
 * Await a promise, but fail fast instead of hanging until vitest's own 5s
 * timeout. A guard for the timeout mechanism that HANGS when the mechanism is
 * broken must fail in milliseconds with a message that says which guard it is;
 * a vitest timeout says only that a test was slow.
 */
async function settlesWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Finds a task record by label. */
function byLabel(q: TaskQueue, label: string) {
  const found = q.list().find((t) => t.label === label);
  if (found === undefined) throw new Error(`no task labelled ${label}`);
  return found;
}

describe('a hung task times out and FREES ITS SLOT', () => {
  test('with one slot, a task that never resolves does not stop the next one running', async () => {
    // GUARD G17 — the headline claim. Break: delete the `setTimeout` in
    // `start()`. Then the queue never idles and `settlesWithin` rejects at
    // 1500ms with the name of this guard.
    let secondRan = false;
    const executor = (task: { label: string }): Promise<unknown> => {
      if (task.label === 'hung') return new Promise(() => {}); // never settles
      secondRan = true;
      return Promise.resolve('ok');
    };
    const q = queue({ executor, maxConcurrency: 1, maxPending: 8, minTimeoutMs: FAST_FLOOR });

    // 5ms requested, 20ms effective: the floor raises it, and the record and
    // the failure message both report the EFFECTIVE value, not the request.
    q.enqueue({ kind: 'server', label: 'hung', timeoutMs: 5 });
    q.enqueue({ kind: 'build', label: 'next', timeoutMs: 5 });

    await settlesWithin(
      (async () => {
        for (let i = 0; i < 200; i += 1) {
          if (byLabel(q, 'next').state === 'done') return;
          await sleep(5);
        }
      })(),
      1500,
      'slot-release guard',
    );

    expect(secondRan).toBe(true);
    expect(byLabel(q, 'hung').state).toBe('failed');
    expect(byLabel(q, 'hung').failure).toEqual({
      code: 'timeout',
      message: `exceeded ${FAST_FLOOR}ms`,
    });
    expect(byLabel(q, 'hung').timeoutMs).toBe(FAST_FLOOR);
    expect(byLabel(q, 'next').state).toBe('done');
    expect(q.stats().running).toBe(0);
    expect(q.stats().pending).toBe(0);
  });

  test('the queue keeps draining after a timeout instead of stalling at the hole', async () => {
    // GUARD G18. One hung task among many must cost exactly one task, not the
    // rest of the queue. Break: make the timeout settle without calling
    // `drain()` — the other 9 never start and this fails.
    const executor = (task: { label: string }): Promise<unknown> => {
      if (task.label === 't3') return new Promise(() => {});
      return Promise.resolve('ok');
    };
    const q = queue({ executor, maxConcurrency: 1, maxPending: 16, minTimeoutMs: FAST_FLOOR });
    for (let i = 0; i < 10; i += 1) q.enqueue({ kind: 'test-suite', label: `t${i}`, timeoutMs: 50 });

    await settlesWithin(
      (async () => {
        for (let i = 0; i < 300; i += 1) {
          if (q.list().filter((t) => t.state === 'done').length === 9) return;
          await sleep(5);
        }
      })(),
      2000,
      'drain-after-timeout guard',
    );

    const states = q.list().map((t) => t.state);
    expect(states.filter((s) => s === 'done')).toHaveLength(9);
    expect(states.filter((s) => s === 'failed')).toHaveLength(1);
    expect(byLabel(q, 't3').failure?.code).toBe('timeout');
  });

  test('both slots can be held by hung tasks and both are reclaimed', async () => {
    let live = 0;
    let peak = 0;
    const executor = (): Promise<unknown> => {
      live += 1;
      peak = Math.max(peak, live);
      return new Promise(() => {}).finally(() => {
        live -= 1;
      });
    };
    const q = queue({ executor, maxConcurrency: 2, maxPending: 4, minTimeoutMs: FAST_FLOOR });
    q.enqueue({ kind: 'a', label: 'h1', timeoutMs: 50 });
    q.enqueue({ kind: 'a', label: 'h2', timeoutMs: 50 });
    q.enqueue({ kind: 'a', label: 'w1', timeoutMs: 50 });
    q.enqueue({ kind: 'a', label: 'w2', timeoutMs: 50 });
    expect(peak).toBe(2);

    await settlesWithin(
      (async () => {
        for (let i = 0; i < 300; i += 1) {
          if (q.list().every((t) => t.state === 'failed')) return;
          await sleep(5);
        }
      })(),
      2000,
      'both-slots-reclaimed guard',
    );

    expect(q.list()).toHaveLength(4);
    expect(q.list().every((t) => t.state === 'failed' && t.failure?.code === 'timeout')).toBe(true);
    expect(q.stats().running).toBe(0);
  });
});

describe('a late settlement after a timeout cannot overwrite it', () => {
  test('a timed-out task that resolves later stays failed, and the late settle is counted', async () => {
    // GUARD G4. Break: let `settle` overwrite a terminal state.
    let release: (() => void) | undefined;
    const executor = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const q = queue({ executor, maxConcurrency: 1, minTimeoutMs: FAST_FLOOR });
    const r = q.enqueue({ kind: 'server', label: 'slow', timeoutMs: 50 });

    await settlesUntil(() => byLabel(q, 'slow').state === 'failed');
    release?.();
    await sleep(20);

    expect(q.get(idOf(r))!.state).toBe('failed');
    expect(q.get(idOf(r))!.failure?.code).toBe('timeout');
    expect(q.stats().lateSettlements).toBe(1);
  });

  test('a rejection arriving after a timeout is absorbed, not an unhandled rejection', async () => {
    // The failure mode of the obvious implementation. `Promise.race([run,
    // deadline])` settles on the deadline and leaves the executor's promise
    // with nobody listening: a later `reject` becomes an unhandled rejection,
    // which on Node is a process-level event and not a task failure. This test
    // exists because the engine does NOT race — it awaits inside a try/catch.
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let reject: ((e: Error) => void) | undefined;
    const executor = () =>
      new Promise<void>((_, rej) => {
        reject = rej;
      });
    const q = queue({ executor, maxConcurrency: 1, minTimeoutMs: FAST_FLOOR });
    try {
      q.enqueue({ kind: 'server', label: 'late', timeoutMs: 50 });
      await settlesUntil(() => byLabel(q, 'late').state === 'failed');
      reject?.(new Error('too late'));
      await sleep(50);
      expect(seen).toEqual([]);
      expect(byLabel(q, 'late').failure?.code).toBe('timeout');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('the timeout is applied to every task, whatever the spec says', () => {
  test('an omitted timeout still yields an effective deadline, never zero', () => {
    // GUARD G19. A record with `timeoutMs: 0` would mean "no deadline" to any
    // reader, and `setTimeout(fn, 0)` would fire immediately.
    const q = queue({ executor: () => new Promise(() => {}) });
    const r = q.enqueue({ kind: 'build', label: 'default' });
    const record = q.get(idOf(r))!;
    expect(record.timeoutMs).toBe(DEFAULT_TASK_TIMEOUT_MS);
    expect(record.timeoutMs).toBeGreaterThan(0);
  });

  test('a nonsense timeout falls back to the default rather than to unbounded', () => {
    const q = queue({ executor: () => new Promise(() => {}) });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      const record = q.get(idOf(q.enqueue({ kind: 'build', label: `t${String(bad)}`, timeoutMs: bad })))!;
      // 0 and -1 clamp up to the floor; NaN/Infinity fall back to the default.
      const expected = Number.isFinite(bad) ? MIN_TASK_TIMEOUT_MS : DEFAULT_TASK_TIMEOUT_MS;
      expect(record.timeoutMs).toBe(expected);
    }
  });

  test('the DEFAULT floor is 1s, and a sub-second request is raised to it', () => {
    // Found by accident while writing this file: a 60ms request became 1000ms.
    // That is the clamp working, but it is only acceptable because the record
    // reports the effective value — so this guard exists to keep the floor from
    // being quietly lowered to make some future test faster.
    expect(MIN_TASK_TIMEOUT_MS).toBe(1000);
    const q = queue({ executor: () => new Promise(() => {}) });
    const record = q.get(idOf(q.enqueue({ kind: 'build', label: 'sub-second', timeoutMs: 60 })))!;
    expect(record.timeoutMs).toBe(MIN_TASK_TIMEOUT_MS);
  });

  test('a host-supplied floor replaces the default, and a nonsense floor is refused', () => {
    const q = queue({ executor: () => new Promise(() => {}), minTimeoutMs: FAST_FLOOR });
    expect(q.get(idOf(q.enqueue({ kind: 'build', label: 'x', timeoutMs: 1 })))!.timeoutMs).toBe(
      FAST_FLOOR,
    );
    expect(() => new TaskQueue({ executor: hang2, minTimeoutMs: 0 })).toThrow(RangeError);
  });

  test('an over-long timeout is clamped down, and the clamp is visible in the record', () => {
    const q = queue({ executor: () => new Promise(() => {}) });
    const record = q.get(idOf(q.enqueue({ kind: 'build', label: 'week', timeoutMs: 30 * 86_400_000 })))!;
    expect(record.timeoutMs).toBe(MAX_TASK_TIMEOUT_MS);
  });

  test('the clamp bounds hold', () => {
    expect(MIN_TASK_TIMEOUT_MS).toBeLessThan(DEFAULT_TASK_TIMEOUT_MS);
    expect(DEFAULT_TASK_TIMEOUT_MS).toBeLessThan(MAX_TASK_TIMEOUT_MS);
  });
});

describe('non-timeout failures', () => {
  test('a rejected executor becomes failed/threw, and the slot is released', async () => {
    const executor = (task: { label: string }): Promise<unknown> =>
      task.label === 'boom' ? Promise.reject(new Error('exit code 1')) : Promise.resolve('ok');
    const q = queue({ executor, maxConcurrency: 1, minTimeoutMs: FAST_FLOOR });
    const r = q.enqueue({ kind: 'test-suite', label: 'boom', timeoutMs: 5_000 });
    await settlesUntil(() => q.get(idOf(r))!.state === 'failed');

    expect(q.get(idOf(r))!.failure).toEqual({ code: 'threw', message: 'exit code 1' });
    expect(q.get(idOf(r))!.settledAt).not.toBeNull();

    // "Slot released" has to mean the NEXT task runs, not merely that the count
    // happens to read zero. Asserting only the count would pass even if the
    // slot were unreleasable.
    const after = q.enqueue({ kind: 'build', label: 'after', timeoutMs: 5_000 });
    await settlesUntil(() => q.get(idOf(after))!.state === 'done');
    expect(q.get(idOf(after))!.state).toBe('done');
    expect(q.stats().running).toBe(0);
  });

  test('an executor that throws SYNCHRONOUSLY is a failure, not an escape', async () => {
    // An exception thrown synchronously out of `drain()` would unwind through
    // `enqueue()` and leave the queue with a task in `running` and no timer.
    const q = queue({
      executor: (task: { label: string }): Promise<unknown> => {
        if (task.label === 'sync-throw') throw new Error('threw before returning a promise');
        return Promise.resolve('ok');
      },
      maxConcurrency: 1,
    });
    const r = q.enqueue({ kind: 'build', label: 'sync-throw', timeoutMs: 5_000 });
    await settlesUntil(() => q.get(idOf(r))!.state === 'failed');
    expect(q.get(idOf(r))!.failure).toEqual({ code: 'threw', message: 'threw before returning a promise' });

    // And the queue is still usable afterwards.
    const after = q.enqueue({ kind: 'build', label: 'after', timeoutMs: 5_000 });
    await settlesUntil(() => q.get(idOf(after))!.state === 'done');
    expect(q.get(idOf(after))!.state).toBe('done');
  });

  test('an executor that resolves with a rejection-shaped value is still a success', () => {
    // Guards against over-eager classification: the queue judges the PROMISE,
    // not the resolved value. A build step that returns a non-zero code as data
    // is the caller's business, not the queue's.
    const q = queue({ executor: () => Promise.resolve({ code: 1 }) });
    const r = q.enqueue({ kind: 'build', label: 'returns-code', timeoutMs: 5_000 });
    return settlesUntil(() => q.get(idOf(r))!.state !== 'queued').then(() => {
      expect(q.get(idOf(r))!.state).toBe('done');
    });
  });
});

/** Never finishes. */
const hang2 = () => new Promise<unknown>(() => {});

/** Poll until `pred` holds, or fail naming the label we were waiting for. */
async function settlesUntil(pred: () => boolean, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (pred()) return;
    await sleep(2);
  }
  throw new Error(`condition never held within ${budgetMs}ms`);
}
