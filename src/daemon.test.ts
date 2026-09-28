import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ipcTokenFromEnv, startDaemon, vaultPathFromEnv, type DaemonHandle } from './daemon.js';
import {
  DAEMON_OWNER_FILE,
  DAEMON_OWNER_KEY_ENV,
  ensureIpcToken,
  ipcTokenPath,
  parseDaemonOwnerMarker,
} from './daemon.js';
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

describe('C2: the daemon publishes who owns the IPC port', () => {
  const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
  const OTHER = 'f'.repeat(64);

  const owner = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ v: 1, pid: 4242, ipcPort: 4097, contractVersion: '3.1.0', ownerKey: KEY, ...over });

  test('our own live marker parses and a stranger marker does not', () => {
    // The two cases the shell has to tell apart, on the Node side. The Rust
    // mirror (`holder_from_probe`) asserts the same shapes, so a change to one
    // side that the other does not follow shows up as a launch refusing its own
    // daemon.
    expect(parseDaemonOwnerMarker(owner(), KEY)).toMatchObject({ pid: 4242, ipcPort: 4097 });
    expect(parseDaemonOwnerMarker(owner({ ownerKey: OTHER }), KEY), 'another install is not ours').toBeNull();
    expect(parseDaemonOwnerMarker(owner({ pid: 0 }), KEY), 'pid 0 is not a process').toBeNull();
    expect(parseDaemonOwnerMarker(owner({ pid: -1 }), KEY)).toBeNull();
    expect(parseDaemonOwnerMarker(owner({ v: 99 }), KEY), 'an unknown version is not ours').toBeNull();
  });

  test('a malformed, empty or foreign-shape file is refused without throwing', () => {
    for (const raw of [
      '',
      '   ',
      'not json',
      '[]',
      'null',
      '"a string"',
      JSON.stringify({ pid: 4242, ownerKey: KEY }),
      JSON.stringify({ v: 1, ownerKey: KEY }),
      JSON.stringify({ v: 1, pid: 'x', ipcPort: 4097, contractVersion: '3.1.0', ownerKey: KEY }),
      JSON.stringify({ v: 1, pid: 4242, ipcPort: 0, contractVersion: '3.1.0', ownerKey: KEY }),
      JSON.stringify({ v: 1, pid: 4242, ipcPort: 4097, ownerKey: KEY }),
    ]) {
      expect(parseDaemonOwnerMarker(raw, KEY), `must be refused: ${raw}`).toBeNull();
    }
  });

  test('no expected key means nothing can verify', () => {
    // A keyless caller (a dev script, a second install with no key yet) must not
    // be able to accept a marker just by not looking.
    expect(parseDaemonOwnerMarker(owner(), '')).toBeNull();
  });

  test('a running daemon publishes its identity and clears it on stop', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-owner-'));
    const ownerPath = join(runtimeDir, 'daemon.owner');
    const previous = process.env[DAEMON_OWNER_KEY_ENV];
    process.env[DAEMON_OWNER_KEY_ENV] = KEY;
    try {
      const { server, port } = await fakeServe();
      servers.push(server);
      const handle = await startDaemon({
        servePort: port,
        servePassword: 'pw',
        ipcToken: 'test-ipc-token',
        ipcPort: 0,
        vaultPath: join(mkdtempSync(join(tmpdir(), 'daemon-owner-vault-')), 'keyring.dat'),
        directory: process.cwd(),
        inventoryIntervalMs: 3_600_000,
        runtimeDir,
      });
      handles.push(handle);

      // Published against the port the server ACTUALLY bound, not the 0 we
      // asked for — a marker naming port 0 would be useless to the shell.
      const raw = readFileSync(ownerPath, 'utf8');
      const parsed = parseDaemonOwnerMarker(raw, KEY);
      expect(parsed, `marker must verify: ${raw}`).not.toBeNull();
      expect(parsed?.pid).toBe(process.pid);
      expect(parsed?.ipcPort).toBe(handle.ipcPort);
      expect(parsed?.ipcPort).toBeGreaterThan(0);
      expect(parsed?.contractVersion).toBe('3.1.0');

      // A second launch holding the same key adopts it; a different key does not.
      expect(parseDaemonOwnerMarker(raw, OTHER)).toBeNull();

      await handle.stop();
      handles.pop();
      expect(existsSync(ownerPath), 'a clean stop must not leave a stale claim').toBe(false);
    } finally {
      if (previous === undefined) delete process.env[DAEMON_OWNER_KEY_ENV];
      else process.env[DAEMON_OWNER_KEY_ENV] = previous;
    }
  });

  test('a daemon started without an install key publishes nothing', async () => {
    // A hand-started `cli.js serve` has no key, so it cannot claim the port. A
    // later launch will then report 4097 as held by a stranger — which is
    // TRUE, and is the point of C2.
    const runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-nokey-'));
    const previous = process.env[DAEMON_OWNER_KEY_ENV];
    delete process.env[DAEMON_OWNER_KEY_ENV];
    try {
      const { server, port } = await fakeServe();
      servers.push(server);
      const handle = await startDaemon({
        servePort: port,
        servePassword: 'pw',
        ipcToken: 'test-ipc-token',
        ipcPort: 0,
        vaultPath: join(mkdtempSync(join(tmpdir(), 'daemon-nokey-vault-')), 'keyring.dat'),
        directory: process.cwd(),
        inventoryIntervalMs: 3_600_000,
        runtimeDir,
      });
      handles.push(handle);
      expect(existsSync(join(runtimeDir, 'daemon.owner'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[DAEMON_OWNER_KEY_ENV];
      else process.env[DAEMON_OWNER_KEY_ENV] = previous;
    }
  });

  test('stop does not delete a claim that is no longer ours', async () => {
    // `clearOwner` re-reads and re-validates before unlinking, so a daemon that
    // has been superseded does not delete its successor's claim — which would
    // make the shell refuse a perfectly healthy daemon.
    const runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-successor-'));
    const ownerPath = join(runtimeDir, DAEMON_OWNER_FILE);
    const previous = process.env[DAEMON_OWNER_KEY_ENV];
    process.env[DAEMON_OWNER_KEY_ENV] = KEY;
    try {
      const { server, port } = await fakeServe();
      servers.push(server);
      const handle = await startDaemon({
        servePort: port,
        servePassword: 'pw',
        ipcToken: 'test-ipc-token',
        ipcPort: 0,
        vaultPath: join(mkdtempSync(join(tmpdir(), 'daemon-succ-vault-')), 'keyring.dat'),
        directory: process.cwd(),
        inventoryIntervalMs: 3_600_000,
        runtimeDir,
      });
      handles.push(handle);
      expect(parseDaemonOwnerMarker(readFileSync(ownerPath, 'utf8'), KEY)).not.toBeNull();

      // Another install publishes over the top of us.
      writeFileSync(ownerPath, owner({ ownerKey: OTHER }), 'utf8');
      await handle.stop();
      handles.pop();

      expect(existsSync(ownerPath), 'a foreign claim must survive our stop').toBe(true);
      expect(
        parseDaemonOwnerMarker(readFileSync(ownerPath, 'utf8'), OTHER),
        'and it must still be the foreign claim, undamaged',
      ).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env[DAEMON_OWNER_KEY_ENV];
      else process.env[DAEMON_OWNER_KEY_ENV] = previous;
    }
  });
});

describe('env resolvers', () => {
  test('vault path prefers explicit db, then the canonical vault root', () => {
    expect(vaultPathFromEnv({ VOXAURA_VAULT_PATH: '/tmp/k.dat' } as NodeJS.ProcessEnv)).toBe('/tmp/k.dat');
    expect(
      vaultPathFromEnv({ VOXAURA_VAULT_DIR: '/repo/vault' } as NodeJS.ProcessEnv, '/elsewhere'),
    ).toBe(join('/repo/vault', 'keyring.dat'));
    expect(vaultPathFromEnv({} as NodeJS.ProcessEnv, '/repo')).toBe(join('/repo', 'vault', 'keyring.dat'));
    expect(ipcTokenFromEnv({ VOICE_RUNTIME_IPC_TOKEN: 'abc' } as NodeJS.ProcessEnv)).toBe('abc');
    expect(ipcTokenFromEnv({} as NodeJS.ProcessEnv)).toBe('');
  });

  test('ensureIpcToken generates a per-install token once and reuses it', () => {
    const path = ipcTokenPath(join(mkdtempSync(join(tmpdir(), 'ipctoken-'))));
    const first = ensureIpcToken(path);
    expect(first.length).toBe(64); // 32 random bytes, hex
    expect(ensureIpcToken(path)).toBe(first);
  });
});