import { OrchestratorError, errorCodeFor } from '../common/errors.js';
import type { SessionId } from '../common/brands.js';
import {
  TaskQueue,
  buildTaskNotice,
  isTerminal,
  DEFAULT_TASK_TIMEOUT_MS,
  type TaskEvent,
  type TaskId,
  type TaskOutcomeCode,
  type TaskRecord,
  type TaskStore,
} from '../tasks/index.js';
import type { OutputFrameInput } from '../ipc/protocol.js';
import type { SessionShellResult, ShellOutcome } from '../runtime/client.js';

// The `execSessionShell` bridge: an approved shell command becomes a QUEUED TASK
// whose result reaches the shell as an `output` frame and a notice, instead of
// vanishing into a boolean.
//
// WHY IT IS HERE AND NOT IN `daemon.ts`. `daemon.ts` is the composition root and
// already carries the pipeline, the delivery buffer and the credit monitor. This
// is a self-contained mechanism with three dependencies (run, emit, speak), so it
// is written as one factory the root wires — the same late-binding discipline
// `coordinatorRef` and `liveRing` already use, and the reason nothing here needs
// to know about keys, speakers or WebSockets.
//
// WHY A QUEUE AT ALL, when serve BLOCKS until the command completes (measured: a
// 7 s ping took 7.4 s). Because "the call returned" and "the work finished" are
// different statements here, and only the queue can hold them apart: the record
// has a state machine, a deadline and a bounded history, so a command that never
// answers is `failed`/`timeout` rather than an `await` that never resolves. It
// also gives the shell something to show while the work runs, which the old
// `{ ok: true }` gave it nothing.
//
// THE HONESTY RULE, and the reason this file is not three lines. Measured against
// serve 1.18.32: `POST /session/{id}/shell` blocks until the command completes and
// carries NO exit code in any field. `exit 3` comes back `completed` with empty
// output — byte-identical to a silent success. So:
//   - `outcome` is whatever `deriveShellOutcome` said, passed straight through.
//     This file never upgrades `unknown` and never synthesises a failure from an
//     empty output string.
//   - the notice `buildTaskNotice` produces is QUALIFIED by that outcome before it
//     reaches the user, because `خلص <command>` read on its own is a success
//     report and in the common case it would be one.
// The charter's "notify on failure only" is not implementable against this API.
// Notifying on completion, with the uncertainty stated, is.

/** The `TaskSpec.kind` for every task this bridge creates. */
export const SHELL_TASK_KIND = 'shell';

/**
 * Deadline applied to a shell task, stated explicitly rather than left to the
 * engine default so the number in the record is traceable to a decision here.
 *
 * The engine's own default is 15 minutes and is right: the longest thing this
 * daemon legitimately runs through serve is a test suite, and serve runs the call
 * through a MODEL TURN (`agent: "build"`), so the command's own runtime is only
 * part of the wait. The clamp still applies — `MIN_TASK_TIMEOUT_MS` below and
 * `MAX_TASK_TIMEOUT_MS` above — and the EFFECTIVE value is what lands in the
 * record, so a caller who reads `timeoutMs` off a task is reading the deadline
 * that actually applied.
 */
export const SHELL_TASK_TIMEOUT_MS = DEFAULT_TASK_TIMEOUT_MS;

