import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskQueue, type TaskQueueOptions } from './engine.js';
import { FileTaskStore, MemoryTaskStore, SNAPSHOT_VERSION, TaskStoreError, type FsPort } from './store.js';
import { taskId, type TaskId, type TaskRecord } from './types.js';

// Persistence. The question this file answers is not "does it round-trip" — it
// is "what happens to a task that was RUNNING when the process died", because
// that is the record most likely to be wrong in a way a user acts on.

const open: TaskQueue[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tasks-test-'));
  dirs.push(d);
  return d;
}
type QueueOpts = Omit<TaskQueueOptions, 'executor'> & { executor: TaskQueueOptions['executor'] };
function queue(options: QueueOpts): TaskQueue {
  const q = new TaskQueue(options);
  open.push(q);
  return q;
}
afterEach(() => {
  for (const q of open.splice(0)) q.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hang = () => new Promise<unknown>(() => {});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const idOf = (r: { ok: boolean; id?: unknown }): TaskId => taskId(String(r.id));
const spec = (label: string) => ({ kind: 'test-suite', label, timeoutMs: 60_000 });

/**
 * Wait for the queue to be IDLE. Polling only `pending` returns early — a task
 * moves from pending to running, so pending hits 0 while work is still in
 * flight. Throwing on timeout names the stall instead of leaving the next
 * assertion to fail mysteriously.
 */
async function idle(q: TaskQueue, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const s = q.stats();
    if (s.running === 0 && s.pending === 0) return;
    await sleep(2);
  }
  throw new Error(`queue never went idle: ${JSON.stringify(q.stats())}`);
}

/** A store holding hand-written records — the "process died" snapshots. */
function seeded(tasks: unknown[]): MemoryTaskStore {
  const store = new MemoryTaskStore();
  store.write({ v: SNAPSHOT_VERSION, tasks });
  return store;
}

/** Overrides for a hand-written record. `id` stays a plain string on purpose. */
type Over = Partial<Omit<TaskRecord, 'id'>> & { id?: string };

function record(over: Over = {}): Record<string, unknown> {
  return {
    id: 'r1',
    seq: 1,
    kind: 'test-suite',
    label: 'suite',
    payload: null,
    timeoutMs: 900_000,
    state: 'queued',
    enqueuedAt: 1000,
    startedAt: null,
    settledAt: null,
    failure: null,
    restoredFrom: null,
    ...over,
  };
}

describe('what is durable', () => {
  test('a finished task survives a restart with its state, failure and timestamps', async () => {
    const file = join(tempDir(), 'tasks.json');
    const first = queue({
      store: new FileTaskStore(file),
      executor: (task: { label: string }) =>
        task.label === 'desktop' ? Promise.reject(new Error('exit 1')) : Promise.resolve('ok'),
    });
    const ok = first.enqueue(spec('vantrilex'));
    const bad = first.enqueue(spec('desktop'));
    await idle(first);
    expect(first.get(idOf(bad))!.state).toBe('failed');

    const second = queue({ store: new FileTaskStore(file), executor: async () => {} });
    const restoredOk = second.get(idOf(ok))!;
    const restoredBad = second.get(idOf(bad))!;

    expect(restoredOk.state).toBe('done');
    expect(restoredOk.label).toBe('vantrilex');
    expect(restoredOk.timeoutMs).toBe(60_000);
    expect(restoredOk.settledAt).toBeGreaterThan(0);
    expect(restoredBad.state).toBe('failed');
    expect(restoredBad.failure?.code).toBe('threw');
    expect(second.recovered()).toEqual([]);
  });

  test('the on-disk shape is versioned and holds only records', async () => {
    const file = join(tempDir(), 'tasks.json');
    const q = queue({ store: new FileTaskStore(file), executor: hang });
    q.enqueue({ ...spec('suite'), payload: { suite: 'vantrilex' } });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { v: number; tasks: TaskRecord[] };

    expect(raw.v).toBe(SNAPSHOT_VERSION);
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0]!.payload).toEqual({ suite: 'vantrilex' });
    // Nothing that cannot survive a process: no promise, no timer, no signal.
    expect(JSON.stringify(raw)).not.toMatch(/signal|AbortController|Promise/);
  });

  test('a missing file is a first run, not an error', () => {
    const q = queue({ store: new FileTaskStore(join(tempDir(), 'nope', 'tasks.json')), executor: hang });
    expect(q.list()).toEqual([]);
    expect(q.recovered()).toEqual([]);
    expect(q.enqueue(spec('a')).ok).toBe(true);
  });
});

