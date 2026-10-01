import { describe, expect, test } from 'vitest';
import {
  Coordinator,
  INTAKE_MODEL,
  COORDINATOR_MODEL,
  GATE_TIMEOUT_MS,
  buildHandoff,
  type MissionResult,
} from './coordinator.js';
import type { CoordinatorDeps } from './coordinator.js';
import { isSpeakable } from '../voice/tts.js';

// P5 TDD — Dots3 intake → Inkling plan → Inkling handoff dispatch.
// Fast verbal reply first, structured failure never throws out.
//
// PHASE B — `plan()` now opens a CONTEXTUAL PERMISSION gate before it plans,
// so a turn that dispatches takes TWO `plan()` calls: the first raises the ask
// and dispatches nothing, the second carries the approval and dispatches the
// PENDING action. `chatFor` answers the gate as the model would (approve, with
// the id the gate named in its system prompt) so the dispatch-asserting tests
// below read the way they always did, plus one extra call.
function gateReplyFor(system: string): string {
  const pending = /pending id: (\S+)/.exec(system);
  return pending === null
    ? JSON.stringify({
        addressed: true,
        needs_opencode: true,
        decision: 'ask_permission',
        ask_ar: 'أرسل برومبت لـ OpenCode؟',
        approves_id: '',
        reason_en: 'task',
      })
    : JSON.stringify({
        addressed: true,
        needs_opencode: true,
        decision: 'approve',
        ask_ar: '',
        approves_id: pending[1] as string,
        reason_en: 'approved',
      });
}

/**
 * Responses are keyed by ROLE, not by model slug.
 *
 * WHY THIS CHANGED 2026-10-01. These helpers used to be `Record<modelSlug,
 * reply>`, which silently assumed INTAKE_MODEL and COORDINATOR_MODEL are two
 * DIFFERENT strings. When intake was re-pointed at `thinkingmachines/inkling:free`
 * — the only free model that still answers, and already the planner's slug —
 * every `{ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK }` literal in
 * this file collapsed to ONE key, PLAN_OK won, intake was handed a plan, and 15
 * of 30 tests failed. The harness, not the coordinator, was wrong: it was keyed
 * on something that is configuration rather than on the thing that actually
 * distinguishes the legs.
 *
 * The discriminator that does not move is the SYSTEM PROMPT. `intakeSystem()`
 * opens "You take Arabic voice transcripts", `COORDINATOR_SYSTEM` opens "You are
 * the planner for Voxaura", and the re-ask is `intakeSystem() + REASK_CONSTRAINT`
 * so it keeps the intake prefix — which is correct, because no test here needs
 * the re-ask answered differently from the first intake. The one sterner plan
 * retry prefixes `COORDINATOR_SYSTEM`, so it keeps the plan prefix too.
 */
type RoleResponses = { readonly intake?: string; readonly plan?: string };

/** The gate is a third stage and is answered by `gateReplyFor`, never here. */
function roleOf(system: string): 'intake' | 'plan' {
  if (system.startsWith('You take Arabic voice transcripts')) return 'intake';
  if (system.startsWith('You are the planner for Voxaura')) return 'plan';
  throw new Error(`unclassifiable system prompt: ${JSON.stringify(system.slice(0, 60))}`);
}

function chatFor(responses: RoleResponses): (model: string, system: string, u: string) => Promise<string> {
  return async (model: string, system: string) => {
    if (system.includes('addressee gate')) return gateReplyFor(system);
    const out = responses[roleOf(system)];
    if (out === undefined) throw new Error(`unexpected ${roleOf(system)} call: ${model}`);
    return out;
  };
}

/**
 * Two `run()` calls for one dispatch: the first raises the contextual
 * permission ask and dispatches NOTHING, the second carries the approval.
 *
 * Used by every test below that asserts a dispatch happened. The FIRST result
 * is returned too, because "the ask turn dispatched nothing" is the Phase B
 * property these tests are now sitting on top of and it costs nothing to keep.
 */
async function runApproved(
  coordinator: Coordinator,
  transcript: string,
  opts: Parameters<Coordinator['run']>[1] = {},
): Promise<{ asked: MissionResult; result: MissionResult }> {
  const asked = await coordinator.run(transcript, opts);
  const result = await coordinator.run(transcript, opts);
  return { asked, result };
}

const INTAKE_OK = JSON.stringify({ reply_ar: 'تمام، أبحث الآن', task_en: 'List all sessions and report their states' });
const PLAN_OK = JSON.stringify({
  steps: [
    { id: 's1', kind: 'prompt', detail: 'Ask the session for its status' },
    { id: 's2', kind: 'control', detail: 'Summarize the replies' },
  ],
  tools: ['session.prompt'],
  skills: ['mission-handoff'],
});

