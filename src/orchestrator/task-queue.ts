// M2 Pattern 1 — the `spawn_thinking` split, queue half.
//
// The queue holds what intake produced and hands it to the planner one task at
// a time. It exists because the split made the asymmetry explicit: intake is
// the part the user waits for (measured p50 901 ms) and planning is the part
// they do not (p50 1950 ms, max 3987). Before the split both were inside
// `coordinator.run()` and the ack was fired from inside it, so the ack could
// not be spoken until the plan was already built.
//
// DEPENDENCY RULE. This module imports nothing but the standard library. It
// must not import the coordinator, the models, or the protocol: a queue that
// drags the planner into every importer's graph re-introduces exactly the
// barrel-bypass failure this repo already paid for once, where a daemon
// import of `PERSONA_DIRECTIVES` pulled the BM25 retriever and its 43-chunk
// corpus onto the startup path. `TaskResult` is therefore a structural shape,
// not `MissionResult` — the daemon adapts.
//
// FOUR RULES, all of them tested by a named break:
//   1. FIFO at concurrency 1. Two plans in flight means two dispatches racing
//      on one session, which is not a latency win, it is a lost update.
//   2. Epoch supersede. A newer turn invalidates older work: `epoch < current`
//      is `cancelled-superseded`, never dispatched. Planning a stale brief
//      acts on an instruction the user has already moved past.
//   3. A deadline. `PLAN_DEADLINE_MS` sits ABOVE the 25 s plan ceiling so the
//      model's own timeout is what normally fires; the deadline catches the
//      case where the ceiling is never reached because the promise never
//      settles. Without it one hung plan holds the single drain slot for the
//      life of the daemon.
//   4. Cancellation is checked before the EFFECT, not before the call. A
//      planner already in flight cannot be un-called; what must not happen is
//      its result reaching a session.

/** Where a task stands. `completed` covers FR-12 holds on purpose — see below. */
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Task owners. One today; the union is the seam for a second source. */
export type TaskOwner = 'voice';

/** Task kinds. One today; Pattern 3's delivery buffer hangs off the same id. */
export type TaskKind = 'plan';

/**
 * What a finished task produced. Structural, not `MissionResult`: the queue
 * must not know what a plan is. Frozen on assignment so a consumer holding a
 * reference cannot reshape a result another consumer already read.
 */
export interface TaskResult {
  readonly ok: boolean;
  readonly receipt: string | null;
  readonly detail?: string;
  readonly needsConfirmation?: boolean;
  readonly flagged?: readonly string[];
}

export interface TaskRecord {
  /** `task-<base36 time>-<base36 seq>`: sortable, and unique within a ms. */
  readonly id: string;
  readonly owner: TaskOwner;
  readonly kind: TaskKind;
  /** Turn number. Monotonic; `epoch < currentEpoch` invalidates this task. */
  readonly epoch: number;
  /** The USER's words, verbatim. Never the optimized brief, never `taskEn`. */
  readonly transcript: string;
  /** The planner's English restatement. Machine context, never spoken. */
  readonly taskEn: string;
  /** The Ammani acknowledgement the user already heard. */
  readonly replyAr: string;
  /**
   * Which model answered intake. Recorded so a re-plan (approval re-entry)
   * rebuilds the identical ack — the queue must not re-derive it, or a
   * failover turn would silently present itself as the primary.
   */
  readonly intakeModel?: string;
  readonly enqueuedAt: number;
  status: TaskStatus;
  /** Why the task ended in this status. Diagnostic, never parsed for control. */
  detail?: string;
  /** Assigned exactly once, on completion. Immutable thereafter. */
  readonly result?: TaskResult;
  startedAt?: number;
  finishedAt?: number;
}

export interface EnqueueInput {
  readonly transcript: string;
  readonly taskEn: string;
  readonly replyAr: string;
  readonly epoch: number;
  readonly intakeModel?: string;
}

export interface TaskStats {
  readonly depth: number;
  readonly maxDepth: number;
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly enabled: boolean;
}

export interface TaskQueueOptions {
  /**
   * Does the planning work. Receives an `AbortSignal` that fires on cancel, on
   * supersede and on the deadline, and is expected to check it between awaits.
   */
  plan(task: TaskRecord, signal: AbortSignal): Promise<TaskResult>;
  /** Delivers a finished result. Never called for a cancelled or held task. */
  dispatch?(task: TaskRecord, result: TaskResult): void;
  /** Clock seam — the deadline is time, and time has to be injectable. */
  now?(): number;
  /** Queue bound. 8 is a companion burst, not a backlog. */
  maxDepth?: number;
  /** Kill-switch. Default ON: `enabled = false` routes the caller back to the
   *  pre-split `await coordinator.run(task)` without touching the queue. */
  enabled?: boolean;
  /** Plan ceiling plus margin. The model's own 25 s timeout fires first. */
  planDeadlineMs?: number;
}

