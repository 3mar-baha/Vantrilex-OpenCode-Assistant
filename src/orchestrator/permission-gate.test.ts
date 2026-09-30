import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Coordinator, type CoordinatorDeps } from './coordinator.js';

// PHASE B — contextual addressee + contextual permission.
//
// RED written before the gate existed. Most of these tests are about what does
// NOT happen, because that is the whole deliverable.
//
// (e), (g) and (h) are the ANTI-DEFECT tests. They are the ones a "works"
// implementation most often fails, and they were written first for that reason.

const PLAN_OK = JSON.stringify({
  steps: [{ id: 's1', kind: 'prompt', detail: 'Ask the session for its status' }],
});

/** The gate's strict-schema reply, with per-test overrides. */
function gateReply(fields: Record<string, unknown>): string {
  return JSON.stringify({
    addressed: true,
    needs_opencode: true,
    decision: 'ask_permission',
    ask_ar: 'أرسل برومبت لـ OpenCode؟',
    approves_id: '',
    reason_en: 'task',
    ...fields,
  });
}

const QUESTION = gateReply({ needs_opencode: false, decision: 'answer', ask_ar: '', reason_en: 'question' });
const ASK = gateReply({});
const SELF_TALK = gateReply({ addressed: false, decision: 'not_addressed', ask_ar: '' });
const UNDECIDED = gateReply({ decision: 'undecided', ask_ar: 'تحتاج إذن؟' });

interface Harness {
  readonly coordinator: Coordinator;
  /** Every handoff text handed to `deps.dispatch`, i.e. every OpenCode prompt. */
  readonly dispatched: string[];
  readonly asked: Array<{ taskEn: string; askAr: string; id: string }>;
  /** Model calls that reached the PLANNER. A gated turn must not. */
  readonly plans: number[];
  /** `deps.dispatch` invocations that reached the body (throws still count). */
  dispatchAttempts: number;
}

interface HarnessOpts {
  /** Intake reply for turn N. */
  intake?: (turn: number) => string;
  /** Gate reply for turn N. `pendingId` is whatever the previous ask opened with. */
  gate?: (turn: number, pendingId: string) => string;
  plan?: string;
  dispatch?: (text: string) => Promise<{ receipt: string }>;
  activeSessionId?: () => ReturnType<CoordinatorDeps['activeSessionId']>;
  now?: () => number;
  permissionTtlMs?: number;
}

/**
 * Routes `deps.chat` by SYSTEM prompt rather than by call order: intake, the
 * addressee gate and the planner each have a distinct system string, so a test
 * stays readable when a call is skipped (which is most of them).
 */
function harness(opts: HarnessOpts = {}): Harness {
  const dispatched: string[] = [];
  const asked: Array<{ taskEn: string; askAr: string; id: string }> = [];
  const plans: number[] = [];
  let intakeTurn = 0;
  let gateTurn = 0;
  let lastPendingId = '';
  let dispatchAttempts = 0;

  const deps: CoordinatorDeps = {
    chat: async (_model, system) => {
      if (system.includes('split them into two fields')) {
        const n = intakeTurn;
        intakeTurn += 1;
        return opts.intake?.(n) ?? JSON.stringify({ reply_ar: 'بجيك', task_en: `task ${n}` });
      }
      if (system.includes('addressed')) {
        const n = gateTurn;
        gateTurn += 1;
        return opts.gate?.(n, lastPendingId) ?? ASK;
      }
      plans.push(1);
      return opts.plan ?? PLAN_OK;
    },
    dispatch: async (text) => {
      dispatchAttempts += 1;
      dispatched.push(text);
      return opts.dispatch ? await opts.dispatch(text) : { receipt: `r${dispatched.length}` };
    },
    activeSessionId: opts.activeSessionId ?? (() => 'ses_a' as never),
    onPermissionRequired: (p) => {
      lastPendingId = p.id;
      asked.push({ taskEn: p.taskEn, askAr: p.askAr, id: p.id });
    },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.permissionTtlMs !== undefined ? { permissionTtlMs: opts.permissionTtlMs } : {}),
  };
  return {
    coordinator: new Coordinator(deps),
    dispatched,
    asked,
    plans,
    get dispatchAttempts(): number {
      return dispatchAttempts;
    },
  };
}

/** Intake that turns 0 is the task, turn 1+ is the approval/denial. */
function twoTurnIntake(aTask: string, anAnswer = 'نعم'): (turn: number) => string {
  return (turn) => JSON.stringify({ reply_ar: 'تمام', task_en: turn === 0 ? aTask : anAnswer });
}