describe('coordinator chain', () => {
  test('model slugs match the locked roster', () => {
    // INTAKE_MODEL was re-picked by measurement on 2026-10-01 after the old
    // slug's free tier returned 429. See the record at the constant in
    // coordinator.ts — including the part that matters most: the 429 is
    // KEY-SCOPED (`free_model_daily_requests.remaining = 0`, one 50/day pool
    // per key), so only two of sixteen free models answered at all, and this
    // is one of them. Both slugs stay free.
    expect(INTAKE_MODEL).toBe('thinkingmachines/inkling:free');
    expect(INTAKE_MODEL.endsWith(':free')).toBe(true);
    expect(COORDINATOR_MODEL).toBe('thinkingmachines/inkling:free');
  });

  test('D4: a hung speak must not block planning or dispatch', async () => {
    // The regression: `await speak(...)` serialized every turn behind a Fish
    // round-trip, so a slow or hung TTS put seconds of dead air in front of
    // the plan. speak is now detached — it must never gate the chain.
    let speakStarted = false;
    const never = new Promise<void>(() => undefined);
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ intake: INTAKE_OK, plan: PLAN_OK }),
      speak: () => {
        speakStarted = true;
        return never;
      },
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'msg_hang' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    // If speak were awaited this would never settle.
    const { asked, result } = await runApproved(coordinator, 'show me sessions', { taskId: 'm_hang' });
    expect(speakStarted).toBe(true);
    expect(asked.needsPermission, 'Phase B: the ask turn dispatched nothing').toBe(true);
    expect(result.ok).toBe(true);
    expect(result.receipt).toBe('msg_hang');
    expect(dispatched).toHaveLength(1);
  });

  test('D4: a rejected speak is swallowed, never an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void errors.push(args[0]);
    try {
      const coordinator = new Coordinator({
        chat: chatFor({ intake: INTAKE_OK, plan: PLAN_OK }),
        speak: async () => {
          throw new Error('fish down');
        },
        dispatch: async () => ({ receipt: 'msg_ok' }),
        activeSessionId: () => 'ses_a' as never,
      });
      const { result } = await runApproved(coordinator, 'show me sessions', { taskId: 'm_reject' });
      expect(result.ok).toBe(true);
      // Let the detached rejection settle before asserting it was reported.
      await new Promise((r) => setTimeout(r, 0));
      // Two turns ran (ask, then approve), and `speak` is detached on both.
      expect(errors).toHaveLength(2);
      expect(String(errors[0])).toContain('coordinator-speak-failed');
      expect(String(errors[0])).not.toContain('api_key');
    } finally {
      console.error = original;
    }
  });

  test('B.5: a rejected speak logs a redacted line, never the provider text', async () => {
    // The speak failure is interpolated into a `console.error` line, which is
    // the stderr a human pastes into an issue. Scrubbing belongs on the exact
    // interpolation (redact before JSON.stringify), not on the caller that
    // rejects — a rejection can carry any provider's message. BOTH asserts:
    // absent, and the marker PRESENT (proves a scrub, not a dropped line).
    // Synthetic material only.
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void errors.push(args[0]);
    try {
      const coordinator = new Coordinator({
        chat: chatFor({ intake: INTAKE_OK, plan: PLAN_OK }),
        speak: async () => {
          throw new Error('fish 401 with sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        },
        dispatch: async () => ({ receipt: 'msg_ok' }),
        activeSessionId: () => 'ses_a' as never,
      });
      await runApproved(coordinator, 'show me sessions', { taskId: 'm_redact' });
      await new Promise((r) => setTimeout(r, 0));
      expect(errors).toHaveLength(2);
      const line = String(errors[0]);
      expect(line).toContain('coordinator-speak-failed');
      expect(line).not.toContain('sk-or-v1-AAAAAAAA');
      expect(line).toContain('[REDACTED]');
      // Still valid JSON: redaction must not corrupt the line's shape.
      expect(JSON.parse(line)).toMatchObject({ evt: 'coordinator-speak-failed' });
    } finally {
      console.error = original;
    }
  });

  test('reply_ar is written FROM the situation, not from a stock phrase (Phase 5)', async () => {
    // The whole point of the context block: a heavy model just swapped onto a
    // full context window should produce a line ABOUT that, and the model must
    // be able to see those facts to do it.
    const systems: string[] = [];
    const coordinator = new Coordinator({
      chat: (model, system, user) => {
        systems.push(system);
        return chatFor({ intake: INTAKE_OK, plan: PLAN_OK })(model, system, user);
      },
      dispatch: async () => ({ receipt: 'r' }),
      activeSessionId: () => 'ses_a' as never,
    });
    await coordinator.run('حوّل النموذج', {
      context: {
        sessionTitle: 'إصلاح خطأ الصوت',
        currentModel: 'nemotron',
        currentAgent: 'explore',
        contextPercent: 88,
      },
    });
    const intakeSystemPrompt = systems[0] ?? '';
    expect(intakeSystemPrompt).toContain('إصلاح خطأ الصوت');
    expect(intakeSystemPrompt).toContain('nemotron');
    expect(intakeSystemPrompt).toContain('88%');
    expect(intakeSystemPrompt).toMatch(/forbidden|forbid|قوالب|آلية/i);
  });

  test('no context supplied means no SITUATION block, and still parses', async () => {
    const systems: string[] = [];
    const coordinator = new Coordinator({
      chat: (model, system, user) => {
        systems.push(system);
        return chatFor({ intake: INTAKE_OK, plan: PLAN_OK })(model, system, user);
      },
      dispatch: async () => ({ receipt: 'r' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const { result } = await runApproved(coordinator, 'hi');
    expect(systems[0]).not.toContain('SITUATION:');
    expect(result.ok).toBe(true);
  });

  test('full mission: speak first, then dispatch handoff with receipt', async () => {
    const order: string[] = [];
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ intake: INTAKE_OK, plan: PLAN_OK }),
      speak: async (text) => void order.push(`speak:${text}`),
      dispatch: async (text) => {
        order.push('dispatch');
        dispatched.push(text);
        return { receipt: 'msg_9' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    const { asked, result } = await runApproved(coordinator, 'show me sessions', { taskId: 'm1' });
    expect(asked.receipt, 'Phase B: the ask turn reached no session').toBeNull();
    expect(result.ok).toBe(true);
    expect(result.replyAr).toBe('تمام، أبحث الآن');
    expect(result.taskEn).toBe('List all sessions and report their states');
    expect(result.receipt).toBe('msg_9');
    // Fast verbal response precedes dispatch. TWO turns ran, so the ack is
    // spoken twice and the single dispatch still comes last.
    expect(order.filter((o) => o === 'dispatch')).toHaveLength(1);
    expect(order.indexOf('dispatch')).toBe(order.length - 1);
    expect(order[0]).toBe('speak:تمام، أبحث الآن');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('[HANDOFF from=Nemotron to=Inkling task=m1]');
    expect(dispatched[0]).toContain('ses_a');
  });

  test('invalid intake JSON fails gracefully with no dispatch', async () => {
    let dispatched = 0;
    let spoken = 0;
    const coordinator = new Coordinator({
      chat: chatFor({ intake: 'not json at all', plan: 'still not json' }),
      speak: async () => void (spoken += 1),
      dispatch: async () => {
        dispatched += 1;
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('hi');
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('intake-invalid');
    expect(dispatched).toBe(0);
    expect(spoken).toBe(0);
  });

  test('dots3 serves intake directly with reasoning suppression when healthy', async () => {
    const calls: Array<{ model: string; options: unknown; system: string }> = [];
    const coordinator = new Coordinator({
      chat: async (model: string, system: string, user: string, options?: unknown) => {
        if (system.includes('addressee gate')) return gateReplyFor(system);
        calls.push({ model, options, system });
        return roleOf(system) === 'intake' ? INTAKE_OK : PLAN_OK;
      },
      dispatch: async () => ({ receipt: 'msg_d' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const { result } = await runApproved(coordinator, 'hi', { taskId: 'm3' });
    expect(result.ok).toBe(true);
    expect(result.intakeModel).toBe(INTAKE_MODEL);
    expect(result.receipt).toBe('msg_d');
    // `system` is on the record only so the role-keyed helpers can be counted
    // by role rather than by slug; it is not what this assertion is about.
    expect(calls[0]).toEqual({
      model: INTAKE_MODEL,
      system: expect.any(String),
      options: { reasoning: { effort: 'none' }, maxTokens: 200, temperature: 0.2, timeoutMs: 10_000 },
    });
    // Coordinator stage runs with strict schema enforcement and a planning ceiling.
    // The gate's own calls are NOT recorded here (it is a separate stage), so
    // `calls` is two intake legs and one plan. The plan is the LAST recorded
    // call, which is the property that matters.
    const planCall = calls[calls.length - 1] as { model: string; options: unknown };
    expect(planCall).toMatchObject({
      model: COORDINATOR_MODEL,
      options: { timeoutMs: 25_000, temperature: 0.2, maxTokens: 300 },
    });
    expect((planCall.options as { responseFormat: { type: string } }).responseFormat.type).toBe('json_schema');
    expect(calls.filter((c) => roleOf(c.system) === 'intake')).toHaveLength(2);
  });

  test('a dead primary fails over to the fallback intake model', async () => {
    const seen: string[] = [];
    // The gate is not in `script`: it is a separate stage with its own answer,
    // and folding it in would make this test about the gate rather than about
    // failover. Two full turns therefore need two intake/gate/plan rounds.
    const script: Array<{ model: string; reply: string } | { model: string; error: string }> = [
      { model: INTAKE_MODEL, error: 'dots unreachable' },
      { model: COORDINATOR_MODEL, reply: INTAKE_OK },
      { model: INTAKE_MODEL, error: 'dots unreachable' },
      { model: COORDINATOR_MODEL, reply: INTAKE_OK },
      { model: COORDINATOR_MODEL, reply: PLAN_OK },
    ];
    const coordinator = new Coordinator({
      chat: async (model: string, system: string) => {
        if (system.includes('addressee gate')) return gateReplyFor(system);
        seen.push(model);
        const next = script.shift();
        if (next === undefined || next.model !== model) throw new Error(`out-of-script call: ${model}`);
        if ('error' in next) throw new Error(next.error);
        return next.reply;
      },
      dispatch: async () => ({ receipt: 'msg_f' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const { result } = await runApproved(coordinator, 'hi', { taskId: 'm9' });
    expect(result.ok).toBe(true);
    expect(result.intakeModel).toBe(COORDINATOR_MODEL);
    expect(result.receipt).toBe('msg_f');
    // Two intake legs, each failing over once, then one plan:
    // [dots, inkling] x 2 + [inkling planner].
    expect(seen).toEqual([
      INTAKE_MODEL,
      COORDINATOR_MODEL,
      INTAKE_MODEL,
      COORDINATOR_MODEL,
      COORDINATOR_MODEL,
    ]);
  });

  test('prose plan triggers exactly one sterner retry, then succeeds', async () => {
    const systems: string[] = [];
    let plans = 0;
    const coordinator = new Coordinator({
      chat: async (model: string, system: string) => {
        systems.push(system);
        if (system.includes('addressee gate')) return gateReplyFor(system);
        if (roleOf(system) === 'intake') return INTAKE_OK;
        plans += 1;
        return plans === 1 ? 'just some prose, no json here' : PLAN_OK;
      },
      dispatch: async () => ({ receipt: 'msg_r' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const { result } = await runApproved(coordinator, 'hi');
    expect(result.ok).toBe(true);
    expect(result.receipt).toBe('msg_r');
    expect(result.plan?.steps).toHaveLength(2);
    expect(plans).toBe(2);
    expect(systems.filter((s) => s.includes('CRITICAL'))).toHaveLength(1);
  });

  test('invalid plan JSON still speaks, but never dispatches', async () => {
    const spoken: string[] = [];
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ intake: INTAKE_OK, plan: 'oops' }),
      speak: async (text) => void spoken.push(text),
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    const { asked, result } = await runApproved(coordinator, 'hi');
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('plan-invalid');
    // Spoken once per turn (two turns ran) and never dispatched.
    expect(spoken).toEqual(['تمام، أبحث الآن', 'تمام، أبحث الآن']);
    expect(dispatched).toHaveLength(0);
    expect(asked.receipt).toBeNull();
  });

  test('destructive plan is held for confirmation, then executes on approve', async () => {
    const evil = JSON.stringify({ steps: [{ id: 's1', kind: 'shell', detail: 'rm -rf build output' }] });
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ intake: INTAKE_OK, plan: evil }),
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'msg_z' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    // Phase B first: TWO permission gates now sit in front of FR-12's one, and
    // each needs its own approval. That composition is the point — the new gate
    // is strictly BROADER, not a replacement.
    const t1 = await coordinator.run('clean it');
    expect(t1.needsPermission, 'turn 1 asks for the contextual permission').toBe(true);
    expect(t1.needsConfirmation, 'FR-12 has not even planned yet').not.toBe(true);
    expect(dispatched).toHaveLength(0);

    const t2 = await coordinator.run('clean it');
    expect(t2.needsPermission, 'turn 2 supplies the permission and reaches the planner').not.toBe(true);
    expect(t2.needsConfirmation, '…and FR-12 then holds the destructive step').toBe(true);
    expect(dispatched).toHaveLength(0);

    const t3 = await coordinator.run('clean it', { approve: true });
    expect(t3.needsPermission, 'FR-12 approval still needs the contextual one').toBe(true);
    expect(dispatched).toHaveLength(0);

    const approved = await coordinator.run('clean it', { approve: true });
    expect(approved.ok).toBe(true);
    expect(approved.receipt).toBe('msg_z');
    expect(dispatched).toHaveLength(1);
  });

  test('no active session returns the plan with a null receipt', async () => {
    let dispatched = 0;
    const coordinator = new Coordinator({
      chat: chatFor({ intake: INTAKE_OK, plan: PLAN_OK }),
      dispatch: async () => {
        dispatched += 1;
        return { receipt: 'x' };
      },
      activeSessionId: () => undefined,
    });
    const { result } = await runApproved(coordinator, 'hi');
    expect(result.ok).toBe(true);
    expect(result.receipt).toBeNull();
    expect(dispatched).toBe(0);
    expect(result.plan?.steps).toHaveLength(2);
  });

  test('a dead model endpoint fails as intake-failed, never throws out', async () => {
    const coordinator = new Coordinator({
      chat: async () => {
        throw new Error('network down');
      },
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });
    const result = await coordinator.run('hi');
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('intake-failed');
  });
});

// M2 Pattern 1 — the split itself. `run()` is retained and unchanged for the
// chain tests above; what is new here is that intake and plan can be driven
// SEPARATELY, which is what lets the daemon speak the ack while Inkling plans.
describe('M2 Pattern 1 — coordinator split', () => {
  /** Records which model answered, so "did it reach the planner" is provable. */
  function modelsFor(responses: RoleResponses) {
    const seen: string[] = [];
    const chat = async (model: string, system: string): Promise<string> => {
      // The Phase B gate is a third stage, not one of the two this test is
      // about. Answer it from its own system prompt and do NOT record it, so
      // `seen` keeps meaning "the models intake and planning used".
      if (system.includes('addressee gate')) return gateReplyFor(system);
      seen.push(model);
      const out = responses[roleOf(system)];
      if (out === undefined) throw new Error(`unexpected ${roleOf(system)} call: ${model}`);
      return out;
    };
    return { seen, chat };
  }

  test('intake returns an ack WITHOUT the coordinator model ever being called', async () => {
    // This is the latency claim in test form. Measured intake p50 is 901 ms and
    // plan p50 1950 ms; if intake touched the planner there would be nothing
    // to gain by splitting the method at all.
    const { seen, chat } = modelsFor({ intake: INTAKE_OK, plan: PLAN_OK });
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'never' }),
      activeSessionId: () => 'ses_a' as never,
    });

    const ack = await coordinator.intake('show me sessions');

    expect(ack.ok).toBe(true);
    expect(ack.replyAr).toBe('تمام، أبحث الآن');
    expect(ack.taskEn).toBe('List all sessions and report their states');
    expect(ack.intakeModel).toBe(INTAKE_MODEL);
    expect(ack.receipt).toBeNull();
    // The planner was never asked for anything.
    expect(seen).toEqual([INTAKE_MODEL]);
  });

  test('plan never re-runs intake: it consumes the ack it is handed', async () => {
    const { seen, chat } = modelsFor({ intake: INTAKE_OK, plan: PLAN_OK });
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat,
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'msg_split' };
      },
      activeSessionId: () => 'ses_a' as never,
    });

    const ack = await coordinator.intake('show me sessions');
    const asked = await coordinator.plan(ack, { taskId: 'task-x' });
    // Phase B: the first `plan()` asks and dispatches nothing.
    expect(asked.needsPermission).toBe(true);
    expect(dispatched).toHaveLength(0);
    const mission = await coordinator.plan(ack, { taskId: 'task-x' });

    // `seen` holds only INTAKE and PLANNER models — the gate answers itself from
    // its own system prompt and is deliberately not recorded here. Exactly one
    // intake (above) and one plan, across BOTH `plan()` calls. A `plan()` that
    // called intake again would show a SECOND INTAKE_MODEL call, and would
    // double the 901 ms the split was built to hide.
    expect(seen).toEqual([INTAKE_MODEL, COORDINATOR_MODEL]);
    expect(mission.ok).toBe(true);
    expect(mission.receipt).toBe('msg_split');
    expect(dispatched).toHaveLength(1);
  });

  test('plan() on a failed intake returns intake-failed without calling any model', async () => {
    // The daemon enqueues only successful acks, but the type allows this and a
    // caller must not be able to spend a 25 s planning budget on a turn that
    // already failed.
    const { seen, chat } = modelsFor({});
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });

    const mission = await coordinator.plan({ ok: false, receipt: null, detail: 'intake-invalid' });

    expect(mission.ok).toBe(false);
    expect(mission.detail).toBe('intake-invalid');
    expect(seen).toEqual([]);
  });

  test('an abort landing mid-plan cancels before the dispatch', async () => {
    // The planner is called AFTER the signal fires — the exact ordering a
    // post-await check exists for. A check only at method entry would pass
    // this test's setup and still dispatch.
    const controller = new AbortController();
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: async (model, system: string) => {
        if (system.includes('addressee gate')) {
          // The barge arrives while the GATE call is in flight — one await
          // earlier than it used to, and the gate has its own post-await check
          // for exactly this reason.
          controller.abort();
          return gateReplyFor(system);
        }
        if (roleOf(system) === 'intake') return INTAKE_OK;
        // The barge arrives while the 25 s planning call is in flight.
        controller.abort();
        return PLAN_OK;
      },
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'must_not_happen' };
      },
      activeSessionId: () => 'ses_a' as never,
    });

    const ack = await coordinator.intake('احذف الملفات');
    const mission = await coordinator.plan(ack, { signal: controller.signal });

    // BREAK: delete the post-await `aborted()` checks in `plan()` and this
    // dispatches a destructive-adjacent plan the user already interrupted.
    expect(dispatched).toEqual([]);
    expect(mission.cancelled).toBe(true);
    expect(mission.detail).toBe('cancelled');
    expect(mission.receipt).toBeNull();
  });

  test('a signal already aborted on entry cancels without calling the planner', async () => {
    const controller = new AbortController();
    controller.abort();
    const { seen, chat } = modelsFor({ intake: INTAKE_OK, plan: PLAN_OK });
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => 'ses_a' as never,
    });

    const ack = await coordinator.intake('hi');
    seen.length = 0;
    const mission = await coordinator.plan(ack, { signal: controller.signal });

    expect(seen).toEqual([]);
    expect(mission.cancelled).toBe(true);
  });

  test('FR-12 survives the split: plan() alone still holds a destructive plan', async () => {
    const destructive = JSON.stringify({
      steps: [{ id: 's1', kind: 'shell', detail: 'rm -rf /tmp/build' }],
    });
    const { chat } = modelsFor({ intake: INTAKE_OK, plan: destructive });
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat,
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'held' };
      },
      activeSessionId: () => 'ses_a' as never,
    });

    const ack = await coordinator.intake('clean it');
    // Phase B sits IN FRONT of FR-12, so the destructive hold is only reachable
    // once the contextual permission has been granted on a previous turn.
    const asked = await coordinator.plan(ack, { taskId: 'task-fr12' });
    expect(asked.needsPermission).toBe(true);
    expect(asked.needsConfirmation, 'FR-12 has not planned yet, so it cannot have held').not.toBe(true);
    const held = await coordinator.plan(ack, { taskId: 'task-fr12' });

    expect(held.needsConfirmation).toBe(true);
    expect(held.flagged).toContain('s1');
    expect(dispatched).toEqual([]);
  });
});

