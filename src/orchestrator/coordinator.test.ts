import { describe, expect, test } from 'vitest';
import { Coordinator, INTAKE_MODEL, COORDINATOR_MODEL, buildHandoff } from './coordinator.js';
import type { CoordinatorDeps } from './coordinator.js';
import { isSpeakable } from '../voice/tts.js';

// P5 TDD — Dots3 intake → Inkling plan → Inkling handoff dispatch.
// Fast verbal reply first, structured failure never throws out.
function chatFor(responses: Record<string, string>): (model: string, _s: string, _u: string) => Promise<string> {
  return async (model: string) => {
    if (!(model in responses)) throw new Error(`unexpected model call: ${model}`);
    return responses[model] as string;
  };
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
    expect(INTAKE_MODEL).toBe('dots-studio/dots-3-note-preview:free');
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
      chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK }),
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
    const result = await coordinator.run('show me sessions', { taskId: 'm_hang' });
    expect(speakStarted).toBe(true);
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
        chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK }),
        speak: async () => {
          throw new Error('fish down');
        },
        dispatch: async () => ({ receipt: 'msg_ok' }),
        activeSessionId: () => 'ses_a' as never,
      });
      const result = await coordinator.run('show me sessions', { taskId: 'm_reject' });
      expect(result.ok).toBe(true);
      // Let the detached rejection settle before asserting it was reported.
      await new Promise((r) => setTimeout(r, 0));
      expect(errors).toHaveLength(1);
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
        chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK }),
        speak: async () => {
          throw new Error('fish 401 with sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        },
        dispatch: async () => ({ receipt: 'msg_ok' }),
        activeSessionId: () => 'ses_a' as never,
      });
      await coordinator.run('show me sessions', { taskId: 'm_redact' });
      await new Promise((r) => setTimeout(r, 0));
      expect(errors).toHaveLength(1);
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
        return chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK })(model, system, user);
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
        return chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK })(model, system, user);
      },
      dispatch: async () => ({ receipt: 'r' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('hi');
    expect(systems[0]).not.toContain('SITUATION:');
    expect(result.ok).toBe(true);
  });

  test('full mission: speak first, then dispatch handoff with receipt', async () => {
    const order: string[] = [];
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK }),
      speak: async (text) => void order.push(`speak:${text}`),
      dispatch: async (text) => {
        order.push('dispatch');
        dispatched.push(text);
        return { receipt: 'msg_9' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('show me sessions', { taskId: 'm1' });
    expect(result.ok).toBe(true);
    expect(result.replyAr).toBe('تمام، أبحث الآن');
    expect(result.taskEn).toBe('List all sessions and report their states');
    expect(result.receipt).toBe('msg_9');
    // Fast verbal response precedes dispatch.
    expect(order).toEqual(['speak:تمام، أبحث الآن', 'dispatch']);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('[HANDOFF from=Nemotron to=Inkling task=m1]');
    expect(dispatched[0]).toContain('ses_a');
  });

  test('invalid intake JSON fails gracefully with no dispatch', async () => {
    let dispatched = 0;
    let spoken = 0;
    const coordinator = new Coordinator({
      chat: chatFor({ [INTAKE_MODEL]: 'not json at all', [COORDINATOR_MODEL]: 'still not json' }),
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
    const calls: Array<{ model: string; options: unknown }> = [];
    const coordinator = new Coordinator({
      chat: async (model: string, _s: string, _u: string, options?: unknown) => {
        calls.push({ model, options });
        return model === INTAKE_MODEL ? INTAKE_OK : PLAN_OK;
      },
      dispatch: async () => ({ receipt: 'msg_d' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('hi', { taskId: 'm3' });
    expect(result.ok).toBe(true);
    expect(result.intakeModel).toBe(INTAKE_MODEL);
    expect(result.receipt).toBe('msg_d');
    expect(calls[0]).toEqual({
      model: INTAKE_MODEL,
      options: { reasoning: { effort: 'none' }, maxTokens: 200, temperature: 0.2, timeoutMs: 10_000 },
    });
    // Coordinator stage runs with strict schema enforcement and a planning ceiling.
    expect(calls[1]).toMatchObject({
      model: COORDINATOR_MODEL,
      options: { timeoutMs: 25_000, temperature: 0.2, maxTokens: 300 },
    });
    expect((calls[1] as { options: { responseFormat: { type: string } } }).options.responseFormat.type).toBe(
      'json_schema',
    );
  });

  test('a dead primary fails over to the fallback intake model', async () => {
    const seen: string[] = [];
    const script: Array<{ model: string; reply: string } | { model: string; error: string }> = [
      { model: INTAKE_MODEL, error: 'dots unreachable' },
      { model: COORDINATOR_MODEL, reply: INTAKE_OK },
      { model: COORDINATOR_MODEL, reply: PLAN_OK },
    ];
    const coordinator = new Coordinator({
      chat: async (model: string) => {
        seen.push(model);
        const next = script.shift();
        if (next === undefined || next.model !== model) throw new Error(`out-of-script call: ${model}`);
        if ('error' in next) throw new Error(next.error);
        return next.reply;
      },
      dispatch: async () => ({ receipt: 'msg_f' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('hi', { taskId: 'm9' });
    expect(result.ok).toBe(true);
    expect(result.intakeModel).toBe(COORDINATOR_MODEL);
    expect(result.receipt).toBe('msg_f');
    expect(seen).toEqual([INTAKE_MODEL, COORDINATOR_MODEL, COORDINATOR_MODEL]);
  });

  test('prose plan triggers exactly one sterner retry, then succeeds', async () => {
    const systems: string[] = [];
    let plans = 0;
    const coordinator = new Coordinator({
      chat: async (model: string, system: string) => {
        systems.push(system);
        if (model === INTAKE_MODEL) return INTAKE_OK;
        plans += 1;
        return plans === 1 ? 'just some prose, no json here' : PLAN_OK;
      },
      dispatch: async () => ({ receipt: 'msg_r' }),
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('hi');
    expect(result.ok).toBe(true);
    expect(result.receipt).toBe('msg_r');
    expect(result.plan?.steps).toHaveLength(2);
    expect(plans).toBe(2);
    expect(systems[systems.length - 1]).toContain('CRITICAL');
  });

  test('invalid plan JSON still speaks, but never dispatches', async () => {
    const spoken: string[] = [];
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: 'oops' }),
      speak: async (text) => void spoken.push(text),
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    const result = await coordinator.run('hi');
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('plan-invalid');
    expect(spoken).toEqual(['تمام، أبحث الآن']);
    expect(dispatched).toHaveLength(0);
  });

  test('destructive plan is held for confirmation, then executes on approve', async () => {
    const evil = JSON.stringify({ steps: [{ id: 's1', kind: 'shell', detail: 'rm -rf build output' }] });
    const dispatched: string[] = [];
    const coordinator = new Coordinator({
      chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: evil }),
      dispatch: async (text) => {
        dispatched.push(text);
        return { receipt: 'msg_z' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    const held = await coordinator.run('clean it');
    expect(held.ok).toBe(false);
    expect(held.needsConfirmation).toBe(true);
    expect(dispatched).toHaveLength(0);
    const approved = await coordinator.run('clean it', { approve: true });
    expect(approved.ok).toBe(true);
    expect(approved.receipt).toBe('msg_z');
    expect(dispatched).toHaveLength(1);
  });

  test('no active session returns the plan with a null receipt', async () => {
    let dispatched = 0;
    const coordinator = new Coordinator({
      chat: chatFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK }),
      dispatch: async () => {
        dispatched += 1;
        return { receipt: 'x' };
      },
      activeSessionId: () => undefined,
    });
    const result = await coordinator.run('hi');
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
  function modelsFor(responses: Record<string, string>) {
    const seen: string[] = [];
    const chat = async (model: string): Promise<string> => {
      seen.push(model);
      const out = responses[model];
      if (out === undefined) throw new Error(`unexpected model call: ${model}`);
      return out;
    };
    return { seen, chat };
  }

  test('intake returns an ack WITHOUT the coordinator model ever being called', async () => {
    // This is the latency claim in test form. Measured intake p50 is 901 ms and
    // plan p50 1950 ms; if intake touched the planner there would be nothing
    // to gain by splitting the method at all.
    const { seen, chat } = modelsFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK });
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
    const { seen, chat } = modelsFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK });
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
    const mission = await coordinator.plan(ack, { taskId: 'task-x' });

    // Exactly two model calls total: one intake (above), one plan. A `plan()`
    // that called intake again would show a SECOND INTAKE_MODEL call here, and
    // would double the 901 ms the split was built to hide.
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
      chat: async (model) => {
        if (model === INTAKE_MODEL) return INTAKE_OK;
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
    const { seen, chat } = modelsFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: PLAN_OK });
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
    const { chat } = modelsFor({ [INTAKE_MODEL]: INTAKE_OK, [COORDINATOR_MODEL]: destructive });
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
        if (model === COORDINATOR_MODEL) return PLAN_OK;
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
    const mission = await coordinator.plan(ack, { taskId: 'task-6a' });
    expect(mission.ok).toBe(true);
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
