import { describe, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basicAuth } from '../runtime/client.js';
import { probeHealth, resolvePort } from './launcher.js';

describe('port adopt-or-escalate (E-1)', () => {
  test('adopts healthy owner with matching password', () => {
    expect(resolvePort({ healthy: true, passwordMatches: true }, 4096, [])).toEqual({ port: 4096, adopted: true });
  });

  test('escalates on password mismatch or unhealthy listener', () => {
    expect(resolvePort({ healthy: true, passwordMatches: false }, 4096, []).port).toBe(4097);
    expect(resolvePort({ healthy: false, passwordMatches: false }, 4096, [4097]).port).toBe(4098);
  });
});

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