describe('buildHandoff', () => {
  test('envelope carries task, session, steps, and constraints', () => {
    const text = buildHandoff('m7', 'Do the thing', 'ses_q', [
      { id: 's1', kind: 'prompt', detail: 'Ask nicely' },
    ]);
    expect(text).toContain('[HANDOFF from=Nemotron to=Inkling task=m7]');
    expect(text).toContain('ses_q');
    expect(text).toContain('[s1] prompt :: Ask nicely');
    expect(text).toContain('FR-12');
  });
});

// M2 Pattern 6a — the acknowledgement is spoken ~1.4 s after the user stops
// talking and BEFORE a single step has run. A line that claims a result is
// therefore a lie with a receipt-free timestamp: the user hears "done" and
// then waits. The prompt already bans robotic confirmation templates as a
// STYLE matter; this is the timing half — nothing has executed yet, so no
// outcome may be reported, whatever the tone.
describe('M2 Pattern 6a — never assert results', () => {
  const TASK = 'List all sessions and report their states';
  const ASSERTING = JSON.stringify({ reply_ar: 'تم تنفيذ الأمر بنجاح', task_en: TASK });
  const STILL_ASSERTING = JSON.stringify({ reply_ar: 'تم تغيير النموذج، والتحديث تم', task_en: TASK });
  const CLEAN = JSON.stringify({ reply_ar: 'هسا بتفتّح عليها، ثواني', task_en: TASK });

  /**
   * One model, a queue of bodies — the re-ask is the SECOND intake call on the
   * SAME model, so a per-model map cannot express it, and a queue shorter than
   * the call count would silently pass a body that does not exist.
   */
  function intakeQueue(bodies: string[]): { chat: CoordinatorDeps['chat']; systems: string[] } {
    const systems: string[] = [];
    let n = 0;
    const chat: CoordinatorDeps['chat'] = async (model, system) => {
      // The Phase B gate is not an intake call and must not consume a body from
      // this queue — that would make the queue length a lie about the re-ask.
      if (system.includes('addressee gate')) return gateReplyFor(system);
      systems.push(system);
      const body = bodies[n];
      n += 1;
      if (body === undefined) throw new Error(`unexpected extra call #${n} to ${model}`);
      return body;
    };
    return { chat, systems };
  }

  test('an outcome-asserting ack is re-asked once and a clean re-ask replaces it', async () => {
    const { chat, systems } = intakeQueue([ASSERTING, CLEAN]);
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'never' }),
      activeSessionId: () => undefined,
    });

    const ack = await coordinator.intake('اعرض الجلسات');

    expect(ack.ok).toBe(true);
    // The re-ask carries the constraint; without it the same answer comes back.
    expect(systems).toHaveLength(2);
    expect(systems[1]).toMatch(/nothing has run|never state an outcome/i);
    expect(ack.replyAr).toBe('هسا بتفتّح عليها، ثواني');
    expect(ack.taskEn).toBe(TASK);
    // D2: the row is marked so a ~2 s intake latency reads as two calls.
    expect(ack.reasked).toBe(true);
  });

  test('a re-ask that still asserts is DROPPED and the turn continues silently', async () => {
    // The defect this closes: the user hears "تم تنفيذ الأمر بنجاح" and then
    // watches nothing happen. Silence is the honest answer; dropping the whole
    // line is required because a filter that edits Arabic produces a mangled
    // half-sentence, which is worse than saying nothing.
    const { chat } = intakeQueue([ASSERTING, STILL_ASSERTING]);
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: async (model, system, user, options) => {
        if (system.includes('addressee gate')) return gateReplyFor(system);
        if (roleOf(system) === 'plan') return PLAN_OK;
        return chat(model, system, user, options);
      },
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'msg_drop' };
      },
      activeSessionId: () => 'ses_a' as never,
    });

    const ack = await coordinator.intake('اعرض الجلسات');
    expect(ack.ok).toBe(true);
    // Dropped whole, not filtered: no fragment of the claim survives, and the
    // line is un-speakable, which is exactly how `onUtterance` stays silent.
    expect(ack.replyAr).toBe('');
    expect(isSpeakable(ack.replyAr ?? 'x')).toBe(false);
    // The WORK is not dropped with the words: the task survives, and it plans.
    expect(ack.taskEn).toBe(TASK);
    // Phase B: ask first, then approve, then the work runs.
    const asked = await coordinator.plan(ack, { taskId: 'task-6a' });
    expect(asked.needsPermission).toBe(true);
    const mission = await coordinator.plan(ack, { taskId: 'task-6a' });
    expect(mission.ok).toBe(true);
    expect(mission.replyAr, 'the dropped ack is still dropped on the approving turn').toBe('');
    expect(mission.receipt).toBe('msg_drop');
    expect(dispatched).toHaveLength(1);
  });

  test('the re-ask is bounded to one and never touches the fallback model', async () => {
    // Unbounded re-asking turns a model that always lies about the outcome into
    // an infinite loop on the 901 ms intake path.
    const { chat, systems } = intakeQueue([ASSERTING, STILL_ASSERTING]);
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });

    const ack = await coordinator.intake('اعرض الجلسات');

    expect(systems).toHaveLength(2);
    expect(ack.replyAr).toBe('');
  });

  test('an acknowledgement that only ACKNOWLEDGES is never re-asked', async () => {
    // The trap: 'تمام' contains 'تم'. A naive substring detector silences every
    // healthy turn, which is a louder failure than the one being fixed.
    for (const phrase of ['تمام، أبحث الآن', 'تمام بس للتأكيد', 'يا غالي، هسا بنرتبها', 'ماشي، بلّش']) {
      const { chat, systems } = intakeQueue([JSON.stringify({ reply_ar: phrase, task_en: TASK })]);
      const coordinator = new Coordinator({
        chat,
        dispatch: async () => ({ receipt: 'x' }),
        activeSessionId: () => undefined,
      });

      const ack = await coordinator.intake('اعرض الجلسات');

      expect(systems, `re-asked a clean ack: ${phrase}`).toHaveLength(1);
      expect(ack.replyAr).toBe(phrase);
    }
  });

  test('the system prompt states the timing rule, not just a style ban', async () => {
    const { chat, systems } = intakeQueue([CLEAN]);
    const coordinator = new Coordinator({
      chat,
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });

    await coordinator.intake('اعرض الجلسات');

    expect(systems[0]).toMatch(/nothing has run/i);
  });
});

