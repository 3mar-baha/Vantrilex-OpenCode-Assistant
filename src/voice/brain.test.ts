import { describe, expect, test } from 'vitest';
import {
  OpenRouterBrainClient,
  BRAIN_OPENROUTER_MODEL,
  openRouterChat,
  normalizeBrainJson,
  extractJson,
} from './brain.js';

// OpenRouter brain routing TDD — Bearer endpoint, project-default slug,
// strict JSON contract, retry semantics identical to the Groq path.
function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

const good = {
  choices: [{ message: { content: '{"intent":"followUp","control":"none","reply":"ok"}' } }],
};

describe('OpenRouterBrainClient', () => {
  test('uses the project-default OpenRouter slug and Bearer auth', async () => {
    expect(BRAIN_OPENROUTER_MODEL).toBe('thinkingmachines/inkling:free');
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(good), { status: 200 });
    }) as typeof fetch;
    const client = new OpenRouterBrainClient('test-key', undefined, fetchImpl);
    const { output, attempts } = await client.respond('hi', 'ctx');
    expect(output.intent).toBe('followUp');
    expect(attempts).toBe(1);
    expect(seen!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((seen!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    // Harness-gated models (inkling:free) 403 without an agentic UA.
    expect((seen!.init.headers as Record<string, string>)['User-Agent']).toBe('opencode/1.0 (Voxaura)');
    const body = JSON.parse(seen!.init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe(BRAIN_OPENROUTER_MODEL);
    expect(body['response_format']).toEqual({ type: 'json_object' });
  });

  test('retries transient empties, then succeeds', async () => {
    const client = new OpenRouterBrainClient(
      'k',
      undefined,
      mockFetch([
        { status: 200, body: { choices: [{ message: { content: '  ' } }] } },
        { status: 200, body: { choices: [{ message: { content: '' } }] } },
        { status: 200, body: good },
      ]),
    );
    const { attempts } = await client.respond('hi', 'ctx');
    expect(attempts).toBe(3);
  });

  test('persistent empties throw retryable; non-JSON and 401 throw non-retryable', async () => {
    // L24: these used to all carry code BRAIN_TIMEOUT. The codes are now honest
    // so a caller can tell a bad key from a bad completion from a slow network.
    const empty = new OpenRouterBrainClient(
      'k',
      undefined,
      mockFetch([{ status: 200, body: { choices: [{ message: { content: '' } }] } }]),
    );
    await expect(empty.respond('hi', 'ctx')).rejects.toMatchObject({ code: 'BRAIN_REJECTED', retryable: true });

    const bad = new OpenRouterBrainClient(
      'k',
      undefined,
      mockFetch([{ status: 200, body: { choices: [{ message: { content: 'not json at all' } }] } }]),
    );
    await expect(bad.respond('hi', 'ctx')).rejects.toMatchObject({ retryable: false });

    const denied = new OpenRouterBrainClient(
      'k',
      undefined,
      mockFetch([{ status: 401, body: { error: { message: 'bad key' } } }]),
    );
    await expect(denied.respond('hi', 'ctx')).rejects.toMatchObject({ retryable: false });
  });

  // L24 — the point of the change. Each cause must be separately identifiable,
  // because the user action differs: rotate the key, wait for quota, or retry.
  test('a rejected credential is BRAIN_AUTH, not a timeout', async () => {
    const c = new OpenRouterBrainClient('k', undefined, mockFetch([{ status: 403, body: {} }]));
    await expect(c.respond('hi', 'ctx')).rejects.toMatchObject({ code: 'BRAIN_AUTH', retryable: false });
  });

  test('HTTP 429 is RATE_LIMITED and is never retried', async () => {
    let calls = 0;
    const counting = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return mockFetch([{ status: 429, body: {} }])(...args);
    }) as unknown as typeof fetch;
    const c = new OpenRouterBrainClient('k', undefined, counting);
    await expect(c.respond('hi', 'ctx')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: false });
    // Retrying an exhausted quota just burns the same exhausted budget.
    expect(calls).toBe(1);
  });

  test('a 5xx is retryable and distinct from auth and quota', async () => {
    const c = new OpenRouterBrainClient('k', undefined, mockFetch([{ status: 503, body: {} }]));
    await expect(c.respond('hi', 'ctx')).rejects.toMatchObject({ code: 'BRAIN_REJECTED', retryable: true });
  });

  test('a genuine timeout is still BRAIN_TIMEOUT', async () => {
    // The one case the old code was actually named for must keep its name.
    const aborting = (() => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const c = new OpenRouterBrainClient('k', undefined, aborting);
    await expect(c.respond('hi', 'ctx')).rejects.toMatchObject({ code: 'BRAIN_TIMEOUT' });
  });

  test('the four rejection causes are four different codes', async () => {    const codes = new Set<string>();
    for (const [status, expected] of [
      [401, 'BRAIN_AUTH'],
      [429, 'RATE_LIMITED'],
      [503, 'BRAIN_REJECTED'],
    ] as const) {
      const c = new OpenRouterBrainClient('k', undefined, mockFetch([{ status, body: {} }]));
      try {
        await c.respond('hi', 'ctx');
      } catch (err) {
        codes.add((err as { code: string }).code);
        expect((err as { code: string }).code).toBe(expected);
      }
    }
    expect(codes.size).toBe(3);
  });
});

