import { randomUUID } from 'node:crypto';
import { MemoryTaskStore, type StoreRead, type TaskStore } from './store.js';
import {
  canTransition,
  isTerminal,
  taskId,
  type RecoveryCode,
  type TaskExecutor,
  type TaskFailure,
  type TaskId,
  type TaskOutcomeCode,
  type TaskRecord,
  type TaskSpec,
  type TaskState,
} from './types.js';

/**
 * The engine. Bounded FIFO, bounded history, every task on a clock, durable
 * across a restart, and unable to report the same task twice.
 *
 * The design target is the defect class this repo keeps re-learning: an
 * unbounded accumulation that looks fine until it does not. `vadGate` in
 * `src/daemon.ts` runs ~156 serial awaits with no timeout, so one hung
 * `onnxruntime-node` call stalls the push path. The same mistake in a queue
 * looks different — a pending list that grows, a history that grows, a task
 * that holds a slot forever — and all three are bounded here with a constant,
 * a boundary test, and an OBSERVABLE outcome at the bound. Nothing is dropped
 * quietly: a full queue refuses the enqueue and emits a `rejected` event.
 */

/* ------------------------------------------------------------------ bounds */

/**
 * Tasks allowed to run at once.
 *
 * RATIONALE (a product judgement, NOT a measurement — see the honesty note at
 * the bottom of this file). 1 would serialise a build behind a 10-minute test
 * suite, which is exactly the complaint the charter is answering. Unbounded
 * would let N test suites saturate the box and show up as turn latency in the
 * voice loop. 2 is the smallest value that fixes the complaint without taking
 * on the second one, and it leaves the machine room for `opencode serve` plus
 * the daemon. The honest version of this constant's justification is "small
 * enough to protect the loop, large enough to not serialise", and it is one
 * edit away from a real measurement.
 */
export const MAX_CONCURRENCY = 2;

/**
 * Tasks allowed to WAIT. Excludes running ones, so the total number of live
 * records is hard-capped at `MAX_CONCURRENCY + MAX_PENDING`.
 *
 * RATIONALE. A pending task costs a few hundred bytes, so memory is not the
 * reason to bound it — the reason is that an unbounded list is a queue nobody
 * is watching, and the whole point of the bound is that the user is TOLD. 8 is
 * roughly one drain cycle of real work (a suite, a build, a dev server, a
 * re-run) before a human is told the queue is full; a depth nobody is watching
 * anyway, so bounding it costs nothing real and removes the failure mode.
 */
export const MAX_PENDING = 8;

/**
 * Terminal records retained in memory and on disk. Older terminals are evicted
 * first, so the SNAPSHOT is bounded too — a queue that appends forever would
 * move the unbounded-growth bug from the pending list into the file.
 */
export const MAX_HISTORY = 64;

/** Longest a single task may run. Generous enough for a cold full build. */
export const MAX_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Shortest a single task may run, so a typo cannot mean "no timeout at all". */
export const MIN_TASK_TIMEOUT_MS = 1_000;

/**
 * Deadline applied when the spec does not name one. 15 minutes: the longest
 * thing this daemon legitimately runs is a test suite, and a turn is ~5 s, so
 * nothing here competes with conversation for the user's patience.
 */
export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------- types */

export type EnqueueResult =
  | { readonly ok: true; readonly id: TaskId }
  | {
      readonly ok: false;
      readonly code: 'queue-full' | 'queue-closed' | 'invalid-payload';
      readonly detail: string;
    };

export type TaskEvent =
  | { readonly type: 'queued'; readonly task: TaskRecord }
  | { readonly type: 'started'; readonly task: TaskRecord }
  | { readonly type: 'settled'; readonly task: TaskRecord; readonly code: TaskOutcomeCode }
  | {
      readonly type: 'rejected';
      readonly code: 'queue-full' | 'queue-closed' | 'invalid-payload';
      readonly label: string;
    };

/**
 * One record's fate at load time. Exposed as a list rather than an event
 * because load happens in the CONSTRUCTOR: an event emitted there would reach
 * nobody, so it would read as a mechanism while being unobservable. A restart
 * the user cannot see is exactly the silent failure this module is for.
 */
export interface TaskRecovery {
  readonly code: RecoveryCode;
  readonly task: TaskRecord | null;
}

