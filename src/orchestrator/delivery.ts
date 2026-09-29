import type { TaskRecord, TaskResult } from './task-queue.js';

// M2 Pattern 3 — completion ≠ delivery.
//
// The `spawn_thinking` split (Pattern 1) made the queue half of the turn
// observable: a task can be `completed` while the speaker is still busy, and
// the daemon proves the consequence — a held FR-12 plan was announced with
// `ui.notice('plan-held', …)` from INSIDE the planner, so the one thing the user
// has to act on arrived in the middle of an utterance. That is not a delivery.
// It is a collision.
//
// This buffer is the missing half. A completed result is OFFERED; it is
// delivered immediately if the channel is free and HELD otherwise, then
// delivered on the next quiet window — coalesced to the newest, so three
// back-to-back turns produce one notice rather than three. Completion and
// delivery are separate events, and only the second one talks to the user.
//
// DEPENDENCY RULE, identical to `task-queue.ts`: standard library plus TYPE-only
// imports of the task shapes. It must not import the coordinator, the models or
// the protocol — a delivery buffer that dragged the planner into every importer's
// graph would re-introduce the barrel-bypass failure this repo already paid for,
// and the daemon imports this module beside `speechGate`. `TaskResult` is
// structural for exactly the reason `TaskResult` is structural there: the
// buffer does not know what a plan is, only that something is waiting.
//
// FOUR RULES, each with a named break in `delivery.test.ts`:
//   1. Delivery needs a QUIET channel. Busy in any of the three dimensions —
//      speech live, TTS still synthesising, or no shell that can play — and the
//      result is held. Delivering into a live utterance is the defect.
//   2. Newest wins. The drain coalesces to the single newest held item and
//      COUNTS what it discarded. Three FR-12 holds in a row are not three
//      decisions the user can make; they are one current state.
//   3. A held item expires. TTL bounds the buffer in TIME as the cap bounds it
//      in COUNT, because an unbounded queue is the same defect as an unbounded
//      replay buffer — and a stale "your plan is waiting" notice is noise.
//   4. Epoch supersede, same rule as `TaskQueue`: `epoch < current` is a
//      cancellation. A newer utterance means the older hold is moot, and a
//      confirmation for a plan the user has moved past is a wrong prompt.

/**
 * How busy the delivery channel is, sampled at offer and at drain.
 *
 * Three independent dimensions, deliberately NOT collapsed into one boolean at
 * the call site: collapsing them in the daemon is how a "we think speech is
 * happening" guess becomes a delivery that talks over itself. Each is
 * observable, so a wrong one is debuggable.
 *
 *  - `speechLive`   — a `voice` frame currently claims the speaker.
 *  - `ttsPlaying`   — Fish is still synthesising (a barge has not landed).
 *  - `playbackReady` — the shell can take audio. False when no player exists or
 *    the last utterance's audio has not drained; delivering into a dead player
 *    is silence the user reads as the assistant ignoring them.
 */
export interface DeliveryChannelState {
  readonly speechLive: boolean;
  readonly ttsPlaying: boolean;
  readonly playbackReady: boolean;
}

/** Free only when all three dimensions say the channel is available. */
export function channelFree(state: DeliveryChannelState): boolean {
  return !state.speechLive && !state.ttsPlaying && state.playbackReady;
}

/** One completed result waiting for a quiet channel. */
export interface DeliveryItem {
  readonly taskId: string;
  readonly epoch: number;
  /** The queue's frozen result. Never re-derived, never mutated here. */
  readonly result: TaskResult;
  readonly offeredAt: number;
}

export interface DeliveryStats {
  readonly held: number;
  readonly maxHeld: number;
  readonly delivered: number;
  /** Items the newest-wins drain discarded because a newer one replaced them. */
  readonly coalesced: number;
  /** Items lost to the cap, the TTL, or supersede. Distinct from coalescing. */
  readonly dropped: number;
  readonly retried: number;
}

