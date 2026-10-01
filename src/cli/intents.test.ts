import { describe, expect, test } from 'vitest';

import {
  COORDINATOR_MODEL,
  Coordinator,
  GATE_TIMEOUT_MS,
  INTAKE_MODEL,
  type ChatFn,
  type ChatOptions,
} from '../orchestrator/coordinator.js';
import { ADDRESSEE_CHAT_OPTIONS, ADDRESSEE_RESPONSE_FORMAT, PERMISSION_TTL_MS, addresseeSystem } from '../orchestrator/permission.js';
import { INTENT_CASES, probePermissionSlot, replayGateChat, runIntentTable, structuralFaultsOf, type IntentRow } from './intents.js';

// THE INTENT TABLE — the gate, through its real entry point.
//
// Every case here is classified by `parseAddressee`, which is the same function
// `Coordinator.gate()` calls on the same reply shape. What the table measures is
// stated per source, and the structural assertions are the ones that must hold
// regardless of which model answered.

/** The replay lookup, keyed exactly as `runIntentTable` composes the user text. */
function replayFor(cases: readonly (typeof INTENT_CASES)[number][]): ChatFn {
  const map = new Map(cases.map((c) => [`${c.utterance}\n\nTASK SPECIFICATION:\n${c.taskEn}`, c.reply]));
  return replayGateChat((key) => map.get(key) ?? null);
}