describe('a queued task is REPLAYED, in its original order', () => {
  test('waiters come back in seq order and actually run', async () => {
    // GUARD G22. Break: drop `queued` records on load — nothing runs and the
    // executor never sees them.
    const store = seeded([record({ id: 'q1', seq: 1, label: 'first' }), record({ id: 'q2', seq: 2, label: 'second' })]);
    const seen: string[] = [];
    const q = queue({
      store,
      executor: async (task) => {
        seen.push(task.label);
      },
      maxConcurrency: 1,
    });

    await sleep(20);
    expect(seen).toEqual(['first', 'second']);
    expect(q.recovered().map((r) => r.code)).toEqual(['replayed', 'replayed']);
    expect(q.list().every((t) => t.state === 'done')).toBe(true);
  });

  test('a new task after a restart does not jump the restored queue', async () => {
    // seq is restored and advanced, so a fresh enqueue lands AFTER the replayed
    // ones. Break: reset `nextSeq` to 1 on load and a restarted task overtakes
    // the user's older work.
    const store = seeded([record({ id: 'q1', seq: 7, label: 'old' })]);
    const seen: string[] = [];
    const q = queue({
      store,
      executor: async (task) => {
        seen.push(task.label);
      },
      maxConcurrency: 1,
    });
    q.enqueue(spec('new'));
    await sleep(20);
    expect(seen).toEqual(['old', 'new']);
    expect(q.list().map((t) => t.label)).toEqual(['old', 'new']);
  });

  test('a snapshot deeper than the configured bound is replayed WHOLE, and new work is refused meanwhile', () => {
    // The bound governs ADMISSION, not recovery. Truncating a deeper snapshot
    // would silently delete work the user already asked for — the exact failure
    // the bound exists to prevent. So all five come back, the queue sits above
    // its configured depth until it drains, and nothing NEW is admitted.
    const store = seeded(
      Array.from({ length: 5 }, (_, i) => record({ id: `q${i}`, seq: i + 1, label: `w${i}` })),
    );
    const q = queue({ store, executor: hang, maxPending: 3 });

    expect(q.list()).toHaveLength(5);
    expect(q.stats().running).toBe(2);
    expect(q.stats().pending).toBe(3);
    expect(q.enqueue(spec('new'))).toMatchObject({ ok: false, code: 'queue-full' });
  });
});