// The gate's transport budget, and the invariant that raising it must not have
// moved.
//
// WHY THIS BLOCK EXISTS SEPARATELY FROM THE FR-12 SUITE ABOVE. The FR-12 tests
// assert that a destructive plan is held for approval. They do NOT assert which
// budget the gate call runs on, which is why a 6 s ceiling could ship against a
// 4.3 s p50 and close the product's only egress on roughly one turn in ten
// while every FR-12 test stayed green: the gate was failing CLOSED, which is
// precisely the behaviour those tests were built to enforce. A fail-closed
// regression is invisible to a suite that only checks fail-closed.
describe('gate transport budget', () => {
  test('the gate call carries the measured 12 s budget, not the shared 6 s default', () => {
    // The value itself. Measured 2026-09-30 on the gate's own path (31 calls,
    // p50 4349 ms, max 6607 ms); 6 s aborted 3 of them at ~6.01 s and each one
    // failed closed, so the turn dispatched nothing.
    expect(GATE_TIMEOUT_MS).toBe(12_000);

    // The spread ORDER, which is the part that rots. `timeoutMs` sits after the
    // `...ADDRESSEE_CHAT_OPTIONS` spread; moving it above the spread reverts the
    // gate to 6 s with no type error and no failing test anywhere else.
    let seen: { timeoutMs?: number } | null = null;
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: async (model, system, _user, options) => {
        if (system.includes('addressee gate')) {
          seen = (options ?? {}) as { timeoutMs?: number };
          return gateReplyFor(system);
        }
        return roleOf(system) === 'intake' ? INTAKE_OK : PLAN_OK;
      },
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });

    return coordinator
      .run('اعرض الجلسات')
      .then(() => {
        expect(seen).not.toBeNull();
        expect(seen!.timeoutMs).toBe(12_000);
        // Explicitly NOT the shared bundle's value. If someone edits
        // ADDRESSEE_CHAT_OPTIONS to something larger this is the assertion that
        // stops the gate silently drifting away from its own documented budget.
        expect(seen!.timeoutMs).not.toBe(6_000);
        expect(dispatched).toHaveLength(0);
      });
  });

  test('the raised budget does NOT make the gate fail open — a slow gate still asks', async () => {
    // The FR-12 invariant, restated against the specific change. This is the
    // test that matters most in this file: raising a budget is exactly the kind
    // of edit that can quietly become "give it more time and assume it worked".
    //
    // It must NOT. A gate call that never resolves must still reach the catch,
    // still ask, and still dispatch NOTHING. Approving is reachable only
    // through `permission.consume()` with an exact id match.
    const dispatched: string[] = [];
    let asks = 0;
    const coordinator = new Coordinator({
      chat: async (model, system) => {
        if (system.includes('addressee gate')) {
          // Simulates the transport aborting at the new ceiling.
          throw Object.assign(new Error('brain exceeded 12.0s ceiling'), { name: 'AbortError' });
        }
        return roleOf(system) === 'intake' ? INTAKE_OK : PLAN_OK;
      },
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'must_not_happen' };
      },
      onPermissionRequired: () => {
        asks += 1;
      },
      activeSessionId: () => 'ses_a' as never,
    });

    const result = await coordinator.run('اعرض الجلسات');

    // BREAK-THE-GUARD: change the gate's `catch` to `return { kind: 'proceed' }`
    // (or widen it to only rethrow), and this test fails — dispatched goes from
    // [] to one entry and detail stops being 'gate-unavailable'. Verified by
    // running that mutation; see the report.
    expect(dispatched).toEqual([]);
    expect(result.detail).toBe('gate-unavailable');
    expect(result.receipt).toBeNull();
    expect(asks).toBe(1);

    // The planner was never reached either: a gate that cannot decide spends
    // nothing downstream, which is the other half of "fails closed".
    expect(result.plan).toBeUndefined();
  });

  test('a gate timeout is reported as a timeout, not a dispatch', async () => {
    // One turn, one aborting gate. The result must be a structured
    // gate-unavailable ask and never a thrown provider error — the gate's
    // catch is the reason a free-tier outage is a question rather than silence.
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: async (model, system) => {
        if (system.includes('addressee gate')) throw new Error('upstream 500');
        return roleOf(system) === 'intake' ? INTAKE_OK : PLAN_OK;
      },
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'must_not_happen' };
      },
      activeSessionId: () => 'ses_a' as never,
    });

    const result = await coordinator.run('اعرض الجلسات');

    expect(dispatched).toEqual([]);
    expect(result.detail).toBe('gate-unavailable');
    expect(result.ok).toBe(false);
  });
});
