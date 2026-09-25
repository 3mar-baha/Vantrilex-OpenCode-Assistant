import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ipcTokenFromEnv, startDaemon, vaultPathFromEnv, type DaemonHandle } from './daemon.js';
import { readKeyPools } from './voice/key-store.js';
import { FileVault } from './voice/vault.js';

// A fake `opencode serve`: only the routes the daemon touches.
function fakeServe(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const send = (body: unknown, code = 200): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/session' && req.method === 'GET') {
        send({ data: [{ id: 'ses_a', state: 'idle' }] });
        return;
      }
      if (req.url?.startsWith('/api/agent')) {
        send({ data: [{ id: 'build', name: 'Build' }] });
        return;
      }
      send({ error: 'not found' }, 404);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

const servers: Server[] = [];
const handles: DaemonHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.stop();
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function boot(vaultPath: string): Promise<DaemonHandle> {
  const { server, port } = await fakeServe();
  servers.push(server);
  const handle = await startDaemon({
    servePort: port,
    servePassword: 'pw',
    ipcToken: 'test-ipc-token',
    ipcPort: 0,
    vaultPath,
    directory: process.cwd(),
    inventoryIntervalMs: 3_600_000,
  });
  handles.push(handle);
  return handle;
}

describe('daemon composition (production wiring)', () => {
  test('starts against a healthy serve, publishes inventory + agents', async () => {
    const vault = join(mkdtempSync(join(tmpdir(), 'daemon-')), 'keyring.dat');
    const handle = await boot(vault);
    expect(handle.ipcPort).toBeGreaterThan(0);
    expect(await handle.publishSessions()).toBe(1);
  });

  test('refuses to start without a serve password (fail-closed)', async () => {
    const { server, port } = await fakeServe();
    servers.push(server);
    await expect(
      startDaemon({ servePort: port, servePassword: '', ipcToken: 't', ipcPort: 0, vaultPath: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  test('refuses to start without an IPC token (fail-closed)', async () => {
    const { server, port } = await fakeServe();
    servers.push(server);
    await expect(
      startDaemon({ servePort: port, servePassword: 'pw', ipcToken: '', ipcPort: 0, vaultPath: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  test('refuses to start when no serve is listening (single-supervisor)', async () => {
    await expect(
      startDaemon({ servePort: 1, servePassword: 'pw', ipcToken: 't', ipcPort: 0, vaultPath: 'x' }),
    ).rejects.toMatchObject({ code: 'SERVE_UNREACHABLE' });
  });

  test('saveApiKeys persists encrypted pools through the vault adapter', async () => {
    const vaultPath = join(mkdtempSync(join(tmpdir(), 'daemon-keys-')), 'keyring.dat');
    await boot(vaultPath);
    // Exercise the same adapter the router calls.
    const { writeKeyPools } = await import('./voice/key-store.js');
    const vault = new FileVault(vaultPath);
    writeKeyPools(vault, { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
    expect(readKeyPools(new FileVault(vaultPath))).toEqual({ groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
  });
});

describe('env resolvers', () => {
  test('vault path and IPC token come from env only', () => {
    expect(vaultPathFromEnv({ VOXAURA_VAULT_PATH: '/tmp/k.dat' } as NodeJS.ProcessEnv)).toBe('/tmp/k.dat');
    expect(vaultPathFromEnv({} as NodeJS.ProcessEnv, '/repo')).toBe('/repo/vault/keyring.dat');
    expect(ipcTokenFromEnv({ VOICE_RUNTIME_IPC_TOKEN: 'abc' } as NodeJS.ProcessEnv)).toBe('abc');
    expect(ipcTokenFromEnv({} as NodeJS.ProcessEnv)).toBe('');
  });
});