describe('B(d) — a question is answered VERBALLY and dispatches nothing', () => {
  test('no dispatch, and no planning call either', async () => {
    const h = harness({ gate: () => QUESTION });
    const result = await h.coordinator.plan(await h.coordinator.intake('شو رأيك؟'));
    expect(h.dispatched, 'a question must never reach OpenCode').toEqual([]);
    expect(h.plans, 'and must not even spend a planning call on it').toEqual([]);
    expect(result.receipt).toBeNull();
    // These two are what separate "answered" from "asked", and both dispatch
    // nothing. Without them this test passes on an implementation that asked
    // permission for every question — the fourth break-guard of this phase.
    expect(result.detail).toContain('answered-verbally');
    expect(result.needsPermission, 'a question is not a permission request').not.toBe(true);
  });

  test('the verbal answer is the line intake already produced, and it survives', async () => {
    const h = harness({ gate: () => QUESTION });
    const ack = await h.coordinator.intake('شو رأيك؟');
    const result = await h.coordinator.plan(ack);
    expect(result.replyAr).toBe(ack.replyAr);
    expect(result.detail).toContain('answered-verbally');
  });

  test('no permission is opened for a question — asking would be noise', async () => {
    const h = harness({ gate: () => QUESTION });
    await h.coordinator.plan(await h.coordinator.intake('شو رأيك؟'));
    expect(h.asked).toEqual([]);
  });
});

describe('B(e) — a task ASKS and dispatches NOTHING on that turn  [ANTI-DEFECT]', () => {
  test('the turn that raises the ask sends no prompt to OpenCode', async () => {
    const h = harness({ gate: () => ASK });
    const result = await h.coordinator.plan(await h.coordinator.intake('افتح لي الجلسة'));
    expect(h.dispatched, 'this is the defect this test exists to catch').toEqual([]);
    expect(h.plans).toEqual([]);
    expect(h.dispatchAttempts).toBe(0);
    expect(result.needsPermission).toBe(true);
  });

  test('the ask is raised in the assistant\'s own words, bound to the action', async () => {
    const h = harness({ gate: () => ASK });
    const ack = await h.coordinator.intake('افتح لي الجلسة');
    await h.coordinator.plan(ack);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.askAr).toBe('أرسل برومبت لـ OpenCode؟');
    expect(h.asked[0]?.taskEn).toBe(ack.taskEn);
    expect(h.asked[0]?.id).not.toBe('');
  });

  test('the result claims no success and holds no receipt', async () => {
    const h = harness({ gate: () => ASK });
    const result = await h.coordinator.plan(await h.coordinator.intake('افتح لي الجلسة'));
    expect(result.receipt).toBeNull();
    expect(result.ok).toBe(false);
  });
});