export interface QueueStats {
  readonly running: number;
  readonly pending: number;
  readonly terminal: number;
  /** Terminal transitions REFUSED because the task was already terminal. */
  readonly lateSettlements: number;
  readonly evictedFromHistory: number;
  /** Store writes that threw. The queue keeps working; the count is the signal. */
  readonly persistErrors: number;
  /** Subscriber callbacks that threw. Never allowed to break a transition. */
  readonly listenerErrors: number;
  /** Stored records `revive` refused, because they were not a `TaskRecord`. */
  readonly droppedFromStore: number;
  readonly closed: boolean;
}

export interface TaskQueueOptions {
  /** Durable state. Defaults to a no-op in-memory store — durability is opt-in. */
  readonly store?: TaskStore;
  /** The ONLY way work happens. Injected; the engine never spawns anything. */
  readonly executor: TaskExecutor;
  readonly maxConcurrency?: number;
  readonly maxPending?: number;
  readonly maxHistory?: number;
  /**
   * Floor for a task's deadline. Defaults to `MIN_TASK_TIMEOUT_MS`, which
   * exists to turn `timeoutMs: 500` (someone meaning 500 SECONDS) into a slow
   * task rather than a fast one. A host that runs short health probes needs a
   * lower floor than a task queue, and the bound is only meaningful if it is
   * the host's floor — so it is a bound, like the other three.
   */
  readonly minTimeoutMs?: number;
  readonly now?: () => number;
}

interface TaskInternal {
  readonly id: TaskId;
  readonly seq: number;
  readonly kind: string;
  readonly label: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly timeoutMs: number;
  readonly enqueuedAt: number;
  state: TaskState;
  startedAt: number | null;
  settledAt: number | null;
  failure: TaskFailure | null;
  restoredFrom: TaskState | null;
}

/* ------------------------------------------------------------------ engine */

export class TaskQueue {
  private readonly executor: TaskExecutor;
  private readonly tasks = new Map<TaskId, TaskInternal>();
  /** Waiters, in seq order. The array is itself the FIFO. */
  private readonly waiting: TaskId[] = [];
  private readonly timers = new Map<TaskId, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<TaskId, AbortController>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly store: TaskStore;
  private readonly now: () => number;

  private nextSeq = 1;
  private maxConcurrency: number;
  private maxPending: number;
  private maxHistory: number;
  private minTimeoutMs: number;
  private closed = false;

  private lateSettlements = 0;
  private evicted = 0;
  private persistErrors = 0;
  private listenerErrors = 0;
  private droppedFromStore = 0;
  private readonly recovery: TaskRecovery[] = [];

  constructor(options: TaskQueueOptions) {
    this.executor = options.executor;
    this.store = options.store ?? new MemoryTaskStore();
    this.now = options.now ?? (() => Date.now());
    this.maxConcurrency = positive(options.maxConcurrency, MAX_CONCURRENCY, 'maxConcurrency');
    this.maxPending = positive(options.maxPending, MAX_PENDING, 'maxPending');
    this.maxHistory = positive(options.maxHistory, MAX_HISTORY, 'maxHistory');
    this.minTimeoutMs = positive(options.minTimeoutMs, MIN_TASK_TIMEOUT_MS, 'minTimeoutMs');
    this.restore();
  }

  /* ------------------------------------------------------------- reading */

  get(id: TaskId): TaskRecord | undefined {
    const t = this.tasks.get(id);
    return t === undefined ? undefined : snapshot(t);
  }

