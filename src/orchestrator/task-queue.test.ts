import { describe, expect, test, vi } from 'vitest';
import {
  PLAN_DEADLINE_MS,
  TaskQueue,
  type TaskRecord,
  type TaskResult,
} from './task-queue.js';

// M2 Pattern 1 — the `spawn_thinking` split, queue half.
//
// The queue is deliberately dependency-free: it does NOT import the
// coordinator, the models, or the protocol. A queue that pulled the planner
// into every importer's graph would re-introduce the exact barrel-bypass
// failure this repo already paid for once (`PERSONA_DIRECTIVES` dragged the
// BM25 retriever into the daemon's startup path). The result type is a type
// PARAMETER for the same reason.
//
// Every test here has a named break: drop the guard it names and it must fail.
// A queue test that cannot fail is decoration.

// `detail` is OMITTED rather than set to `undefined`: with
// `exactOptionalPropertyTypes` an optional property may not be assigned
// `undefined`, and the same rule applies in tests as in production.
const OK: TaskResult = {
  ok: true,
  receipt: 'msg_1',
  needsConfirmation: false,
  flagged: [],
};

interface PlanInput {
  readonly transcript: string;
  readonly taskEn: string;
  readonly replyAr: string;
  readonly epoch: number;
}

const UTTERANCE: PlanInput = {
  transcript: 'شوف الجلسات',
  taskEn: 'List all sessions',
  replyAr: 'هسا بنرتبها',
  epoch: 1,
};

/** A planner that records what it was handed and resolves immediately. */
function plannerSpy(dispatched?: string[]) {
  const planned: TaskRecord[] = [];
  return {
    planned,
    plan: async (task: TaskRecord): Promise<TaskResult> => {
      planned.push(task);
      if (dispatched !== undefined) dispatched.push(task.id);
      return OK;
    },
  };
}

