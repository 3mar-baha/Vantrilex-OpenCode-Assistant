import { describe, expect, test } from 'vitest';
import { OpenRouterBrainClient, BRAIN_OPENROUTER_MODEL, openRouterChat } from './brain.js';

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
    expect(BRAIN_OPENROUTER_MODEL).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
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
    const counting = ((...args: unknown[]) => {
      calls += 1;
      return mockFetch([{ status: 429, body: {} }])(...(args as []));
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

  test('the four rejection causes are four different codes', async () => {
    const codes = new Set<string>();
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

describe('openRouterChat (shared P5 transport)', () => {
  test('posts model/system/user with json_object format and returns content', async () => {
    let seen = null;
    const fetchImpl = (async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), { status: 200 });
    });
    const content = await openRouterChat('k', 'm/slug', 'sys', 'hi', fetchImpl);
    expect(content).toBe('{"a":1}');
    expect(seen.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(seen.init.body);
    expect(body).toMatchObject({ model: 'm/slug', response_format: { type: 'json_object' } });
    expect(seen.init.headers['Authorization']).toBe('Bearer k');
  });

  test('401 rejects non-retryable; empty content rejects retryable', async () => {
    const denied = async () =>
      openRouterChat('k', 'm', 's', 'u', mockFetch([{ status: 401, body: { error: { message: 'bad' } } }]));
    await expect(denied()).rejects.toMatchObject({ retryable: false });
    const empty = async () =>
      openRouterChat('k', 'm', 's', 'u', mockFetch([{ status: 200, body: { choices: [{ message: { content: ' ' } }] } }]));
    await expect(empty()).rejects.toMatchObject({ retryable: true });
  });
});