export interface DeliveryBufferOptions {
  /** Actually tells the user. Called only on a free channel. */
  readonly deliver: (item: DeliveryItem) => void;
  /** Live channel state, sampled at each offer and drain. */
  readonly state: () => DeliveryChannelState;
  /**
   * The result source for `retry`. Supplied by the daemon as
   * `(id) => tasks.getResult(id)`; absent means retry is always `unknown`.
   */
  readonly resultFor?: (taskId: string) => TaskResult | undefined;
  /** Clock seam — TTL is time, and time has to be injectable. */
  now?(): number;
  /**
   * Called once per item that expires by TTL (NOT for superseded items — the
   * user moved on, and a notice about a moot confirmation is noise). Peer
   * review: without this, a shell that never reports playback holds a
   * confirmation until TTL silently drops it — permanent silence for old
   * shells. The daemon wires it to a terminal warn notice, so the worst case
   * is a late notice, never no notice.
   */
  onExpired?: (item: DeliveryItem) => void;
  /** Held bound. 4 concurrent confirmations is a burst, not a backlog. */
  readonly maxHeld?: number;
  /** Held bound in time. Same reasoning as `MAX_PARKED`. */
  readonly ttlMs?: number;
}

/**
 * 4 held items. Below `MAX_PARKED` (8) because each held item is a decision the
 * user must make, and 4 unanswered questions is a product failure while 8 is
 * noise.
 */
export const DELIVERY_CAP = 4;

/**
 * 30 s. Long enough for a reply to finish and for the user to notice it, short
 * enough that an approval prompt cannot outlive the conversation it belongs to.
 */
export const DELIVERY_TTL_MS = 30_000;

/**
 * `offer`/`retry` outcomes. `buffered` is the spec word for "held for a quiet
 * channel" and is kept rather than renamed to `held` so the two halves of
 * Pattern 3 read the same; `dropped` covers supersede and `unknown` covers a
 * task with no recorded result.
 */
export type DeliveryOutcome = 'delivered' | 'buffered' | 'dropped' | 'unknown';

export class DeliveryBuffer {
  private readonly items: DeliveryItem[] = [];
  private readonly opts: Required<Omit<DeliveryBufferOptions, 'resultFor' | 'onExpired'>> &
    Pick<DeliveryBufferOptions, 'resultFor' | 'onExpired'>;
  private currentEpoch = 0;
  private droppedCount = 0;
  private coalescedCount = 0;
  private deliveredCount = 0;
  private retriedCount = 0;