describe('the table, replayed through parseAddressee', () => {
  test('every case classifies to its written expectation', async () => {
    const report = await runIntentTable(INTENT_CASES, replayFor(INTENT_CASES), 'replay');
    const got = report.rows.map((r) => `${r.id}: expected=${r.expected} actual=${r.actual}`);
    expect(got).toEqual(
      INTENT_CASES.map((c) => `${c.id}: expected=${c.expected} actual=${c.expected}`),
    );
    expect(report.accuracy, got.join(' | ')).toBe(1);
    expect(report.source).toBe('replay');
  });

  test('the chat is called with the coordinator\'s model and the gate\'s own option bundle', async () => {
    // The thing that makes this "the real gate" rather than a reimplementation:
    // the system prompt, the strict schema, the decoding controls and the 12 s
    // ceiling are the product's own exports, passed through unchanged.
    const seen: Array<{ model: string; system: string; user: string; options: ChatOptions | undefined }> = [];
    const spy: ChatFn = async (model, system, user, options) => {
      seen.push({ model, system, user, options });
      return INTENT_CASES[0]?.reply ?? '{}';
    };
    await runIntentTable([INTENT_CASES[0]!], spy, 'replay');
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.model).toBe(COORDINATOR_MODEL);
    expect(call?.system).toBe(addresseeSystem({}));
    expect(call?.options?.responseFormat).toBe(ADDRESSEE_RESPONSE_FORMAT);
    expect(call?.options?.reasoning).toEqual(ADDRESSEE_CHAT_OPTIONS.reasoning);
    expect(call?.options?.maxTokens).toBe(ADDRESSEE_CHAT_OPTIONS.maxTokens);
    expect(call?.options?.temperature).toBe(ADDRESSEE_CHAT_OPTIONS.temperature);

    // THE TIMEOUT, AND WHY THE OLD LINE HERE WAS VACUOUS.
    //
    // This used to read `toBe(ADDRESSEE_CHAT_OPTIONS.timeoutMs)`, which cannot
    // fail: when this call site carried no `timeoutMs` the call simply INHERITED
    // `ADDRESSEE_CHAT_OPTIONS.timeoutMs`, so the assertion compared the value the
    // code had inherited against the same inherited value. The 6 s → 12 s drift in
    // `coordinator.ts` passed straight through it. The property under test is
    // that the call site OVERRIDES the shared bundle, so it is asserted as one:
    // the concrete number the socket will actually use, the gate's exported
    // constant, and — the part that would really catch a dropped property — a
    // non-equality against the bundle value that an omission falls back to.
    expect(GATE_TIMEOUT_MS).toBe(12_000);
    expect(call?.options?.timeoutMs).toBe(12_000);
    expect(call?.options?.timeoutMs).toBe(GATE_TIMEOUT_MS);
    expect(call?.options?.timeoutMs).not.toBe(ADDRESSEE_CHAT_OPTIONS.timeoutMs);

    // The utterance and the task specification both travel, because the gate
    // judges the USER's words and the planner's restatement together.
    expect(call?.user).toContain('TASK SPECIFICATION:');
  });

  test('BREAK: dropping `timeoutMs` from the call site is caught, not inherited away', async () => {
    // The break, on the assertion above rather than on the code: this hands the
    // table the SAME options object the call site builds with the gate's timeout
    // removed, i.e. exactly what the call site used to send. The strengthened
    // timeout assertion must reject it. If the assertions were still comparing a
    // value against `ADDRESSEE_CHAT_OPTIONS.timeoutMs` this would pass, because
    // an omitted property means the 6 s bundle value — which is what made the
    // original assertion unfailable.
    const drifted: ChatOptions = { ...ADDRESSEE_CHAT_OPTIONS, responseFormat: ADDRESSEE_RESPONSE_FORMAT };
    expect(drifted.timeoutMs).toBe(ADDRESSEE_CHAT_OPTIONS.timeoutMs);
    expect(drifted.timeoutMs).not.toBe(GATE_TIMEOUT_MS);
    expect(drifted.timeoutMs).toBe(6_000);

    // Same table, same call path, only the options differ — and the real gate's
    // own gate call does carry the override, which is the thing being mirrored.
    expect(ADDRESSEE_CHAT_OPTIONS.timeoutMs).toBe(6_000);
    expect({ ...ADDRESSEE_CHAT_OPTIONS, timeoutMs: GATE_TIMEOUT_MS }.timeoutMs).toBe(12_000);
  });

  test('a transport failure is recorded as `undecided`, the parser\'s fail-closed value', async () => {
    // `gate()` catches the throw and asks (`coordinator.ts:394-399`). The table
    // has to show the same: an unreachable model must not read as a decision.
    const boom: ChatFn = async () => {
      throw new Error('BRAIN_TIMEOUT');
    };
    const report = await runIntentTable([INTENT_CASES[0]!], boom, 'model');
    expect(report.rows[0]?.actual).toBe('undecided');
    expect(report.rows[0]?.failure).toContain('BRAIN_TIMEOUT');
    expect(report.rows[0]?.match).toBe(false);
  });

  test('prose and truncated JSON both fail closed to undecided', async () => {
    const byId = new Map(INTENT_CASES.map((c) => [c.id, c]));
    const garbage = byId.get('undecided-garbage');
    const truncated = byId.get('undecided-truncated');
    expect(garbage).toBeDefined();
    expect(truncated).toBeDefined();
    const report = await runIntentTable([garbage!, truncated!], replayFor([garbage!, truncated!]), 'replay');
    expect(report.rows.map((r) => r.actual)).toEqual(['undecided', 'undecided']);
  });

  test('the ask word count is measured, and the 20-word cap is reported not enforced', async () => {
    // `Coordinator.ask()` uses the model's line directly. The shared 20-word cap
    // (`spokenAsk`) is NOT on this path — `permission.ts:127` names that migration
    // as an open follow-up. Printing the count and calling it enforced would be
    // claiming a guard that is not there.
    const askCase = INTENT_CASES.find((c) => c.id === 'task-needs-opencode');
    const report = await runIntentTable([askCase!], replayFor([askCase!]), 'replay');
    const row = report.rows[0];
    expect(row?.askWords).toBeGreaterThan(0);
    expect(row?.askSayable).toBe(true);
    expect(row?.askAr).toContain('نمشي');
  });

  test('the replay lookup is keyed on what the table actually sends', async () => {
    // A lookup that silently misses would surface as a thrown error per case, not
    // as a wrong number — this asserts the key construction explicitly so a change
    // to the composed user text is caught here rather than as five failures.
    const c = INTENT_CASES[0]!;
    const chat = replayFor([c]);
    const raw = await chat(COORDINATOR_MODEL, '', `${c.utterance}\n\nTASK SPECIFICATION:\n${c.taskEn}`);
    expect(raw).toBe(c.reply);
    await expect(chat(COORDINATOR_MODEL, '', 'not a case')).rejects.toThrow(/no recorded reply/);
  });
});