describe('M2 Pattern 1 — task queue', () => {
  test('identity: id is task-<base36>, owner voice, kind plan', () => {
    const spy = plannerSpy();
    const queue = new TaskQueue({ plan: spy.plan });
    const task = queue.enqueue(UTTERANCE);

    expect(task.id).toMatch(/^task-[0-9a-z]+-[0-9a-z]+$/);
    expect(task.owner).toBe('voice');
    expect(task.kind).toBe('plan');
    // The transcript is the USER's words, verbatim. The optimized brief and the
    // model's `task_en` are separate fields precisely so a fabricated rewrite
    // can never be mistaken for what was said.
    expect(task.transcript).toBe('شوف الجلسات');
    expect(task.taskEn).toBe('List all sessions');
    expect(task.replyAr).toBe('هسا بنرتبها');
    expect(task.status).toBe('queued');
    expect(task.result).toBeUndefined();

    // Two enqueues in the same millisecond must not collide: ids are what an
    // approval re-entry looks the record up by.
    const second = queue.enqueue({ ...UTTERANCE, transcript: 'مرة ثانية' });
    expect(second.id).not.toBe(task.id);
  });

  test('drain runs three concurrently enqueued tasks in FIFO order at concurrency 1', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const queue = new TaskQueue({
      plan: async (task) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        order.push(task.id);
        return OK;
      },
    });

    // A burst of three utterances lands before anything is drained: this is
    // the ordinary case once intake stopped awaiting the plan.
    const a = queue.enqueue({ ...UTTERANCE, transcript: 'أ' });
    const b = queue.enqueue({ ...UTTERANCE, transcript: 'ب', epoch: 1 });
    const c = queue.enqueue({ ...UTTERANCE, transcript: 'ج', epoch: 1 });

    // Three drains racing. Coalescing matters: without it the same task could
    // be handed to the planner twice.
    await Promise.all([queue.drain(), queue.drain(), queue.drain()]);

    expect(order).toEqual([a.id, b.id, c.id]);
    expect(peakInFlight).toBe(1);
    expect(queue.stats()).toMatchObject({ queued: 0, running: 0, completed: 3, failed: 0, cancelled: 0 });
  });

  test('a task from a superseded epoch is cancelled WITHOUT dispatch', async () => {
    const dispatched: string[] = [];
    const spy = plannerSpy(dispatched);
    const queue = new TaskQueue({ plan: spy.plan });

    // Turn 1 enqueues, then turn 2 arrives before the drain reaches it. The
    // user has moved on; planning turn 1 now would act on a stale brief.
    const stale = queue.enqueue({ ...UTTERANCE, epoch: 1 });
    const fresh = queue.enqueue({ ...UTTERANCE, epoch: 2, transcript: 'غيّر الاتجاه' });

    await queue.drain();

    // BREAK: drop `task.epoch < currentEpoch` in drain() and `stale` is
    // planned too — `dispatched` would hold both ids and this fails.
    expect(dispatched).toEqual([fresh.id]);
    expect(stale.status).toBe('cancelled');
    expect(stale.detail).toBe('cancelled-superseded');
    expect(stale.result).toBeUndefined();
    expect(fresh.status).toBe('completed');
    expect(supersededEpisodes(queue)).toEqual([]);
  });

  test('a planner that outlives the deadline fails as plan-timeout and never dispatches', async () => {
    vi.useFakeTimers();
    try {
      const dispatched: string[] = [];
      // The plan call hangs. This is the free-tier reality the deadline exists
      // for: a silent coordinator holds the single drain slot forever.
      const queue = new TaskQueue({
        plan: () => new Promise<TaskResult>(() => undefined),
        dispatch: (task) => {
          dispatched.push(task.id);
        },
      });
      const task = queue.enqueue(UTTERANCE);

      const drained = queue.drain();
      await vi.advanceTimersByTimeAsync(PLAN_DEADLINE_MS + 1);
      await drained;

      expect(task.status).toBe('failed');
      expect(task.detail).toBe('plan-timeout');
      expect(dispatched).toEqual([]);
      // The drain slot is released, so a later utterance is not poisoned.
      expect(queue.stats().running).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('cancel() mid-run prevents dispatch even when the planner returns', async () => {
    const dispatched: string[] = [];
    let release: (() => void) | undefined;
    const queue = new TaskQueue({
      plan: async () =>
        await new Promise<TaskResult>((resolve) => {
          release = () => resolve(OK);
        }),
      dispatch: (task) => {
        dispatched.push(task.id);
      },
    });
    const task = queue.enqueue(UTTERANCE);

    const drained = queue.drain();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    // The user barged in on this turn's plan. The planner is already in flight,
    // so cancellation cannot prevent the CALL — it must prevent the EFFECT.
    expect(queue.cancel(1)).toBe(1);
    release?.();
    await drained;

    // BREAK: drop the `task.status === 'cancelled'` re-check before dispatch
    // and this id lands in `dispatched`.
    expect(dispatched).toEqual([]);
    expect(task.status).toBe('cancelled');
    expect(task.detail).toBe('cancelled');
    expect(task.result).toBeUndefined();
  });

  test('cancel() also drops queued work at or below the epoch, and reports the count', async () => {
    const dispatched: string[] = [];
    const spy = plannerSpy(dispatched);
    const queue = new TaskQueue({ plan: spy.plan });
    const old1 = queue.enqueue({ ...UTTERANCE, epoch: 1 });
    const old2 = queue.enqueue({ ...UTTERANCE, epoch: 2 });
    const newer = queue.enqueue({ ...UTTERANCE, epoch: 3 });

    expect(queue.cancel(2)).toBe(2);
    expect(old1.detail).toBe('cancelled');
    expect(old2.detail).toBe('cancelled');
    expect(newer.status).toBe('queued');

    await queue.drain();
    expect(dispatched).toEqual([newer.id]);
  });

  test('FR-12: a confirmation-holding result completes with a detail and is NOT dispatched', async () => {
    const dispatched: string[] = [];
    const HOLD: TaskResult = { ...OK, ok: false, receipt: null, needsConfirmation: true, flagged: ['s2'] };
    const queue = new TaskQueue({
      plan: async () => HOLD,
      dispatch: (task) => {
        dispatched.push(task.id);
      },
    });
    const task = queue.enqueue(UTTERANCE);

    await queue.drain();

    // Deliberately `completed`, NOT `failed`: a destructive plan held for
    // approval is a success of the pipeline. Billing it as a failure is how a
    // FR-12 gate turns into a red notice for work that is merely waiting.
    expect(task.status).toBe('completed');
    expect(task.detail).toBe('confirmation-required');
    expect(dispatched).toEqual([]);
    // Not identity: the queue hands out a frozen copy, so a consumer cannot
    // reshape a result another consumer already read. Pattern 3 re-offers
    // this exact object on delivery retry.
    const held = queue.getResult(task.id);
    expect(held).toEqual(HOLD);
    expect(Object.isFrozen(held)).toBe(true);
  });

  test('a thrown planner marks the task failed and releases the drain slot', async () => {
    const dispatched: string[] = [];
    let failNext = true;
    const queue = new TaskQueue({
      plan: async () => {
        if (failNext) {
          failNext = false;
          throw new Error('provider exploded');
        }
        return OK;
      },
      dispatch: (task) => {
        dispatched.push(task.id);
      },
    });
    const task = queue.enqueue(UTTERANCE);

    await queue.drain();

    expect(task.status).toBe('failed');
    expect(task.detail).toBe('plan-error');
    expect(dispatched).toEqual([]);
    // A failed turn must not wedge the queue: the next utterance still runs.
    const next = queue.enqueue({ ...UTTERANCE, epoch: 2 });
    await queue.drain();
    expect(next.status).toBe('completed');
  });

  test('maxDepth 8 drops the OLDEST queued task instead of growing without bound', async () => {
    const spy = plannerSpy();
    const queue = new TaskQueue({ plan: spy.plan });
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(queue.enqueue({ ...UTTERANCE, transcript: `t${i}`, epoch: 1 }).id);
    }

    expect(queue.stats()).toMatchObject({ depth: 8, maxDepth: 8 });
    const dropped = ids.slice(0, 2);
    const kept = ids.slice(2);
    for (const id of dropped) {
      expect(queue.get(id)?.detail).toBe('queue-full');
      expect(queue.get(id)?.status).toBe('cancelled');
    }
    for (const id of kept) expect(queue.get(id)?.status).toBe('queued');

    await queue.drain();
    expect(spy.planned.map((t) => t.id)).toEqual(kept);
  });

  test('the kill-switch is on by default and toggles cleanly', () => {
    const queue = new TaskQueue({ plan: plannerSpy().plan });
    expect(queue.enabled).toBe(true);
    queue.enabled = false;
    expect(queue.enabled).toBe(false);
    expect(queue.stats().enabled).toBe(false);
  });

  test('the kill-switch is operable from the environment, not just the setter', () => {
    // Peer review: an affordance nothing can flip is A.14-class. The daemon
    // passes `enabled: process.env['VOXAURA_TASK_QUEUE'] !== 'off'`; here the
    // constructor contract is pinned so the wiring has something to wire.
    const off = new TaskQueue({ plan: plannerSpy().plan, enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.stats().enabled).toBe(false);
  });

  test('terminal records are swept past 64 — the map cannot grow per turn', async () => {
    // Peer review: maxDepth bounds `pending` only; every turn used to leave
    // one verbatim transcript + brief + ack in `records` forever (Triad-B
    // class). Break: remove the sweepRecords() call in finish() → 70 remain.
    const spy = plannerSpy();
    const queue = new TaskQueue({ plan: spy.plan });
    for (let i = 0; i < 70; i += 1) {
      queue.enqueue({ ...UTTERANCE, epoch: i + 1 });
    }
    await queue.drain();
    expect(queue.list().length).toBeLessThanOrEqual(64);
  });

  test('the frozen result freezes the flagged list too', async () => {
    // Peer review: a shallow freeze leaves the one array inside mutable.
    const spy = {
      planned: [] as TaskRecord[],
      plan: async (task: TaskRecord): Promise<TaskResult> => {
        spy.planned.push(task);
        return { ok: true, receipt: 'msg_9', needsConfirmation: true, flagged: ['ses_x'] };
      },
    };
    const queue = new TaskQueue({ plan: spy.plan });
    queue.enqueue(UTTERANCE);
    await queue.drain();
    const result = queue.getResult(queue.list()[0]?.id ?? 'missing');
    expect(result).toBeDefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.flagged)).toBe(true);
  });
});

/** Anything still marked superseded after the drain is a leak in the scanner. */
function supersededEpisodes(queue: TaskQueue): string[] {
  return queue.list().filter((t) => t.detail === 'cancelled-superseded' && t.status === 'completed').map((t) => t.id);
}