  /** Every known task in seq order (FIFO order), running and terminal included. */
  list(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => a.seq - b.seq).map(snapshot);
  }

  stats(): QueueStats {
    let running = 0;
    let pending = 0;
    let terminal = 0;
    for (const t of this.tasks.values()) {
      if (t.state === 'running') running += 1;
      else if (t.state === 'queued') pending += 1;
      else terminal += 1;
    }
    return {
      running,
      pending,
      terminal,
      lateSettlements: this.lateSettlements,
      evictedFromHistory: this.evicted,
      persistErrors: this.persistErrors,
      listenerErrors: this.listenerErrors,
      droppedFromStore: this.droppedFromStore,
      closed: this.closed,
    };
  }

  /**
   * What load did, in order. Read after construction; the list is empty on a
   * first run and after a clean shutdown.
   */
  recovered(): TaskRecovery[] {
    return this.recovery.map((r) => ({ code: r.code, task: r.task }));
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ------------------------------------------------------------- writing */

  /**
   * Admit a task, or refuse it explicitly. A refusal creates NO record — an
   * enqueue that did not happen must not look like a task that is waiting.
   */
  enqueue(spec: TaskSpec): EnqueueResult {
    if (this.closed) {
      const detail = 'the queue is closed';
      this.emit({ type: 'rejected', code: 'queue-closed', label: spec.label });
      return { ok: false, code: 'queue-closed', detail };
    }
    if (this.waiting.length >= this.maxPending) {
      // The bound. Observable, counted, and never a silent drop: the caller is
      // told and the `rejected` event is what a future HUD would render.
      const detail = `pending queue is full (${this.maxPending} waiting, ${this.runningCount()} running)`;
      this.emit({ type: 'rejected', code: 'queue-full', label: spec.label });
      return { ok: false, code: 'queue-full', detail };
    }
    let payload: Readonly<Record<string, unknown>> | null = null;
    if (spec.payload !== undefined) {
      try {
        const clone = structuredClone(spec.payload);
        // structuredClone accepts cycles, which JSON does not. Round-trip now,
        // at the edge, rather than throwing later inside a state transition.
        JSON.stringify(clone);
        payload = deepFreeze(clone as Record<string, unknown>);
      } catch (err) {
        const detail = `payload is not JSON-serialisable: ${(err as Error).message}`;
        this.emit({ type: 'rejected', code: 'invalid-payload', label: spec.label });
        return { ok: false, code: 'invalid-payload', detail };
      }
    }

    const timeoutMs = this.clampTimeout(spec.timeoutMs);
    const task: TaskInternal = {
      id: taskId(randomUUID()),
      seq: this.nextSeq,
      kind: spec.kind,
      label: spec.label,
      payload,
      timeoutMs,
      enqueuedAt: this.now(),
      state: 'queued',
      startedAt: null,
      settledAt: null,
      failure: null,
      restoredFrom: null,
    };
    this.nextSeq += 1;
    this.tasks.set(task.id, task);
    this.waiting.push(task.id);
    this.persist();
    this.emit({ type: 'queued', task: snapshot(task) });
    this.drain();
    return { ok: true, id: task.id };
  }

  /**
   * Cancel a task. A waiter never starts. A runner is marked cancelled NOW and
   * its `signal` is aborted; if the executor ignores the signal and settles
   * later, that settlement is refused and counted. We cannot preempt a running
   * executor and do not pretend to — the guarantee is only that the queue stops
   * waiting on it and never reports it twice.
   */
  cancel(id: TaskId): boolean {
    const task = this.tasks.get(id);
    if (task === undefined || isTerminal(task.state)) return false;
    const idx = this.waiting.indexOf(id);
    if (idx !== -1) this.waiting.splice(idx, 1);
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    return this.settle(id, 'cancelled', null);
  }

  /**
   * Stop accepting work and drop every deadline timer. In-flight executors are
   * NOT awaited (a hung one would hang close) and are not re-parented; if the
   * process exits with one running, the next load reports it `interrupted`.
   */
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  /* ------------------------------------------------------------ internals */

  private runningCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.state === 'running') n += 1;
    return n;
  }

  /**
   * Start whatever fits. Deliberately synchronous with no `await`: the whole
   * body runs to completion in one turn, so re-entrancy from a listener or a
   * settlement cannot start the same task twice or over-fill a slot.
   */
  private drain(): void {
    if (this.closed) return;
    while (this.waiting.length > 0 && this.runningCount() < this.maxConcurrency) {
      const id = this.waiting.shift();
      if (id === undefined) return;
      const task = this.tasks.get(id);
      if (task === undefined || task.state !== 'queued') continue;
      this.start(task);
    }
  }

  private start(task: TaskInternal): void {
    task.state = 'running';
    task.startedAt = this.now();
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.persist();
    this.emit({ type: 'started', task: snapshot(task) });

    // The deadline is the whole anti-vadGate mechanism: it is armed here, for
    // every task, and it is the only thing that can free the slot if the
    // executor never resolves.
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      this.settle(task.id, 'failed', { code: 'timeout', message: `exceeded ${task.timeoutMs}ms` });
    }, task.timeoutMs);
    this.timers.set(task.id, timer);

    // A synchronous throw from the executor is a failure like any other, and
    // must not escape into the drain loop.
    void (async () => {
      try {
        await this.executor(snapshot(task), controller.signal);
        this.clearTimer(task.id);
        this.settle(task.id, 'done', null);
      } catch (err) {
        this.clearTimer(task.id);
        this.settle(task.id, 'failed', {
          code: 'threw',
          message: (err as Error).message ?? 'executor rejected',
        });
      }
    })();
  }

  private clearTimer(id: TaskId): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.controllers.delete(id);
  }

  /**
   * THE ONLY place a task becomes terminal. Consults the transition table, so a
   * second settlement of an already-terminal task is refused and counted rather
   * than applied. Every refusal in practice is a real bug (a late promise, a
   * cancel that raced a timeout), which is why it is a counter and not a throw:
   * a throw here would strand the slot it was supposed to free.
   */
  private settle(id: TaskId, next: TaskState, failure: TaskFailure | null): boolean {
    const task = this.tasks.get(id);
    if (task === undefined) return false;
    if (!canTransition(task.state, next)) {
      this.lateSettlements += 1;
      return false;
    }
    this.clearTimer(id);
    task.state = next;
    task.settledAt = this.now();
    task.failure = failure;
    this.trimHistory();
    this.persist();
    this.emit({ type: 'settled', task: snapshot(task), code: outcomeCode(next, failure) });
    this.drain();
    return true;
  }

  /**
   * Evict the OLDEST terminal records once history is full. Never evicts a
   * waiting or running task: the bound must not delete work that has not been
   * done. `evictedFromHistory` makes the eviction visible.
   */
  private trimHistory(): void {
    const terminal: TaskInternal[] = [];
    for (const t of this.tasks.values()) if (isTerminal(t.state)) terminal.push(t);
    if (terminal.length <= this.maxHistory) return;
    terminal.sort((a, b) => a.seq - b.seq);
    const excess = terminal.length - this.maxHistory;
    for (let i = 0; i < excess; i += 1) {
      const victim = terminal[i];
      if (victim === undefined) continue;
      this.tasks.delete(victim.id);
      this.evicted += 1;
    }
  }

  /**
   * A store failure must never break a state transition — that would wedge the
   * queue on a disk problem, which is strictly worse than losing durability.
   * Counted instead, so `persistErrors` is the operator's signal.
   */
  private persist(): void {
    try {
      this.store.write({ v: 1, tasks: this.list() });
    } catch {
      this.persistErrors += 1;
    }
  }

  /** One transition, one snapshot, one emit. `recovered` is emitted before any listener can exist. */
  private emit(event: TaskEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A throwing subscriber cannot be allowed to abort the caller's
        // transition; it is counted so the bug is still visible.
        this.listenerErrors += 1;
      }
    }
  }

  /**
   * The effective deadline. Clamped, never ignored, and the RESULT is what goes
   * in the record — so a caller who asked for 60ms and got 1000ms can see it in
   * the snapshot rather than having to infer it. A non-finite or absent value
   * falls back to the default rather than to "no deadline".
   */
  private clampTimeout(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TASK_TIMEOUT_MS;
    return Math.min(MAX_TASK_TIMEOUT_MS, Math.max(this.minTimeoutMs, Math.trunc(requested)));
  }

  /* -------------------------------------------------------------- restore */

  /**
   * Load, then decide each record's fate BEFORE starting anything. Two passes
   * on purpose: settling one record must not call `drain()` and start a task
   * from a half-rebuilt FIFO.
   *
   *   queued  → replayed, back in its original seq order. The user asked for
   *             it and a process death does not withdraw the request.
   *   running → `failed` / `interrupted`. Never `done`, never re-queued: it did
   *             not finish and nobody verified it, and quietly re-running it
   *             would be the one behaviour a user cannot reason about (is this
   *             attempt 2, or is the first still going?).
   *   terminal→ kept as-is.
   *   garbage → dropped and counted (`droppedFromStore`), never trusted.
   *
   * THE BOUND GOVERNS ADMISSION, NOT RECOVERY. A snapshot written by a queue
   * configured with a deeper `maxPending` (or by an older build) can hold more
   * waiters than this one allows, and all of them are replayed anyway: they
   * were already admitted, and dropping them to satisfy a bound would delete
   * the user's work silently — the exact failure the bound exists to prevent.
   * The consequence is that a freshly loaded queue can sit ABOVE its configured
   * depth until it drains, and `enqueue` keeps refusing new work until then.
   * That is the intended shape, and it is asserted in `persistence.test.ts`
   * rather than left to be discovered.
   */
  private restore(): void {
    const read: StoreRead = this.store.read();
    if (!read.ok) {
      // Start empty and SAY SO. Losing a corrupt snapshot silently is how a
      // user's history disappears without anyone noticing.
      this.recovery.push({ code: 'store-unreadable', task: null });
      this.persist();
      return;
    }
    if (read.snapshot === null) return;

    for (const raw of read.snapshot.tasks) {
      const task = revive(raw);
      if (task === null) {
        this.droppedFromStore += 1;
        continue;
      }
      this.tasks.set(task.id, task);
      this.nextSeq = Math.max(this.nextSeq, task.seq + 1);
      if (task.state === 'queued') {
        this.waiting.push(task.id);
        this.recovery.push({ code: 'replayed', task: snapshot(task) });
        continue;
      }
      if (task.state === 'running') {
        // The one rule that must not be bent, so it goes through the same
        // transition table as every other settle rather than around it.
        if (!canTransition('running', 'failed')) {
          throw new Error('FSM violation: running→failed is not a legal transition');
        }
        task.state = 'failed';
        task.failure = {
          code: 'interrupted',
          message: 'the process ended while this task was running; it was never verified',
        };
        task.settledAt = this.now();
        this.recovery.push({ code: 'interrupted', task: snapshot(task) });
      }
    }
    this.trimHistory();
    this.persist();
    this.drain();
  }
}

