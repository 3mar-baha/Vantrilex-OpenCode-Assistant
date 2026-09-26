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
        data: [{ id: 'ses_mock1', agent: 'explore', model: { id: 'muse-spark' } }],
        cursor: null,
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/openapi.json') {
      json(res, 200, { info: { version: '2.9.9-mock' } });
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
        if (req.url === '/api/session/ses1/shell') return record(raw);
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

      expect(await client.execSessionShell('ses1' as never, 'git status')).toEqual({ ok: true });
      expect(await client.execSessionShell('ses1' as never, 'git status')).toEqual({ ok: true });
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

