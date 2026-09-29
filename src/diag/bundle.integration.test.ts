import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { assertRedactionSafe, hasResidualMaterial } from './bundle.js';
import { UiServer } from '../ipc/ui-server.js';
import { FileVault } from '../voice/vault.js';
import { writeKeyPools } from '../voice/key-store.js';
import {
  collectBundle,
  defaultBundleSources,
  probeServePort,
  probeUiBridgeHandshake,
  renderBundle,
} from './bundle.js';

// M5 `doctor --bundle` against REAL sockets. The unit suite proves the shape;
// this suite proves the probes survive a real listener, a real 401 and a real
// squatter — the three cases that made "just TCP-connect to 4097" wrong.
//
// `describe.sequential` is required: every test here owns a port, a temp
// runtime dir and the process-wide VOXAURA_MACHINE_KEY the vault reads.

const FAKE_GROQ = 'gsk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_OR = 'sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FAKE_FISH = 'sk-fish-AAAAAAAAAAAAAAAAAAAAAAAAAA';
const UPPER = 'SK-FISH-AAAAAAAAAAAAAAAAAAAAAAAAAA';
const IPC_TOKEN = 'integration-ipc-token-AAAA';
const WRONG_SERVE_PASSWORD = 'serve-pass-the-stub-never-issued';

const open: { close(): void }[] = [];
const closers: (() => Promise<void> | void)[] = [];



afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function ephemeralHttp(handler: (auth: string | undefined) => { status: number }): Promise<number> {
  const server = createServer((req, res) => {
    const { status } = handler(req.headers.authorization);
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(status === 200 ? JSON.stringify({ data: [] }) : 'denied');
  });
  open.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
}