// Measured live on 2026-09-27 against the real free Nemotron model: the same
// prompt returned `"intent": "followUp"` on one call and a nested intent OBJECT
// on the next. A zod `.default()` does not rescue a wrong-typed value, so the
// object form failed the parse and the voice loop produced silence. These pin
// the recovery, using the exact shape the live model emitted.
describe('brain output normalization tolerates a non-deterministic model', () => {
  const liveObjectIntent = {
    intent: { name: 'answer', confidence: 1.0, slots: { topic: 'arithmetic' } },
    reply: 'أربع — 2+2=4',
  };

  test('recovers a reply when intent arrives as an object', () => {
    const out = normalizeBrainJson(liveObjectIntent);
    expect(out).not.toBeNull();
    expect(out?.reply).toBe('أربع — 2+2=4');
  });

  test('an unrecognised intent degrades to followUp rather than failing', () => {
    // Losing the intent is recoverable; losing the reply means the user hears
    // nothing, which is not.
    const out = normalizeBrainJson({ intent: { name: 'answer' }, reply: 'حاضر' });
    expect(out?.intent).toBe('followUp');
  });

  test('a recognisable intent inside the object is honoured', () => {
    const out = normalizeBrainJson({ intent: { name: 'control' }, reply: 'تمام' });
    expect(out?.intent).toBe('control');
  });

  test('intent is matched case-insensitively', () => {
    expect(normalizeBrainJson({ intent: 'NewSession', reply: 'x' })?.intent).toBe('newSession');
    expect(normalizeBrainJson({ intent: { name: 'FOLLOWUP' }, reply: 'x' })?.intent).toBe('followUp');
  });

  test('a bogus control value degrades to none, never to an unsafe action', () => {
    // `control` drives approve/cancel. An unrecognised value must not be able
    // to resolve to something that acts.
    const out = normalizeBrainJson({ intent: 'followUp', control: 'DELETE_EVERYTHING', reply: 'x' });
    expect(out?.control).toBe('none');
  });

  test('a valid control value survives the loose path', () => {
    expect(normalizeBrainJson({ intent: { name: 'control' }, control: 'approve', reply: 'x' })?.control).toBe('approve');
  });

  test('still returns null when there is genuinely no reply to speak', () => {
    // The fix must not turn "nothing salvageable" into an empty spoken line.
    expect(normalizeBrainJson({ intent: { name: 'answer' } })).toBeNull();
    expect(normalizeBrainJson({ intent: 'followUp', outcome: '', identity: '' })).toBeNull();
  });

  test('the exact live shape no longer costs the user their reply', () => {
    // End-to-end through the client, with the model returning the object form.
    const c = new OpenRouterBrainClient(
      'k',
      undefined,
      mockFetch([
        {
          status: 200,
          body: { choices: [{ message: { content: JSON.stringify(liveObjectIntent) } }] },
        },
      ]),
    );
    return expect(c.respond('hi', 'ctx')).resolves.toMatchObject({
      output: { reply: 'أربع — 2+2=4' },
    });
  });
});

