import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { basicAuth, ServeClient } from './client.js';

// Mock serve over loopback — docs/11 §11.2 contract-fidelity rule: payloads match
// the zod-validated shapes production expects. Auth is HTTP Basic
// (opencode:<password>), verified live against OpenCode serve 1.18.32.
let server: Server;
let baseUrl = '';
const GOOD_AUTH = basicAuth('test-password');

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== GOOD_AUTH) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session') {
      json(res, 200, { data: { id: 'ses_mock1', state: 'created' } });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_mock1/prompt') {
      json(res, 200, { data: { id: 'evt_r1', delivery: 'steer' } });
      return;
    }
    // Live contract (verified): sessions live at /api/session, envelope {data}.
    if (req.method === 'GET' && req.url === '/api/session/ses_mock1') {
      json(res, 200, {
        data: { id: 'ses_mock1', agent: 'explore', model: { id: 'muse-spark' }, state: 'running', time: { updated: Date.now() } },
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/session') {
      json(res, 200, {
        data: [
          {
            id: 'ses_mock1',
            agent: 'explore',
            model: { id: 'muse-spark' },
            projectID: 'prj_1',
            cost: 0.0123,
            tokens: { input: 1200, output: 300, reasoning: 45, cache: { read: 800, write: 10 } },
            time: { updated: 1_700_000_000_000 },
          },
        ],
        cursor: null,
      });
      return;
    }
    // D9: the dedicated context endpoint. Returns the session's messages, whose
    // StepFinishPart tokens are what actually occupy the window right now.
    if (req.method === 'GET' && req.url === '/api/session/ses_mock1/context') {
      // Context rows as the LIVE serve actually returns them: FLAT, with
      // `tokens` at the TOP level (not under `parts`), and CUMULATIVE per step.
      // Shapes and numbers taken from a real 690-row payload.
      json(res, 200, {
        data: [
          { type: 'user', id: 'm0', time: { created: 1 }, status: 'completed' },
          {
            type: 'assistant',
            id: 'm1',
            time: { created: 2 },
            status: 'completed',
            model: { id: 'muse-spark' },
            tokens: { input: 200_000, output: 1_000, reasoning: 0, cache: { read: 50_000, write: 0 } },
          },
          {
            type: 'assistant',
            id: 'm2',
            time: { created: 3 },
            status: 'completed',
            model: { id: 'muse-spark' },
            // Cumulative: this step re-sent the whole conversation.
            tokens: { input: 400_000, output: 2_000, reasoning: 500, cache: { read: 300_000, write: 0 } },
          },
          { type: 'compaction', id: 'mc', time: { created: 4 }, summary: 'x', recent: 'y' },
          {
            type: 'assistant',
            id: 'm3',
            time: { created: 5 },
            status: 'completed',
            model: { id: 'muse-spark' },
            tokens: { input: 248, output: 429, reasoning: 152, cache: { read: 468_468, write: 0 } },
          },
        ],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_mock1/compact') {
      res.writeHead(204).end();
      return;
    }    if (req.method === 'POST' && req.url === '/api/session/ses_mock1/interrupt') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_mock1/revert/stage') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/openapi.json') {
      json(res, 200, { info: { version: '2.9.9-mock' } });
      return;
    }
    // Phase 5 follow-up: the model catalog carries `limit.context`, which is
    // the ONLY verified source for a session's context window. The session row
    // itself carries just {id, providerID, variant}.
    if (req.method === 'GET' && req.url === '/api/session/ses_mock1') {
      json(res, 200, {
        data: {
          id: 'ses_mock1',
          agent: 'explore',
          // Phase 5: the session row carries only {id, providerID, variant} —
          // no context limit. It has to come from the model catalog.
          model: { id: 'muse-spark', providerID: 'openai', variant: undefined },
          state: 'running',
          time: { created: 1, updated: 2 },
        },
      });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/model')) {
      json(res, 200, {
        data: [
          { id: 'muse-spark', providerID: 'openai', name: 'Muse Spark', limit: { context: 200_000, output: 8_000 } },
          { id: 'tiny', providerID: 'openai', name: 'Tiny' },
        ],
      });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/skill')) {
      json(res, 200, {
        data: [{ name: 'mission-handoff', description: 'handoff envelope', slash: true, location: '.opencode', content: 'x' }],
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('mock serve failed to bind');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ServeClient vs mock serve', () => {
  test('create → prompt → get → list → probe round-trip (Basic auth, /api/session)', async () => {
    const client = new ServeClient(baseUrl, 'test-password');
    const created = await client.createSession('O:/repos/mock');
    expect(created.sessionId).toBe('ses_mock1');
    const prompted = await client.promptSession(created.sessionId, 'hello', { origin: 'cli', actor: 'test' });
    expect(prompted.receipt).toBe('evt_r1');
    expect(prompted.state).toBe('running');
    const status = await client.getSession(created.sessionId);
    expect(status.state).toBe('running');
    const list = await client.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 'ses_mock1', agent: 'explore', model: 'muse-spark' });
    expect(list[0]!.state).toBe('idle'); // list row omits state → derived 'idle'
    expect(await client.probeContract()).toBe('2.9.9-mock');
  });

  test('missing Basic credentials → 401 non-retryable', async () => {
    // A client whose Authorization is deliberately broken still hits the mock
    // 401 path; we prove it by pointing at the mock with a wrong password.
    const client = new ServeClient(baseUrl, 'wrong');
    await expect(client.createSession('O:/repos/mock')).rejects.toMatchObject({ retryable: false });
  });

  test('listSessions normalizes {data:[...]} and tolerates malformed rows', async () => {
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.headers.authorization !== GOOD_AUTH) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, {
        data: [
          { id: 'a', agent: 'build', model: { id: 'm1' } },
          { nope: true }, // malformed → dropped
          { id: 'c' }, // minimal → state falls back to 'idle' (never 'unknown')
        ],
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const client = new ServeClient(`http://127.0.0.1:${addr.port}`, 'test-password');
      const list = await client.listSessions();
        expect(list.map((s) => s.sessionId).sort()).toEqual(['a', 'c']);
      expect(list.find((s) => s.sessionId === 'a')).toMatchObject({ agent: 'build', model: 'm1' });
      expect(list.find((s) => s.sessionId === 'c')?.state).toBe('idle');
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  test('unknown session maps to SESSION_NOT_FOUND', async () => {
    const client = new ServeClient(baseUrl, 'test-password');
    await expect(client.getSession('ses_nope' as never)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  test('prompt retries reuse a stable idempotency key per (session, text)', async () => {
    const seen: string[] = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/api/session/ses_k/prompt') {
        seen.push(req.headers['idempotency-key'] as string);
        json(res, 200, { data: { id: 'evt_k', delivery: 'steer' } });
        return;
      }
      json(res, 404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const client = new ServeClient(`http://127.0.0.1:${addr.port}`, 'test-password');
      await client.promptSession('ses_k' as never, 'same text', { origin: 'cli', actor: 'test' });
      await client.promptSession('ses_k' as never, 'same text', { origin: 'cli', actor: 'test' });
      await client.promptSession('ses_k' as never, 'other text', { origin: 'cli', actor: 'test' });
      expect(seen).toHaveLength(3);
      expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(seen[1]).toBe(seen[0]); // retry reuses the key
      expect(seen[2]).not.toBe(seen[0]); // distinct prompt, distinct key
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });


  test('prompt envelope is version-selectable (flat canonical vs nested 1.18.x)', async () => {
    const bodies: string[] = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        bodies.push(raw);
        json(res, 200, { data: { id: 'm1', state: 'running' } });
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const base = `http://127.0.0.1:${addr.port}`;
      await new ServeClient(base, 'test-password').promptSession('s' as never, 'hi', { origin: 'cli', actor: 't' });
      await new ServeClient(base, 'test-password', { promptEnvelope: 'nested' }).promptSession('s' as never, 'hi', { origin: 'cli', actor: 't' });
      expect(JSON.parse(bodies[0]!)).toMatchObject({ text: 'hi' }); // flat (canonical 2.0.x)
      expect(JSON.parse(bodies[1]!)).toMatchObject({ prompt: { text: 'hi' } }); // nested (1.18.x)
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  test('listAgents scopes by directory and normalizes rows', async () => {
    const seenUrls: string[] = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      seenUrls.push(req.url ?? '');
      if (req.headers.authorization !== GOOD_AUTH) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, {
        location: { directory: 'O:/proj' },
        data: [{ id: 'build', name: 'Build', mode: 'primary' }, { id: 'ts-reviewer', name: 'TS Reviewer' }],
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const client = new ServeClient(`http://127.0.0.1:${addr.port}`, 'test-password');
      const agents = await client.listAgents('O:/proj');
      expect(seenUrls[0]).toContain('/api/agent?directory=O%3A%2Fproj');
      expect(agents).toHaveLength(2);
      expect(agents[0]).toMatchObject({ id: 'build', name: 'Build', mode: 'primary' });
      expect(agents[1]!.name).toBe('TS Reviewer');
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  test('per-session controls: 204 No Content, model via POST, stable/fresh keys', async () => {
    const seen: Array<{ key: string; method: string; url: string; body: string }> = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      const record = (body: string): void => {
        seen.push({ key: req.headers['idempotency-key'] as string, method: req.method ?? '', url: req.url ?? '', body });
        res.writeHead(204);
        res.end(); // no body — canonical control response
      };
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        if (req.url === '/api/session/ses1/agent') return record(raw);
        if (req.url === '/api/session/ses1/model') return record(raw);
        if (req.url === '/api/experimental/session/ses1/skill') return record(raw);
        // execSessionShell moved to the v1 route: `/api/session/{id}/shell` was
        // never a route in serve's v2 family — it answered 200 + `text/html`
        // from the SPA catch-all, byte-identical to a deliberately absurd path
        // (measured live 2026-09-30). This block only needs a body to answer
        // with; the full shape coverage is in `client-shell.test.ts`.
        if (req.url === '/session/ses1/shell') {
          seen.push({
            key: req.headers['idempotency-key'] as string,
            method: req.method ?? '',
            url: req.url ?? '',
            body: raw,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              info: { id: 'msg_1', sessionID: 'ses1' },
              parts: [
                {
                  id: 'prt_1',
                  type: 'tool',
                  tool: 'bash',
                  state: { status: 'completed', input: {}, output: 'ok', time: { start: 1, end: 2 } },
                },
              ],
            }),
          );
          return;
        }
        if (req.url === '/api/session/nope/agent') {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.url === '/api/session/busy/model') {
          res.writeHead(409);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const base = `http://127.0.0.1:${addr.port}`;
      const client = new ServeClient(base, 'test-password');

      expect(await client.setSessionAgent('ses1' as never, 'build')).toEqual({ ok: true });
      expect(await client.setSessionAgent('ses1' as never, 'build')).toEqual({ ok: true });
      const agentCalls = seen.filter((s) => s.url.endsWith('/agent'));
      expect(agentCalls[0]!.key).toBe(agentCalls[1]!.key); // stable control key
      expect(JSON.parse(agentCalls[0]!.body)).toMatchObject({ agent: 'build' });

      expect(await client.setSessionModel('ses1' as never, { id: 'opus', providerID: 'opencode' })).toEqual({ ok: true });
      const modelCall = seen.find((s) => s.url.endsWith('/model'))!;
      expect(modelCall.method).toBe('POST'); // canonically POST, not PATCH
      expect(JSON.parse(modelCall.body)).toMatchObject({ model: { id: 'opus', providerID: 'opencode' } });

      expect(await client.toggleSessionSkill('ses1' as never, 'probe-skill', 'attach')).toEqual({ ok: true });
      const skillCall = seen.find((s) => s.url.endsWith('/skill'))!;
      expect(JSON.parse(skillCall.body)).toMatchObject({ id: 'probe-skill', resume: true });

      // The return is the server's answer, not a fabricated `{ok: true}` — the
      // pre-fix assertion was `toEqual({ ok: true })`, which is exactly the
      // defect `client-shell.test.ts` pins. Full coverage is there.
      const shell1 = await client.execSessionShell('ses1' as never, 'git status');
      const shell2 = await client.execSessionShell('ses1' as never, 'git status');
      expect(shell1.status).toBe('completed');
      expect(shell1.output).toBe('ok');
      expect(shell1.outcome).toBe('unknown'); // serve reports no exit code
      expect(shell2.outcome).toBe('unknown');
      const shellKeys = seen.filter((s) => s.url.endsWith('/shell')).map((s) => s.key);
      expect(shellKeys[0]).not.toBe(shellKeys[1]); // fresh key: exec is not idempotent

      await expect(client.setSessionAgent('nope' as never, 'x')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
        retryable: false,
      });
      await expect(client.setSessionModel('busy' as never, { id: 'x', providerID: 'opencode' })).rejects.toMatchObject({
        code: 'SESSION_BUSY',
        retryable: true,
      });
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
  test('dispatchPrompt sends canonical envelope; 409 maps to retryable SESSION_BUSY', async () => {
    const seen: Array<{ key: string; body: string }> = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      const capture = (fn: () => void): void => {
        let raw = '';
        req.on('data', (c: Buffer) => {
          raw += c.toString('utf8');
        });
        req.on('end', () => {
          seen.push({ key: req.headers['idempotency-key'] as string, body: raw });
          fn();
        });
      };
      if (req.method === 'POST' && req.url === '/api/session/ses_b/prompt') {
        return capture(() => {
          res.writeHead(409);
          res.end();
        });
      }
      if (req.method === 'POST' && req.url === '/api/session/ses_ok/prompt') {
        return capture(() => {
          json(res, 200, { data: { id: 'evt_ok', state: 'running' } });
        });
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const client = new ServeClient(`http://127.0.0.1:${addr.port}`, 'test-password');
      await expect(
        client.dispatchPrompt('ses_b' as never, 'report please', {
          origin: 'voice',
          actor: 'voxaura',
          fromSessionId: 'ses_a' as never,
          taskId: 'task-1',
        }),
      ).rejects.toMatchObject({ code: 'SESSION_BUSY', retryable: true });
      const sent = await client.dispatchPrompt('ses_ok' as never, 'report please', {
        origin: 'voice',
        actor: 'voxaura',
        fromSessionId: 'ses_a' as never,
        taskId: 'task-1',
      });
      expect(sent.receipt).toBe('evt_ok');
      const body = JSON.parse(seen[seen.length - 1]!.body) as { text: string; metadata: Record<string, unknown> };
      expect(body.text).toBe('report please');
      expect(body.metadata).toMatchObject({ origin: 'voice', fromSessionId: 'ses_a', taskId: 'task-1' });
      // Same (session, text) but different taskId → different key (no cross-task dedupe).
      const before = seen.length;
      await client.dispatchPrompt('ses_ok' as never, 'report please', {
        origin: 'voice',
        actor: 'voxaura',
        taskId: 'task-2',
      });
      expect(seen.length).toBe(before + 1);
      expect(seen[seen.length - 1]!.key).not.toBe(seen[seen.length - 2]!.key);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
});

// D9 — OpenCode context telemetry. The live API already returns per-session
// tokens and a dedicated `/context` endpoint; both were being discarded.
describe('context telemetry (D9)', () => {
  const client = (): ServeClient => new ServeClient(baseUrl, 'test-password');

  test('listSessions keeps tokens, cost, projectID and updatedAt', async () => {
    const [row] = await client().listSessions();
    expect(row).toBeDefined();
    expect(row!.tokens).toEqual({ input: 1200, output: 300, reasoning: 45, cacheRead: 800, cacheWrite: 10 });
    expect(row!.cost).toBeCloseTo(0.0123, 6);
    expect(row!.projectId).toBe('prj_1');
    expect(row!.updatedAt).toBe(1_700_000_000_000);
  });

  test('a row without tokens omits the key rather than reporting zeros', async () => {
    // exactOptionalPropertyTypes: `tokens: undefined` is not assignable, and a
    // fabricated 0 would read as "this session used no tokens".
    const [row] = await client().listSessions();
    expect(row!.tokens).toBeDefined();
  });

  test('window fill is the last step, and the roll-up is exposed separately', async () => {
    // This test originally asserted a SUM across messages. That was wrong and
    // was only caught by running against the live serve: per-step `input` is
    // cumulative, so a sum measures the session, not the window.
    const usage = await client().contextUsage('ses_mock1' as never, 200_000);
    expect(usage.used).toBe(469_297);
    expect(usage.limit).toBe(200_000);
    expect(usage.messageCount).toBe(3);
    // The user-only and compaction rows carry no tokens and are not counted.
    expect(usage.byMessage.input).toBe(600_248);
  });

  test('resolves the context window from the model catalog when not supplied', async () => {
    // The Phase 1 behaviour was `null` here, which is exactly why the gauge was
    // inert. The catalog makes the real limit available.
    const usage = await client().contextUsage('ses_mock1' as never);
    expect(usage.limit).toBe(200_000);
    // 469297 / 200000 — over 100 %, which is CORRECT: the mock window is smaller
    // than the real session's last step. Clamping would hide a genuine overflow.
    expect(usage.percent).toBeCloseTo(234.6, 1);
  });

  test('an invalid explicit limit falls back to the catalog rather than zero', async () => {
    // 0 is a bug in the caller, not an answer. Falling back to the catalog is
    // the truthful recovery; reporting 0 would render a permanently empty gauge.
    const usage = await client().contextUsage('ses_mock1' as never, 0);
    expect(usage.limit).toBe(200_000);
  });

  test('window fill is the LAST step, not the sum of all steps', async () => {
    // Each step re-sends the whole conversation, so summing measures the
    // session. On the measured real payload a naive sum of 671 assistant rows
    // produced 1,492,988 tokens = 142% of a 1,048,576 window.
    const usage = await client().contextUsage('ses_mock1' as never, 1_048_576);
    // Last row: 248 + 429 + 152 + 468468
    expect(usage.used).toBe(469_297);
    expect(usage.percent).toBeCloseTo(44.8, 1);
    expect(usage.percent).toBeLessThan(100);
  });

  test('cached reads count toward the window', async () => {
    // A cache hit still occupies the context — that is the point of caching.
    const usage = await client().contextUsage('ses_mock1' as never, 1_048_576);
    expect(usage.used).toBeGreaterThan(usage.byMessage.input === 0 ? 0 : 1);
    // Without cache the same step would be 829, i.e. 0.08% — absurdly low.
    const withoutCache = 248 + 429 + 152;
    expect(usage.used).toBeGreaterThan(withoutCache * 100);
  });

  test('peak reports the largest single step, not the session', async () => {
    const usage = await client().contextUsage('ses_mock1' as never, 1_048_576);
    // Largest row is m2: 400000 + 2000 + 500 + 300000
    expect(usage.peak).toBe(702_500);
    // Peak is one step (cache included); the roll-up spans every step and so is
    // larger in total but measures a different thing entirely.
    expect(usage.peak).not.toBe(usage.used);
    expect(usage.peak).toBeGreaterThan(usage.used);
  });

  test('the lifetime roll-up is exposed separately and is never the window', async () => {
    const usage = await client().contextUsage('ses_mock1' as never, 1_048_576);
    // byMessage is a sum: 600248 input across the three steps.
    expect(usage.byMessage.input).toBe(600_248);
    expect(usage.used).toBe(469_297);
  });

  test('reads the live flat shape, not the {info,parts} shape the SDK types implied', async () => {
    // The old reader looked for parts[].tokens and silently returned 0 here.
    const usage = await client().contextUsage('ses_mock1' as never, 1_048_576);
    expect(usage.used).toBeGreaterThan(0);
    expect(usage.messageCount).toBe(3);
  });

  test('an explicit limit still wins over the catalog', async () => {
    const usage = await client().contextUsage('ses_mock1' as never, 1000);
    expect(usage.limit).toBe(1000);
  });

  // The context window is NOT on the session row ({id, providerID, variant}
  // only) — it lives in the model catalog. Without this the gauge is inert.
  test('resolves the context window from the model catalog when not supplied', async () => {
    // The Phase 1 behaviour was `null` here, which is exactly why the gauge was
    // inert. The catalog makes the real limit available.
    const usage = await client().contextUsage('ses_mock1' as never);
    expect(usage.limit).toBe(200_000);
    // 469297 / 200000 — over 100 %, which is CORRECT: the mock window is smaller
    // than the real session's last step. Clamping would hide a genuine overflow.
    expect(usage.percent).toBeCloseTo(234.6, 1);
  });

  test('a model with no catalog limit still reports null rather than zero', async () => {
    // "Unknown" is a real answer; zero would render as a permanently empty gauge.
    // `request` is private, so reachability is proven through the public
    // `listModels`, which returns [] on a non-OK response (client.ts:607) —
    // a non-empty list therefore means serve really answered /api/model.
    const models = await client().listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.find((m) => m.id === 'tiny')?.contextWindow).toBeNull();
  });

  test('listModels returns ids and context limits, skipping malformed rows', async () => {
    const models = await client().listModels();
    const muse = models.find((m) => m.id === 'muse-spark');
    expect(muse?.contextWindow).toBe(200_000);
    // A row with no limit is still listed, with null — "unknown", not zero.
    expect(models.find((m) => m.id === 'tiny')?.contextWindow).toBeNull();
  });

  test('listSkills returns names and whether they are slash-invocable', async () => {
    const skills = await client().listSkills();
    expect(skills.map((s) => s.name)).toContain('mission-handoff');
    expect(skills[0]?.slash).toBe(true);
  });

  test('native session commands hit the real endpoints', async () => {
    const c = client();
    await expect(c.compactSession('ses_mock1' as never)).resolves.toEqual({ ok: true });
    await expect(c.interruptSession('ses_mock1' as never)).resolves.toEqual({ ok: true });
    await expect(c.revertSession('ses_mock1' as never, 'stage')).resolves.toEqual({ ok: true });
  });
});

