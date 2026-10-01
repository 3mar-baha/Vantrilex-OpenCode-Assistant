import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

import { ADDRESSEE_RESPONSE_FORMAT, type AddresseeVerdict } from '../orchestrator/permission.js';
import { OrchestratorError } from '../common/errors.js';
import { COORDINATOR_MODEL, INTAKE_MODEL, type ChatFn } from '../orchestrator/coordinator.js';
import type { SessionId } from '../common/brands.js';
import {
  HeadlessBrain,
  assertGateInvariant,
  checkRuntimeInvariant,
  measureGateInvariant,
  readCoordinatorSource,
  type DispatchRecord,
} from './turn.js';

// THE GATE INVARIANT — measured from the real file, and broken on purpose.
//
// This suite is the guard for the number the `gate` subcommand prints. Every test
// here has been run against a deliberately broken INPUT as well as the real one,
// because a guard that has only ever seen a passing file has not been shown to
// detect anything. The break cases are inline and mechanical: a source string with
// a second proceed, or a dispatch ledger with an extra entry.

const here = dirname(fileURLToPath(import.meta.url));
const realPath = resolve(here, '..', 'orchestrator', 'coordinator.ts');
const realSource = readFileSync(realPath, 'utf8');

function verdict(decision: AddresseeVerdict['decision']): AddresseeVerdict {
  return { decision, addressed: true, askAr: '', approvesId: '', reasonEn: 'test fixture' };
}

function delivered(text = 'handoff'): DispatchRecord {
  return { text, receipt: 'msg_1', state: 'running', ms: 5, delivered: true, failure: null };
}