describe('openRouterChat (shared P5 transport)', () => {
  test('posts model/system/user with json_object format and returns content', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), { status: 200 });
    }) as typeof fetch;
    const content = await openRouterChat('k', 'm/slug', 'sys', 'hi', fetchImpl);
    expect(content).toBe('{"a":1}');
    expect(seen!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({ model: 'm/slug', response_format: { type: 'json_object' } });
    expect((seen!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
    expect((seen!.init.headers as Record<string, string>)['User-Agent']).toBe('opencode/1.0 (Voxaura)');
  });

  test('401 rejects non-retryable; empty content rejects retryable', async () => {
    const denied = async () =>
      openRouterChat('k', 'm', 's', 'u', mockFetch([{ status: 401, body: { error: { message: 'bad' } } }]));
    // Same honest codes as the BrainClient path: a refused credential is not
    // a timeout, and quota exhaustion must be identifiable, not retried.
    await expect(denied()).rejects.toMatchObject({ code: 'BRAIN_AUTH', retryable: false });
    const limited = async () =>
      openRouterChat('k', 'm', 's', 'u', mockFetch([{ status: 429, body: {} }]));
    await expect(limited()).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: false });
    const empty = async () =>
      openRouterChat('k', 'm', 's', 'u', mockFetch([{ status: 200, body: { choices: [{ message: { content: ' ' } }] } }]));
    await expect(empty()).rejects.toMatchObject({ code: 'BRAIN_REJECTED', retryable: true });
  });
});

describe('extractJson (first complete object wins)', () => {
  // Measured live 2026-09-27: inkling under a repetition habit emits
  // `{"reply_ar": "…"}{"reply_ar": "…truncated`. First-brace-to-last-brace
  // spans that into unparseable garbage and the turn goes silent. The fix
  // takes the first balanced object; the legacy whole-span parse remains as
  // fallback for shapes the scanner cannot close.
  test('two concatenated objects yield the first', () => {
    expect(extractJson('{"reply_ar": "خلصت"}{"reply_ar": "ناقص')).toEqual({ reply_ar: 'خلصت' });
  });

  test('the exact live inkling shape parses', () => {
    const live =
      '{"reply_ar": "تم تفعيل muse-spark للجلسة، جاهز للمهمة الصعبة."}' +
      '{"reply_ar": "muse-spark جاهز، يبدو أنه سيحتاج تر';
    expect(extractJson(live)).toEqual({ reply_ar: 'تم تفعيل muse-spark للجلسة، جاهز للمهمة الصعبة.' });
  });

  test('braces inside strings do not corrupt the boundary', () => {
    expect(extractJson('{"reply_ar": "نص { ليس كائناً } تمام"}')).toEqual({
      reply_ar: 'نص { ليس كائناً } تمام',
    });
  });

  test('escaped quotes inside strings do not end the scan early', () => {
    expect(extractJson('{"reply_ar": "قال \\"تمام\\" ومشى"}')).toEqual({ reply_ar: 'قال "تمام" ومشى' });
  });

  test('prose around a single object still parses (legacy behavior)', () => {
    expect(extractJson('sure: {"a": 1} done')).toEqual({ a: 1 });
  });

  test('fenced blocks still parse (legacy behavior)', () => {
    expect(extractJson('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
  });

  test('no JSON, or an unclosable object, is null', () => {
    expect(extractJson('just words')).toBeNull();
    expect(extractJson('{"reply_ar": "never closes')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