describe('a task that was RUNNING when the process died', () => {
  test('it comes back FAILED, never done, and the reason says why', () => {
    // GUARD G23 — the one rule that must not be bent. It did not finish and
    // nobody verified it; "done" is the single state a user would be badly
    // misled by, because they would go and read the results of a test run that
    // was killed. Break: mark it `done` on load, or `cancelled`, and this fails.
    const store = seeded([record({ id: 'r1', state: 'running', startedAt: 1500 })]);
    const q = queue({ store, executor: hang });

    const task = q.get(taskId('r1'))!;
    expect(task.state).toBe('failed');
    expect(task.failure?.code).toBe('interrupted');
    expect(task.failure?.message).toContain('never verified');
    expect(task.restoredFrom).toBe('running');
    expect(task.settledAt).toBeGreaterThan(0);
    expect(q.recovered()).toEqual([{ code: 'interrupted', task }]);
    expect(q.stats().running).toBe(0);
  });

  test('an interrupted task is not re-run — the user is told once, not twice', () => {
    // The alternative (re-queue it) is defensible, so it is worth pinning which
    // one this does: a re-run would be invisible — the user would see a task
    // start with no explanation of why it is running again.
    let ran = 0;
    const store = seeded([record({ id: 'r1', state: 'running', startedAt: 1500 })]);
    const q = queue({
      store,
      executor: async () => {
        ran += 1;
      },
    });
    expect(ran).toBe(0);
    expect(q.list()).toHaveLength(1);
    expect(q.get(taskId('r1'))!.state).toBe('failed');
  });

  test('a mixed snapshot: replayed waiters, one interrupted, and terminals kept', async () => {
    const store = seeded([
      record({ id: 'a', seq: 1, state: 'running', startedAt: 1, label: 'was-running' }),
      record({ id: 'b', seq: 2, state: 'queued', label: 'waiter' }),
      record({ id: 'c', seq: 3, state: 'done', settledAt: 9, label: 'finished' }),
      record({ id: 'd', seq: 4, state: 'cancelled', settledAt: 10, label: 'stopped' }),
      record({ id: 'e', seq: 5, state: 'failed', settledAt: 11, failure: { code: 'threw', message: 'x' }, label: 'broke' }),
    ]);
    const q = queue({ store, executor: async () => {}, maxConcurrency: 1 });
    await sleep(20);

    const byId = (id: string) => q.get(taskId(id))!;
    expect(byId('a').state).toBe('failed');
    expect(byId('a').failure?.code).toBe('interrupted');
    expect(byId('b').state).toBe('done');
    expect(byId('c').state).toBe('done');
    expect(byId('d').state).toBe('cancelled');
    expect(byId('e').state).toBe('failed');
    expect(q.recovered().map((r) => r.code)).toEqual(['interrupted', 'replayed']);
    // The interruption is itself persisted, so the next restart agrees.
    const read = store.read();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(`unreachable: ${read.error}`);
    const stored = read.snapshot?.tasks as TaskRecord[] | undefined;
    expect(stored?.find((t) => t.id === 'a')?.state).toBe('failed');
  });

  test('an interrupted record is recovered while the queue is at capacity, and recovery costs no capacity', () => {
    // The interrupted record becomes terminal during load, so it never enters
    // the waiter list and never consumes a slot or a pending place. Two hung
    // runners and one waiter = 3 live; the fourth enqueue is admitted because
    // the bound counts WAITERS (1 of 3), not live records.
    const store = seeded([
      record({ id: 'r1', seq: 1, state: 'running', startedAt: 1 }),
      record({ id: 'w0', seq: 2, state: 'queued' }),
      record({ id: 'w1', seq: 3, state: 'queued' }),
      record({ id: 'w2', seq: 4, state: 'queued' }),
    ]);
    const q = queue({ store, executor: hang, maxPending: 3 });

    expect(q.get(taskId('r1'))!.state).toBe('failed');
    expect(q.stats().running).toBe(2);
    expect(q.stats().pending).toBe(1);
    expect(q.list()).toHaveLength(4);
    expect(q.enqueue(spec('another'))).toMatchObject({ ok: true });
    expect(q.stats().pending).toBe(2);
  });
});

describe('a damaged snapshot', () => {
  test('unparseable JSON starts an empty queue and SAYS the snapshot was unreadable', () => {
    // GUARD G24. Break: swallow the read error — the queue comes up looking
    // healthy and the user's history has silently vanished.
    const file = join(tempDir(), 'tasks.json');
    writeFileSync(file, '{ this is not json', 'utf8');
    const q = queue({ store: new FileTaskStore(file), executor: hang });

    expect(q.list()).toEqual([]);
    expect(q.recovered()).toEqual([{ code: 'store-unreadable', task: null }]);
    // And it is still a working queue afterwards.
    expect(q.enqueue(spec('after-corruption')).ok).toBe(true);
  });

  test('a snapshot of the wrong shape is refused, not half-read', () => {
    const file = join(tempDir(), 'tasks.json');
    writeFileSync(file, JSON.stringify({ v: 99, tasks: [] }), 'utf8');
    expect(queue({ store: new FileTaskStore(file), executor: hang }).recovered()).toEqual([
      { code: 'store-unreadable', task: null },
    ]);
    writeFileSync(file, JSON.stringify({ v: SNAPSHOT_VERSION, tasks: 'not-an-array' }), 'utf8');
    expect(queue({ store: new FileTaskStore(file), executor: hang }).recovered()).toEqual([
      { code: 'store-unreadable', task: null },
    ]);
  });

  test('records that are not records are dropped and counted, never trusted', () => {
    // A hand-edited or half-written file must not be able to inject a task into
    // a live queue. Break: `revive` returns something for anything object-shaped
    // and this fails on the count.
    const store = seeded([
      record({ id: 'good', seq: 1 }),
      'a string',
      null,
      { id: 'no-seq' },
      { seq: 2 },
      { seq: 3, id: 'x', kind: 'k', label: 'l', state: 'not-a-state' },
      record({ id: 'good2', seq: 4 }),
    ]);
    const q = queue({ store, executor: hang, maxPending: 8 });

    expect(q.list().map((t) => t.id)).toEqual(['good', 'good2']);
    expect(q.stats().droppedFromStore).toBe(5);
  });
});

