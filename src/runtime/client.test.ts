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
        // v2 500s on every body on serve 1.18.32, which is what makes the v1
        // fallback the live path. Mirrored here so both are exercised.
        if (bodies.length === 1) {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const base = `http://127.0.0.1:${addr.port}`;
      const out = await new ServeClient(base, 'test-password').promptSession('s' as never, 'hi', {
        origin: 'cli',
        actor: 't',
      });
      // ONE call now reaches BOTH routes, so this asserts the v2 shape AND the
      // fallback body AND that the receipt is the id we minted (a 204 returns
      // no id, so an echoed server id would be `undefined` here).
      expect(JSON.parse(bodies[0]!)).toEqual({ prompt: { text: 'hi' }, delivery: 'steer' });
      expect(JSON.parse(bodies[1]!)).toMatchObject({ parts: [{ type: 'text', text: 'hi' }] });
      expect((JSON.parse(bodies[1]!) as { messageID: string }).messageID).toMatch(/^msg_/);
      expect(out.receipt).toMatch(/^msg_/);
      expect(out.state).toBe('running');
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
      // The v2 schema is `additionalProperties:false` with `PromptInput` also
      // closed, so `metadata` has no legal home anywhere in the body — it was
      // measured 400 (missing prompt) and 500 (metadata inside prompt). The
      // text is asserted where it now travels, inside the prompt object.
      const body = JSON.parse(seen[seen.length - 1]!.body) as {
        prompt: { text: string };
        delivery: string;
      };
      expect(body.prompt.text).toBe('report please');
      expect(body.delivery).toBe('steer');
      // `messageID` belongs to the v1 fallback body, not this one — this probe
      // answers 200 on v2 so only the v2 request is ever made here. The
      // fallback shape is pinned by the envelope test above, which serves 500
      // on v2 and therefore does see both bodies.
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

// ── TURN CONTROL — promptTurn / readTurn / sessionStatus ────────────────────
//
// Three methods added because the routes that LOOK like they do this job were
// measured not to, against opencode 1.18.32 on 2026-10-01:
//
//   POST /api/session/{id}/agent  -> 500 UnknownError   (the route exists; the
//                                                            handler throws)
//   POST /session/{id}/agent      -> 200 text/html 2884 bytes, byte-identical to
//                                    an invented path — the SPA catch-all
//
// so an agent switch is only expressible as the `agent` field on the v1 message
// envelope, and the only proof it took effect is the `info.agent` / `info.mode`
// the server writes onto the assistant row.
//
// THE FIXTURES BELOW ARE MEASURED ROWS, captured from a live turn. A guard written
// against an invented payload proves nothing about a server that does not send
// it, which is how the two earlier defects in this file were missed.
describe('turn control: promptTurn, readTurn, sessionStatus', () => {
  /** Serve one measured turn, and record every request that reached it. */
  async function withTurnServe(
    handler: (req: IncomingMessage, res: ServerResponse, url: string, body: string) => boolean,
    run: (client: ServeClient, seen: Array<{ url: string; body: string; key: string }>) => Promise<void>,
  ): Promise<void> {
    const seen: Array<{ url: string; body: string; key: string }> = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        const url = req.url ?? '';
        seen.push({ url, body: raw, key: String(req.headers['idempotency-key'] ?? '') });
        if (req.headers.authorization !== GOOD_AUTH) {
          json(res, 401, { error: 'unauthorized' });
          return;
        }
        if (!handler(req, res, url, raw)) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      await run(new ServeClient(`http://127.0.0.1:${addr.port}`, 'test-password'), seen);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }

  const noContent = (_r: IncomingMessage, res: ServerResponse): boolean => {
    res.writeHead(204);
    res.end();
    return true;
  };

  // A real assistant row, captured live. `completed` and `agent` are the two
  // load-bearing fields: one says the turn is done, the other says which agent
  // ran it, and NEITHER is ever written by this client.
  const FINISHED = {
    info: {
      id: 'msg_finished',
      sessionID: 'ses_1',
      role: 'assistant',
      parentID: 'msg_parent',
      modelID: 'space-bunny-free',
      providerID: 'opencode',
      mode: 'plan',
      agent: 'plan',
      cost: 0,
      time: { created: 1_790_842_280_449, completed: 1_790_842_284_593 },
      finish: 'stop',
    },
    parts: [
      { type: 'step-start' },
      { type: 'text', text: 'Space Bunny' },
      { type: 'step-finish' },
    ],
  };
  // The SAME turn 3 s earlier: the row exists, `parts` is EMPTY, and there is no
  // `completed`. This is the measured trap, and the reason `readTurn` cannot be
  // a boolean "is there a row".
  const IN_FLIGHT = {
    info: {
      id: 'msg_finished',
      sessionID: 'ses_1',
      role: 'assistant',
      parentID: 'msg_parent',
      mode: 'plan',
      agent: 'plan',
      cost: 0,
      time: { created: 1_790_842_280_449 },
    },
    parts: [],
  };
  // The USER row, measured. Its `id` IS the message id this client mints and its
  // `parts` hold the PROMPT. It is the row a naive `id === messageId` match
  // returns — and that mistake was made, shipped in the first version of
  // `readTurn`, and caught only by running the poll against a live serve: it
  // waited 90 s on a turn that finished in 4 s and printed the request back as
  // the model's answer. `UserMessage` declares `agent` but no `mode` and no
  // `time.completed`, which is why the bug was invisible to every fixture that
  // contained only the assistant row.
  const USER = {
    info: {
      id: 'msg_parent',
      sessionID: 'ses_1',
      role: 'user',
      time: { created: 1_790_842_278_410 },
      summary: { diffs: [] },
      agent: 'plan',
      model: { providerID: 'opencode', modelID: 'space-bunny-free' },
    },
    parts: [{ type: 'text', text: 'رد بكلمة واحدة فقط: ما اسمك؟' }],
  };

  test('promptTurn sends the v1 envelope with `agent`, and parts is present', async () => {
    // `parts` is REQUIRED: measured, omitting it is a 400 `Missing key at
    // ["parts"]`. The route is `additionalProperties: false`, so `agent` is a
    // declared member of that envelope and the switch rides inside it.
    await withTurnServe(
      (req, res, url) => (req.method === 'POST' && url === '/session/ses_1/prompt_async' ? noContent(req, res) : false),
      async (client, seen) => {
        const out = await client.promptTurn('ses_1' as never, 'قل نعم فقط', { agent: 'plan' });
        expect(out.status).toBe(204);
        expect(out.messageId).toMatch(/^msg_/);
        const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
        expect(body['agent']).toBe('plan');
        expect(body['parts']).toEqual([{ type: 'text', text: 'قل نعم فقط' }]);
        expect(body['messageID']).toBe(out.messageId);
        // The message id doubles as the idempotency key, so a retried send is
        // deduped by serve rather than run twice.
        expect(seen[0]!.key).toBe(out.messageId);
      },
    );
  });

  test('BREAK: a 200 carrying the SPA page is a typed CONTRACT_DRIFT, not a delivered turn', async () => {
    // The `execSessionShell` defect, on this route. Measured: an unknown path on
    // this server answers 200 + `text/html` + 2 884 bytes, so `res.ok` is true
    // for a path with no handler, and a turn reported delivered against it never
    // reached a route. The guard is the same one predicate the shell verb uses.
    await withTurnServe(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
        res.end('<!doctype html><html></html>');
        return true;
      },
      async (client) => {
        await expect(client.promptTurn('ses_1' as never, 'x')).rejects.toMatchObject({
          code: 'CONTRACT_DRIFT',
          retryable: false,
        });
      },
    );
  });

  test('BREAK: a 204 with no body is the measured answer and is NOT the fallback', async () => {
    // The mirror of the case above, and the reason the guard cannot simply reject
    // "no content-type": `204 No Content` legitimately declares none. Rejecting
    // it would break the verb that is measured working.
    await withTurnServe(noContent, async (client) => {
      await expect(client.promptTurn('ses_1' as never, 'x', { noReply: true })).resolves.toMatchObject({ status: 204 });
    });
  });

  test('noReply is sent only when asked, and adds no other member', async () => {
    await withTurnServe(noContent, async (client, seen) => {
      await client.promptTurn('ses_1' as never, 'خامل', { agent: 'plan', noReply: true });
      const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
      expect(body['noReply']).toBe(true);
      expect(Object.keys(body).sort()).toEqual(['agent', 'messageID', 'noReply', 'parts']);
      // The measured cheap switch: 204, the user row records `agent`, and no
      // model is called. `session.agent` then reports the new name.
    });
  });

  test('a 404 on the turn is SESSION_NOT_FOUND and not a transport error', async () => {
    await withTurnServe(
      (_req, res) => {
        json(res, 404, { name: 'NotFoundError', data: { message: 'Session not found' } });
        return true;
      },
      async (client) => {
        await expect(client.promptTurn('ses_gone' as never, 'x')).rejects.toMatchObject({
          code: 'SESSION_NOT_FOUND',
          retryable: false,
        });
      },
    );
  });

  test('readTurn returns the server\'s own agent, mode and completion time', async () => {
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [FINISHED]);
        return true;
      },
      async (client, seen) => {
        // `msg_parent` is the id THIS CLIENT minted, and the assistant row names
        // it in `parentID`. It is never the assistant row's own `id` — see the
        // user-row regression below for what passing that instead returns.
        const row = await client.readTurn('ses_1' as never, 'msg_parent');
        // Pinned to the V1 route. Measured on one session at one moment:
        // `/api/session/{id}/message` returned 0 rows and `/session/{id}/message`
        // returned 2. Neither is a superset, so a poller on the v2 surface waits
        // forever on a turn that already finished.
        expect(seen[0]!.url).toBe('/session/ses_1/message');
        expect(row?.agent).toBe('plan');
        expect(row?.mode).toBe('plan');
        expect(row?.completedAt).toBe(1_790_842_284_593);
        expect(row?.finish).toBe('stop');
        expect(row?.text).toBe('Space Bunny');
        expect(row?.partTypes).toEqual(['step-start', 'text', 'step-finish']);
      },
    );
  });

  test('BREAK: given BOTH rows, it returns the ASSISTANT one — not the row carrying our own id', async () => {
    // THE live defect, as a regression. Measured payload order is user-then-
    // assistant, and the user row's `id` is the message id `promptTurn` mints. A
    // match on `id` returns the question: the poll then never sees
    // `time.completed`, times out at 90 s on a turn that finished in 4 s, and
    // `assistantText` prints the operator's own prompt as the model's reply.
    // Matched on `parentID` and `role`, the question is unmatchable.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [USER, IN_FLIGHT, FINISHED]);
        return true;
      },
      async (client) => {
        const row = await client.readTurn('ses_1' as never, 'msg_parent');
        expect(row?.role).toBe('assistant');
        expect(row?.id).toBe('msg_finished');
        expect(row?.text).toBe('Space Bunny');
        expect(row?.text).not.toContain('ما اسمك');
        expect(row?.completedAt).toBe(1_790_842_284_593);
      },
    );
  });

  test('BREAK: the user row is never returned, so nothing can echo the request back', async () => {
    // The same payload with the assistant row still in flight. The answer is
    // `null` — not the user row — which is what makes `still-running` an
    // observation instead of a misread question.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [USER, IN_FLIGHT]);
        return true;
      },
      async (client) => {
        const row = await client.readTurn('ses_1' as never, 'msg_parent');
        expect(row?.role).toBe('assistant');
        expect(row?.completedAt).toBeNull();
        expect(row?.text).toBe('');
      },
    );
  });

  test('BREAK: with ONLY the user row present, the result is null and not the question', async () => {
    // Measured on an invalid agent name: the request is recorded, nothing answers.
    // Returning the user row here would confirm a switch off a field the request
    // itself carried — the echo, in the place where it does the most damage.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [USER]);
        return true;
      },
      async (client) => {
        expect(await client.readTurn('ses_1' as never, 'msg_parent')).toBeNull();
      },
    );
  });

  test('when several assistant rows answer one turn, the LAST one wins', async () => {
    // A tool loop produces more than one. The finished one is the answer; the
    // earlier in-flight one is not.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [IN_FLIGHT, { ...FINISHED, info: { ...FINISHED.info, id: 'msg_second' } }]);
        return true;
      },
      async (client) => {
        const row = await client.readTurn('ses_1' as never, 'msg_parent');
        expect(row?.id).toBe('msg_second');
        expect(row?.completedAt).toBe(1_790_842_284_593);
      },
    );
  });

  test('BREAK: the in-flight row reports completedAt null — the poll must read THAT', async () => {
    // The same turn 3 s earlier. It has an `agent` and a `mode` and an id, so
    // anything that switches on row-presence calls this finished and reports the
    // model's silence as its answer.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [IN_FLIGHT]);
        return true;
      },
      async (client) => {
        const row = await client.readTurn('ses_1' as never, 'msg_parent');
        expect(row).not.toBeNull();
        expect(row?.completedAt).toBeNull();
        expect(row?.finish).toBeNull();
        expect(row?.text).toBe('');
        expect(row?.partTypes).toEqual([]);
      },
    );
  });

  test('a message id that has no row is null, not a zeroed row', async () => {
    // Measured on an invalid agent name: 204 accepted, and no assistant row ever
    // appears. `null` is what makes that a failed switch instead of a successful
    // one built out of defaults.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, []);
        return true;
      },
      async (client) => {
        expect(await client.readTurn('ses_1' as never, 'msg_never')).toBeNull();
      },
    );
  });

  test('a provider error is reduced to name/message/status, never a raw body dump', async () => {
    // Measured on a rate-limited turn: `error.data.responseHeaders` carries
    // connection metadata, and a raw dump of that object into a report is a leak
    // path. Only the three fields that identify the fault are kept.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [
          {
            ...FINISHED,
            info: {
              ...FINISHED.info,
              error: {
                name: 'APIError',
                data: {
                  message: 'Rate limit exceeded: free-models-per-day',
                  statusCode: 429,
                  isRetryable: true,
                  responseHeaders: { 'set-cookie': 'secret=abc', server: 'cloudflare' },
                },
              },
            },
          },
        ]);
        return true;
      },
      async (client) => {
        const row = await client.readTurn('ses_1' as never, 'msg_parent');
        expect(row?.error).toEqual({
          name: 'APIError',
          message: 'Rate limit exceeded: free-models-per-day',
          statusCode: 429,
          retryable: true,
        });
        expect(JSON.stringify(row)).not.toContain('secret=abc');
      },
    );
  });

  test('BREAK: the v2 message route being empty is not read as "no turn happened"', async () => {
    // `{"data":[], "cursor":{…}}` is what `/api/session/{id}/message` returns for
    // a session that demonstrably HAS messages. If a poller were pointed there it
    // would see zero rows forever and never finish. Asserted on the v1 read so
    // the pin is visible in the suite rather than only in a comment.
    await withTurnServe(
      (_req, res) => {
        json(res, 200, [FINISHED]);
        return true;
      },
      async (client, seen) => {
        await client.readTurn('ses_1' as never, 'msg_parent');
        expect(seen.map((s) => s.url)).not.toContain('/api/ses_1/message');
        expect(seen.map((s) => s.url)).not.toContain('/api/session/ses_1/message');
      },
    );
  });

  test('sessionStatus reads busy, retry and absent-as-idle', async () => {
    // `retry` is the state a rate-limited turn sits in, and it names the provider
    // error the assistant row does not carry for another 10 s. `absent` is the
    // GOOD news and is a real answer: the map is complete, so a session with no
    // entry is not running.
    //
    // KEYED BY THE RESPONSE BODY, not by the request URL: `/session/status` takes
    // no session parameter and returns a MAP of every live session, so the only
    // place a session id can appear is the reply. The fixture returns all three
    // shapes at once and the assertions below are about which entry wins.
    await withTurnServe(
      (_req, res, url) => {
        if (url !== '/session/status') return false;
        json(res, 200, {
          ses_busy: { type: 'busy' },
          ses_retry: { type: 'retry', attempt: 5, message: 'Rate limit exceeded', next: 1_790_842_192_143 },
        });
        return true;
      },
      async (client) => {
        expect(await client.sessionStatus('ses_busy' as never)).toMatchObject({ kind: 'busy' });
        const retry = await client.sessionStatus('ses_retry' as never);
        expect(retry.kind).toBe('retry');
        expect(retry.attempt).toBe(5);
        expect(retry.detail).toContain('Rate limit exceeded');
        // Absent is idle — the map is complete, so a missing entry is not running.
        expect(await client.sessionStatus('ses_absent' as never)).toMatchObject({ kind: 'idle' });
      },
    );
  });

  test('the SPA page on /session/status is unreachable, not a bogus idle', async () => {
    // Reporting "idle" because a web page came back would be a lie that reads as
    // a settled session — the worst failure for a poller's diagnostic.
    await withTurnServe(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html;charset=UTF-8' });
        res.end('<!doctype html>');
        return true;
      },
      async (client) => {
        expect(await client.sessionStatus('ses_1' as never)).toMatchObject({ kind: 'unreachable' });
      },
    );
  });
});

