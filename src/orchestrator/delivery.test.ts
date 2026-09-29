import { describe, expect, test, vi } from 'vitest';
import {
  DELIVERY_CAP,
  DELIVERY_TTL_MS,
  DeliveryBuffer,
  channelFree,
  type DeliveryChannelState,
  type DeliveryItem,
} from './delivery.js';
import { TaskQueue, type TaskResult } from './task-queue.js';
import { UiCommandSchema } from '../ipc/protocol.js';
import { createCommandHandler } from './command-router.js';

// M2 Pattern 3 — completion ≠ delivery.
//
// The queue half (Pattern 1) proved that a task can finish while the speaker is
// still busy, and `daemon.ts` proved the consequence: a held FR-12 plan was
// announced with `ui.notice('plan-held', …)` from INSIDE the planner, so the
// one thing the user has to act on was delivered into a live utterance. This
// module is the missing half: a completion is not a delivery, and delivery
// happens on a quiet channel or not at all.
//
// DEPENDENCY RULE (same as `task-queue.ts`): standard library only, plus
// TYPE-only imports of the task shapes. A delivery buffer that imported the
// protocol or the coordinator would put the planner on every importer's graph.
//
// Every test names its break. A buffer test that cannot fail is decoration:
//   - coalesce count   → drop the newest-wins pick, assert the delivered set
//   - TTL expiry       → stop sweeping, assert the stale item is delivered
//   - epoch cancel     → drop `cancelEpoch`, assert the item still delivers
//   - retry            → make `retry` re-plan, assert the plan spy DID move
//   - playbackId       → drop the schema bound, assert the long id parses

const FREE: DeliveryChannelState = { speechLive: false, ttsPlaying: false, playbackReady: true };

function heldResult(flagged: readonly string[] = ['delete']): TaskResult {
  return { ok: true, receipt: null, needsConfirmation: true, flagged };
}

function busy(over: Partial<DeliveryChannelState> = {}): DeliveryChannelState {
  return { ...FREE, ...over };
}

/**
 * A channel the test drives in place. `DeliveryChannelState` is `readonly` — the
 * daemon builds a fresh object from live flags — so a test that has to flip the
 * channel mid-scenario needs its own mutable shape. The direction matters: a
 * writable type where production reads a readonly one can never UNDER-specify
 * the contract, and the mismatch would be a type error rather than a silent
 * loosening.
 */
interface MutableChannel {
  speechLive: boolean;
  ttsPlaying: boolean;
  playbackReady: boolean;
}

function mutableChannel(over: Partial<MutableChannel> = {}): MutableChannel {
  return { ...FREE, ...over };
}

/**
 * A buffer whose channel state the test drives in place, with a recorded
 * delivery log. The clock auto-advances by a second per call unless the test
 * pins `now`, because the TTL test needs a clock it owns and everything else
 * only needs time to move.
 */
function harness(state: MutableChannel = mutableChannel(), now?: () => number) {
  const delivered: DeliveryItem[] = [];
  let clock = 0;
  const pinned = now !== undefined;
  const time = (): number => (pinned ? (now as () => number)() : (clock += 1000));
  const buffer = new DeliveryBuffer({
    deliver: (item) => delivered.push(item),
    state: () => state,
    now: time,
  });
  return { buffer, delivered, state, time };
}

describe('M2-P3 channelFree', () => {
  test('free only when nothing is speaking, nothing is synthesising, and the shell can play', () => {
    expect(channelFree(FREE)).toBe(true);
    // The spec table, one row each. A notice delivered while the assistant is
    // mid-sentence is the defect this whole module exists to remove.
    expect(channelFree(busy({ speechLive: true }))).toBe(false);
    expect(channelFree(busy({ ttsPlaying: true }))).toBe(false);
    // `!playbackReady` blocks: a shell that has not confirmed playback started
    // cannot be assumed able to take the audio.
    expect(channelFree(busy({ playbackReady: false }))).toBe(false);
  });
});

