import { describe, expect, test } from 'vitest';

import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { ServeClient } from '../runtime/client.js';
import { readToolInvocations, rowsAfter, toolInvocationsOfRow } from './driver-tools.js';

// HERMETIC. Nothing here opens a socket: the client is the same `{ request }`
// stand-in `serve.test.ts` uses, because `requestPathOf` binds `ServeClient`'s own
// private `request` and that is the seam under test.
//
// WHAT IS BEING GUARDED. `/session/{id}/message` is served by a server this project
// does not own, it answers `200 text/html` with a 2 884-byte SPA page for ANY
// unknown path, and `readTurn` deliberately throws away the tool name, arguments,
// result and timing this file exists to read. So the parser is defensive
// everywhere, and every guard below has the shape that would fail if it were
// removed.

const SES = 'ses_1' as SessionId;

/** A Response with the shapes measured on 1.18.32 (see `serve.test.ts`). */
function fakeResponse(init: { status?: number; contentType?: string | null; body?: string }): Response {
  const status = init.status ?? 200;
  const ct = init.contentType === undefined ? 'application/json' : init.contentType;
  const body = init.body ?? '[]';
  const payload = status === 204 || status === 304 ? null : body;
  return new Response(payload, { status, headers: ct === null ? {} : { 'content-type': ct } });
}

function clientOf(handler: (path: string, init: RequestInit) => Promise<Response>): ServeClient {
  return { request: handler } as unknown as ServeClient;
}

function jsonClient(body: unknown): ServeClient {
  return clientOf(async () => fakeResponse({ body: JSON.stringify(body) }));
}

/** The measured shape (`client.ts:522-526`), plus a second part of another type. */
function row(id: string, parentID: string | null, parts: unknown[]): unknown {
  return {
    info: { id, ...(parentID !== null ? { parentID } : {}), role: 'assistant' },
    parts,
  };
}

const TOOL_COMPLETED = {
  id: 'prt_1',
  type: 'tool',
  callID: 'call_abc',
  tool: 'bash',
  state: {
    status: 'completed',
    input: { command: 'npm test' },
    output: 'ok',
    title: 'npm test',
    time: { start: 1_000, end: 1_250 },
  },
};

const TOOL_ERROR = {
  id: 'prt_2',
  type: 'tool',
  callID: 'call_err',
  tool: 'read',
  state: { status: 'error', input: { path: 'nope' }, error: 'ENOENT: no such file', time: { start: 2_000, end: 2_010 } },
};

