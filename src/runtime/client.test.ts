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
});