/** 30 s over the 25 s plan ceiling (`coordinator.ts`) — see module header. */
export const PLAN_DEADLINE_MS = 30_000;

/** Queue bound. Same reasoning as `MAX_PARKED` in `command-router.ts`. */
export const TASK_MAX_DEPTH = 8;

/**
 * Peer review: the records map is NOT bounded by maxDepth — that caps
 * `pending` only. Without this, every turn leaves one verbatim
 * transcript + brief + ack in the map forever (Triad-B unbounded class).
 */
export const TASK_RECORDS_CAP = 64;

export class TaskQueue {
  private readonly pending: TaskRecord[] = [];
  private readonly records = new Map<string, TaskRecord>();
  /**
   * Resolved options. `plan` stays REQUIRED (there is no queue without one);
   * only `dispatch` is optional, so it is the single member left in a `Pick`
   * that keeps the exact-optional distinction — `dispatch` genuinely may be
   * absent, and `this.opts.dispatch?.()` must reflect that.
   */
  private readonly opts: Required<Omit<TaskQueueOptions, 'dispatch'>> & Pick<TaskQueueOptions, 'dispatch'>;
  private currentEpoch = 0;
  private seq = 0;
  private draining: Promise<void> | null = null;
  private inFlight: AbortController | null = null;
  private _enabled: boolean;