describe('parsing a tool part', () => {
  test('name, call id, status, args, result and the tool\'s OWN duration', () => {
    const rows = toolInvocationsOfRow(row('msg_1', 'msg_0', [TOOL_COMPLETED]));
    expect(rows).toHaveLength(1);
    const t = rows[0];
    expect(t?.name).toBe('bash');
    expect(t?.callId).toBe('call_abc');
    expect(t?.status).toBe('completed');
    expect(t?.args).toEqual({ command: 'npm test' });
    expect(t?.output).toBe('ok');
    expect(t?.title).toBe('npm test');
    // 250 ms, from `state.time`, NOT the wall clock of the read — the two are
    // different numbers and the transcript carries both under different names.
    expect(t?.ms).toBe(250);
    expect(t?.startedAt).toBe(1_000);
  });

  test('a failed tool carries `error`, and `output` does not swallow it', () => {
    // The `client.ts:573-576` lesson: reading only `output` renders a failed
    // command as one that produced no output, which is a second way of saying
    // nothing went wrong.
    const rows = toolInvocationsOfRow(row('msg_1', 'msg_0', [TOOL_ERROR]));
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.error).toBe('ENOENT: no such file');
    expect(rows[0]?.output).toBeNull();
    expect(rows[0]?.ms).toBe(10);
  });

  test('non-tool parts are skipped, and a text part is not a tool', () => {
    const rows = toolInvocationsOfRow(
      row('msg_1', 'msg_0', [
        { type: 'step-start' },
        { type: 'text', text: 'running the tests' },
        TOOL_COMPLETED,
        { type: 'step-finish', tokens: { input: 10 } },
      ]),
    );
    expect(rows.map((r) => r.name)).toEqual(['bash']);
  });

  test('a part with no timing reports null rather than 0', () => {
    // 0 is a measurement. A tool whose duration serve did not report has no
    // measured duration, and the transcript's `ms: 0` would read as instant.
    const rows = toolInvocationsOfRow(
      row('msg_1', 'msg_0', [{ type: 'tool', callID: 'c', tool: 'grep', state: { status: 'completed', output: '' } }]),
    );
    expect(rows[0]?.ms).toBeNull();
    expect(rows[0]?.startedAt).toBeNull();
    expect(rows[0]?.endedAt).toBeNull();
  });

  test('an absent input is null, not {} — an empty object reads as "ran with no args"', () => {
    const rows = toolInvocationsOfRow(row('msg_1', 'msg_0', [{ type: 'tool', callID: 'c', tool: 'ls', state: { status: 'pending' } }]));
    expect(rows[0]?.args).toBeNull();
    expect(rows[0]?.status).toBe('pending');
  });

  test('an unrecognised status is `unknown`, never optimistically `completed`', () => {
    const rows = toolInvocationsOfRow(row('msg_1', 'msg_0', [{ type: 'tool', tool: 'x', state: { status: 'weird-new-state' } }]));
    expect(rows[0]?.status).toBe('unknown');
  });

  test('an absent tool name is labelled, not left blank', () => {
    const rows = toolInvocationsOfRow(row('msg_1', 'msg_0', [{ type: 'tool', state: { status: 'completed' } }]));
    expect(rows[0]?.name).toBe('(unnamed)');
    expect(rows[0]?.callId).toBe('');
  });

  test('a huge output is bounded, and the overflow is stated', () => {
    const rows = toolInvocationsOfRow(
      row('msg_1', 'msg_0', [{ type: 'tool', tool: 'cat', state: { status: 'completed', output: 'x'.repeat(10_000) } }]),
    );
    const output = rows[0]?.output ?? '';
    expect(output.length).toBeLessThan(10_000);
    expect(output).toContain('+6000 chars');
  });

  test('a row that is not a row, and a part that is not a part, both yield nothing', () => {
    expect(toolInvocationsOfRow(null)).toEqual([]);
    expect(toolInvocationsOfRow('a string')).toEqual([]);
    expect(toolInvocationsOfRow({ parts: 'not an array' })).toEqual([]);
    expect(toolInvocationsOfRow({ info: { id: 'm' }, parts: [null, 42, 'x'] })).toEqual([]);
  });
});

describe('scoping to the turn that was dispatched', () => {
  test('the receipt is the USER row, so the filter is `parentID` and not `id`', () => {
    // `readTurn` measured this the hard way (`client.ts:1469-1485`): the message id
    // the driver holds belongs to the question, and the assistant row carrying the
    // tool calls names it as `parentID`.
    const user = row('msg_user', null, [{ type: 'text', text: 'do the thing' }]);
    const answer = row('msg_assistant', 'msg_user', [TOOL_COMPLETED]);
    const older = row('msg_older', 'msg_prev', [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }]);
    expect(rowsAfter([user, older, answer], 'msg_user').map((r) => (r as { info: { id: string } }).info.id)).toEqual(['msg_assistant']);
  });

  test('a null receipt returns EVERY row, and says so through `matched`', () => {
    // An unscoped read must be labelled unscoped rather than looking like a scoped
    // read that found nothing.
    const rows = [row('a', null, []), row('b', null, [])];
    expect(rowsAfter(rows, null)).toHaveLength(2);
  });
});

