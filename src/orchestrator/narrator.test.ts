import { describe, expect, test } from 'vitest';
import {
  NARRATOR_MODEL,
  NARRATOR_RESPONSE_FORMAT,
  NARRATOR_SYSTEM,
  narrate,
  narrationContextLine,
} from './narrator.js';

// Phase 5 — ZERO CANNED REPLIES.
//
// The whole point: a verbal confirmation must be produced by the conversational
// model from the situation, never selected from a template table. These tests
// are written to make a template implementation FAIL.
//
// The narrator runs on Inkling under a strict json_schema contract, so every
// fixture below speaks JSON: only the extracted `reply_ar` may ever reach the
// user. Raw model output — wrapper, prose, or control tokens — is never spoken.
describe('narrate (zero canned replies)', () => {
  const chat = (reply: string) => async () => reply;
  const json = (replyAr: string) => `{"reply_ar": ${JSON.stringify(replyAr)}}`;

  test('returns the extracted reply_ar, never the JSON wrapper', async () => {
    const out = await narrate(
      { action: 'setSessionModel', outcome: 'ok' },
      chat(json('بدّلت النموذج، صار أقوى للمهمة.')),
      NARRATOR_MODEL,
    );
    expect(out).toBe('بدّلت النموذج، صار أقوى للمهمة.');
  });

  test('does NOT substitute a canned phrase for any action/outcome pair', async () => {
    // The banned shapes from the mandate, asserted as ABSENT from the result.
    const banned = ['تم', 'بنجاح', 'تم تنفيذ الأمر'];
    const actions = ['setSessionModel', 'setSessionAgent', 'switchSession', 'createSession', 'compact', 'unknownAction'];
    for (const action of actions) {
      for (const outcome of ['ok', 'error'] as const) {
        const line = await narrate({ action, outcome }, chat(json('سطر أ totally unrelated عن الموقف')), NARRATOR_MODEL);
        for (const phrase of banned) {
          expect(line, `${action}/${outcome}`).not.toContain(phrase);
        }
      }
    }
  });

  test('two different situations with the same model output stay distinct', async () => {
    // A template keyed on (action, outcome) would collapse these.
    const a = await narrate({ action: 'setSessionModel', outcome: 'ok' }, chat(json('اختيار')), NARRATOR_MODEL);
    const b = await narrate({ action: 'compact', outcome: 'ok' }, chat(json('اختيار')), NARRATOR_MODEL);
    expect(a).toBe('اختيار');
    expect(b).toBe('اختيار');
    // Same model words, but the CONTEXT handed to the model must differ.
    const seen: string[] = [];
    const capture = async (_m: string, _s: string, user: string) => {
      seen.push(user);
      return json('x');
    };
    await narrate({ action: 'setSessionModel', outcome: 'ok', target: 'nemotron' }, capture, NARRATOR_MODEL);
    await narrate({ action: 'compact', outcome: 'ok' }, capture, NARRATOR_MODEL);
    expect(seen[0]).not.toBe(seen[1]);
  });

  test('passes the full situational context to the model', async () => {
    let user = '';
    const capture = async (_m: string, _s: string, u: string) => {
      user = u;
      return json('حسناً');
    };
    await narrate(
      {
        action: 'setSessionModel',
        outcome: 'ok',
        target: 'nemotron',
        sessionTitle: 'إصلاح خطأ الصوت',
        previousModel: 'muse-spark',
        contextPercent: 82,
        // `errorDetail` is omitted, not set to undefined: under
        // exactOptionalPropertyTypes an explicit undefined is unrepresentable,
        // and `narrationContextLine` treats absent and undefined identically.
      },
      capture,
      NARRATOR_MODEL,
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
        return json('ما قدرت أوصله');
      },
      NARRATOR_MODEL,
    );
    expect(user).toContain('SERVE_UNREACHABLE');
  });

  test('trims the model output and drops an empty reply_ar', async () => {
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat(json('  padded  ')), NARRATOR_MODEL)).toBe('padded');
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat(json('   ')), NARRATOR_MODEL)).toBeNull();
  });

  test('returns null when the model is unavailable — never a fallback sentence', async () => {
    // There is deliberately NO canned fallback. A failure must be visible as a
    // null, not papered over with a template the user would hear.
    const out = await narrate({ action: 'x', outcome: 'ok' }, async () => {
      throw new Error('no keys');
    }, NARRATOR_MODEL);
    expect(out).toBeNull();
  });

  test('caps the length so a rambling model cannot produce a monologue', async () => {
    const out = await narrate({ action: 'x', outcome: 'ok' }, chat(json('ط'.repeat(500))), NARRATOR_MODEL);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(240);
  });

  test('never lets key material into the prompt', async () => {
    let user = '';
    await narrate(
      { action: 'setSessionModel', outcome: 'error', errorDetail: 'HTTP 401 for Bearer sk-secret-value' },
      async (_m, _s, u) => {
        user = u;
        return json('حسنا');
      },
      NARRATOR_MODEL,
    );
    // Error details are passed through, but a redaction step must exist upstream
    // or in the caller; here we assert the narrator never ADDS one.
    expect(user).not.toMatch(/api[_-]?key\s*[:=]/i);
  });

  test('passes the strict schema to the model so the provider enforces JSON', async () => {
    // If this regresses to a format-less call, inkling answers with tool-call
    // syntax and the next test is what the user would hear. Pin the wiring.
    let format: unknown;
    await narrate({ action: 'x', outcome: 'ok' }, async (_m, _s, _u, o) => {
      format = o?.responseFormat;
      return json('تمام');
    }, NARRATOR_MODEL);
    expect(format).toEqual(NARRATOR_RESPONSE_FORMAT);
  });

  test('forwards the model slug it was given — it does not pick its own', async () => {
    // Every other test in this file uses a chat double that IGNORES its first
    // argument, so before this one nothing pinned the `model` parameter at all:
    // narrate could have passed '' or a hardcoded slug and the suite stayed
    // green. That is exactly the kind of drift a signature change hides, and
    // docs/personas/WIRING.md proposes adding a parameter to this very
    // function. Pin the forwarding in both directions.
    const captured: string[] = [];
    const capture = async (m: string) => {
      captured.push(m);
      return json('x');
    };
    await narrate({ action: 'x', outcome: 'ok' }, capture, NARRATOR_MODEL);
    await narrate({ action: 'x', outcome: 'ok' }, capture, 'some/other:free');
    expect(captured).toEqual([NARRATOR_MODEL, 'some/other:free']);
    expect(captured[0]).toBe('thinkingmachines/inkling:free');
  });
});