  constructor(options: TaskQueueOptions) {
    this.opts = {
      plan: options.plan,
      ...(options.dispatch !== undefined ? { dispatch: options.dispatch } : {}),
      now: options.now ?? (() => Date.now()),
      maxDepth: options.maxDepth ?? TASK_MAX_DEPTH,
      enabled: options.enabled ?? true,
      planDeadlineMs: options.planDeadlineMs ?? PLAN_DEADLINE_MS,
    };
    this._enabled = this.opts.enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  /**
   * Accepts a task. Synchronous by design: intake must not await anything
   * here, because the whole point of the split is that the acknowledgement is
   * already on its way to the speaker while this returns.
   */
  enqueue(input: EnqueueInput): TaskRecord {
    this.seq += 1;
    const at = this.opts.now();
    const task: TaskRecord = {
      id: `task-${at.toString(36)}-${this.seq.toString(36)}`,
      owner: 'voice',
      kind: 'plan',
      epoch: input.epoch,
      transcript: input.transcript,
      taskEn: input.taskEn,
      replyAr: input.replyAr,
      ...(input.intakeModel !== undefined ? { intakeModel: input.intakeModel } : {}),
      enqueuedAt: at,
      status: 'queued',
    };
    this.records.set(task.id, task);
    if (input.epoch > this.currentEpoch) this.currentEpoch = input.epoch;

    // Drop-OLDEST: the newest task is the one the user is actually waiting on,
    // so evicting the oldest is the only choice that does not delay them. An
    // unbounded queue is the same defect as an unbounded replay buffer.
    while (this.pending.length >= this.opts.maxDepth) {
      const oldest = this.pending.shift();
      if (oldest === undefined) break;
      this.finish(oldest, 'cancelled', 'queue-full');
    }
    this.pending.push(task);
    return task;
  }

  /**
   * Runs queued tasks one at a time until the queue is empty. Concurrent calls
   * share the in-flight run rather than starting a second one — that is what
   * makes concurrency 1 true under a burst of utterances.
   */
  drain(): Promise<void> {
    if (this.draining !== null) return this.draining;
    const run = (async () => {
      try {
        while (this.pending.length > 0) {
          const task = this.pending.shift();
          if (task === undefined) break;
          await this.runOne(task);
        }
      } finally {
        this.draining = null;
      }
    })();
    this.draining = run;
    return run;
  }

  /**
   * Cancels everything at or below `epoch` — queued AND in flight — and
   * returns how many tasks were cancelled. The in-flight planner is signalled,
   * not awaited: a barge-in must not block on a model call.
   */
  cancel(epoch: number): number {
    if (epoch > this.currentEpoch) this.currentEpoch = epoch;
    let count = 0;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const task = this.pending[i];
      if (task === undefined || task.epoch > epoch) continue;
      this.pending.splice(i, 1);
      this.finish(task, 'cancelled', 'cancelled');
      count += 1;
    }
    const running = this.findRunning();
    if (running !== undefined && running.epoch <= epoch) {
      this.finish(running, 'cancelled', 'cancelled');
      this.inFlight?.abort();
      count += 1;
    }
    return count;
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  /** The immutable result of a finished task — the approval re-entry seam. */
  getResult(id: string): TaskResult | undefined {
    return this.records.get(id)?.result;
  }

  list(): TaskRecord[] {
    return [...this.records.values()];
  }

  stats(): TaskStats {
    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    for (const task of this.records.values()) {
      if (task.status === 'queued') queued += 1;
      else if (task.status === 'running') running += 1;
      else if (task.status === 'completed') completed += 1;
      else if (task.status === 'failed') failed += 1;
      else cancelled += 1;
    }
    return {
      depth: this.pending.length,
      maxDepth: this.opts.maxDepth,
      queued,
      running,
      completed,
      failed,
      cancelled,
      enabled: this._enabled,
    };
  }

  /**
   * Whether a task has been cancelled since it started running.
   *
   * A METHOD, not an inline read. `task.status` was assigned `'running'` a few
   * lines above, so TypeScript narrows the property to `'running'` and — not
   * seeing that `cancel()` mutated it from another call frame — reports every
   * later `task.status === 'cancelled'` as an impossible comparison (TS2367)
   * and would let it be deleted as dead code. The mutation is real and is the
   * whole of rule 4, so the read must not be narrowable.
   */
  private isCancelled(task: TaskRecord): boolean {
    return task.status === 'cancelled';
  }

  private findRunning(): TaskRecord | undefined {
    for (const task of this.records.values()) {
      if (task.status === 'running') return task;
    }
    return undefined;
  }

  /**
   * Evict terminal records past the cap, oldest first. Queued/running are
   * never evicted: the queue owns their lifetime, not the archive.
   */
  private sweepRecords(): void {
    for (const [id, rec] of this.records) {
      if (this.records.size <= TASK_RECORDS_CAP) break;
      if (rec.status === 'queued' || rec.status === 'running') continue;
      this.records.delete(id);
    }
  }

  private finish(task: TaskRecord, status: TaskStatus, detail: string, result?: TaskResult): void {
    task.status = status;
    task.detail = detail;
    task.finishedAt = this.opts.now();
    // Assigned once and frozen. Pattern 3 re-offers this exact object on
    // delivery retry, so a consumer that could mutate it would corrupt the
    // retry for everyone else. The flagged list is frozen too: a shallow
    // freeze would leave the one array inside mutable. `result` is readonly
    // on the type, so this single assignment site uses a mutable view —
    // the ONLY place in the tree allowed to set it (grep `\.result =`).
    if (result !== undefined) {
      const writable = task as { -readonly [K in keyof TaskRecord]: TaskRecord[K] };
      writable.result = Object.freeze({
        ...result,
        ...(result.flagged !== undefined ? { flagged: Object.freeze([...result.flagged]) } : {}),
      });
    }
    this.sweepRecords();
  }

  private async runOne(task: TaskRecord): Promise<void> {
    // Rule 2. A newer turn already exists: planning this one acts on an
    // instruction the user has already moved past.
    if (task.epoch < this.currentEpoch) {
      this.finish(task, 'cancelled', 'cancelled-superseded');
      return;
    }

    task.status = 'running';
    task.startedAt = this.opts.now();
    const controller = new AbortController();
    this.inFlight = controller;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('plan-deadline'));
        }, this.opts.planDeadlineMs);
      });
      const result = await Promise.race([
        this.opts.plan(task, controller.signal),
        deadline,
      ]);
      if (timer !== undefined) clearTimeout(timer);

      // Rule 4. The cancel may have landed while the planner was in flight; the
      // call could not be undone, but its effect can still be refused.
      if (this.isCancelled(task) || task.epoch < this.currentEpoch) return;

      // FR-12 is a SUCCESS of this pipeline. A destructive plan waiting for
      // approval did everything it was asked to do; billing it `failed` turns a
      // confirmation gate into a red notice about work that is merely pending.
      if (result.needsConfirmation === true) {
        this.finish(task, 'completed', 'confirmation-required', result);
        return;
      }
      if (!result.ok) {
        this.finish(task, 'failed', result.detail ?? 'plan-failed', result);
        return;
      }
      this.finish(task, 'completed', 'dispatched', result);
      this.opts.dispatch?.(task, task.result ?? result);
    } catch (err) {
      if (timer !== undefined) clearTimeout(timer);
      // A cancelled task that ALSO throws is still a cancellation: the abort
      // we signalled is the most likely cause of the throw, and reporting it as
      // a plan failure would bill a user barge-in as a provider fault.
      if (this.isCancelled(task)) return;
      const timedOut = err instanceof Error && err.message === 'plan-deadline';
      this.finish(task, 'failed', timedOut ? 'plan-timeout' : 'plan-error');
    } finally {
      this.inFlight = null;
    }
  }
}