describe('M2-P3 offer', () => {
  test('delivers immediately on a free channel, and buffers while any of the three is busy', () => {
    const st = mutableChannel();
    const { buffer, delivered } = harness(st);
    expect(buffer.offer({ taskId: 'task-1', epoch: 1, result: heldResult() })).toBe('delivered');
    expect(delivered.map((d) => d.taskId)).toEqual(['task-1']);
    expect(delivered[0]?.offeredAt).toBeGreaterThan(0);

    // The same offer on a busy channel holds instead of talking over the speech.
    st.speechLive = true;
    expect(buffer.offer({ taskId: 'task-2', epoch: 1, result: heldResult() })).toBe('buffered');
    expect(delivered.map((d) => d.taskId)).toEqual(['task-1']);
    expect(buffer.list().map((h) => h.taskId)).toEqual(['task-2']);
  });

  test('a busy channel buffers; the SAME offer on a free one does not', () => {
    for (const st of [busy({ speechLive: true }), busy({ ttsPlaying: true }), busy({ playbackReady: false })]) {
      // `busy()` rows are only ever READ here, never mutated — that is why they
      // can stay on the readonly production type.
      const { buffer, delivered } = harness(st);
      expect(buffer.offer({ taskId: 'task-x', epoch: 1, result: heldResult() }), JSON.stringify(st)).toBe('buffered');
      expect(delivered).toHaveLength(0);
    }
  });

  test('cap is 4 and overflow drops the OLDEST, because the newest is the live one', () => {
    const { buffer, delivered } = harness(mutableChannel({ speechLive: true }));
    for (let i = 1; i <= DELIVERY_CAP + 2; i += 1) {
      buffer.offer({ taskId: `task-${i}`, epoch: 1, result: heldResult() });
    }
    expect(DELIVERY_CAP).toBe(4);
    expect(buffer.list().map((h) => h.taskId)).toEqual(['task-3', 'task-4', 'task-5', 'task-6']);
    // Two were evicted, and eviction is counted rather than silent.
    expect(buffer.stats().dropped).toBe(2);
    expect(delivered).toHaveLength(0);
  });
});

