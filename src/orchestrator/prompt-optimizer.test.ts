import { describe, expect, test } from 'vitest';
import { isActionableInstruction, optimizePrompt, PROMPT_SYSTEM } from './prompt-optimizer.js';

// Phase 5 — the prompt optimization seam.
//
// A spoken instruction ("شوف لي الجلسات اللي فشلت") is converted into a
// structured, high-yield brief before it reaches an OpenCode session. The rule
// that keeps this honest: the optimizer IMPROVES an instruction, it never
// invents work. A greeting is not turned into a task.
describe('optimizePrompt', () => {
  const chat = (reply: string) => async () => reply;

  test('returns the model output verbatim — no template wrapping', async () => {
    const out = await optimizePrompt('قائمة الجلسات', chat('ROLE: ...\nGOAL: ...'), 'gpt-5');
    expect(out).toBe('ROLE: ...\nGOAL: ...');
  });

  test('hands the raw utterance AND the session context to the model', async () => {
    let user = '';
    await optimizePrompt(
      'شوف لي الجلسات اللي فشلت',
      async (_m, _s, u) => {
        user = u;
        return 'GOAL: list failed sessions';
      },
      'gpt-5',
      { sessionTitle: 'تشخيص الصوت', currentModel: 'nemotron', contextPercent: 64 },
    );
    expect(user).toContain('شوف لي الجلسات اللي فشلت');
    expect(user).toContain('تشخيص الصوت');
    expect(user).toContain('nemotron');
    expect(user).toContain('64');
  });

  test('falls back to the original text when the model is unavailable', async () => {
    // A degraded prompt is far better than silence: the user still gets their
    // request acted on, just unpolished. This is the ONE place a fallback is
    // correct, because the fallback is the user's own words, not a template.
    const out = await optimizePrompt('افتح الجلسات', async () => {
      throw new Error('down');
    }, 'gpt-5');
    expect(out).toBe('افتح الجلسات');
  });

  test('falls back when the model returns nothing usable', async () => {
    expect(await optimizePrompt('افتح الجلسات', chat('   '), 'gpt-5')).toBe('افتح الجلسات');
  });

  test('never returns an empty prompt', async () => {
    for (const reply of ['', '   ', '\n\n']) {
      expect((await optimizePrompt('س', chat(reply), 'gpt-5')).length).toBeGreaterThan(0);
    }
  });

  test('does not wrap the model output in extra commentary', async () => {
    const out = await optimizePrompt('س', chat('GOAL: x'), 'gpt-5');
    expect(out).not.toMatch(/^(إليك|Here is|Subject:)/);
    expect(out.trim()).toBe(out);
  });

  test('caps length so a rambling rewrite cannot become the prompt', async () => {
    const out = await optimizePrompt('س', chat('x'.repeat(4000)), 'gpt-5');
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});

describe('isActionableInstruction', () => {
  test('recognises a real instruction', () => {
    expect(isActionableInstruction('شوف لي الجلسات اللي فشلت')).toBe(true);
    expect(isActionableInstruction('افتح لوحة الموديلات')).toBe(true);
    expect(isActionableInstruction('why is the build failing')).toBe(true);
  });

  test('does NOT manufacture a task from small talk or an acknowledgement', () => {
    // Turning "تمام" into a prompt would make the assistant act on nothing.
    for (const small of ['تمام', 'اوك', 'شكرا', 'مرحبا', 'اهلا', 'نعم', 'تماما', 'حسنا', '']) {
      expect(isActionableInstruction(small), small).toBe(false);
    }
  });

  test('catches every known short acknowledgement, which is the real risk', () => {
    // The fast path exists so we do not spend a model call on politeness.
    // A long conversational sentence ("تمام شكرا جزيلا، أنا بخير") is NOT
    // caught here by design: robustly classifying free Arabic is the brain's
    // job, not a word list's. The gate is this check AND the coordinator's own
    // judgement, never this check alone.
    const known = [
      'تمام',
      'تمام.',
      'تمام!',
      'اوك',
      'شكرا',
      'شكرا جزيلا',
      'مرحبا',
      'حسنا',
      'يسلمو',
      '',
      '   ',
      '؟؟',
    ];
    for (const phrase of known) {
      expect(isActionableInstruction(phrase), phrase).toBe(false);
    }
  });

  test('a long conversational sentence is left to the brain, not guessed at', () => {
    // Documented limitation, asserted so it cannot regress silently.
    expect(isActionableInstruction('تمام شكرا جزيلا جدا، أنا بخير')).toBe(true);
  });

  test('treats a question as actionable (it still needs an answer)', () => {
    expect(isActionableInstruction('ما هو نموذج الجلسة الحالية؟')).toBe(true);
  });
});

describe('PROMPT_SYSTEM', () => {
  test('demands a structured brief', () => {
    expect(PROMPT_SYSTEM).toMatch(/ROLE|GOAL|دور|هدف/);
    expect(PROMPT_SYSTEM).toMatch(/CONSTRAINT|قيد/);
  });

  test('forbids inventing scope the user did not ask for', () => {
    expect(PROMPT_SYSTEM).toMatch(/لا تختلق|لا تضيف|بدون/s);
  });

  test('demands the same language the user spoke', () => {
    expect(PROMPT_SYSTEM).toMatch(/لغة|language|العربية|الإنجليزية/);
  });

  test('offers no worked example to copy', () => {
    expect(PROMPT_SYSTEM).not.toMatch(/مثال/);
  });
});
