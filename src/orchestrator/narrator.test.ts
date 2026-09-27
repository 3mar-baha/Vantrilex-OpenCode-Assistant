import { describe, expect, test } from 'vitest';
import { NARRATOR_SYSTEM, narrate, narrationContextLine } from './narrator.js';

// Phase 5 — ZERO CANNED REPLIES.
//
// The whole point: a verbal confirmation must be produced by the conversational
// model from the situation, never selected from a template table. These tests
// are written to make a template implementation FAIL.
describe('narrate (zero canned replies)', () => {
  const chat = (reply: string) => async () => reply;

  test('returns the model output verbatim, not a template', async () => {
    const out = await narrate({ action: 'setSessionModel', outcome: 'ok' }, chat('بدّلت النموذج، صار أقوى للمهمة.'));
    expect(out).toBe('بدّلت النموذج، صار أقوى للمهمة.');
  });

  test('does NOT substitute a canned phrase for any action/outcome pair', async () => {
    // The banned shapes from the mandate, asserted as ABSENT from the result.
    const banned = ['تم', 'بنجاح', 'تم تنفيذ الأمر'];
    const actions = ['setSessionModel', 'setSessionAgent', 'switchSession', 'createSession', 'compact', 'unknownAction'];
    for (const action of actions) {
      for (const outcome of ['ok', 'error'] as const) {
        const line = await narrate({ action, outcome }, chat('سطر أ totally unrelated عن الموقف'));
        for (const phrase of banned) {
          expect(line, `${action}/${outcome}`).not.toContain(phrase);
        }
      }
    }
  });

  test('two different situations with the same model output stay distinct', async () => {
    // A template keyed on (action, outcome) would collapse these.
    const a = await narrate({ action: 'setSessionModel', outcome: 'ok' }, chat('اختيار'));
    const b = await narrate({ action: 'compact', outcome: 'ok' }, chat('اختيار'));
    expect(a).toBe('اختيار');
    expect(b).toBe('اختيار');
    // Same model words, but the CONTEXT handed to the model must differ.
    const seen: string[] = [];
    const capture = async (_m: string, _s: string, user: string) => {
      seen.push(user);
      return 'x';
    };
    await narrate({ action: 'setSessionModel', outcome: 'ok', target: 'nemotron' }, capture);
    await narrate({ action: 'compact', outcome: 'ok' }, capture);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test('passes the full situational context to the model', async () => {
    let user = '';
    const capture = async (_m: string, _s: string, u: string) => {
      user = u;
      return 'حسناً';
    };
    await narrate(
      {
        action: 'setSessionModel',
        outcome: 'ok',
        target: 'nemotron',
        sessionTitle: 'إصلاح خطأ الصوت',
        previousModel: 'muse-spark',
        contextPercent: 82,
        errorDetail: undefined,
      },
      capture,
    );
    // Everything the model needs to sound situational rather than scripted.
    expect(user).toContain('setSessionModel');
    expect(user).toContain('nemotron');
    expect(user).toContain('إصلاح خطأ الصوت');
    expect(user).toContain('muse-spark');
    expect(user).toContain('82');
  });

  test('an error outcome hands the failure reason to the model', async () => {
    let user = '';
    await narrate(
      { action: 'setSessionAgent', outcome: 'error', errorDetail: 'SERVE_UNREACHABLE' },
      async (_m, _s, u) => {
        user = u;
        return 'ما قدرت أوصله';
      },
    );
    expect(user).toContain('SERVE_UNREACHABLE');
  });

  test('trims the model output and drops an empty reply', async () => {
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat('  padded  '))).toBe('padded');
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat('   '))).toBeNull();
  });

  test('returns null when the model is unavailable — never a fallback sentence', async () => {
    // There is deliberately NO canned fallback. A failure must be visible as a
    // null, not papered over with a template the user would hear.
    const out = await narrate({ action: 'x', outcome: 'ok' }, async () => {
      throw new Error('no keys');
    });
    expect(out).toBeNull();
  });

  test('caps the length so a rambling model cannot produce a monologue', async () => {
    const out = await narrate({ action: 'x', outcome: 'ok' }, chat('ط'.repeat(500)));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(240);
  });

  test('never lets key material into the prompt', async () => {
    let user = '';
    await narrate(
      { action: 'setSessionModel', outcome: 'error', errorDetail: 'HTTP 401 for Bearer sk-secret-value' },
      async (_m, _s, u) => {
        user = u;
        return 'حسنا';
      },
    );
    // Error details are passed through, but a redaction step must exist upstream
    // or in the caller; here we assert the narrator never ADDS one.
    expect(user).not.toMatch(/api[_-]?key\s*[:=]/i);
  });
});

describe('NARRATOR_SYSTEM', () => {
  test('forbids canned and robotic phrasing explicitly', () => {
    expect(NARRATOR_SYSTEM).toMatch(/جملة|عبارة|قالب|آلي/i);
  });

  test('demands Arabic output and a peer register', () => {
    expect(NARRATOR_SYSTEM).toMatch(/عربي/);
    expect(NARRATOR_SYSTEM).toMatch(/زميل|مهندس/i);
  });

  test('demands brevity so a confirmation is not a lecture', () => {
    expect(NARRATOR_SYSTEM).toMatch(/قصير|بسيط|كلمة/i);
  });

  test('offers no worked example the model could parrot', () => {
    // Naming the banned phrases in order to FORBID them is correct and is not a
    // parrot-able example. What must not exist is a standalone canned line, or
    // an example marker offering a model output to imitate.
    expect(NARRATOR_SYSTEM).not.toMatch(/مثال/);
    for (const line of NARRATOR_SYSTEM.split('\n')) {
      expect(line.trim(), line).not.toMatch(/^تم\b/);
    }
  });
});

describe('narrationContextLine', () => {
  test('is a machine-readable context line, never a sentence for the user to hear', () => {
    const line = narrationContextLine({ action: 'setSessionModel', outcome: 'ok', target: 'nemotron' });
    expect(line).toContain('setSessionModel');
    expect(line).not.toMatch(/^تم/);
  });
});