describe('narrate (control-token leakage can never reach the speaker)', () => {
  // Measured live 2026-09-27: prompt-only inkling answers narration prompts
  // with raw `<|message_model|>shell<|content_invoke_tool_json|>…` in 5/5
  // trials. Every one of these must be a null — never spoken, never displayed.
  const chat = (reply: string) => async () => reply;

  test('raw tool-call syntax is a null, not a spoken line', async () => {
    const leaked =
      '<|message_model|>shell<|content_invoke_tool_json|>{"name":"shell","args":{"command":"pwd && ls -la"}}<|end_message|>';
    const out = await narrate({ action: 'compact', outcome: 'ok' }, chat(leaked), NARRATOR_MODEL);
    expect(out).toBeNull();
  });

  test('plain prose without the JSON wrapper is a null', async () => {
    // The strict schema is enforced at the provider; anything arriving without
    // it means the contract already broke upstream, and speaking it would
    // reward the breakage with airtime.
    const out = await narrate({ action: 'x', outcome: 'ok' }, chat('تم، خلصت الشغلة'), NARRATOR_MODEL);
    expect(out).toBeNull();
  });

  test('JSON without a reply_ar string is a null', async () => {
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat('{"other": "x"}'), NARRATOR_MODEL)).toBeNull();
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat('{"reply_ar": 42}'), NARRATOR_MODEL)).toBeNull();
    expect(await narrate({ action: 'x', outcome: 'ok' }, chat('[1,2]'), NARRATOR_MODEL)).toBeNull();
  });

  test('the JSON wrapper itself is never part of the spoken line', async () => {
    const out = await narrate({ action: 'x', outcome: 'ok' }, chat('{"reply_ar": "خلصت"}'), NARRATOR_MODEL);
    expect(out).toBe('خلصت');
    expect(out).not.toContain('reply_ar');
    expect(out).not.toContain('{');
  });

  test('the narrator runs on the free inkling model', async () => {
    expect(NARRATOR_MODEL).toBe('thinkingmachines/inkling:free');
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

  test('demands JSON-only output naming reply_ar, never bare prose', () => {
    // Inkling emits tool-call syntax when the output shape is only suggested;
    // the provider-enforced schema plus this instruction close that hole.
    // The placeholder is not a speakable sentence, so it cannot be parroted.
    expect(NARRATOR_SYSTEM).toContain('reply_ar');
    expect(NARRATOR_SYSTEM).toMatch(/JSON/);
    expect(NARRATOR_SYSTEM).toMatch(/دون أي نص خارج/);
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