describe('M2-P3 drain', () => {
  test('coalesces to the NEWEST and counts what it discarded', () => {
    const st = mutableChannel({ speechLive: true });
    const { buffer, delivered } = harness(st);
    for (const id of ['task-1', 'task-2', 'task-3']) {
      buffer.offer({ taskId: id, epoch: 1, result: heldResult() });
    }
    // Still busy: a drain must not push a notice into a live utterance.
    expect(buffer.drain()).toBe(0);
    expect(delivered).toHaveLength(0);

    // All three accumulate on the busy channel, THEN it frees.
    st.speechLive = false;
    expect(buffer.drain()).toBe(1);
    // BREAK: newest-wins. Delivering all three would put three confirmations in
    // front of the user, two of which are for turns they have already moved past.
    expect(delivered.map((d) => d.taskId)).toEqual(['task-3']);
    expect(buffer.stats().coalesced).toBe(2);
    expect(buffer.list()).toHaveLength(0);
    expect(delivered.map((d) => d.result.flagged?.[0])).toEqual(['delete']);
  });

  test('TTL 30s expires an undelivered item instead of delivering it late', () => {
    let t = 0;
    // Mutable on purpose: the item expires on TIME, not on the channel, and the
    // two must be separable — a test that only ever frees the channel proves
    // nothing about the TTL.
    const st = mutableChannel({ speechLive: true });
    const { buffer, delivered } = harness(st, () => t);
    buffer.offer({ taskId: 'task-old', epoch: 1, result: heldResult() });

    t = DELIVERY_TTL_MS - 1;
    expect(buffer.drain()).toBe(0); // channel still busy, and not expired yet
    expect(buffer.list()).toHaveLength(1);

    // The channel frees, and the item is now older than the TTL: a stale
    // "your plan is waiting for approval" notice is noise, not delivery.
    st.speechLive = false;
    t = DELIVERY_TTL_MS + 1;
    expect(buffer.drain()).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(buffer.list()).toHaveLength(0);
    expect(buffer.stats().dropped).toBe(1);
    expect(DELIVERY_TTL_MS).toBe(30_000);
  });

  test('TTL expiry calls onExpired, supersede does not', () => {
    // Peer review: a shell that never reports playback would otherwise hold a
    // confirmation until TTL silently dropped it. Expired holds end in a
    // terminal hook (the daemon notices); superseded ones stay silent (the
    // user moved on — a notice would confuse, not inform).
    // Break: remove the hook call → expired counter stays 0.
    let t = 0;
    const expired: string[] = [];
    const st = mutableChannel({ speechLive: true });
    const { buffer } = harness(st, () => t);
    const withHook = new DeliveryBuffer({
      deliver: () => undefined,
      state: () => st,
      now: () => t,
      onExpired: (item) => void expired.push(item.taskId),
    });
    withHook.offer({ taskId: 'task-old', epoch: 1, result: heldResult() });
    t = DELIVERY_TTL_MS + 1;
    st.speechLive = false;
    expect(withHook.drain()).toBe(0);
    expect(expired, 'an expired hold must surface, never vanish').toEqual(['task-old']);

    const expired2: string[] = [];
    const withHook2 = new DeliveryBuffer({
      deliver: () => undefined,
      state: () => mutableChannel(),
      now: () => 0,
      onExpired: (item) => void expired2.push(item.taskId),
    });
    withHook2.offer({ taskId: 'task-gone', epoch: 1, result: heldResult() });
    withHook2.cancelEpoch(2);
    expect(expired2, 'a superseded hold stays silent').toEqual([]);
  });

  test('cancelEpoch drops everything held at or below the epoch and refuses it later', () => {    const { buffer, delivered } = harness(mutableChannel({ speechLive: true }));
    buffer.offer({ taskId: 'task-1', epoch: 1, result: heldResult() });
    buffer.offer({ taskId: 'task-2', epoch: 2, result: heldResult() });

    // A new utterance supersedes the old turn: `cancelEpoch` is called with the
    // NEW epoch (the daemon bumps `voiceEpoch` first), so BOTH held items are at
    // or below it and neither may still be announced.
    expect(buffer.cancelEpoch(2)).toBe(2);
    expect(buffer.list()).toHaveLength(0);
    expect(buffer.epoch).toBe(2);

    // BREAK: without the epoch check a superseded plan would still be announced.
    // Epoch 1 is below the current 2, so it is refused outright.
    expect(buffer.offer({ taskId: 'task-1-again', epoch: 1, result: heldResult() })).toBe('dropped');
    expect(buffer.list()).toHaveLength(0);
    expect(buffer.drain()).toBe(0);
    expect(delivered).toHaveLength(0);

    // The NEW turn's own delivery at the current epoch is still accepted — the
    // cancel must not poison the epoch it just opened.
    buffer.offer({ taskId: 'task-3', epoch: 3, result: heldResult() });
    expect(buffer.list().map((h) => h.taskId)).toEqual(['task-3']);
    // Supersede is counted as a drop, not a coalesce: these were not replaced by
    // a newer delivery, they were invalidated by a newer TURN.
    expect(buffer.stats().coalesced).toBe(0);
    expect(buffer.stats().dropped).toBe(3);
  });
});

