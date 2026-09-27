import { describe, expect, test } from 'vitest';
import { Coordinator, INTAKE_MODEL, COORDINATOR_MODEL, buildHandoff } from './coordinator.js';

// P5 TDD — Dots3 intake → Nemotron plan → Inkling handoff dispatch.
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
    expect(COORDINATOR_MODEL).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
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