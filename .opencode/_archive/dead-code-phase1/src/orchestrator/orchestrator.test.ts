import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { basicAuth, ServeClient } from '../runtime/client.js';
import { Orchestrator } from './orchestrator.js';
import { SpeechQueue } from './queue.js';

function frame(res: ServerResponse, type: string, id: string, body: unknown): void {
  res.write(`event: ${type}\nid: ${id}\ndata: ${JSON.stringify(body)}\n\n`);
}

describe('SpeechQueue dedupe + ordering', () => {
  test('duplicate event ids enqueue once; T2 jumps ahead of T1 tail', () => {
    const q = new SpeechQueue();
    const job = { sessionId: 'ses_a' as never, eventId: 'evt_1', tier: 'T1' as const, outcome: 'green', text: 'a done' };
    expect(q.enqueue(job)).toBe(true);
    expect(q.enqueue(job)).toBe(false);
    q.enqueue({ sessionId: 'ses_b' as never, eventId: 'evt_2', tier: 'T1', outcome: 'green', text: 'b done' });
    q.enqueue({ sessionId: 'ses_c' as never, eventId: 'evt_3', tier: 'T2', outcome: 'amber', text: 'approval' });
    const first = q.dequeue();
    expect(first !== null && !('digest' in first) && first.eventId).toBe('evt_1');
    const second = q.dequeue();
    expect(second !== null && !('digest' in second) && second.eventId).toBe('evt_3');
  });
});

describe('Orchestrator vs mock SSE', () => {
  let server: Server;
  let baseUrl = '';
  const spoken: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers.authorization !== basicAuth('test-password')) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const body = (sessionId: string) => ({
        sessionId, at: new Date().toISOString(),
        payload: { outcome: 'green', summaryText: `${sessionId} finished green` },
        cursor: 'evt_live_1',
      });
      frame(res as ServerResponse, 'agent:action', 'evt_live_0', {
        sessionId: 'ses_live', at: new Date().toISOString(),
        payload: { action: 'ran tests', stepIndex: 1, routine: true }, cursor: 'evt_live_0',
      });
      frame(res as ServerResponse, 'session:complete', 'evt_live_1', body('ses_live'));
      frame(res as ServerResponse, 'session:complete', 'evt_live_1', body('ses_live'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock SSE failed to bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('live stream: routine silent, complete briefed exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const client = new ServeClient(baseUrl, 'test-password');
    const orch = new Orchestrator(client, dir, { speak: async (text: string) => { spoken.push(text); } });
    const run = orch.subscribe(baseUrl, 'test-password');
    await new Promise((resolve) => setTimeout(resolve, 500));
    orch.stop();
    await run;
    expect(spoken).toEqual(['ses_live finished green']);
    expect(await orch.reconcile()).toEqual([]);
  });
});