describe('the structural invariant, counted from coordinator.ts source', () => {
  test('the shipped file satisfies all three counts', () => {
    const measured = measureGateInvariant(realSource, realPath);
    // Printed so a failure names the file and the numbers, not just "expected 1".
    expect(measured.failures, measured.file).toEqual([]);
    expect(measured.ok).toBe(true);
    expect(measured.counts.map((c) => [c.label, c.count])).toEqual([
      ["return { kind: 'proceed'", 1],
      ['this.deps.dispatch(', 1],
      ['this.permission.consume(', 1],
    ]);
  });

  test('the naive substring count is 2, and that is why the anchored pattern is used', () => {
    // This is the number a reader gets from grepping the file. It is published as
    // `naiveProceedMentions` precisely so nobody has to guess which count is
    // load-bearing: 1 is the returned value, the other is the type member in
    // `gate()`'s return annotation.
    const measured = measureGateInvariant(realSource, realPath);
    expect(measured.naiveProceedMentions).toBe(2);
    expect(measured.counts[0]?.count).toBe(1);
  });

  test('BREAK: a second `return { kind: \'proceed\'` is detected', () => {
    // The injection is the whole point of this test, so its landing is asserted
    // before the measurement is trusted. A break that silently failed to change
    // the input would pass the same assertion as a real break.
    const broken = realSource.replace(
      "return { kind: 'proceed', taskEn: consumed.taskEn };",
      "return { kind: 'proceed', taskEn: consumed.taskEn };\n      return { kind: 'proceed', taskEn: opts.taskEn };",
    );
    expect(broken, 'injection must actually modify the source').not.toBe(realSource);
    expect(broken.match(/return \{ kind: 'proceed'/g) ?? []).toHaveLength(2);

    const measured = measureGateInvariant(broken, 'broken-coordinator.ts');
    expect(measured.ok).toBe(false);
    expect(measured.counts[0]?.count).toBe(2);
    expect(measured.failures.join(' ')).toContain("return { kind: 'proceed': 2");
    // The type annotation must NOT be what trips it, or the guard is measuring
    // the wrong thing: the naive count rises to 3 while the anchored one to 2.
    expect(measured.naiveProceedMentions).toBe(3);
  });

  test('BREAK: a second dispatch call site is detected', () => {
    const broken = realSource.replace(
      'const { receipt } = await this.deps.dispatch(',
      'const { receipt } = await this.deps.dispatch(',
    );
    // Anchor on something that exists, so the replacement cannot no-op.
    const twice = broken.replace(
      '  async plan(',
      '  private async extraDispatch(): Promise<void> { await this.deps.dispatch("x"); }\n\n  async plan(',
    );
    expect(twice, 'injection must actually modify the source').not.toBe(realSource);
    expect(twice.match(/this\.deps\.dispatch\(/g) ?? []).toHaveLength(2);

    const measured = measureGateInvariant(twice, 'broken-coordinator.ts');
    expect(measured.ok).toBe(false);
    expect(measured.counts[1]?.count).toBe(2);
    expect(measured.failures.join(' ')).toContain('this.deps.dispatch(: 2');
  });

  test('BREAK: a second consume() read is detected', () => {
    // Anchored on a string that is verified to exist by the assertion below. An
    // earlier revision of this test anchored on a comment from `permission.ts`
    // rather than `coordinator.ts`, the `replace` silently matched nothing, and
    // the injection "landed" as an unchanged string — a break that would have
    // passed identically with and without a guard.
    const anchor = '    this.permission = new PermissionSlot({';
    expect(realSource, 'the anchor must exist in the file under test').toContain(anchor);
    const broken = realSource.replace(
      anchor,
      '    private peek(): PendingPermission | null { return this.permission.consume("x"); }\n' + anchor,
    );
    expect(broken, 'injection must actually modify the source').not.toBe(realSource);
    expect(broken.match(/this\.permission\.consume\(/g) ?? []).toHaveLength(2);

    const measured = measureGateInvariant(broken, 'broken-coordinator.ts');
    expect(measured.ok).toBe(false);
    expect(measured.counts[2]?.count).toBe(2);
    expect(measured.failures.join(' ')).toContain('this.permission.consume(: 2');
  });

  test('an empty source fails every count rather than passing vacuously', () => {
    const measured = measureGateInvariant('', 'empty.ts');
    expect(measured.ok).toBe(false);
    expect(measured.failures).toHaveLength(3);
  });
});

describe('reading the real source file', () => {
  test('readCoordinatorSource finds coordinator.ts from this module', () => {
    const { path, source } = readCoordinatorSource();
    expect(path.endsWith('coordinator.ts'), path).toBe(true);
    expect(source).toBe(readFileSync(resolve(here, '..', 'orchestrator', 'coordinator.ts'), 'utf8'));
  });

  test('BREAK: an unresolvable start path THROWS instead of defaulting to 1', () => {
    // The failure mode this guards: a source-measured invariant that falls back to
    // a hard-coded count when the file cannot be read. That number would be
    // correct by construction and therefore worth nothing.
    // A REAL absolute path OUTSIDE the repository, so the walk genuinely reaches
    // the filesystem root without finding the file. Two weaker breaks were tried
    // first and both are wrong for this assertion: a malformed URL is rejected by
    // `fileURLToPath` before the walk starts, and a non-existent directory INSIDE
    // the repo still walks UP into it and succeeds — which is the function working,
    // not the guard failing.
    const outside = join(tmpdir(), 'voxaura-no-such-tree', 'deep');
    expect(() => readCoordinatorSource(pathToFileURL(join(outside, 'turn.js')).href)).toThrow(/coordinator\.ts not found/);
  });

  test('a path inside the repo but not yet built still resolves — the walk goes up', () => {
    // The positive half of the same behaviour, and the reason the walk exists: the
    // module runs from `src/cli/` under Vitest and `dist/cli/` after a build, two
    // different depths, and a hard-coded `../..` is correct for exactly one.
    const underSrc = pathToFileURL(join(here, 'turn.ts')).href;
    expect(readCoordinatorSource(underSrc).path.endsWith('coordinator.ts')).toBe(true);
  });

  test('assertGateInvariant agrees with measureGateInvariant on the real file', () => {
    const asserted = assertGateInvariant();
    const measured = measureGateInvariant(realSource, realPath);
    expect(asserted.ok).toBe(measured.ok);
    expect(asserted.counts.map((c) => c.count)).toEqual(measured.counts.map((c) => c.count));
  });
});

describe('the runtime invariant', () => {
  test('a dispatch with no approving verdict is a violation', () => {
    // The case a source count cannot catch: one proceed line, reached anyway.
    const result = checkRuntimeInvariant({
      dispatches: [delivered()],
      gateVerdicts: [verdict('answer')],
      slotAfter: null,
      slotEverOpened: false,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toContain('without an `approve` verdict');
  });

  test('two dispatch attempts in one run is a violation', () => {
    const result = checkRuntimeInvariant({
      dispatches: [delivered('a'), delivered('b')],
      gateVerdicts: [verdict('approve')],
      slotAfter: null,
      slotEverOpened: true,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toContain('single-dispatch invariant');
  });

  test('an open slot beside a delivered dispatch is a violation', () => {
    // `consume()` deletes before it returns; a live slot afterwards would mean a
    // permission survived its own use.
    const result = checkRuntimeInvariant({
      dispatches: [delivered()],
      gateVerdicts: [verdict('approve')],
      slotAfter: { id: 'p1', taskEn: 't', sessionId: 'ses_1', askAr: '', openedAt: 0 },
      slotEverOpened: true,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(' ')).toContain('still open after a delivered dispatch');
  });

  test('an approve with no dispatch is NOT a violation — that is the fail-closed path', () => {
    // The mirror case, and the one most likely to be "fixed" wrongly. An
    // `approval-unbound` re-ask (`coordinator.ts:427-431`) produces exactly this
    // ledger, and calling it a violation would punish the product for refusing.
    const result = checkRuntimeInvariant({
      dispatches: [],
      gateVerdicts: [verdict('approve')],
      slotAfter: { id: 'p1', taskEn: 't', sessionId: 'ses_1', askAr: '', openedAt: 0 },
      slotEverOpened: true,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(0);
    expect(result.slotAfter).toBe('open');
  });

  test('the clean authorised path passes', () => {
    const result = checkRuntimeInvariant({
      dispatches: [delivered()],
      gateVerdicts: [verdict('ask_permission'), verdict('approve')],
      slotAfter: null,
      slotEverOpened: true,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.gateDecisions).toEqual(['ask_permission', 'approve']);
    expect(result.slotAfter).toBe('empty');
  });

  test('a no-gate-call turn is recorded as such rather than as a refusal', () => {
    const result = checkRuntimeInvariant({
      dispatches: [],
      gateVerdicts: [null],
      slotAfter: null,
      slotEverOpened: false,
    });
    expect(result.gateDecisions).toEqual(['no-gate-call']);
    expect(result.slotAfter).toBe('none-observed');
    expect(result.ok).toBe(true);
  });
});

describe('the instrumented chain, driven with no network and no key', () => {
  /** A chat that answers each stage from the product's own schema shapes. */
  function fakeChat(replies: {
    intake?: string;
    gate?: string | (() => string);
    plan?: string;
  }): ChatFn {
    // Answers by SHAPE, not by model — the same rule `turn.ts` classifies by, and
    // the reason it can: with two slots on one slug there is nothing else to key
    // on. A fixture that switched on `model` could not tell these legs apart.
    return async (_model, _system, _user, options) => {
      if (options?.responseFormat === ADDRESSEE_RESPONSE_FORMAT) {
        return typeof replies.gate === 'function' ? replies.gate() : (replies.gate ?? '{}');
      }
      if (options?.responseFormat !== undefined) {
        // A VALID one-step plan by default. `'{"steps":[]}'` would look like a
        // pass and would not be: `PlanSchema` requires at least one step, so an
        // empty array is `plan-invalid` and the turn ends before the dispatch. A
        // fixture that silently stops the chain two stages early makes every
        // downstream assertion untestable.
        return replies.plan ?? '{"steps":[{"id":"s1","kind":"prompt","detail":"read the repo"}]}';
      }
      return replies.intake ?? '{"reply_ar":"تمام","task_en":"do the thing"}';
    };
  }

  const SES_1 = 'ses_1' as SessionId;

  test('an ask_permission verdict dispatches NOTHING', async () => {
    // The single most important line in this file's purpose: a gate that asks must
    // produce zero dispatches, and the trace must say so.
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({
          addressed: true,
          needs_opencode: true,
          decision: 'ask_permission',
          ask_ar: 'بدي أبعت للـ OpenCode؟',
          approves_id: '',
          reason_en: 'needs OpenCode',
        }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'should-never-happen', state: 'running' }),
    });
    const trace = await brain.turn('شوف لي الجلسات');
    expect(trace.dispatches).toHaveLength(0);
    expect(trace.result.needsPermission).toBe(true);
    expect(trace.gateVerdict?.decision).toBe('ask_permission');
    expect(trace.openedAsk).not.toBeNull();
  });

  test('an approve naming a live slot dispatches exactly once, and the slot is gone', async () => {
    const holder: { brain: HeadlessBrain | null } = { brain: null };
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: () => {
          const id = holder.brain?.pendingPermission?.id ?? '';
          return JSON.stringify({
            addressed: true,
            needs_opencode: true,
            decision: 'approve',
            ask_ar: '',
            approves_id: id,
            reason_en: 'approving the shown action',
          });
        },
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'msg_ok', state: 'running' }),
    });
    holder.brain = brain;
    const first = await brain.turn('شوف لي الجلسات');
    expect(first.dispatches).toHaveLength(0);
    const second = await brain.turn('اي هلا سويت');
    expect(second.dispatches).toHaveLength(1);
    expect(second.dispatches[0]?.delivered).toBe(true);
    expect(brain.pendingPermission).toBeNull();
    expect(brain.slotEverOpened).toBe(true);
    const runtime = checkRuntimeInvariant({
      dispatches: brain.ledger.dispatches,
      gateVerdicts: [first.gateVerdict, second.gateVerdict],
      slotAfter: brain.pendingPermission,
      slotEverOpened: brain.slotEverOpened,
    });
    expect(runtime.ok, runtime.violations.join('; ')).toBe(true);
  });

  test('an approve with a STALE id dispatches nothing and re-asks', async () => {
    // The fail-closed case. `PermissionSlot.consume()` compares for exact
    // equality, so a wrong id authorises nothing — and the trace must report a
    // re-ask rather than the dispatch it did not get.
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({
          addressed: true,
          needs_opencode: true,
          decision: 'approve',
          ask_ar: 'ثانية؟',
          approves_id: 'a0000000-0000-4000-8000-000000000000',
          reason_en: 'approving something that was never shown',
        }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'should-never-happen', state: 'running' }),
    });
    const trace = await brain.turn('اي هلا سويت');
    expect(trace.dispatches).toHaveLength(0);
    expect(trace.result.detail).toBe('approval-unbound');
    expect(trace.result.needsPermission).toBe(true);
  });

  test('a throwing dispatch is RECORDED as undelivered, never as a success', async () => {
    // One brain, two turns: turn 1 opens the slot, turn 2 approves it by name and
    // the dispatch closure throws. An earlier revision of this test built two
    // separate brains and asserted on the first, which read as covering the case
    // and did not — the first brain never reaches a dispatch at all.
    const holder: { brain: HeadlessBrain | null } = { brain: null };
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: () =>
          JSON.stringify({
            addressed: true,
            needs_opencode: true,
            decision: holder.brain?.pendingPermission === null ? 'ask_permission' : 'approve',
            ask_ar: holder.brain?.pendingPermission === null ? 'بدي أبعت للـ OpenCode؟' : '',
            approves_id: holder.brain?.pendingPermission?.id ?? '',
            reason_en: 'fixture',
          }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => {
        throw new OrchestratorError('SERVE_UNREACHABLE', true, 'session.prompt failed with HTTP 400');
      },
    });
    holder.brain = brain;

    const ask = await brain.turn('شوف لي الجلسات');
    expect(ask.dispatches, 'the asking turn must dispatch nothing').toHaveLength(0);
    expect(ask.openedAsk, 'the asking turn must open a slot').not.toBeNull();

    // `plan()` propagates the dispatch throw. `turn()` catches it so the CLI
    // reports a failed dispatch instead of dying with a stack trace — the
    // behaviour that was actually observed against a live serve rejecting the
    // prompt body with HTTP 400.
    const approve = await brain.turn('اي هلا سويت');
    expect(approve.dispatchError).toBe('SERVE_UNREACHABLE: session.prompt failed with HTTP 400');
    expect(approve.result.ok).toBe(false);
    expect(approve.result.detail).toBe('dispatch-failed');
    expect(approve.dispatches).toHaveLength(1);
    expect(approve.dispatches[0]?.delivered).toBe(false);
    expect(approve.dispatches[0]?.receipt).toBeNull();
    expect(brain.ledger.dispatches[0]?.failure).toContain('HTTP 400');
    // The plan was built and is recovered from the ledger, validated through
    // `PlanSchema` — so the report can show what WOULD have been sent without
    // claiming it was.
    expect(approve.plan?.steps).toHaveLength(1);
    expect(approve.result.plan?.steps).toHaveLength(1);
    // The gate authorised this. Saying "refused" would be the lie this case exists
    // to prevent.
    expect(approve.gateVerdict?.decision).toBe('approve');
    // The slot is consumed even though the dispatch failed: `consume()` deletes
    // before it returns (`permission.ts:361-367`), so a failed turn leaves nothing
    // to retry with. That is the fail-closed direction and it is worth pinning.
    expect(brain.pendingPermission).toBeNull();
  });

  test('a turn that never dispatched has NO dispatchError', async () => {
    // The mirror, so `dispatchError !== null` cannot become a routine decoration
    // on a refusal.
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({ addressed: true, needs_opencode: true, decision: 'ask_permission', ask_ar: 'نمشي؟', approves_id: '', reason_en: 'needs opencode' }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'nope', state: 'running' }),
    });
    const trace = await brain.turn('شوف لي الجلسات');
    expect(trace.dispatchError).toBeNull();
    expect(trace.result.detail).toBe('permission-required');
  });

  test('a gate transport failure is recorded AND the coordinator still asks', async () => {
    // `gate()` catches a throw and asks with a fixed line (`coordinator.ts:398`).
    // The ledger has to show the failure, because "the gate asked" and "the gate
    // was reachable" are different facts.
    const brain = new HeadlessBrain({
      chat: async (_model, _system, _user, options) => {
        if (options?.responseFormat === ADDRESSEE_RESPONSE_FORMAT) throw new Error('BRAIN_TIMEOUT');
        return '{"reply_ar":"تمام","task_en":"t"}';
      },
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'nope', state: 'running' }),
    });
    const trace = await brain.turn('شوف لي الجلسات');
    expect(trace.dispatches).toHaveLength(0);
    expect(trace.result.detail).toBe('gate-unavailable');
    expect(trace.result.needsPermission).toBe(true);
    const gateCall = trace.chatCalls.find((c) => c.stage === 'gate');
    expect(gateCall?.failure).toBe('BRAIN_TIMEOUT');
    expect(gateCall?.raw).toBe('');
  });

  test('a not_addressed verdict dispatches nothing and reports not-addressed', async () => {
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({ addressed: false, needs_opencode: false, decision: 'not_addressed', ask_ar: '', approves_id: '', reason_en: 'talking to a colleague' }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'nope', state: 'running' }),
    });
    const trace = await brain.turn('خبر سامي إنه رح يجي');
    expect(trace.dispatches).toHaveLength(0);
    expect(trace.result.ok).toBe(false);
    expect(trace.result.detail).toContain('not-addressed');
  });

  test('an answer verdict dispatches nothing and is ok', async () => {
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({ addressed: true, needs_opencode: false, decision: 'answer', ask_ar: '', approves_id: '', reason_en: 'a question' }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => ({ receipt: 'nope', state: 'running' }),
    });
    const trace = await brain.turn('شو رأيك؟');
    expect(trace.dispatches).toHaveLength(0);
    expect(trace.result.ok).toBe(true);
    expect(trace.result.detail).toContain('answered-verbally');
  });

  test('no active session: the gate still runs and still dispatches nothing', async () => {
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({ addressed: true, needs_opencode: true, decision: 'approve', ask_ar: '', approves_id: '', reason_en: 'x' }),
      }),
      activeSessionId: () => undefined,
      dispatch: async () => ({ receipt: 'nope', state: 'running' }),
    });
    const trace = await brain.turn('شوف لي الجلسات');
    expect(trace.dispatches).toHaveLength(0);
    expect(trace.gateVerdict).not.toBeNull();
  });

  test('the classifier reads SHAPE, so two slots sharing one slug still classify', async () => {
    // THE POINT OF THE FIX. A quota outage put `INTAKE_MODEL` and
    // `COORDINATOR_MODEL` on the same slug. The classifier used to compare
    // `model`, so the intake branch swallowed every call, the coordinator branch
    // was unreachable, `stage` could never be `'plan'`, and `lastPlanOf` found
    // nothing — the report printed `approve.plan === null` for a plan the chain
    // had actually built. That collision is the SHIPPED state, so the ordinary
    // fixtures below already exercise it; this test states it explicitly and
    // asserts the shape each leg is recognised by, so a future "simplification"
    // back to a slug comparison fails here and names the reason.
    // BOTH configurations, driven explicitly, so this keeps its meaning when an
    // outage moves the slots apart again. Distinct is the historical layout;
    // collided is what ships today.
    const configurations: ReadonlyArray<readonly [string, string, string]> = [
      ['distinct', 'vendor/intake:free', 'vendor/planner:free'],
      ['collided', 'vendor/shared-slot:free', 'vendor/shared-slot:free'],
    ];
    for (const [label, intake, planner] of configurations) {
      const brain = new HeadlessBrain({
        intakeModel: intake,
        coordinatorModel: planner,
        fallbackModel: planner,
        chat: fakeChat({
          gate: JSON.stringify({ addressed: true, needs_opencode: false, decision: 'answer', ask_ar: '', approves_id: '', reason_en: 'q' }),
        }),
        activeSessionId: () => undefined,
        dispatch: async () => ({ receipt: 'nope', state: 'running' }),
      });
      const trace = await brain.turn('شو رأيك؟');
      const shape = trace.chatCalls.map((c) => `${c.stage}:${c.schema}`);
      // Intake is schema-less with a budget; the gate carries the addressee schema.
      // Both are recognised by shape alone, with no slug comparison involved.
      expect(shape, label).toContain('intake:none');
      expect(shape, label).toContain('gate:addressee');
      expect(trace.chatCalls.filter((c) => c.stage === 'unclassified'), label).toHaveLength(0);
    }
    // The shipped constants are asserted to be the collided pair, so if an outage
    // moves them apart the loop above still covers that case rather than the test
    // quietly becoming weaker.
    expect(INTAKE_MODEL).toBe(COORDINATOR_MODEL);
  });

  test('a plan call is classified `plan` even though the slots share a slug', async () => {
    // The direct symptom: `lastPlanOf` scans for `stage === 'plan'`, so a plan the
    // classifier cannot name is a plan the dispatch-failed path cannot recover.
    // This drives the full ask-then-approve chain with a throwing dispatch, the
    // exact path where the recovery matters, and asserts the plan survives.
    const COLLIDED = 'vendor/shared-slot:free';
    const holder: { brain: HeadlessBrain | null } = { brain: null };
    const brain = new HeadlessBrain({
      intakeModel: COLLIDED,
      coordinatorModel: COLLIDED,
      fallbackModel: COLLIDED,
      chat: fakeChat({
        gate: () =>
          JSON.stringify({
            addressed: true,
            needs_opencode: true,
            decision: holder.brain?.pendingPermission === null ? 'ask_permission' : 'approve',
            ask_ar: holder.brain?.pendingPermission === null ? 'بدي أبعت للـ OpenCode؟' : '',
            approves_id: holder.brain?.pendingPermission?.id ?? '',
            reason_en: 'fixture',
          }),
      }),
      activeSessionId: () => SES_1,
      dispatch: async () => {
        throw new OrchestratorError('SERVE_UNREACHABLE', true, 'session.prompt failed with HTTP 400');
      },
    });
    holder.brain = brain;
    await brain.turn('شوف لي الجلسات');
    const approve = await brain.turn('اي هلا سويت');

    expect(approve.chatCalls.filter((c) => c.stage === 'plan'), 'the plan leg was classified').not.toHaveLength(0);
    // One slug for every leg: proof the classification came from the request
    // shape, not from which model happened to be named.
    expect(approve.chatCalls.every((c) => c.model === COLLIDED), 'the fixture really did collide the slots').toBe(true);
    expect(approve.chatCalls.filter((c) => c.stage === 'unclassified')).toHaveLength(0);
    expect(new Set(approve.chatCalls.map((c) => c.stage)).size, 'several distinct stages from one slug').toBeGreaterThanOrEqual(3);
    expect(approve.plan?.steps, 'recovered from the ledger through PlanSchema').toHaveLength(1);
    expect(approve.result.plan?.steps).toHaveLength(1);
  });

  test('the stage classifier reads the product\'s own schema object, not a prompt', async () => {
    const brain = new HeadlessBrain({
      chat: fakeChat({
        gate: JSON.stringify({ addressed: true, needs_opencode: false, decision: 'answer', ask_ar: '', approves_id: '', reason_en: 'q' }),
        plan: JSON.stringify({ steps: [{ id: 's1', kind: 'prompt', detail: 'read the repo' }] }),
      }),
      activeSessionId: () => undefined,
      dispatch: async () => ({ receipt: 'nope', state: 'running' }),
    });
    const trace = await brain.turn('شو رأيك؟');
    const stages = trace.chatCalls.map((c) => `${c.stage}:${c.schema}`);
    expect(stages).toContain('intake:none');
    expect(stages).toContain('gate:addressee');
    // The plan is not reached when the gate answers, so the assertion is that no
    // call was mislabelled — not that a plan happened.
    expect(trace.chatCalls.every((c) => c.stage !== 'unclassified')).toBe(true);
  });
});