describe('reading through the product\'s own request path', () => {
  test('the request goes to `/session/{id}/message` with a GET', async () => {
    const seen: Array<{ path: string; method: string | undefined }> = [];
    const client = clientOf(async (path, init) => {
      seen.push({ path, method: init.method });
      return fakeResponse({ body: JSON.stringify([row('m1', 'm0', [TOOL_COMPLETED])]) });
    });
    const read = await readToolInvocations(client, SES, { afterRowId: 'm0' });
    expect(seen).toEqual([{ path: '/session/ses_1/message', method: 'GET' }]);
    expect(read.ok).toBe(true);
    expect(read.invocations).toHaveLength(1);
    expect(read.matched).toBe(1);
    expect(read.polls).toBe(1);
  });

  test('the SPA fallback is a CONTRACT_DRIFT, never "0 tools ran"', async () => {
    // A transcript that printed "no tool calls" from the catch-all page would be
    // reporting a web page as a session.
    const client = clientOf(async () => fakeResponse({ contentType: 'text/html', body: '<!doctype html>' }));
    const read = await readToolInvocations(client, SES, { afterRowId: 'm0' });
    expect(read.ok).toBe(false);
    expect(read.error).toContain('CONTRACT_DRIFT');
    expect(read.error).toContain('SPA fallback');
    expect(read.invocations).toEqual([]);
  });

  test('a 404 is SESSION_NOT_FOUND and a non-2xx is SERVE_UNREACHABLE', async () => {
    const missing = await readToolInvocations(clientOf(async () => fakeResponse({ status: 404, body: '' })), SES);
    expect(missing.error).toContain('SESSION_NOT_FOUND');

    const refused = await readToolInvocations(clientOf(async () => fakeResponse({ status: 500, body: 'boom' })), SES);
    expect(refused.error).toContain('SERVE_UNREACHABLE');
  });

  test('2xx that is not JSON is CONTRACT_DRIFT, not an empty list', async () => {
    const client = clientOf(async () => fakeResponse({ body: 'not json at all' }));
    const read = await readToolInvocations(client, SES);
    expect(read.ok).toBe(false);
    expect(read.error).toContain('CONTRACT_DRIFT');
  });

  test('a transport throw is reported with its code and does not poll', async () => {
    const client = clientOf(async () => {
      throw new OrchestratorError('SERVE_UNREACHABLE', true, 'serve request /session/ses_1/message failed: ECONNREFUSED');
    });
    const read = await readToolInvocations(client, SES, { deadlineMs: 10_000 });
    expect(read.ok).toBe(false);
    expect(read.error).toContain('ECONNREFUSED');
    // ONE read. A refusal is not going to become a tool part by waiting, and
    // retrying it 40 times would report "the session is gone" that many times.
    expect(read.polls).toBe(1);
  });

  test('both response shapes are read: a bare array, and `{data: []}`', async () => {
    // Measured at `client.ts:1456-1458`: neither surface is a superset of the
    // other, so a reader that handled only one would report a working session as
    // empty.
    const bare = await readToolInvocations(jsonClient([row('m1', 'm0', [TOOL_COMPLETED])]), SES);
    expect(bare.invocations).toHaveLength(1);
    const wrapped = await readToolInvocations(jsonClient({ data: [row('m1', 'm0', [TOOL_COMPLETED])] }), SES);
    expect(wrapped.invocations).toHaveLength(1);
  });

  test('an empty timeline is a successful read of zero rows', () => {
    // Distinct from "unreadable": a session with no messages has none, and that is
    // a fact rather than a failure.
    expect(toolInvocationsOfRow({})).toEqual([]);
  });
});

describe('the bounded poll', () => {
  test('it waits for the parts to exist, because an admission is not a completion', async () => {
    // `promptSession` returns an ADMISSION (`daemon.ts:250-265`): OpenCode is
    // already generating. A single read would report "no tools ran" for every turn
    // that ran them — the worst direction for an acceptance harness, because it
    // passes a broken agent and fails a working one.
    let attempt = 0;
    const client = clientOf(async () => {
      attempt += 1;
      return attempt < 3
        ? fakeResponse({ body: JSON.stringify([row('m1', 'm0', [{ type: 'step-start' }])]) })
        : fakeResponse({ body: JSON.stringify([row('m1', 'm0', [TOOL_COMPLETED])]) });
    });
    const slept: number[] = [];
    const read = await readToolInvocations(client, SES, {
      afterRowId: 'm0',
      deadlineMs: 10_000,
      intervalMs: 25,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(read.polls).toBe(3);
    expect(slept).toEqual([25, 25]);
    expect(read.invocations).toHaveLength(1);
  });

  test('the deadline is honoured and the wait is REPORTED, so a reader can distrust it', () => {
    // A number the reader cannot see is a number the reader cannot question.
    let clock = 0;
    const client = clientOf(async () => fakeResponse({ body: '[]' }));
    void readToolInvocations(client, SES, {
      deadlineMs: 100,
      intervalMs: 40,
      now: () => {
        clock += 60;
        return clock;
      },
      sleep: async () => undefined,
    });
    return expect(
      readToolInvocations(client, SES, {
        deadlineMs: 100,
        intervalMs: 40,
        now: () => {
          clock += 60;
          return clock;
        },
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ ok: true, polls: 1, invocations: [] });
  });

  test('deadlineMs 0 reads exactly once', async () => {
    let calls = 0;
    const client = clientOf(async () => {
      calls += 1;
      return fakeResponse({ body: '[]' });
    });
    await readToolInvocations(client, SES, { deadlineMs: 0, sleep: async () => undefined });
    expect(calls).toBe(1);
  });
});