describe.sequential('doctor --bundle against a stub daemon', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'voxaura-rt-'));
  const vaultPath = join(runtimeDir, 'keyring.dat');
  const machineKey = 'ab'.repeat(32);
  let previousMachineKey: string | undefined;

  beforeAll(() => {
    // The vault reads `process.env` directly, so pinning the machine key here is
    // what keeps this suite from touching the operator's real
    // ~/.opencode-voice-runtime/machine.key (creating one would be a side effect
    // a diagnostics test must never have).
    previousMachineKey = process.env['VOXAURA_MACHINE_KEY'];
    process.env['VOXAURA_MACHINE_KEY'] = machineKey;
    // The IPC token is resolved from `<runtime>/ipc.token` when the env var is
    // absent, exactly as an installed build has it. Writing the file (rather
    // than the env var) exercises the real path resolution.
    writeFileSync(join(runtimeDir, 'ipc.token'), IPC_TOKEN, 'utf8');
    // A serve password that is present but WRONG. This is the L17 shape: the
    // port answers, the credential does not work, and the only thing that tells
    // the two apart is the status code. Resolved from the file, as an installed
    // build has it (the shell provisions serve.pass, not the operator's env).
    writeFileSync(join(runtimeDir, 'serve.pass'), WRONG_SERVE_PASSWORD, 'utf8');
    writeKeyPools(new FileVault(vaultPath), { groq: [FAKE_GROQ], fish: [FAKE_FISH], openrouter: [FAKE_OR] });
    // Logs that carry deliberate fake material on three different surfaces:
    // a provider prefix, a Bearer header and an uppercase prefix the shared
    // redactor would miss.
    writeFileSync(
      join(runtimeDir, 'daemon.log'),
      [
        'daemon: bound ws 127.0.0.1:4097',
        `daemon: brain call failed with ${FAKE_OR}`,
        `daemon: Authorization: Bearer ${FAKE_FISH}`,
        // Uppercase: invisible to the shared redactor, caught by this bundle's
        // own case-insensitive sweep and SCRUBBED.
        `daemon: fish rejected ${UPPER}`,
        // A bracketed assignment value: the unquoted class stopped at `]`, so
        // the tail beside it used to ship. Now consumed whole, and asserted
        // scrubbed-rather-than-refused, which is the better outcome.
        'daemon: x-api-key: [bracket-tail-inside]',
        'daemon: shutting down',
      ].join('\n'),
    );
    writeFileSync(join(runtimeDir, 'opencode.log'), `serve: upstream said ${FAKE_FISH} is unknown\n`);
    writeFileSync(
      join(runtimeDir, 'voice-runtime.jsonl'),
      [
        JSON.stringify({
          timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          seq: 0,
          subsystem: 'TTS',
          status: 'ERROR',
          latencyMs: 10,
          errorCode: 'TTS_CREDIT_402',
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          seq: 1,
          subsystem: 'STT',
          status: 'OK',
          latencyMs: 700,
        }),
      ].join('\n'),
    );
  });

  afterAll(() => {
    if (previousMachineKey === undefined) delete process.env['VOXAURA_MACHINE_KEY'];
    else process.env['VOXAURA_MACHINE_KEY'] = previousMachineKey;
  });

  function sources(port: number, ipcPort: number) {
    return defaultBundleSources({
      env: { VOICE_RUNTIME_DIR: runtimeDir, VOXAURA_VAULT_PATH: vaultPath } as NodeJS.ProcessEnv,
      cwd: runtimeDir,
      home: runtimeDir,
      readTextFile: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
      ports: [
        { role: 'serve', port },
        { role: 'ui-bridge', port: ipcPort },
      ],
    });
  }

  test('a real UiServer on an ephemeral port is authenticated 101, and nothing leaks', async () => {
    const ui = new UiServer({ token: IPC_TOKEN, contractVersion: '3.1.0' });
    const ipcPort = await ui.start(0);
    closers.push(() => ui.close());
    // The stub issues 200 ONLY for the password it knows. The wired one is a
    // different string, so the probe gets 401 — the present-but-unusable
    // credential case, which is the whole point of surfacing the status code.
    const rightHeader = `Basic ${Buffer.from('opencode:the-right-one').toString('base64')}`;
    const servePort = await new Promise<number>((resolve) => {
      const s = createServer((req, res) => {
        const ok = req.headers.authorization === rightHeader;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      });
      open.push(s);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });

    const { bundle, outcome, exitCode } = await collectBundle(sources(servePort, ipcPort));
    const text = renderBundle(bundle);

    // The artefact is the deliverable: a public ticket gets THIS string.
    // The oracle is the module's own material-level check, NOT
    // `containsSecret`: that is TRUE on `apiKey=[REDACTED]` and would reject a
    // perfectly clean bundle (measured — see the unit suite).
    expect(hasResidualMaterial(text)).toBe(false);
    expect(() => assertRedactionSafe(bundle)).not.toThrow();
    for (const fake of [FAKE_GROQ, FAKE_OR, FAKE_FISH, UPPER, IPC_TOKEN, machineKey]) {
      expect(text, `leaked ${fake.slice(0, 10)}`).not.toContain(fake);
    }
    expect(bundle.redactions.wholeBundleSafe).toBe(true);

    // The 4097 probe is a HANDSHAKE, not a TCP connect: an authenticated 101
    // with a correct accept key.
    const ui7 = bundle.ports.find((p) => p.role === 'ui-bridge');
    expect(ui7?.status).toBe(101);
    expect(ui7?.healthy).toBe(true);
    expect(ui7?.refusal).toBe('none');

    // The 4096 probe separates reachable-but-unauthenticated (the L17 case)
    // from unreachable, and reports the code that tells them apart. The stub
    // answers 401 for any credential it did not issue, and the wired password is
    // deliberately not the right one.
    const serve = bundle.ports.find((p) => p.role === 'serve');
    expect(serve?.status).toBe(401);
    expect(serve?.refusal).toBe('unauthenticated');
    expect(serve?.bound).toBe(true);
    // The password was used and is nowhere in the artifact.
    expect(text).not.toContain(WRONG_SERVE_PASSWORD);

    // Keys: three pools, fingerprints only.
    expect(bundle.keys?.pools.filter((p) => p.count === 1)).toHaveLength(3);
    expect(bundle.keys?.undecryptable).toEqual([]);
    // Telemetry derived from the jsonl.
    expect(bundle.telemetry?.codeHistogram).toEqual({ TTS_CREDIT_402: 1 });
    expect(bundle.telemetry?.daysSinceFirstFault).toBe(3);
    // Logs: nothing dropped to achieve "clean". Three lines scrubbed (one of
    // them only by the bundle's own case-insensitive sweep), one refused.
    const daemonLog = bundle.logs.find((l) => l.name === 'daemon.log');
    expect(daemonLog?.present).toBe(true);
    expect(daemonLog?.lines).toHaveLength(6);
    // ZERO refusals, and that is the honest number: after 0b11ba9 the shipped
    // redactors cover every shape this fixture contains, so the refusal arm is
    // defence in depth rather than something a normal log trips. A test that
    // demanded a refusal here would be demanding a redaction bug.
    expect(daemonLog?.lines.filter((l) => l === '[REDACTION-REFUSED]')).toHaveLength(0);
    expect(daemonLog?.scrubbed).toBeGreaterThanOrEqual(3);
    expect(bundle.redactions.refused).toBe(0);
    // The bracketed tail is gone, not merely refused away.
    expect(daemonLog?.lines.join('\n')).not.toContain('bracket-tail-inside');
    // Degraded, not healthy: the serve credential is present but wrong (401).
    expect(outcome).toBe('degraded');
    expect(exitCode).toBe(1);
  });

  test('a WRONG token is 401, not a healthy port', async () => {
    const ui = new UiServer({ token: 'the-real-token', contractVersion: '3.1.0' });
    const ipcPort = await ui.start(0);
    closers.push(() => ui.close());
    const result = await probeUiBridgeHandshake({ port: ipcPort, token: 'not-the-token' });
    expect(result.bound).toBe(true);
    expect(result.healthy).toBe(false);
    expect(result.status).toBe(401);
    expect(result.refusal).toBe('unauthenticated');
  });

  test('a SQUATTER that speaks 101 without a correct accept key is not ours', async () => {
    // This is the false positive the roadmap called out: bare TCP-open reported
    // ready for anything holding the port. A squatter that answers 101 with a
    // made-up accept key must be refused, and so must one that says nothing.
    const squatter = await new Promise<number>((resolve) => {
      const s = createNetServer((socket) => {
        socket.once('data', () => {
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: AAAAAAAAAAA=\r\n\r\n',
          );
        });
      });
      open.push(s);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });
    const liar = await probeUiBridgeHandshake({ port: squatter, token: IPC_TOKEN });
    expect(liar.healthy).toBe(false);
    expect(liar.refusal).toBe('not-our-contract');

    const mute = await new Promise<number>((resolve) => {
      const s = createNetServer(() => {
        /* holds the port, never speaks */
      });
      open.push(s);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });
    const silent = await probeUiBridgeHandshake({ port: mute, token: IPC_TOKEN, timeoutMs: 300 });
    expect(silent.bound).toBe(true);
    expect(silent.healthy).toBe(false);
    expect(silent.status).toBeNull();
    expect(silent.refusal).toBe('timeout');
  });

  test('a closed port is unreachable, which is a different diagnosis from 401', async () => {
    const dead = await ephemeralHttp(() => ({ status: 200 }));
    const result = await probeServePort({ port: dead, password: 'x', timeoutMs: 500 });
    expect(result.status).toBe(200);
    const closed = await probeServePort({ port: 1, password: 'x', timeoutMs: 500 });
    expect(closed.healthy).toBe(false);
    expect(closed.status).toBeNull();
    expect(closed.refusal).toBe('unreachable');
  });

  test('the same stub with the right password is healthy', async () => {
    const port = await ephemeralHttp((auth) => ({ status: auth ? 200 : 401 }));
    const result = await probeServePort({ port, password: 'right', timeoutMs: 1000 });
    expect(result.healthy).toBe(true);
    expect(result.status).toBe(200);
    expect(result.refusal).toBe('none');
  });

  test('an empty password never becomes an Authorization header', async () => {
    let seen: string | undefined;
    const port = await new Promise<number>((resolve) => {
      const s = createServer((req, res) => {
        seen = req.headers.authorization;
        res.writeHead(401);
        res.end();
      });
      open.push(s);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });
    const result = await probeServePort({ port, password: '', timeoutMs: 500 });
    expect(seen).toBeUndefined();
    expect(result.refusal).toBe('no-credential');
    expect(result.status).toBeNull();
  });

  test('an absent vault is reported as absent, and no key file is fabricated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voxaura-nokey-'));
    mkdirSync(dir, { recursive: true });
    const s = defaultBundleSources({
      env: { VOICE_RUNTIME_DIR: dir, VOXAURA_VAULT_PATH: join(dir, 'keyring.dat') } as NodeJS.ProcessEnv,
      cwd: dir,
      home: dir,
      readTextFile: () => null,
    });
    const { bundle } = await collectBundle(s);
    expect(bundle.keys).not.toBeNull();
    expect(bundle.keys?.present).toBe(false);
    expect(bundle.keys?.total).toBe(0);
    // `machineKey()` creates the file when the env var is absent. It is set
    // here, so collecting a bundle must not have written one.
    expect(existsSync(join(dir, 'machine.key'))).toBe(false);
  });
});