/* ---------------------------------------------------------------- helpers */

function outcomeCode(state: TaskState, failure: TaskFailure | null): TaskOutcomeCode {
  if (state === 'done') return 'ok';
  if (state === 'cancelled') return 'cancelled';
  return failure?.code ?? 'threw';
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer (got ${String(value)})`);
  }
  return value;
}

/**
 * Freeze the payload all the way down, not just the record's own members.
 *
 * `Object.freeze(record)` alone was a real defect found by the guard in
 * `fsm.test.ts`: two records obtained from the engine shared ONE payload
 * object, so a consumer could write through one record and change the other —
 * including a copy already written to disk. `snapshot()` is called on every
 * read and on every event, so this is on a hot-ish path; a payload is a handful
 * of small JSON values, so the walk is cheap.
 */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function snapshot(t: TaskInternal): TaskRecord {
  return Object.freeze({
    id: t.id,
    seq: t.seq,
    kind: t.kind,
    label: t.label,
    payload: t.payload,
    timeoutMs: t.timeoutMs,
    state: t.state,
    enqueuedAt: t.enqueuedAt,
    startedAt: t.startedAt,
    settledAt: t.settledAt,
    failure: t.failure,
    restoredFrom: t.restoredFrom,
  });
}

/**
 * Rebuild an internal task from a stored record, or `null` if it is not one.
 * Anything unrecognised is dropped rather than trusted — a hand-edited or
 * half-written file must not be able to inject a task into a live queue.
 */
function revive(raw: unknown): TaskInternal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<TaskRecord>;
  const state = r.state;
  if (typeof r.id !== 'string' || typeof r.seq !== 'number' || !isState(state)) return null;
  if (typeof r.kind !== 'string' || typeof r.label !== 'string') return null;
  const payload =
    typeof r.payload === 'object' && r.payload !== null ? (r.payload as Record<string, unknown>) : null;
  const restoredFrom = isState(r.restoredFrom) ? r.restoredFrom : state;
  return {
    id: taskId(r.id),
    seq: r.seq,
    kind: r.kind,
    label: r.label,
    payload,
    timeoutMs: typeof r.timeoutMs === 'number' ? r.timeoutMs : DEFAULT_TASK_TIMEOUT_MS,
    enqueuedAt: typeof r.enqueuedAt === 'number' ? r.enqueuedAt : 0,
    state,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : null,
    settledAt: typeof r.settledAt === 'number' ? r.settledAt : null,
    failure:
      typeof r.failure === 'object' && r.failure !== null && typeof r.failure.code === 'string'
        ? { code: r.failure.code as TaskFailure['code'], message: String(r.failure.message) }
        : null,
    restoredFrom,
  };
}

function isState(value: unknown): value is TaskState {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed' || value === 'cancelled';
}