describe('B(f) — approval executes EXACTLY the approved action', () => {
  test('the pending task is dispatched once the approval names its id', async () => {
    let pending = '';
    const h = harness({
      intake: twoTurnIntake('ASKED: list sessions'),
      gate: (turn, id) => (turn === 0 ? ASK : gateReply({ decision: 'approve', approves_id: id })),
    });
    void pending;
    await h.coordinator.plan(await h.coordinator.intake('اعمل list sessions'));
    pending = h.asked[0]?.id ?? '';
    expect(pending, 'the ask carries an id to approve').not.toBe('');

    const result = await h.coordinator.plan(await h.coordinator.intake('ايه هات'));
    expect(h.dispatched).toHaveLength(1);
    expect(result.receipt).toBe('r1');
  });

  test('the dispatched text is the PENDING task, not the approval utterance', async () => {
    const h = harness({
      intake: twoTurnIntake('LIST THE SESSIONS'),
      gate: (turn, id) => (turn === 0 ? ASK : gateReply({ decision: 'approve', approves_id: id })),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل list sessions'));
    await h.coordinator.plan(await h.coordinator.intake('نعم'));
    expect(h.dispatched.join('\n')).toContain('LIST THE SESSIONS');
    expect(h.dispatched.join('\n')).not.toContain('نعم');
  });

  test('a denial executes nothing and closes the ask', async () => {
    const h = harness({
      intake: twoTurnIntake('TASK-A', 'لا'),
      gate: (turn) => (turn === 0 ? ASK : gateReply({ decision: 'deny' })),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    const result = await h.coordinator.plan(await h.coordinator.intake('لا'));
    expect(h.dispatched).toEqual([]);
    expect(result.detail).toContain('permission-denied');
  });
});

describe('B(g) — an earlier approval does NOT authorise a later different action  [ANTI-DEFECT]', () => {
  test('after approving A, a NEW task B is asked about again, not executed', async () => {
    const h = harness({
      intake: (turn) =>
        JSON.stringify({ reply_ar: 'تمام', task_en: turn === 0 ? 'TASK-A' : turn === 1 ? 'نعم' : 'TASK-B' }),
      gate: (turn, id) => (turn === 1 ? gateReply({ decision: 'approve', approves_id: id }) : ASK),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    await h.coordinator.plan(await h.coordinator.intake('نعم'));
    expect(h.dispatched.join('\n')).toContain('TASK-A');

    // The approval is SPENT. B is a different action.
    await h.coordinator.plan(await h.coordinator.intake('اعمل B'));
    expect(h.dispatched.join('\n'), 'B must not ride on A\'s approval').not.toContain('TASK-B');
    expect(h.asked.length, 'B raised its own ask').toBe(2);
  });

  test('an approval naming the WRONG id executes nothing', async () => {
    const h = harness({
      intake: twoTurnIntake('TASK-A'),
      gate: (turn) => (turn === 0 ? ASK : gateReply({ decision: 'approve', approves_id: 'some-other-id' })),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    await h.coordinator.plan(await h.coordinator.intake('نعم'));
    expect(h.dispatched).toEqual([]);
  });

  test('the same approval turn replayed does not dispatch twice', async () => {
    // The gate fake approves WHATEVER id is pending, on every turn. A fake that
    // only approved on turn 1 would let this pass on its own turn-counter even
    // if `consume` never deleted anything — which is exactly what the first
    // break-guard of this case proved.
    const h = harness({
      intake: twoTurnIntake('TASK-A'),
      gate: (_turn, id) => gateReply({ decision: 'approve', approves_id: id }),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    const approvalTurn = await h.coordinator.intake('نعم');
    await h.coordinator.plan(approvalTurn);
    await h.coordinator.plan(approvalTurn);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatchAttempts).toBe(1);
  });

  test('an EXPIRED ask cannot be approved, even by a correct id', async () => {
    let clock = 1_000;
    const h = harness({
      intake: twoTurnIntake('TASK-A'),
      gate: (turn, id) => (turn === 0 ? ASK : gateReply({ decision: 'approve', approves_id: id })),
      now: () => clock,
      permissionTtlMs: 30_000,
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    clock += 60_000;
    await h.coordinator.plan(await h.coordinator.intake('نعم'));
    expect(h.dispatched).toEqual([]);
  });

  test('a still-valid ask IS approved by a correct id (the control for the expiry test)', async () => {
    let clock = 1_000;
    const h = harness({
      intake: twoTurnIntake('TASK-A'),
      gate: (turn, id) => (turn === 0 ? ASK : gateReply({ decision: 'approve', approves_id: id })),
      now: () => clock,
      permissionTtlMs: 30_000,
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    clock += 1_000;
    await h.coordinator.plan(await h.coordinator.intake('نعم'));
    expect(h.dispatched).toHaveLength(1);
  });
});

describe('B(h) — a crash after permission does NOT execute  [ANTI-DEFECT]', () => {
  test('a dispatch that throws leaves nothing replayable', async () => {
    // Same always-approve fake as the replay test: the point is that the SECOND
    // `plan()` finds an empty slot, not that the fake stopped approving.
    const h = harness({
      intake: twoTurnIntake('TASK-A'),
      gate: (_turn, id) => gateReply({ decision: 'approve', approves_id: id }),
      dispatch: async () => {
        throw new Error('opencode 4096 refused the connection');
      },
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    const approvalTurn = await h.coordinator.intake('نعم');

    // The crash must SURFACE, not be swallowed into a silent success.
    await expect(h.coordinator.plan(approvalTurn)).rejects.toThrow(/4096/);

    // The approval was consumed BEFORE the dispatch. Retrying the identical
    // turn must not fire a second prompt — that is a half-applied permission.
    await h.coordinator.plan(approvalTurn).catch(() => undefined);
    expect(h.dispatchAttempts).toBe(1);
  });

  test('after a crash the next turn re-asks rather than resuming the dead permission', async () => {
    const h = harness({
      intake: (turn) =>
        JSON.stringify({ reply_ar: 'تمام', task_en: turn === 0 ? 'TASK-A' : turn === 1 ? 'نعم' : 'TASK-B' }),
      gate: (turn, id) => (turn === 1 ? gateReply({ decision: 'approve', approves_id: id }) : ASK),
      dispatch: async () => {
        throw new Error('opencode down');
      },
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    await h.coordinator.plan(await h.coordinator.intake('نعم')).catch(() => undefined);
    await h.coordinator.plan(await h.coordinator.intake('اعمل B')).catch(() => undefined);
    expect(h.asked.length, 'B opened a fresh ask').toBe(2);
    expect(h.dispatchAttempts, 'only the approved-and-attempted dispatch ran').toBe(1);
  });

  test('a denial consumes the ask, so a later approval of the same id is dead', async () => {
    const h = harness({
      intake: twoTurnIntake('TASK-A', 'لا'),
      gate: (turn) => (turn === 0 ? ASK : gateReply({ decision: 'deny' })),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    await h.coordinator.plan(await h.coordinator.intake('لا'));
    expect(h.dispatched).toEqual([]);
    // …and a fresh ask gets a DIFFERENT id, so the stale one cannot be reused.
    await h.coordinator.plan(await h.coordinator.intake('اعمل A مرة ثانية'));
    expect(h.asked[0]?.id).not.toBe(h.asked[1]?.id);
  });
});

describe('B — FAIL CLOSED on every undecidable path', () => {
  test('a gate call that throws asks; it never proceeds', async () => {
    const h = harness({
      gate: () => {
        throw new Error('openrouter 500');
      },
    });
    const result = await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    expect(h.dispatched).toEqual([]);
    expect(result.needsPermission).toBe(true);
  });

  test('an unparseable gate reply is `undecided`, which asks', async () => {
    const h = harness({ gate: () => 'I think you should probably just do it' });
    const result = await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    expect(h.dispatched).toEqual([]);
    expect(result.needsPermission).toBe(true);
  });

  test('the model asking for permission is never itself permission', async () => {
    const h = harness({ gate: () => ASK });
    const ack = await h.coordinator.intake('اعمل A');
    await h.coordinator.plan(ack);
    await h.coordinator.plan(ack);
    expect(h.dispatched).toEqual([]);
  });

  test('`undecided` asks rather than answering silently', async () => {
    const h = harness({ gate: () => UNDECIDED });
    const result = await h.coordinator.plan(await h.coordinator.intake('ما رأيك؟'));
    expect(h.dispatched).toEqual([]);
    expect(result.needsPermission).toBe(true);
  });

  test('not-addressed (self-talk) neither answers nor asks, and dispatches nothing', async () => {
    const h = harness({ gate: () => SELF_TALK });
    const result = await h.coordinator.plan(await h.coordinator.intake('.grrr brb'));
    expect(h.dispatched).toEqual([]);
    expect(h.asked).toEqual([]);
    // Absent means false, matching `needsConfirmation` — the same optional
    // contract the daemon already adapts.
    expect(result.needsPermission).not.toBe(true);
    expect(result.detail).toContain('not-addressed');
  });

  test('an approval with no pending ask at all is refused', async () => {
    const h = harness({ gate: () => gateReply({ decision: 'approve', approves_id: 'anything' }) });
    const result = await h.coordinator.plan(await h.coordinator.intake('نعم لحاله؟'));
    expect(h.dispatched).toEqual([]);
    expect(result.needsPermission).toBe(true);
  });
});

describe('B — the gate sits on the only egress to OpenCode', () => {
  test('exactly one `deps.dispatch` call exists in the coordinator', () => {
    // Structural rather than behavioural: the guarantee is that there is ONE
    // door to OpenCode and the gate is immediately in front of it. A second
    // `dispatch` call added anywhere in this file is an ungated egress.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'coordinator.ts'), 'utf8');
    expect(source.match(/this\.deps\.dispatch\(/g) ?? []).toHaveLength(1);
  });

  test('the FR-12 destructive hold is STILL enforced behind the new gate', async () => {
    // The new gate is STRICTLY BROADER, not a replacement: a destructive plan
    // still needs its own confirmation even after the user approves.
    const h = harness({
      intake: twoTurnIntake('destroy the database'),
      gate: (turn, id) => (turn === 0 ? ASK : gateReply({ decision: 'approve', approves_id: id })),
      plan: JSON.stringify({ steps: [{ id: 's1', kind: 'shell', detail: 'delete everything' }] }),
    });
    await h.coordinator.plan(await h.coordinator.intake('اعمل A'));
    const result = await h.coordinator.plan(await h.coordinator.intake('نعم'));
    expect(h.dispatched, 'FR-12 still holds a destructive step after approval').toEqual([]);
    expect(result.needsConfirmation).toBe(true);
  });
});