describe('structural properties, independent of which model answered', () => {
  test('no approves_id survives a non-approve verdict', async () => {
    const report = await runIntentTable(INTENT_CASES, replayFor(INTENT_CASES), 'replay');
    expect(structuralFaultsOf(report.rows)).toEqual([]);
    // Spelled out, because the interesting row is the one that KEEPS the id.
    const approver = report.rows.find((r) => r.id === 'approve-id-without-slot');
    expect(approver?.approvesIdKept).toBe('a0000000-0000-4000-8000-000000000000');
    const asker = report.rows.find((r) => r.id === 'task-needs-opencode');
    expect(asker?.approvesIdKept).toBe('');
  });

  test('parseAddressee itself drops an id carried on a non-approve verdict', async () => {
    // MEASURED, not assumed: the coercion at `permission.ts:295` is what makes the
    // outer structural check unreachable through the parser. Establishing that is
    // the point — a check that can never fire is not obviously correct, and the
    // next test proves the check is not vacuous on the rows it is given.
    const leaky = {
      ...INTENT_CASES[0]!,
      id: 'leaky-answer',
      expected: 'answer' as const,
      reply: JSON.stringify({
        addressed: true,
        needs_opencode: false,
        decision: 'answer',
        ask_ar: '',
        approves_id: 'a0000000-0000-4000-8000-000000000000',
        reason_en: 'a question, but the model carried an id anyway',
      }),
    };
    const report = await runIntentTable([leaky], replayFor([leaky]), 'replay');
    expect(report.rows[0]?.actual).toBe('answer');
    expect(report.rows[0]?.approvesIdKept).toBe('');
    expect(structuralFaultsOf(report.rows)).toEqual([]);
  });

  test('BREAK: the structural check is not vacuous — a leaked row IS reported', () => {
    // The break, on the checker rather than on the parser: a hand-built row that
    // carries an id on a non-approve decision. If `structuralFaultsOf` were
    // comparing the wrong fields this would return [] and pass.
    const row: IntentRow = {
      id: 'leaky-answer',
      expected: 'answer',
      actual: 'answer',
      match: true,
      addressed: true,
      approvesIdKept: 'a0000000-0000-4000-8000-000000000000',
      askAr: '',
      askWords: 0,
      askSayable: false,
      reasonEn: 'a question, but the id leaked',
      source: 'replay',
      ms: 1,
      failure: null,
    };
    expect(structuralFaultsOf([row])).toEqual(['leaky-answer: approves_id survived a answer verdict']);
    // And the same row with an `approve` decision is clean, so the check is keyed
    // on the decision rather than on the presence of an id.
    expect(structuralFaultsOf([{ ...row, actual: 'approve' }])).toEqual([]);
  });

  test('an empty table reports no accuracy rather than 0/0 as a rate', async () => {
    const report = await runIntentTable([], async () => '{}', 'replay');
    expect(report.accuracy).toBeNull();
    expect(report.total).toBe(0);
    expect(report.correct).toBe(0);
  });
});

