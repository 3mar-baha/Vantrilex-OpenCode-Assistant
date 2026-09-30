/**
 * Task queue — the type surface, and the FSM it enforces.
 *
 * WHY THIS EXISTS. The owner charter: long-running work (test suites, builds,
 * servers) runs as an async task so the VOICE LOOP STAYS FREE FOR CONVERSATION.
 * There is no task lifecycle anywhere in this repo today —
 * `src/knowledge/brands.ts` has a `'creating' | 'running' | 'awaiting-approval'`
 * union and that is the narration/brand pipeline, a different machine. It is
 * NOT extended and NOT imported. This module is self-contained: no import in it
 * resolves outside `src/tasks/` except node builtins.
 *
 * The FSM is deliberately the whole lifecycle:
 *
 *      queued ──▶ running ──▶ done
 *        │           ├─────▶ failed      (threw | timeout)
 *        │           └─────▶ cancelled
 *        └─────────────────▶ cancelled   (cancelled before a slot was free)
 *
 * Terminal is terminal. `LEGAL_TRANSITIONS` is the single source of that rule
 * and the engine consults it on every settle, so "a task completed twice is a
 * bug" is enforced by a table rather than by hoping every call site checks.
 * `TaskQueue.stats().lateSettlements` counts the attempts that were refused, so
 * the guard is observable instead of merely silent.
 */
declare const taskIdBrand: unique symbol;

/** Branded so a `TaskId` cannot be passed where an arbitrary string is expected. */
export type TaskId = string & { readonly [taskIdBrand]: true };

export function taskId(raw: string): TaskId {
  return raw as TaskId;
}

/** The complete lifecycle. No state outside this union exists. */
export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * `done | failed | cancelled`. A task in one of these can never change again —
 * not resurrected by a replay, not overwritten by a late promise settlement.
 */
export const TERMINAL_STATES: readonly TaskState[] = Object.freeze(['done', 'failed', 'cancelled']);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The transition table. Note what is NOT in it:
 *  - anything out of a terminal state (the "no resurrection" rule),
 *  - `queued -> running` is here but only `TaskQueue` may use that edge,
 *  - there is no `queued -> failed`: a task that never got a slot did not fail,
 *    it was either cancelled or refused at enqueue (and a refusal creates NO
 *    record at all — see `EnqueueResult`).
 */
export const LEGAL_TRANSITIONS = Object.freeze({
  queued: Object.freeze<TaskState[]>(['running', 'cancelled']),
  running: Object.freeze<TaskState[]>(['done', 'failed', 'cancelled']),
  done: Object.freeze<TaskState[]>([]),
  failed: Object.freeze<TaskState[]>([]),
  cancelled: Object.freeze<TaskState[]>([]),
}) satisfies Readonly<Record<TaskState, readonly TaskState[]>>;

export function canTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Why a task is `failed`. Each is distinguishable by the user and by telemetry. */
export type TaskFailureCode =
  /** The per-task deadline elapsed. The slot was released; the work was not stopped. */
  | 'timeout'
  /** The executor rejected, or threw synchronously. */
  | 'threw'
  /**
   * The process died while the task was `running`. Recovered as `failed` on load
   * because it did NOT finish — reporting it as `done` would be a lie the user
   * acts on (they would assume a 20-minute test suite passed).
   */
  | 'interrupted';

/** Outcome of restoring one record at load. What happened to it, and why. */
export type RecoveryCode =
  /** A `queued` record came back and was put back in the FIFO. */
  | 'replayed'
  /** A `running` record came back and was demoted to `failed` / `interrupted`. */
  | 'interrupted'
  /** The snapshot itself was unreadable or malformed. Carries no task. */
  | 'store-unreadable';

export interface TaskFailure {
  readonly code: TaskFailureCode;
  /** Human-readable, never a stack trace and never key material. */
  readonly message: string;
}

/** Terminal classification of a settled task, carried on the `settled` event. */
export type TaskOutcomeCode = 'ok' | 'cancelled' | TaskFailureCode;

/** What a caller hands the queue. Nothing here is executed by the engine. */
export interface TaskSpec {
  /**
   * Opaque category — `'test-suite' | 'build' | 'server' | ...`. The engine
   * neither interprets nor dispatches on it; it is durable and it is what a
   * notice keys off. Kept as `string` rather than a union so the integration
   * wave can add kinds without editing this file.
   */
  readonly kind: string;
  /** Human text for the notice, e.g. `'اختبارات الواجهة'`. */
  readonly label: string;
  /**
   * Opaque, must be JSON-serialisable. Checked at enqueue (a payload that
   * cannot be written would otherwise throw during the *transition* path and
   * wedge the queue) and cloned, so later mutation by the caller cannot change
   * a record that has already been persisted.
   */
  readonly payload?: Readonly<Record<string, unknown>>;
  /**
   * Per-task deadline. Optional; defaults to `DEFAULT_TASK_TIMEOUT_MS`. Clamped
   * into `[MIN_TASK_TIMEOUT_MS, MAX_TASK_TIMEOUT_MS]` and the EFFECTIVE value
   * is what lands in the record, so the clamp is observable rather than silent.
   */
  readonly timeoutMs?: number;
}

/** An immutable snapshot of one task. Handed out by `get`/`list`/events. */
export interface TaskRecord {
  readonly id: TaskId;
  /** Monotonic enqueue ordinal. FIFO order is seq order, never wall-clock order. */
  readonly seq: number;
  readonly kind: string;
  readonly label: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  /** The effective (post-clamp) deadline in ms. */
  readonly timeoutMs: number;
  readonly state: TaskState;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
  readonly failure: TaskFailure | null;
  /**
   * Non-null when this task came back off disk: the state it held when the
   * process died. `running` here is the interrupted-recovery signal.
   */
  readonly restoredFrom: TaskState | null;
}

/**
 * The injectable executor. The engine NEVER imports `node:child_process`,
 * never spawns, and never touches the network — it hands a task to this
 * function and accounts for how long it takes. That is the whole reason the
 * engine is testable with a fake.
 *
 * `signal` is aborted on cancellation. The engine cannot preempt a running
 * executor (JavaScript has no threads here), so an executor that ignores the
 * signal will keep burning — the ENGINE's contract is only that the queue stops
 * waiting on it and never double-reports it.
 */
export type TaskExecutor = (task: TaskRecord, signal: AbortSignal) => Promise<unknown>;
