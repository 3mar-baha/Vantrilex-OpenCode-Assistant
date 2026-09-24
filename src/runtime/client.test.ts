import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ServeClient } from './client.js';

// Mock serve over loopback — docs/11 §11.2 contract-fidelity rule: payloads match
// the zod-validated shapes production expects.
let server: Server;
let baseUrl = '';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== 'Bearer test-password') {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    if (req.method === 'POST' && req.url === '/session') {
      json(res, 201, { sessionId: 'ses_mock1', state: 'creating', createdAt: new Date().toISOString() });
      return;
    }
    if (req.method === 'POST' && req.url === '/session/ses_mock1/prompt') {
      json(res, 202, { sessionId: 'ses_mock1', state: 'running', receipt: 'evt_r1' });
      return;
    }
    if (req.method === 'GET' && req.url === '/session/ses_mock1') {
      json(res, 200, { sessionId: 'ses_mock1', state: 'running', outcome: 'unknown', updatedAt: new Date().toISOString() });
      return;
    }
    if (req.method === 'GET' && req.url === '/session') {
      json(res, 200, { sessions: [{ sessionId: 'ses_mock1', state: 'running' }] });
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
  test('create → prompt → get → list → probe round-trip', async () => {
    const client = new ServeClient(baseUrl, 'test-password');
    const created = await client.createSession('O:/repos/mock');
    expect(created.sessionId).toBe('ses_mock1');
    const prompted = await client.promptSession(created.sessionId, 'hello', { origin: 'cli', actor: 'test' });
    expect(prompted.receipt).toBe('evt_r1');
    const status = await client.getSession(created.sessionId);
    expect(status.state).toBe('running');
    const list = await client.listSessions();
    expect(list).toHaveLength(1);
    expect(await client.probeContract()).toBe('2.9.9-mock');
  });

  test('bad password maps to non-retryable 401', async () => {
    const client = new ServeClient(baseUrl, 'wrong');
    await expect(client.createSession('O:/repos/mock')).rejects.toMatchObject({ retryable: false });
  });

  test('unknown session maps to SESSION_NOT_FOUND', async () => {
    const client = new ServeClient(baseUrl, 'test-password');
    await expect(client.getSession('ses_nope' as never)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  test('prompt retries reuse a stable idempotency key per (session, text)', async () => {
    const seen: string[] = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/session/ses_k/prompt') {
        seen.push(req.headers['idempotency-key'] as string);
        json(res, 202, { sessionId: 'ses_k', state: 'running', receipt: 'evt_k' });
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


  test('per-session controls hit native /api routes with stable keys; shell is fresh-keyed + capped', async () => {
    const seen: Array<{ key: string; method: string; url: string; body: string }> = [];
    const big = 'x'.repeat(100_000);
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      const record = (body: string, status: number, payload: unknown): void => {
        seen.push({ key: req.headers['idempotency-key'] as string, method: req.method ?? '', url: req.url ?? '', body });
        json(res, status, payload);
      };
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        if (req.url === '/api/session/ses1/agent') return record(raw, 200, { agent: 'build' });
        if (req.url === '/api/session/ses1/model') return record(raw, 200, { model: 'opus' });
        if (req.url === '/api/experimental/session/ses1/skill') return record(raw, 200, { ok: true });
        if (req.url === '/api/session/ses1/shell') return record(raw, 200, { stdout: big, stderr: '', exitCode: 0 });
        if (req.url === '/api/session/nope/agent') return record(raw, 404, { error: 'gone' });
        if (req.url === '/api/session/busy/model') return record(raw, 409, { error: 'busy' });
        return record(raw, 404, { error: 'not found' });
      });
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const addr = probe.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe failed to bind');
    try {
      const base = `http://127.0.0.1:${addr.port}`;
      const client = new ServeClient(base, 'test-password');
      const agent = await client.setSessionAgent('ses1' as never, 'build');
      expect(agent).toMatchObject({ agent: 'build' });
      const agentAgain = await client.setSessionAgent('ses1' as never, 'build');
      expect(agentAgain).toMatchObject({ agent: 'build' });
      const agentKeys = seen.filter((s) => s.url.endsWith('/agent')).map((s) => s.key);
      expect(agentKeys[0]).toBe(agentKeys[1]); // stable control key
      expect(JSON.parse(agentKeys.length > 0 ? seen[0]!.body : '{}')).toMatchObject({ agent: 'build' });

      const model = await client.setSessionModel('ses1' as never, 'opus');
      expect(model).toMatchObject({ model: 'opus' });

      const skill = await client.toggleSessionSkill('ses1' as never, 'probe-skill', 'attach');
      expect(skill).toMatchObject({ ok: true });

      const shell1 = await client.execSessionShell('ses1' as never, 'git status');
      await client.execSessionShell('ses1' as never, 'git status');
      expect(shell1.exitCode).toBe(0);
      expect(shell1.stdout).toHaveLength(65536); // capped, never unbounded
      const shellKeys = seen.filter((s) => s.url.endsWith('/shell')).map((s) => s.key);
      expect(shellKeys[0]).not.toBe(shellKeys[1]); // fresh key: exec is not idempotent

      await expect(client.setSessionAgent('nope' as never, 'x')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
        retryable: false,
      });
      await expect(client.setSessionModel('busy' as never, 'x')).rejects.toMatchObject({
        code: 'SESSION_BUSY',
        retryable: true,
      });
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });
  test('dispatchPrompt carries cross-session provenance; 409 maps to retryable SESSION_BUSY', async () => {
    const seen: Array<{ key: string; body: string }> = [];
    const probe = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/session/ses_b/prompt') {
        let raw = '';
        req.on('data', (c: Buffer) => {
          raw += c.toString('utf8');
        });
        req.on('end', () => {
          seen.push({ key: req.headers['idempotency-key'] as string, body: raw });
          json(res, 409, { error: 'session busy' });
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/session/ses_ok/prompt') {
        let raw = '';
        req.on('data', (c: Buffer) => {
          raw += c.toString('utf8');
        });
        req.on('end', () => {
          seen.push({ key: req.headers['idempotency-key'] as string, body: raw });
          json(res, 202, { sessionId: 'ses_ok', state: 'running', receipt: 'evt_ok' });
        });
        return;
      }
      json(res, 404, { error: 'not found' });
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
      const body = JSON.parse(seen[seen.length - 1]!.body) as { provenance: Record<string, unknown> };
      expect(body.provenance).toMatchObject({ origin: 'voice', fromSessionId: 'ses_a', taskId: 'task-1' });
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