  constructor(options: DeliveryBufferOptions) {
    this.opts = {
      deliver: options.deliver,
      state: options.state,
      ...(options.resultFor !== undefined ? { resultFor: options.resultFor } : {}),
      now: options.now ?? (() => Date.now()),
      ...(options.onExpired !== undefined ? { onExpired: options.onExpired } : {}),
      maxHeld: options.maxHeld ?? DELIVERY_CAP,
      ttlMs: options.ttlMs ?? DELIVERY_TTL_MS,
    };
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  /**
   * A task finished. Delivers now if the channel is free, otherwise holds it
   * for the next drain. Synchronous and non-throwing: it is called from inside
   * the planner's completion path, where an exception would turn a successful
   * plan into a failed task.
   *
   * A held item arriving for a SUPERSEDED epoch is dropped at once rather than
   * buffered: the newer utterance already advanced the epoch, so the only thing
   * to do with this one is forget it.
   */
  offer(offer: {
    readonly taskId: string;
    readonly epoch: number;
    readonly result: TaskResult;
  }): DeliveryOutcome {
    if (offer.epoch > this.currentEpoch) this.currentEpoch = offer.epoch;
    if (offer.epoch < this.currentEpoch) {
      this.droppedCount += 1;
      return 'dropped';
    }
    const item: DeliveryItem = {
      taskId: offer.taskId,
      epoch: offer.epoch,
      result: offer.result,
      offeredAt: this.opts.now(),
    };
    if (channelFree(this.opts.state())) {
      this.opts.deliver(item);
      this.deliveredCount += 1;
      return 'delivered';
    }
    // Drop-OLDEST: the newest held item is the one the user is waiting on.
    // An unbounded buffer is the same defect as an unbounded replay buffer.
    while (this.items.length >= this.opts.maxHeld) {
      const oldest = this.items.shift();
      if (oldest === undefined) break;
      this.droppedCount += 1;
    }
    this.items.push(item);
    return 'buffered';
  }

  /**
   * Delivers the newest held item if the channel is now free. Returns how many
   * were delivered — 0 or 1, because the newest-wins coalescing means a drain
   * emits at most one item no matter how many accumulated.
   *
   * A held item whose epoch has been superseded is swept here as well as in
   * `offer`: the supersede can land while the item waits, which is exactly the
   * window the epoch check exists for.
   */
  drain(): number {
    if (this.items.length === 0) return 0;
    if (!channelFree(this.opts.state())) return 0;
    const now = this.opts.now();
    // Sweep first: an expired or superseded item must not be delivered just
    // because the channel happened to free at that moment.
    let newest: DeliveryItem | undefined;
    while (this.items.length > 0) {
      const item = this.items.shift();
      if (item === undefined) break;
      if (item.epoch < this.currentEpoch) {
        this.droppedCount += 1;
        continue;
      }
      if (now - item.offeredAt > this.opts.ttlMs) {
        this.droppedCount += 1;
        this.opts.onExpired?.(item);
        continue;
      }
      // Newest wins. Counted as COALESCED rather than dropped: these were
      // complete, unexpired results the user never saw, which is a different
      // failure from a buffer that overflowed or timed out.
      if (newest !== undefined) this.coalescedCount += 1;
      newest = item;
    }
    if (newest === undefined) return 0;
    this.opts.deliver(newest);
    this.deliveredCount += 1;
    return 1;
  }

  /**
   * Re-offers a completed task's immutable result WITHOUT re-planning.
   *
   * This is the FR-12 approval re-entry (A.15). The plan is already built and
   * frozen on the task record, and the user is approving THAT plan: re-running
   * the planner would spend a second free-tier call, re-derive the flags, and
   * can produce a different plan than the one the notice described — an approval
   * for something the user never saw.
   *
   * Returns `unknown` when no result is on record, so a caller cannot retry an
   * id that was never completed into something.
   */
  retry(taskId: string): DeliveryOutcome {
    const record = this.opts.resultFor?.(taskId);
    if (record === undefined) return 'unknown';
    this.retriedCount += 1;
    // Retried at the CURRENT epoch: the retry is a fresh delivery of an old
    // plan, and an old epoch would have it swept as superseded immediately.
    return this.offer({ taskId, epoch: this.currentEpoch, result: record });
  }

  /**
   * Cancels everything held at or below `epoch` and advances the clock, so a
   * later `offer`/`retry` for that epoch is refused. Returns how many were
   * cancelled — the count matters because a held FR-12 confirmation that
   * disappears silently reads as "the assistant forgot".
   */
  cancelEpoch(epoch: number): number {
    if (epoch > this.currentEpoch) this.currentEpoch = epoch;
    let count = 0;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      if (item === undefined || item.epoch > epoch) continue;
      this.items.splice(i, 1);
      // Supersede, not coalescing: the newer turn said the user has moved on.
      this.droppedCount += 1;
      count += 1;
    }
    return count;
  }

  list(): DeliveryItem[] {
    return [...this.items];
  }

  stats(): DeliveryStats {
    return {
      held: this.items.length,
      maxHeld: this.opts.maxHeld,
      delivered: this.deliveredCount,
      coalesced: this.coalescedCount,
      dropped: this.droppedCount,
      retried: this.retriedCount,
    };
  }
}

export type { TaskRecord, TaskResult };
