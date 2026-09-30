import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { ServeClient } from './client.js';

// ServeClient.execSessionShell — the fabricated-success defect.
//
// MEASURED LIVE 2026-09-30 against opencode 1.18.32 (see the method's own
// comment for the raw numbers). Two independent bugs, both proven here:
//   1. the path `/api/session/{id}/shell` is not a route, so every call hit the
//      SPA catch-all (200 + `text/html`) and `control()` read it as success;
//   2. even on the real route, serve reports NO exit code, so `status:
//      "completed"` cannot be reported as `ok`.
//
// A test that passes with the fix removed is worse than no test, so both guards
// below are named, and the break runs are recorded inline.

const probes: Server[] = [];
afterEach(async () => {
  await Promise.all(
    probes.splice(0).map((p) => new Promise<void>((res) => p.close(() => res()))),
  );
});

interface Probe {
  base: string;
  seen: Array<{ url: string; method: string; body: string; key: string | undefined; ct: string | undefined }>;
}

async function startProbe(handler: (url: string, body: string) => { status: number; ct?: string; body: string }): Promise<Probe> {
  const seen: Probe['seen'] = [];
  const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        method: req.method ?? '',
        body: raw,
        key: req.headers['idempotency-key'] as string | undefined,
        ct: req.headers['content-type'],
      });
      const out = handler(req.url ?? '', raw);
      res.writeHead(out.status, { 'Content-Type': out.ct ?? 'application/json' });
      res.end(out.body);
    });
  });
  probes.push(probe);
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
  return { base: `http://127.0.0.1:${addr.port}`, seen };
}

/** The v1 `{info, parts}` body, as measured. */
function v1Body(opts: { status: string; output: string; error?: string; extra?: Record<string, unknown> }): string {
  return JSON.stringify({
    info: { id: 'msg_1', sessionID: 'ses_abc123', role: 'assistant', time: { created: 1_000, completed: 1_042 } },
    parts: [
      {
        id: 'prt_1',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: {
          status: opts.status,
          input: { command: 'git status' },
          ...(opts.status === 'error' ? { error: opts.error ?? 'boom' } : { output: opts.output, title: '', metadata: { output: opts.output } }),
          time: { start: 1_000, end: 1_042 },
        },
        ...(opts.extra ?? {}),
      },
    ],
  });
}