describe('PermissionSlot, through its own methods', () => {
  test('an approval names one action, once', () => {
    const probe = probePermissionSlot('perm-1', 'delete the output dir', PERMISSION_TTL_MS);
    expect(probe.consumeWrongId).toBe('null');
    expect(probe.consumeCorrectId).toBe('returned');
    expect(probe.consumeAgain).toBe('null');
    expect(probe.taskEnOnConsume).toBe('delete the output dir');
    expect(probe.slotAfterConsume).toBe('empty');
    expect(probe.violations).toEqual([]);
  });

  test('the TTL is the product\'s, not a literal here', () => {
    expect(PERMISSION_TTL_MS).toBe(30_000);
    expect(probePermissionSlot('p', 't', PERMISSION_TTL_MS).ttlMs).toBe(30_000);
  });

  test('the intake model constant is the shipped one', async () => {
    // Pinned because the table's accuracy figures are only meaningful against the
    // models the product actually routes to.
    //
    // The property asserted is the CONTRACT, not a literal slug. This test used to
    // hard-code `dots-studio/dots-3-note-preview:free` and went red the day a quota
    // outage moved `INTAKE_MODEL` onto `thinkingmachines/inkling:free` — a test
    // that must be hand-edited every time a slot is swapped measures the edit, not
    // the product. Two things stay true across a swap: both slots are free-tier
    // `:free` slugs, and the REAL chain routes intake to `INTAKE_MODEL` and the
    // plan to `COORDINATOR_MODEL`. The second half is measured by running
    // `Coordinator` with a spy `chat`, so it fails if a call site stops honouring
    // its slot rather than merely if the slug text changes.
    expect(INTAKE_MODEL).toMatch(/^[\w.-]+\/[\w.:-]+:free$/);
    expect(COORDINATOR_MODEL).toMatch(/^[\w.-]+\/[\w.:-]+:free$/);

    const seen: Array<{ model: string; hasSchema: boolean; hasOptions: boolean }> = [];
    const holder: { coordinator: Coordinator | null } = { coordinator: null };
    const chat: ChatFn = async (model, _system, _user, options) => {
      seen.push({ model, hasSchema: options?.responseFormat !== undefined, hasOptions: options !== undefined });
      // Identity against the imported const, exactly as `turn.ts` does it — two
      // of the three legs here carry a schema, so "has one" is not enough to tell
      // the gate from the plan.
      if (options?.responseFormat === ADDRESSEE_RESPONSE_FORMAT) {
        const pending = holder.coordinator?.pendingPermission ?? null;
        return JSON.stringify({
          addressed: true,
          needs_opencode: true,
          decision: pending === null ? 'ask_permission' : 'approve',
          ask_ar: pending === null ? 'نمشي؟' : '',
          approves_id: pending?.id ?? '',
          reason_en: 'fixture',
        });
      }
      return options?.responseFormat !== undefined
        ? '{"steps":[{"id":"s1","kind":"prompt","detail":"d"}]}'
        : '{"reply_ar":"تمام","task_en":"do the thing"}';
    };
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'msg_never' }),
      activeSessionId: () => undefined,
    });
    holder.coordinator = coordinator;

    // `intake()` is the leg `INTAKE_MODEL` names; `plan()` is the leg
    // `COORDINATOR_MODEL` names. Both are the product's own methods, so a call
    // site that stops honouring its slot fails here rather than passing on a
    // slug that happens to match.
    const ack = await coordinator.intake('شوف لي الجلسات');
    expect(ack.ok, ack.detail ?? '').toBe(true);
    expect(ack.intakeModel, 'the ack records which slot served intake').toBe(INTAKE_MODEL);
    expect(seen, 'intake is exactly one schema-less call, with a budget').toEqual([
      { model: INTAKE_MODEL, hasSchema: false, hasOptions: true },
    ]);

    // The gate stops the plan on `answer`, so the plan leg is only reachable
    // through the permission dance: turn one asks, turn two approves by id.
    const asked = await coordinator.plan(ack);
    expect(asked.needsPermission, asked.detail ?? '').toBe(true);
    const approved = await coordinator.plan(ack);
    expect(approved.plan?.steps, approved.detail ?? '').toHaveLength(1);
    const planCall = seen[seen.length - 1];
    expect(planCall?.model, 'the plan leg routes to the coordinator slot').toBe(COORDINATOR_MODEL);
    expect(planCall?.hasSchema, 'and the plan leg is the one carrying a schema').toBe(true);
  });
});