describe('the write is atomic and its failure is survivable', () => {
  test('a failed rename leaves the PREVIOUS snapshot intact and removes its temp', () => {
    // GUARD G26. Break: write straight to the target instead of temp+rename and
    // the previous snapshot is gone — a disk hiccup becomes data loss.
    const writes: string[] = [];
    let renames = 0;
    let failRename = false;
    const fake: FsPort = {
      readFileSync: () => {
        throw new Error('ENOENT');
      },
      writeFileSync: (path, data) => {
        writes.push(`${path}|${data}`);
      },
      renameSync: (from, to) => {
        renames += 1;
        if (failRename) throw new Error('EPERM');
        writes.push(`renamed ${from}->${to}`);
      },
      mkdirSync: () => undefined,
      unlinkSync: (path) => {
        writes.push(`unlinked ${path}`);
      },
    };
    const store = new FileTaskStore('C:/tmp/tasks.json', fake);
    store.write({ v: 1, tasks: [] });
    expect(renames).toBe(1);
    // The write targeted a temp, never the snapshot itself.
    expect(writes[0]).toContain('C:/tmp/tasks.json.');
    expect(writes[0]).not.toContain('C:/tmp/tasks.json|');

    writes.length = 0;
    failRename = true;
    expect(() => store.write({ v: 1, tasks: [record()] })).toThrow(TaskStoreError);
    expect(writes.filter((w) => w.startsWith('unlinked'))).toHaveLength(1);
    // Crucially: nothing was written to the snapshot path, so the old one stands.
    expect(writes.some((w) => w.startsWith('C:/tmp/tasks.json|'))).toBe(false);
  });

  test('a real store leaves no temp files behind after any number of writes', () => {
    const dir = tempDir();
    const file = join(dir, 'tasks.json');
    const store = new FileTaskStore(file);
    for (let i = 0; i < 5; i += 1) store.write({ v: 1, tasks: [record({ seq: i })] });
    expect(readdirSync(dir)).toEqual(['tasks.json']);
    expect(JSON.parse(readFileSync(file, 'utf8')).tasks).toHaveLength(1);
  });

  test('a store that throws does not wedge the queue — transitions still complete', async () => {
    // GUARD G27. A disk that is full must not turn every state change into a
    // thrown error inside `drain()`. The count is the operator's signal.
    const store = new MemoryTaskStore();
    store.failNext = 'ENOSPC';
    const q = queue({ store, executor: async () => {}, maxConcurrency: 1 });
    const r = q.enqueue(spec('suite'));
    for (let i = 0; i < 50 && q.get(idOf(r))!.state !== 'done'; i += 1) await sleep(2);

    expect(q.get(idOf(r))!.state).toBe('done');
    expect(q.stats().persistErrors).toBeGreaterThan(0);

    store.failNext = 'ENOSPC';
    const second = q.enqueue(spec('again'));
    for (let i = 0; i < 50 && q.get(idOf(second))!.state !== 'done'; i += 1) await sleep(2);
    expect(q.get(idOf(second))!.state).toBe('done');
  });

  test('two temp names never collide, so a leftover from a crash cannot be clobbered', () => {
    const targets = new Set<string>();
    const fake: FsPort = {
      readFileSync: () => {
        throw new Error('ENOENT');
      },
      writeFileSync: (path) => {
        targets.add(path);
      },
      renameSync: () => undefined,
      mkdirSync: () => undefined,
      unlinkSync: () => undefined,
    };
    const store = new FileTaskStore('C:/tmp/tasks.json', fake);
    for (let i = 0; i < 25; i += 1) store.write({ v: 1, tasks: [] });
    expect(targets.size).toBe(25);
  });
});