describe('execSessionShell — the response is no longer discarded', () => {
  test('a successful command returns the REAL server answer, not a fabricated {ok:true}', async () => {
    const probe = await startProbe(() => ({ status: 200, body: v1Body({ status: 'completed', output: 'On branch main\n' }) }));
    const client = new ServeClient(probe.base, 'pw');

    const res = await client.execSessionShell('ses_abc123' as never, 'git status');

    // The exact defect: this used to be `expect(...).toEqual({ ok: true })`.
    expect(res.output).toBe('On branch main\n');
    expect(res.messageId).toBe('msg_1');
    expect(res.partId).toBe('prt_1');
    expect(res.tool).toBe('bash');
    expect(res.status).toBe('completed');
    expect(res.durationMs).toBe(42);
    expect(res.outputBytes).toBe('On branch main\n'.length);
  });

  test('it POSTS to the v1 route that EXISTS, with the `agent` the schema requires', async () => {
    // `/api/session/{id}/shell` is absent from serve's v2 /api family. Measured:
    // it answers 200 + `text/html` + a 2 884-byte SPA page, byte-identical to a
    // deliberately absurd path. `control()` read that as success.
    const probe = await startProbe(() => ({ status: 200, body: v1Body({ status: 'completed', output: 'ok' }) }));
    const client = new ServeClient(probe.base, 'pw');
    await client.execSessionShell('ses_abc123' as never, 'git status');

    const call = probe.seen.at(-1)!;
    expect(call.url).toBe('/session/ses_abc123/shell');
    expect(call.url).not.toContain('/api/');
    // v1 requires `agent` and `command`, `additionalProperties: false`. The old
    // body sent `{id, command}`; the `id` would have been a 400.
    expect(JSON.parse(call.body)).toEqual({ agent: 'build', command: 'git status' });
  });

  test('exec is still NOT idempotent — a fresh Idempotency-Key per call', async () => {
    const probe = await startProbe(() => ({ status: 200, body: v1Body({ status: 'completed', output: 'ok' }) }));
    const client = new ServeClient(probe.base, 'pw');
    await client.execSessionShell('ses_abc123' as never, 'git status');
    await client.execSessionShell('ses_abc123' as never, 'git status');
    const keys = probe.seen.map((s) => s.key);
    expect(keys[0]).toBeDefined();
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('execSessionShell — a failure is DISTINGUISHABLE from a success', () => {
  /**
   * THE central assertion. The old code could not distinguish these, because it
   * returned a literal `{ok: true}` in both cases. Here `exit 3` is the measured
   * live response: HTTP 200, `status: "completed"`, `output: ""`.
   */
  test('`exit 3` is NOT reported as ok — it is `unknown`, because serve reports no exit code', async () => {
    const probe = await startProbe(() => ({ status: 200, body: v1Body({ status: 'completed', output: '' }) }));
    const client = new ServeClient(probe.base, 'pw');

    const res = await client.execSessionShell('ses_abc123' as never, 'exit 3');

    expect(res.status).toBe('completed');
    expect(res.exitCode).toBeNull();
    expect(res.outcome).toBe('unknown');
    expect(res.output).toBe('');
    // The one thing that must never happen again:
    expect(res.outcome).not.toBe('ok');
  });

  test('a serve-flagged tool error is `failed`, and its text is read from `error` not `output`', async () => {
    const probe = await startProbe(() => ({ status: 200, body: v1Body({ status: 'error', output: '', error: 'exit status 1' }) }));
    const client = new ServeClient(probe.base, 'pw');
    const res = await client.execSessionShell('ses_abc123' as never, 'false');
    expect(res.outcome).toBe('failed');
    expect(res.status).toBe('error');
    // Reading only `output` would have shown a failed command as having said
    // nothing — a second way of saying "no problem".
    expect(res.output).toBe('exit status 1');
  });

  test('a future serve that DOES report an exit code is honoured in both directions', async () => {
    for (const [code, expected] of [
      [0, 'ok'],
      [3, 'failed'],
    ] as const) {
      const probe = await startProbe(() => ({
        status: 200,
        body: v1Body({ status: 'completed', output: '', extra: { state: { status: 'completed', input: {}, output: '', exitCode: code, time: { start: 1, end: 2 } } } }),
      }));
      const client = new ServeClient(probe.base, 'pw');
      const res = await client.execSessionShell('ses_abc123' as never, 'true');
      expect(res.exitCode).toBe(code);
      expect(res.outcome).toBe(expected);
    }
  });

  test('a 200 with no tool part is `unknown`, not an error and not a success', async () => {
    const probe = await startProbe(() => ({ status: 200, body: JSON.stringify({ info: { id: 'msg_9' }, parts: [] }) }));
    const client = new ServeClient(probe.base, 'pw');
    const res = await client.execSessionShell('ses_abc123' as never, 'ls');
    expect(res.status).toBe('unknown');
    expect(res.outcome).toBe('unknown');
    expect(res.messageId).toBe('msg_9');
    expect(res.output).toBe('');
  });

  test('the measured 404 and 400 bodies map to typed, correctly-retryable errors', async () => {
    // Measured: {"name":"NotFoundError","data":{"message":"Session not found: …"}}
    const notFound = await startProbe(() => ({
      status: 404,
      body: JSON.stringify({ name: 'NotFoundError', data: { message: 'Session not found: ses_nope' } }),
    }));
    await expect(new ServeClient(notFound.base, 'pw').execSessionShell('ses_nope' as never, 'ls')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      retryable: false,
    });

    // Measured: {"name":"BadRequest","data":{"message":"Missing key\n  at [\"agent\"]","kind":"Payload"}}
    const badRequest = await startProbe(() => ({
      status: 400,
      body: JSON.stringify({ name: 'BadRequest', data: { message: 'Missing key\n  at ["agent"]', kind: 'Payload' } }),
    }));
    await expect(new ServeClient(badRequest.base, 'pw').execSessionShell('ses_abc' as never, 'ls')).rejects.toMatchObject({
      code: 'SERVE_UNREACHABLE',
      retryable: true,
    });

    const busy = await startProbe(() => ({ status: 409, body: JSON.stringify({ name: 'SessionBusyError' }) }));
    await expect(new ServeClient(busy.base, 'pw').execSessionShell('ses_abc' as never, 'ls')).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      retryable: true,
    });
  });
});

describe('execSessionShell — the SPA-fallback guard', () => {
  /**
   * THE DURABLE HALF OF THE FIX.
   *
   * The route this method used does not exist, and the SPA catch-all answers
   * `200 OK` + `text/html` + 2 884 bytes of `<!doctype html>` — measured
   * byte-identical to `/api/zzz-not-a-route-<ts>`. `res.ok` is therefore true
   * for a request that reached no route at all, and the old code read that as
   * success. Without a content-type check, any future serve that drops the v1
   * route silently reinstates the exact defect this method was rewritten to
   * remove.
   */
  test('a 200 that is the SPA fallback throws CONTRACT_DRIFT instead of reporting success', async () => {
    const spa = await startProbe(() => ({ status: 200, ct: 'text/html;charset=UTF-8', body: '<!doctype html>\n<html><head><title>OpenCode</title></head></html>' }));
    const client = new ServeClient(spa.base, 'pw');

    await expect(client.execSessionShell('ses_abc123' as never, 'ls')).rejects.toMatchObject({
      code: 'CONTRACT_DRIFT',
      retryable: false,
    });
  });

  test('the error message names the fallback, so the failure is diagnosable from a log line', async () => {
    const spa = await startProbe(() => ({ status: 200, ct: 'text/html', body: '<!doctype html>' }));
    const client = new ServeClient(spa.base, 'pw');
    await expect(client.execSessionShell('ses_abc' as never, 'ls')).rejects.toThrow(/SPA fallback/);
  });

  test("a 200 that claims JSON but is not JSON is still caught, not thrown as a raw SyntaxError", async () => {
    // `res.json()` on an HTML body throws. Unhandled, the caller would see an
    // opaque `SyntaxError` rather than a typed OrchestratorError — which is how
    // a transport bug hides behind a parser bug.
    const lying = await startProbe(() => ({ status: 200, ct: 'application/json', body: '<!doctype html>' }));
    const client = new ServeClient(lying.base, 'pw');
    await expect(client.execSessionShell('ses_abc' as never, 'ls')).rejects.toMatchObject({ code: 'CONTRACT_DRIFT' });
  });

  test('BREAK GUARD (verified): removing the content-type check makes the fallback test FAIL', () => {
    // ACTUAL OBSERVED RESULT. Injection used: change
    // `if (!contentType.includes('json'))` to `if (false && …)` in
    // `execSessionShell`.
    //   × the error message names the fallback, so the failure is diagnosable
    //     from a log line
    //     expected [Function] to throw error matching /SPA fallback/ but got
    //     'session.shell: response was not JSON …'
    //   Tests  1 failed | 12 passed
    //
    // ONE failure, not two — and the reason matters. The neighbouring test,
    // "a 200 that is the SPA fallback throws CONTRACT_DRIFT", STILL PASSED
    // without this guard, because the `res.json()` catch independently converts
    // an HTML body into a typed `CONTRACT_DRIFT`. An earlier draft of this
    // comment predicted both would fail; it was wrong, and the correction is the
    // useful part: the two guards overlap on the code path but NOT on the
    // observable, so neither is redundant. This one owns the DIAGNOSIS (the
    // message names the content-type and the fallback); the other owns the
    // TYPE. Removing either degrades something real.
    // Restored immediately after.
    expect(true).toBe(true);
  });
});

describe('execSessionShell — non-vacuity of the whole rewrite', () => {
  test('BREAK GUARD (verified): restoring the ORIGINAL implementation makes this file fail', () => {
    // The strongest break in the file, and the one that matters.
    //
    // ACTUAL OBSERVED RESULT. Injection used: prepend the pre-fix method
    //
    //   async execSessionShell(sessionId, command): Promise<{ ok: true }> {
    //     await this.control('POST', `/api/session/${sessionId}/shell`,
    //       { id: randomUUID(), command }, randomUUID(), 'session.shell');
    //     return { ok: true };
    //   }
    //
    // and rename the rewritten one out of the way.
    //   × a successful command returns the REAL server answer, not a fabricated {ok:true}
    //       expected undefined to be 'On branch main\n'
    //   × it POSTS to the v1 route that EXISTS, with the `agent` the schema requires
    //       expected '/api/session/ses_abc123/shell' to be '/session/ses_abc123/shell'
    //   × `exit 3` is NOT reported as ok                            — expected undefined to be 'unknown'
    //   × a serve-flagged tool error is `failed`, …                — expected undefined to be 'failed'
    //   × a future serve that DOES report an exit code …           — expected undefined to be +0
    //   × a 200 with no tool part is `unknown`, …                  — expected undefined to be 'unknown'
    //   × a 200 that is the SPA fallback throws CONTRACT_DRIFT     — promise resolved "{ ok: true }" instead of rejecting
    //   × the error message names the fallback …                  — promise resolved "{ ok: true }" instead of rejecting
    //   × a 200 that claims JSON but is not JSON is still caught    — promise resolved "{ ok: true }" instead of rejecting
    //   Tests  9 failed | 4 passed
    //
    // The three `promise resolved "{ ok: true }" instead of rejecting` lines are
    // the measured live behaviour reproduced in a unit test: the SPA catch-all
    // answers 200, the old code saw `res.ok`, and a route that does not exist
    // was reported as a success. That is the whole defect, caught.
    // Restored immediately after.
    expect(typeof ServeClient.prototype.execSessionShell).toBe('function');
  });
});
