import { describe, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basicAuth } from '../runtime/client.js';
import { probeHealth } from './launcher.js';

// `probeHealth` is what `doctor` and the daemon rely on to decide whether serve
// is up, so its contract is load-bearing: 200 + correct Basic credentials is the
// ONLY positive signal. A 401 must read as unhealthy, and an unreachable port
// must resolve rather than throw — `doctor` has to survive a dead serve.

describe('probeHealth (Basic auth against /api/session)', () => {
  test('200 with correct Basic credentials → true; 401 → false; down → false', async () => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/session' && req.headers.authorization === basicAuth('pw')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('probe server failed to bind');
    try {
      expect(await probeHealth(addr.port, 'pw')).toBe(true);
      expect(await probeHealth(addr.port, 'wrong')).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await probeHealth(addr.port, 'pw', 300)).toBe(false); // server now down
  });
});