describe('M2-P3 retry', () => {
  test('re-offers the IMMUTABLE result without re-planning (BREAK: re-plan → plan spy moves)', async () => {
    const plan = vi.fn(async () => ({ ok: true, receipt: 'msg_1', needsConfirmation: false, flagged: [] as string[] }));
    const tasks = new TaskQueue({
      plan,
      enabled: true,
      // Not needed for this test, but the queue needs a clock seam it trusts.
      now: () => 1000,
    });
    const task = tasks.enqueue({ transcript: 'امسح الملفات', taskEn: 'Delete files', replyAr: 'تمام', epoch: 1 });
    await tasks.drain();
    expect(plan).toHaveBeenCalledTimes(1);
    const frozen = tasks.getResult(task.id);
    expect(frozen).toBeDefined();

    const delivered: DeliveryItem[] = [];
    const state = mutableChannel({ speechLive: true });
    const delivery = new DeliveryBuffer({
      deliver: (item) => delivered.push(item),
      state: () => state,
      resultFor: (id) => tasks.getResult(id),
    });

    expect(delivery.retry(task.id)).toBe('buffered');
    // THE POINT: the plan spy is unchanged. A re-plan spends a free-tier Inkling
    // call, re-decides the flags, and can produce a DIFFERENT plan than the one
    // the user is approving — the approval would then be for something else.
    expect(plan).toHaveBeenCalledTimes(1);
    expect(delivery.list()[0]?.result).toBe(frozen); // same frozen object, not a copy
    expect(delivery.stats().retried).toBe(1);

    state.speechLive = false;
    expect(delivery.drain()).toBe(1);
    expect(delivered[0]?.taskId).toBe(task.id);

    // An unknown id is refused rather than re-planned into existence.
    expect(delivery.retry('task-nope')).toBe('unknown');
    expect(plan).toHaveBeenCalledTimes(1);
  });
});

describe('M2-P3 playbackStarted command', () => {
  test('a bounded playbackId is accepted and acked ok', async () => {
    const parsed = UiCommandSchema.safeParse({ id: 'c1', kind: 'playbackStarted', playbackId: 'pb-7' });
    expect(parsed.success).toBe(true);

    const seen: Array<string | undefined> = [];
    const handler = createCommandHandler({
      client: {
        setSessionAgent: async () => ({}),
        setSessionModel: async () => ({}),
        toggleSessionSkill: async () => ({}),
        execSessionShell: async () => ({}),
      },
      switchSession: () => {},
      activeSessionId: () => undefined,
      projectDirectory: () => '.',
      onPlaybackStarted: (id) => seen.push(id),
    });
    const outcome = await handler(parsed.data!);
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(['pb-7']);
  });

  test('a bad playbackId is REJECTED by the schema before the daemon sees it', () => {
    // Over the 64-char bound.
    expect(UiCommandSchema.safeParse({ id: 'c1', kind: 'playbackStarted', playbackId: 'x'.repeat(65) }).success).toBe(false);
    // Wrong charset, empty, and control characters all fail for the same reason
    // the schema exists: this string is logged and correlated, not parsed.
    expect(UiCommandSchema.safeParse({ id: 'c1', kind: 'playbackStarted', playbackId: '' }).success).toBe(false);
    expect(UiCommandSchema.safeParse({ id: 'c1', kind: 'playbackStarted', playbackId: 'pb 7' }).success).toBe(false);
    // Absent is fine: the renderer may not correlate at all.
    expect(UiCommandSchema.safeParse({ id: 'c1', kind: 'playbackStarted' }).success).toBe(true);
  });

  test('an unrecognised playbackId never reaches onPlaybackStarted', async () => {
    const seen: Array<string | undefined> = [];
    const handler = createCommandHandler({
      client: {
        setSessionAgent: async () => ({}),
        setSessionModel: async () => ({}),
        toggleSessionSkill: async () => ({}),
        execSessionShell: async () => ({}),
      },
      switchSession: () => {},
      activeSessionId: () => undefined,
      projectDirectory: () => '.',
      onPlaybackStarted: (id) => seen.push(id),
    });
    // The daemon's real entrypoint parses before dispatching; a rejected parse
    // is an `error` frame, never a handler call. Simulated here by parsing.
    const parsed = UiCommandSchema.safeParse({ id: 'c2', kind: 'playbackStarted', playbackId: 'pb 7' });
    expect(parsed.success).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