export interface ShellTaskBridgeOptions {
  /** The real call. Injected so this module never imports the HTTP client. */
  readonly run: (sessionId: SessionId, command: string, signal: AbortSignal) => Promise<SessionShellResult>;
  /** `ui.output` — assigns the seq, runs the 32 KiB cap, retains, fans out. */
  readonly emitOutput: (input: OutputFrameInput) => void;
  /** `ui.notice`. Redaction happens at that sink, so this never pre-redacts. */
  readonly emitNotice: (code: string, detail: string, level: 'info' | 'warn' | 'error') => void;
  /**
   * Whether the room is quiet enough to talk. The integration wave's silence
   * window, injected as DATA so this module decides nothing about audio — the same
   * split `buildTaskNotice`'s `NoticeContext` already draws.
   */
  readonly speechAvailable: () => boolean;
  /** Spoken delivery. Optional, and a missing one means "visual only". */
  readonly speak?: (text: string) => void;
  /**
   * Durability. UNSET IS THE PRODUCTION CHOICE, and it is not an oversight.
   *
   * `TaskQueue` replays a `queued` record on load — correct for a work item the
   * user asked for, and wrong here: the replay would re-execute a shell command
   * the FR-12 gate approved ONCE, with no second approval and no user present.
   * Auto-replaying `rm -rf build` on the next app launch is a duplicate side
   * effect nobody requested, and it is exactly the kind of "the system did
   * something on its own" this repo keeps auditing for.
   *
   * The cost, stated: with an in-memory store the `interrupted` recovery path and
   * the `store-unreadable` path are unreachable in production, and a command that
   * was `running` when the process died leaves no trace. Both are real losses and
   * both are cheaper than silent re-execution. A future wave can opt in the moment
   * the executor is made idempotent (or the replay is made approval-gated) — the
   * seam is here for exactly that.
   */
  readonly store?: TaskStore;
  /**
   * The deadline this bridge asks the engine for. UNSET IN PRODUCTION, where
   * `SHELL_TASK_TIMEOUT_MS` applies.
   *
   * A seam and nothing else: the production deadline is 15 minutes, and a test
   * that has to wait out the real one measures nothing. It is exposed rather than
   * patched so a short-deadline test is a normal call to this factory instead of
   * a fake timer racing a hard-coded constant. `daemon.ts` passes neither this
   * nor `minTimeoutMs`, which is asserted — a production deadline nobody reads
   * off a test seam is how a 15-minute number quietly becomes 15 seconds.
   */
  readonly timeoutMs?: number;
  /**
   * The floor the engine clamps `timeoutMs` up to. UNSET IN PRODUCTION, where
   * `MIN_TASK_TIMEOUT_MS` (1 s) applies. Without it a short-deadline test is
   * clamped to a second and the test measures the clamp.
   */
  readonly minTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ShellTaskBridge {
  /**
   * The `CommandClient.execSessionShell` slot, and the shape it MUST have: three
   * parameters, because the router forwards three.
   *
   * `commandId` is the WS command id the shell sent, and it is what the `output`
   * frame carries — the only thing that lets a shell match a result to the spinner
   * it is still showing. `deps.client.execSessionShell(session, cmd.command, cmd.id)`
   * is `command-router.ts`'s call site and it is not going to change shape.
   *
   * REQUIRED, NOT OPTIONAL, and that is the load-bearing word. A function with
   * FEWER parameters is assignable to this slot, so omitting the third is not a
   * type error — it is a frame that quietly carries the task queue's UUID instead
   * of the id the shell is waiting on. That is not hypothetical: the router was
   * threaded first and this signature was not, so every typecheck passed, the
   * suite was green, and the frame carried an id no shell had ever sent. An
   * optional `commandId?: string` would move the same defect one layer down,
   * where it arrives as `undefined`.
   *
   * The bound is already safe, which is why this can be a plain copy. The id
   * arrives through `UiCommandSchema`, whose `id` is `min(1).max(128)` plus a
   * control-character refusal — and `OutputFrameSchema.commandId` is the SAME
   * rule. So any id that reaches this method is by construction legal in the
   * frame it is copied into, and `buildOutputFrame`'s `parse` cannot throw on it.
   *
   * Resolves with the client's own `SessionShellResult`, so a caller that wants
   * the output still has it. Rejects with an `OrchestratorError` (the client's own
   * for transport/contract faults, `shellStopFailure` for a daemon-side stop) so
   * every existing `catch` site keeps working unchanged.
   */
  execSessionShell(sessionId: SessionId, command: string, commandId: string): Promise<SessionShellResult>;
  /** The live queue. Exposed for `close()` and for the integration test. */
  readonly tasks: TaskQueue;
  close(): void;
}

export function createShellTaskBridge(options: ShellTaskBridgeOptions): ShellTaskBridge {
  const now = options.now ?? (() => Date.now());

  /**
   * What the command actually returned, keyed by task id, so the `settled`
   * handler can (a) resolve the caller and (b) qualify the notice with the
   * outcome the frame carries. Bounded by the live task count and swept on settle
   * — an entry that outlived its task would be a small leak on a hot path.
   */
  const settled = new Map<string, { readonly result?: SessionShellResult; readonly error?: unknown }>();
  const waiters = new Map<string, { resolve: (r: SessionShellResult) => void; reject: (e: unknown) => void }>();

  const readPayload = (task: TaskRecord): ShellTaskRun => {
    const payload = task.payload;
    const sessionId = payload?.['sessionId'];
    const command = payload?.['command'];
    const commandId = payload?.['commandId'];
    if (typeof sessionId !== 'string' || typeof command !== 'string' || typeof commandId !== 'string' || commandId.length === 0) {
      throw new OrchestratorError('CONFIG_INVALID', false, 'shell task payload is missing sessionId/command/commandId');
    }
    // The router only reaches here after `resolveSession` enforced `^ses_…`, and
    // after `shellCommandError` capped the text at 512 chars. Both bounds are
    // re-stated as assertions rather than assumed, because `OutputFrameSchema`
    // enforces them and a throw inside `ui.output` would become an unhandled
    // rejection inside a listener.
    //
    // `commandId` is asserted too, for the reason stated on the interface: it is
    // REQUIRED, and a payload missing it means a record this bridge did not
    // write. The only producer of one is `execSessionShell` below, so this is an
    // assertion about our own writes and not a compatibility path for someone
    // else's — the durable store is unset in production precisely so nothing
    // written by an older build can be replayed here.
    return { sessionId: sessionId as SessionId, command, commandId };
  };

  const queue = new TaskQueue({
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.minTimeoutMs !== undefined ? { minTimeoutMs: options.minTimeoutMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    executor: async (task, signal) => {
      const run = readPayload(task);
      const startedAt = now();
      try {
        const result = await options.run(run.sessionId, run.command, signal);
        if (settledWithoutUs(task.id)) return result;
        settled.set(task.id, { result });
        publishResult(run, result);
        return result;
      } catch (err) {
        if (settledWithoutUs(task.id)) throw err;
        settled.set(task.id, { error: err });
        publishFault(run, err, elapsedMs(startedAt, now()));
        // Rethrown so the engine records `failed`/`threw` — the task record has to
        // agree with the frame, and a swallowed rejection would leave a `done`
        // task whose output frame says `status: 'error'`.
        throw err;
      }
    },
  });

  /**
   * Did the engine already settle this task while the executor was waiting?
   *
   * A deadline, a cancellation and a shutdown all end a task the executor is still
   * awaiting — `TaskQueue` does not and cannot preempt it. The executor then
   * returns or rejects LATE, and without this check it would publish a SECOND
   * `output` frame for a command that has already reported a terminal one: a
   * success frame arriving after a `TASK_TIMEOUT` frame, which is the
   * three-surfaces-disagree defect one layer down, and a spinner that resolves
   * twice. The engine already refuses the second settlement and counts it
   * (`stats().lateSettlements`); the frame is the part it cannot refuse.
   *
   * THE ENGINE'S OWN RECORD IS THE TEST, not a set this file maintains. A record
   * whose executor is still awaiting is `running`, and `trimHistory` evicts only
   * terminal records — so `get()` returning `undefined` means "evicted", which is
   * only ever true of a settled task, and is the same answer. A separate set here
   * would be a second bookkeeping structure for one boolean, and one with no
   * bound on it, which is the accumulation shape this file's other maps exist to
   * avoid.
   *
   * The check and the publish that follows it are synchronous after the `await`,
   * so no settle can interleave between them: a timer callback cannot run inside
   * synchronous code.
   */
  function settledWithoutUs(id: TaskId): boolean {
    const record = queue.get(id);
    return record === undefined || isTerminal(record.state);
  }

  /**
   * The happy-path frame. `status` and `exitCode` go in VERBATIM so
   * `buildOutputFrame` re-derives `outcome` with the same function the client
   * used. Deriving it here instead would be the second opinion this repo already
   * paid for once.
   *
   * `commandId` is the id the SHELL sent, taken from the task payload and not
   * from `task.id`. `task.id` is this queue's own UUID: it keys the task record,
   * which is a legitimate use, but the `output` frame's `commandId` is documented
   * as the correlation token for the command that caused it, and a UUID the
   * caller never sent cannot correlate to anything the caller is displaying.
   */
  function publishResult(run: ShellTaskRun, result: SessionShellResult): void {
    options.emitOutput({
      sessionId: result.sessionId,
      commandId: run.commandId,
      command: run.command,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      durationMs: result.durationMs,
    });
  }

  /**
   * The failure frame — every failure now, not only a transport one.
   *
   * A shell command that never reached serve has no `SessionShellResult`, so
   * there is no `status` to report and nothing to say about whether it ran.
   * `status: 'error'` with `exitCode: null` is the truthful pair: the CALL
   * failed. `deriveShellOutcome` turns that into `outcome: 'failed'`, which is
   * correct — this time the failure is observable, which is the whole difference
   * between this branch and the `completed`-with-no-exit-code branch. A daemon-side
   * stop (deadline, cancellation, shutdown) has no result either, and `failed` is
   * the same truthful answer for it.
   *
   * THE TEXT IS THE MACHINE CODE, never `err.message`: a provider/transport
   * string is untrusted input and `ui.notice` redacts, but the output frame does
   * not, so only a closed-union literal crosses here.
   *
   * `errorCodeFor(err)`, NOT `err.code`, and that one word is the fix this frame
   * needed. The router maps a thrown error to `ack.detail` through the same
   * function, so this frame and that ack are now ONE classification instead of
   * two — which is the only way "the shell was told TASK_TIMEOUT in the ack and
   * SESSION_BUSY in the frame" is prevented rather than merely unlikely. The
   * function prefers `stopReason` and only falls back to `err.code`, so serve's
   * own 409 backpressure is still `SESSION_BUSY` here and a stop is its own code.
   */
  function publishFault(run: ShellTaskRun, err: unknown, durationMs: number | null): void {
    options.emitOutput({
      sessionId: run.sessionId,
      commandId: run.commandId,
      command: run.command,
      status: 'error',
      exitCode: null,
      output: errorCodeFor(err),
      durationMs,
    });
  }

  /**
   * ONE subscriber, and it only reacts to `settled`.
   *
   * `queued` and `started` are deliberately silent. A task that announces itself
   * twice before it has produced anything is noise, and the charter's audio rule
   * is "silent while running". The shell learns a command is running from the
   * `ack` it already has (`confirmation-required`) and from the task record.
   */
  queue.subscribe((event: TaskEvent) => {
    if (event.type !== 'settled') return;
    const { code } = event;
    const record = settled.get(event.task.id);
    const outcome = record?.result?.outcome ?? null;
    const notice = qualifyTaskNotice(buildTaskNotice(event.task, { speechAvailable: options.speechAvailable() }), outcome);
    // `'ok'` → `'info'`: the notice frame's level union is
    // `info | warn | error` (`ipc/protocol.ts:635`) while the task notice's
    // severity is `ok | warn | error`. Both non-alarming levels collapse to
    // `info`, which is the honest direction — the frame has no green, and
    // inventing one would mean editing a protocol this wave does not own.
    options.emitNotice(notice.code, notice.detailAr, notice.severity === 'ok' ? 'info' : notice.severity);
    // Fire and forget, and AFTER the visual notice: a courtesy line must never
    // delay the text the user is reading. A rejection here is swallowed because
    // the spoken path is decorative and a Fish fault must not become an
    // unhandled rejection inside a queue listener.
    if (notice.speak) {
      try {
        options.speak?.(notice.detailAr);
      } catch {
        /* spoken delivery is best-effort by construction */
      }
    }

    // A settle the EXECUTOR did not produce. The engine can end a task on its own
    // — the deadline fires while `run` is still awaiting serve, a cancel aborts
    // the signal — and in that case nothing in the executor ever published a
    // frame, so the shell had a notice and an ack naming the stop and NO frame at
    // all: the indefinite spinner this frame exists to end.
    //
    // ONE ERROR OBJECT, TWO CONSUMERS. `shellStopFailure` is built once here and
    // handed to both `publishFault` and `settleWaiter`, so the code in the frame
    // and the code the router derives for `ack.detail` are the same value by
    // construction rather than by two lookups agreeing.
    //
    // GUARDED, and the guard is not ceremony: `readPayload` throws by design on a
    // payload it did not write, and this runs inside a queue listener where a
    // throw would be swallowed by the engine's `listenerErrors` counter — which
    // would leave the WAITER unsettled and strand the command. So the frame is
    // best-effort and the waiter is settled either way. The payload cannot
    // actually be malformed here (the executor read the identical frozen record
    // before it started), and the catch is here so that "cannot" is not load-
    // bearing.
    let stopped: OrchestratorError | null = null;
    if (record === undefined) {
      stopped = shellStopFailure(code);
      try {
        publishFault(readPayload(event.task), stopped, elapsedMs(event.task.startedAt, event.task.settledAt));
      } catch {
        /* no payload, no frame — the ack below still terminates the command */
      }
    }
    settleWaiter(event.task.id, code, stopped);
  });

  /**
   * Hand the caller its answer, exactly once.
   *
   * `code` is the ENGINE's verdict and `record.result` is the CLIENT's. They are
   * kept apart deliberately: the engine settles `done` whenever the executor
   * returned, so `code === 'ok'` with no result is a real shape (an executor that
   * resolved without one) and must not resolve the caller with `undefined`.
   *
   * `stopped` is the error this subscriber already built for the frame, passed in
   * rather than rebuilt. One construction, two consumers — see the note above.
   */
  function settleWaiter(id: string, code: TaskOutcomeCode, stopped: OrchestratorError | null = null): void {
    // The `settled` entry is swept UNCONDITIONALLY, before the waiter lookup. It is
    // keyed by task id and a task settles exactly once, so an entry whose waiter is
    // somehow absent would otherwise sit in the map for the process's life — the
    // unbounded-accumulation shape `src/tasks/engine.ts` was written to remove, one
    // map over.
    const record = settled.get(id);
    settled.delete(id);
    const waiter = waiters.get(id);
    if (waiter === undefined) return;
    waiters.delete(id);
    if (code === 'ok' && record?.result !== undefined) {
      waiter.resolve(record.result);
      return;
    }
    waiter.reject(stopped ?? failureFor(code, record?.error));
  }

  /**
   * The re-check for a task that settled before its waiter existed.
   *
   * `TaskQueue.start` invokes the executor inside an `async` IIFE, so a settle
   * always lands in a LATER microtask than the `enqueue` that started it, and
   * this branch is unreachable in practice. It is here because "unreachable in
   * practice" is the exact reasoning that has stranded a promise in this repo
   * before, and the cost of being wrong is a `confirm` command that never returns
   * an ack — a spinner with no result, which is the defect the output frame was
   * built to end. The branch resolves from `settled`, so it handles the success
   * and the failure case identically.
   */
  function settleIfAlreadyDone(id: string): void {
    const record = settled.get(id);
    if (record === undefined) return;
    const waiter = waiters.get(id);
    if (waiter === undefined) return;
    settleWaiter(id, record.result !== undefined ? 'ok' : 'threw');
  }

  /**
   * The daemon-side failure for a task that did not produce a result.
   *
   * Delegated to the exported `shellStopFailure` so the three stop conditions are
   * one auditable table rather than a branch per call site, and so a test can read
   * the whole mapping without a queue. The executor's own error still wins when
   * there is one — that is a transport/contract fact about the call, and a stop
   * reason is not a substitute for it.
   */
  function failureFor(code: TaskOutcomeCode, err: unknown): unknown {
    // The executor's own error is the best answer available when there is one.
    if (err !== undefined) return err;
    return shellStopFailure(code);
  }

  return {
    execSessionShell: async (sessionId, command, commandId) => {
      const admitted = queue.enqueue({
        kind: SHELL_TASK_KIND,
        // The label is the user's own text, bounded by `shellCommandError`'s 512
        // so the notice stays one line. It is what `buildTaskNotice` interpolates,
        // which is why the qualifier below matters so much.
        label: command.slice(0, 120),
        // `commandId` RIDES IN THE PAYLOAD rather than beside the queue, so the
        // frame can be built from the task record alone. That is not tidiness: the
        // stop frame below is published for a task whose executor never returned,
        // so there is no closure state left to read an id from by then.
        payload: { sessionId, command, commandId },
        timeoutMs: options.timeoutMs ?? SHELL_TASK_TIMEOUT_MS,
      });
      if (!admitted.ok) {
        // The command NEVER RAN. That is worth a line on its own — and it is not
        // an `output` frame, because there is no result to report: the `ack`
        // carrying this refusal is the terminal signal, and a frame with no task
        // behind it would be a result for work that never happened.
        options.emitNotice('shell-queue-full', `الطابور ممتلئ — ${admitted.detail}`, 'warn');
        throw new OrchestratorError('RATE_LIMITED', true, `shell: refused at enqueue (${admitted.code})`);
      }
      return await new Promise<SessionShellResult>((resolve, reject) => {
        waiters.set(admitted.id, { resolve, reject });
        settleIfAlreadyDone(admitted.id);
      });
    },
    tasks: queue,
    close: () => {
      queue.close();
      for (const [, waiter] of waiters) {
        // `stopReason` set, so the router's `errorCodeFor` reports DAEMON_STOPPED
        // rather than "the session is busy". There is NO frame for this one and
        // there cannot be: `TaskQueue.close()` abandons in-flight tasks without
        // settling them, so no `settled` event fires, and the ack is the only
        // terminal signal the shell is going to get before the socket closes.
        waiter.reject(new OrchestratorError('SESSION_BUSY', false, 'shell: the daemon stopped', 'daemon-stopped'));
      }
      waiters.clear();
      settled.clear();
    },
  };
}

/**
 * The three daemon-side stop conditions, as ONE error each.
 *
 * `TaskOutcomeCode` is the engine's verdict and it has exactly one member that is
 * not a transport fact about serve: the task stopped being waited for. A deadline
 * that expires, a cancellation, and a daemon that went away are three different
 * user actions, and the shell used to be told `SESSION_BUSY` for all three — the
 * code whose entire meaning is "serve answered 409 because the session is
 * mid-turn", so the advice was "wait", which is what had already failed.
 *
 * `stopReason` IS THE DISCRIMINATION, and it is the fourth constructor argument
 * rather than the wording of the message. `common/errors.ts` widened `ErrorCode`
 * with `TASK_TIMEOUT`/`CANCELLED`/`DAEMON_STOPPED` and `errorCodeFor` re-codes a
 * stopped waiter from `stopReason` at the sink the router uses for `ack.detail`
 * — so the code a caller sees is derived from the field below and never from
 * `secretSafeMessage`.
 *
 * There used to be a SECOND mechanism underneath this one, and it is gone: a
 * `SHELL_STOP_MESSAGE_PREFIXES` table in `common/errors.ts` plus a `startsWith`
 * loop in `stopReasonOf`, which recovered the same reason by matching the prose
 * of these very messages. While it existed, the classification of a failure was a
 * function of a rewording in this file, and a substring match over free text is
 * one provider message away from firing on the wrong error. `stopReasonOf` now
 * reads the typed field and nothing else, so the reason is set once, here, and
 * rewording a message cannot change what a caller is told. `ack-truth.test.ts`
 * holds the tombstone — the three legacy strings carried with NO reason now
 * report `SESSION_BUSY` — and `shell-task-stop-reason.test.ts` reads this file
 * and fails if any of these four sites stops passing a reason.
 *
 * WHY `code` IS STILL `SESSION_BUSY`, AND WHY THAT IS SETTLED RATHER THAN
 * DEFERRED. It is not the same defect again: the observable code is
 * `SHELL_STOP_REASON_CODES[stopReason]` at every sink (`errorCodeFor`), so
 * `TASK_TIMEOUT` is what reaches the ack and the frame either way, and
 * `httpStatusOf` reads the reason rather than the code. Re-coding the literal here
 * would therefore change nothing a caller can see.
 *
 * IT WAS DEFERRED ONCE, for a reason that has since been SATISFIED rather than
 * argued away, and the old paragraph is worth naming because the record would
 * otherwise be silent about it: it cited `ack-truth.test.ts` still asserting a
 * COUNT of `SESSION_BUSY` constructions over lines this function used to own from
 * elsewhere, so re-coding the site would have taken a guard red in a file that
 * change was not allowed to edit. That test now asserts the fourth constructor
 * argument instead — and it still matches on the literal `'SESSION_BUSY'`, so that
 * constraint is real today rather than historical. It was never more than a
 * mechanical reason, and it is not the reason the literal stays. The reason that
 * holds is the fallthrough arm below: it carries no reason, so `errorCodeFor`
 * returns its `err.code` verbatim, which makes whatever literal it holds the code
 * an engine outcome with no stop of its own is reported as. `SESSION_BUSY` — "the
 * shell could not give you a result for this command" — is the one member of the
 * union that says that without claiming a cause the daemon does not have. Give
 * the three stops literals of their own and this arm has to keep `SESSION_BUSY`
 * anyway, so a one-line cosmetic change would split one shared construction code
 * in two and buy no observable difference.
 *
 * The `retryable` flag is a property of the throw site and is set per arm: only
 * the deadline is retryable, because only there may the command still complete
 * inside serve. A cancelled command that is retried is a duplicate side effect,
 * and a daemon that stopped is not coming back on its own.
 *
 * The fallthrough keeps `stopReason: null` on purpose — an outcome code that is
 * not one of the three stops is a fact about the engine, not a reason the waiter
 * stopped, and claiming otherwise would put a catch-all inside the taxonomy.
 */
export function shellStopFailure(code: TaskOutcomeCode): OrchestratorError {
  if (code === 'cancelled') {
    return new OrchestratorError(
      'SESSION_BUSY',
      false,
      'shell: the command was cancelled before it completed',
      'cancelled',
    );
  }
  if (code === 'timeout') {
    return new OrchestratorError(
      'SESSION_BUSY',
      true,
      'shell: the command exceeded its deadline; the daemon stopped waiting and serve may still be running it',
      'timeout',
    );
  }
  return new OrchestratorError('SESSION_BUSY', false, `shell: the command finished as ${code}`);
}

/**
 * The three facts a frame needs about the command that produced it.
 *
 * Read out of the task payload, never out of queue state, so a frame can be
 * published for a task the executor no longer holds anything for.
 */
interface ShellTaskRun {
  readonly sessionId: SessionId;
  readonly command: string;
  readonly commandId: string;
}

/**
 * A frame-legal `durationMs`, or `null` for "we do not know".
 *
 * `OutputFrameSchema.durationMs` is `int().nonnegative().nullable()` and
 * `buildOutputFrame` PARSES, so a fractional or negative value throws inside a
 * queue listener — where the engine would count it as a listener error and the
 * caller would never learn why. `now` is injectable, so truncation is not
 * theoretical. `null` is the honest answer when either endpoint is missing (a
 * task cancelled before it started has no `startedAt`).
 */
function elapsedMs(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null;
  return Math.max(0, Math.trunc(to - from));
}

/**
 * A notice as the user receives it.
 *
 * Kept separate from `TaskNotice` because it is this bridge's own type — the
 * qualifier is a decision about the SHELL RESULT, which `buildTaskNotice` cannot
 * see (it classifies the task, not the command serve ran).
 */
export interface QualifiedTaskNotice {
  readonly code: string;
  readonly detailAr: string;
  readonly severity: 'ok' | 'warn' | 'error';
  readonly speak: boolean;
}

/**
 * Attach the shell's own verdict to a task notice.
 *
 * THE FUNCTION THIS WHOLE FILE EXISTS TO KEEP HONEST. `buildTaskNotice` knows a
 * task reached `done`. It does not know whether the command succeeded — and
 * against serve 1.18.32 it usually cannot, because there is no exit code in the
 * response. `outcome === 'unknown'` therefore has to be said out loud: without
 * this, every shell command in the common case reads `خلص npm test` in green,
 * which is the fabricated success this whole chain was written to remove.
 *
 * `outcome === null` means the task settled with no result at all (a timeout, a
 * cancellation, a refused enqueue). Those are already `warn`/`error` from
 * `buildTaskNotice`, so nothing is appended and their severity is left alone.
 */
export function qualifyTaskNotice(
  notice: { readonly code: string; readonly detailAr: string; readonly severity: 'ok' | 'warn' | 'error'; readonly speak: boolean },
  outcome: ShellOutcome | null,
): QualifiedTaskNotice {
  if (outcome === 'failed') {
    return {
      ...notice,
      detailAr: `${notice.detailAr} — فشل الأمر عند OpenCode`,
      severity: 'error',
    };
  }
  if (outcome === 'unknown') {
    return {
      ...notice,
      detailAr: `${notice.detailAr} — الخادم ما رجّع رمز خروج، فالنتيجة مو مؤكدة`,
      // `warn`, not `ok`. Green on an unknown is the lie this rejects.
      severity: 'warn',
    };
  }
  return notice;
}
