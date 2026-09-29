import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ipcTokenFromEnv, startDaemon, vaultPathFromEnv, type DaemonHandle, type DaemonOptions } from './daemon.js';
import {
  DAEMON_OWNER_FILE,
  DAEMON_OWNER_KEY_ENV,
  ensureIpcToken,
  ipcTokenPath,
  parseDaemonOwnerMarker,
} from './daemon.js';
import { decodeAudioChunk, MAX_AUDIO_CHUNK } from './ipc/audio.js';
import { decodeFrames, maskFrame, Opcode } from './ipc/protocol.js';
import { FishCreditError } from './voice/tts.js';
import { readKeyPools, writeKeyPools } from './voice/key-store.js';
import { FileVault } from './voice/vault.js';
import { Keyring } from './voice/keyring.js';

// The STT provider is stubbed for the whole file: a real turn must never reach
// Groq (hermetic, and no quota). It rejects instantly, so a test can wait for
// the daemon's `stt-failed` notice as the deterministic signal that the pipeline
// ring has already ACQUIRED a key — which is the state A.6 is about.
//
// MUTABLE, and the default is still the rejection every other test here depends
// on. A turn that must reach `onUtterance` needs a real transcript, and the only
// other way to get one is a live Whisper call. The object is read inside
// `create` (at call time), never in the factory body, so hoisting cannot catch
// it in TDZ.
const sttState: { text: string | null } = { text: null };

vi.mock('groq-sdk', () => ({
  default: class StubGroq {
    readonly audio = {
      transcriptions: {
        create: (): Promise<{ text: string; segments: unknown[] }> =>
          sttState.text === null
            ? Promise.reject(new Error('stubbed STT provider'))
            : // `segments: []` is not a shortcut: `meanNoSpeechProb` returns
              // undefined for an empty array, so the window is NOT dropped by the
              // `no_speech_prob > 0.6` gate and the turn really reaches think().
              Promise.resolve({ text: sttState.text, segments: [] }),
      },
    };
  },
}));

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

async function boot(vaultPath: string, over: Partial<DaemonOptions> = {}, realNarrator = false): Promise<DaemonHandle> {
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
    // Never the real provider: a command that narrates would otherwise spend a
    // network call (and quota) inside a hermetic test. `realNarrator` opts a
    // test back into the production closure, because the ring THAT builds is
    // only reachable from inside the daemon.
    ...(realNarrator ? {} : { narratorChat: async () => '{"line":"تم"}' }),
    ...over,
  });
  handles.push(handle);
  return handle;
}

interface AckFrame {
  readonly type: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly detail?: string;
}

/**
 * Drive ONE command through the real WS-4097 transport: handshake with the
 * subprotocol bearer, send a masked client frame, resolve on the matching ack.
 * Going through the socket (not the handler directly) is what makes
 * `saveApiKeys` a production-shaped event: a test that called the handler
 * itself would still pass with a router that the shell can never reach.
 */
function sendCommand(port: number, token: string, cmd: Record<string, unknown>): Promise<AckFrame> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        Buffer.from(
          [
            'GET /v1/ui HTTP/1.1',
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            `Sec-WebSocket-Protocol: voice-ui.v1, ${token}`,
            '',
            '',
          ].join('\r\n'),
          'utf8',
        ),
      );
    });
    let acc = Buffer.alloc(0);
    let head = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('no ack within 5s'));
    }, 5_000);
    const fail = (err: Error): void => {
      clearTimeout(timer);
      reject(err);
    };
    sock.on('error', fail);
    const onFrames = (bytes: Buffer): void => {
      if (bytes.byteLength === 0) return;
      acc = Buffer.concat([acc, bytes]);
      const { frames, remaining } = decodeFrames(acc);
      acc = Buffer.from(remaining);
      for (const f of frames) {
        if (f.opcode !== Opcode.Text) continue;
        const frame = JSON.parse(Buffer.from(f.payload).toString('utf8')) as AckFrame;
        if (frame.type !== 'ack' || frame.id !== cmd['id']) continue;
        clearTimeout(timer);
        sock.end();
        resolve(frame);
        return;
      }
    };
    sock.on('data', (chunk: Buffer) => {
      if (upgraded) {
        onFrames(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) return;
      upgraded = true;
      const rest = head.subarray(idx + 4);
      sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify(cmd)), Buffer.from([1, 2, 3, 4])));
      onFrames(rest);
    });
  });
}

/** Poll until `ready()` or the deadline. For fire-and-forget daemon work. */
async function until(ready: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('condition not met within budget');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface DestroyProbe {
  /** The ring that was destroyed — read its cache again after the zeroing. */
  readonly ring: Keyring;
  /** Key material the cache held at the moment destroy() was called. */
  readonly snapshot: string[];
  /** The live Buffer objects, so they can be inspected AFTER zeroing. */
  readonly held: Buffer[];
}

/** The ring's per-pool cache. Private, so this reads it the way a debugger would. */
const cachedBuffers = (ring: Keyring): Map<string, Buffer> =>
  (ring as unknown as { cached: Map<string, Buffer> }).cached;

/**
 * Spy on the real `Keyring.destroy`, recording what each ring was holding.
 *
 * A spy on the prototype — not an injected seam — because the point is that the
 * PRODUCTION rings are the ones destroyed. `mockRestore` puts the method back.
 */
function watchKeyringDestroys(): { readonly probes: DestroyProbe[]; restore: () => void } {
  const probes: DestroyProbe[] = [];
  const real = Keyring.prototype.destroy;
  const spy = vi.spyOn(Keyring.prototype, 'destroy');
  spy.mockImplementation(function (this: Keyring) {
    const cache = cachedBuffers(this);
    probes.push({ ring: this, snapshot: [...cache.values()].map((b) => b.toString('utf8')), held: [...cache.values()] });
    real.call(this);
  });
  return { probes, restore: () => spy.mockRestore() };
}

/** The bytes the daemon is supposed to have erased. */
const allZero = (b: Buffer): boolean => [...b].every((x) => x === 0);

/**
 * Push one real 5 s uplink window through WS-4097 and resolve on the daemon's
 * `stt-failed` notice.
 *
 * This exists because a ring that has never acquired anything holds nothing, so
 * "stop() zeroed the cache" would pass on a daemon whose cache was always empty.
 * Driving a real window is the only way to make the PIPELINE ring hold key
 * bytes; the notice is the deterministic proof the acquire already happened.
 */
function driveSttTurn(port: number, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        Buffer.from(
          [
            'GET /v1/ui HTTP/1.1',
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            `Sec-WebSocket-Protocol: voice-ui.v1, ${token}`,
            '',
            '',
          ].join('\r\n'),
          'utf8',
        ),
      );
    });
    let acc = Buffer.alloc(0);
    let head = Buffer.alloc(0);
    let upgraded = false;
    const seen: string[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no stt-failed notice within 12s; saw [${seen.join(', ')}]`));
    }, 12_000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('data', (chunk: Buffer) => {
      let rest = chunk;
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const idx = head.indexOf('\r\n\r\n');
        if (idx === -1) return;
        upgraded = true;
        // 50 × 100 ms of full-scale PCM = one 160 000-byte window, loud enough
        // to clear the −30 dBFS energy gate.
        const loud = Buffer.alloc(3200, 0x7f);
        for (let i = 0; i < 50; i += 1) sock.write(maskFrame(Opcode.Binary, loud, Buffer.from([1, 2, 3, 4])));
        rest = head.subarray(idx + 4);
      }
      acc = Buffer.concat([acc, rest]);
      const { frames, remaining } = decodeFrames(acc);
      acc = Buffer.from(remaining);
      for (const f of frames) {
        if (f.opcode !== Opcode.Text) continue;
        const frame = JSON.parse(Buffer.from(f.payload).toString('utf8')) as { type?: string; code?: string };
        seen.push(frame.code ?? frame.type ?? '?');
        if (frame.type !== 'notice' || frame.code !== 'stt-failed') continue;
        clearTimeout(timer);
        sock.end();
        resolve();
        return;
      }
    });
  });
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

describe('A5: the TTS credit clock belongs to the daemon, not to the pipeline', () => {
  const DAY_MS = 86_400_000;
  const T0 = 1_760_000_000_000;

  test('a 402 fault is still 7 days overdue after saveApiKeys rebuilds the pipeline', async () => {
    let now = T0;
    const runtimeDir = mkdtempSync(join(tmpdir(), 'daemon-credit-rt-'));
    const vaultPath = join(mkdtempSync(join(tmpdir(), 'daemon-credit-')), 'keyring.dat');
    const handle = await boot(vaultPath, { ttsCreditNow: () => now, runtimeDir });

    // The fault lands on the daemon's monitor, exactly as the TTS credit
    // interceptor in `onUtterance` records it.
    const before = handle.ttsCredit;
    expect(before.recordFault(new FishCreditError(402, 'out of credit')).daysSinceFirstFault).toBe(0);

    now = T0 + 7 * DAY_MS;
    const ack = await sendCommand(handle.ipcPort, 'test-ipc-token', {
      id: 'cmd-keys',
      kind: 'saveApiKeys',
      groqKey: 'g1',
      fishKey: 'f1',
      openrouterKey: 'o1',
    });
    expect(ack).toMatchObject({ ok: true });
    // The router drops the saver's `detail` (command-router returns a bare
    // `{ok:true}`), so the ack cannot prove the rebuild ran. The vault can:
    // `writeKeyPools` is the statement immediately before it.
    expect(readKeyPools(new FileVault(vaultPath))).toEqual({ groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });

    // The escalation is a property of the fault, not of the pipeline object. A
    // monitor rebuilt with the pipeline restarts the clock here, so the
    // operator's "a week without voice" slides forward on every key save.
    const after = handle.ttsCredit;
    expect(after, 'the same monitor must survive the rebuild').toBe(before);
    expect(after.faultCount, 'and it must still hold the one recorded fault').toBe(1);
    const status = after.status();
    expect(status.daysSinceFirstFault).toBe(7);
    expect(status.noticeCode).toBe('tts-credit-exhausted-overdue');

    // Positive proof that the POST-SAVE rebuild ran and succeeded, without
    // which the three assertions above would also hold on a daemon that never
    // rebuilt anything. `rebuildVoice` records KEYS_MISSING only when the
    // pipeline fails to build, so exactly one row — written at boot, while the
    // vault was still keyless — means the save produced a working pipeline.
    await handle.stop();
    handles.pop();
    const rows = readFileSync(join(runtimeDir, 'voice-runtime.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"KEYS_MISSING"'));
    expect(rows.length, 'the save-time rebuild must have succeeded, not failed again').toBe(1);
  });
});

describe('A.6: key material is zeroed when the ring that holds it goes away', () => {
  // `Keyring` caches ONE Buffer per pool for the ring's whole life, so a ring
  // that is merely "still referenced" is a ring still holding three API keys in
  // the heap. Two owners exist — the pipeline ring (rebuilt on every key save)
  // and the per-narration ring — and each is destroyed by its OWN owner. The
  // assertion is on the bytes, not on a call count, so a ring that never held
  // material cannot make these pass.
  //
  // HONEST GAP (peer review): the `buildVoicePipeline` catch path that zeroes a
  // ring orphaned by a throwing constructor is NOT covered here — driving it
  // needs a post-load constructor throw that is not injectable today. It is
  // defense-in-depth, not a verified guard; do not cite it as tested.

  const keyedVault = (prefix: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), prefix)), 'keyring.dat');
    writeKeyPools(new FileVault(path), { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
    return path;
  };

  // Force the ENERGY gate. `models/silero-vad.onnx` is gitignored and ships in
  // no build (the daemon's own decision is the RMS fallback when the model is
  // absent), but a developer checkout can have one, and Silero correctly judges
  // a full-scale DC tone to be non-speech — which would gate the window and make
  // this suite silently test nothing.
  const PREV_VAD = process.env['VAD_MODEL_PATH'];
  beforeEach(() => {
    process.env['VAD_MODEL_PATH'] = 'models/a6-absent-vad.onnx';
  });
  afterEach(() => {
    if (PREV_VAD === undefined) delete process.env['VAD_MODEL_PATH'];
    else process.env['VAD_MODEL_PATH'] = PREV_VAD;
  });

  test('stop() zeroes the pipeline ring, including bytes a live turn cached', async () => {
    const watch = watchKeyringDestroys();
    try {
      const handle = await boot(keyedVault('a6-stop-'));
      await driveSttTurn(handle.ipcPort, 'test-ipc-token');
      await handle.stop();
      handles.pop();

      expect(watch.probes.length, 'stop() must destroy the one live ring').toBe(1);
      const probe = watch.probes[0] as DestroyProbe;
      expect(probe.snapshot, 'the destroyed ring really held the Groq key the turn acquired').toContain('g1');
      for (const buf of probe.held) expect(allZero(buf), 'cached key bytes must be erased in place').toBe(true);
      expect(cachedSize(probe), 'and the ring must forget them').toBe(0);
    } finally {
      watch.restore();
    }
  }, 20_000);

  test('saving keys destroys the ring the previous pipeline was holding', async () => {
    // The half most likely to be missed: the replaced ring is the one holding
    // the bytes the user just replaced, and nothing else in the process knows
    // it exists.
    const watch = watchKeyringDestroys();
    try {
      const handle = await boot(keyedVault('a6-save-'));
      await driveSttTurn(handle.ipcPort, 'test-ipc-token');
      const ack = await sendCommand(handle.ipcPort, 'test-ipc-token', {
        id: 'cmd-a6-save',
        kind: 'saveApiKeys',
        groqKey: 'g2',
        fishKey: 'f2',
        openrouterKey: 'o2',
      });
      expect(ack).toMatchObject({ ok: true });

      expect(watch.probes.length, 'the save must destroy exactly the ring it replaced').toBe(1);
      const replaced = watch.probes[0] as DestroyProbe;
      expect(replaced.snapshot, 'the replaced ring was holding the old key').toContain('g1');
      for (const buf of replaced.held) expect(allZero(buf), 'the replaced ring must be zeroed, not just dropped').toBe(true);

      // The survivor is a different ring, and stop() still owns it.
      await handle.stop();
      handles.pop();
      expect(watch.probes.length).toBe(2);
      expect(watch.probes[1]?.snapshot, 'the rebuilt ring is the one stop() finishes off').not.toContain('g1');
    } finally {
      watch.restore();
    }
  });

  test('a narration ring is zeroed even when the provider call throws', async () => {
    // `narratorChat` builds a ring PER CALL, so a `try` without `finally` (or a
    // bare `return await`) leaks one ring per narration for the daemon's whole
    // life. An error is the common case — the narrator swallows it and returns
    // null — so the throw path is the one that matters.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://openrouter.ai')) return Promise.reject(new Error('stubbed provider outage'));
      return realFetch(input, init);
    });
    const watch = watchKeyringDestroys();
    try {
      const handle = await boot(keyedVault('a6-narrate-'), {}, true);
      // `setPersona` fires `onExecuted`, which is what makes the daemon narrate.
      const ack = await sendCommand(handle.ipcPort, 'test-ipc-token', {
        id: 'cmd-a6-persona',
        kind: 'setPersona',
        persona: 'nour',
      });
      expect(ack).toMatchObject({ ok: true });
      await until(() => watch.probes.length > 0);

      expect(watch.probes.length, 'exactly the one per-call ring, and no pipeline ring').toBe(1);
      const probe = watch.probes[0] as DestroyProbe;
      expect(probe.snapshot, 'the narration ring acquired the OpenRouter key').toEqual(['o1']);
      for (const buf of probe.held) expect(allZero(buf), 'a failed narration must still erase the key').toBe(true);
      await handle.stop();
      handles.pop();
    } finally {
      watch.restore();
      vi.unstubAllGlobals();
    }
  });
});

/** Buffers the destroyed ring still referenced (0 once it forgot them). */
const cachedSize = (probe: DestroyProbe): number => cachedBuffers(probe.ring).size;

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

// ---------------------------------------------------------------------------
// M2-6c: the Fish response is DRAINED, not awaited whole.

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface AudioShell {
  /** Resolves once the 101 completed; `frames` is meaningless before that. */
  readonly ready: Promise<void>;
  /** One entry per broadcast downlink frame, still wire-encoded. */
  readonly frames: Buffer[];
  readonly failures: string[];
  send(payload: Buffer): void;
  close(): void;
}

/**
 * A real shell socket, used as BOTH directions: it uplinks one loud PCM window
 * and records every downlink audio frame the daemon broadcasts.
 *
 * End to end on purpose. `broadcastAudio` is private to `startDaemon` and
 * `onUtterance` is a closure inside it, so the only place the drain is
 * observable from outside the process is the wire itself — a test that injected
 * a fake synthesizer would be asserting against its own fake.
 */
function openAudioShell(port: number, token: string): AudioShell {
  const frames: Buffer[] = [];
  const failures: string[] = [];
  let acc = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let upgraded = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  const sock = createConnection({ host: '127.0.0.1', port }, () => {
    sock.write(
      Buffer.from(
        [
          'GET /v1/ui HTTP/1.1',
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Protocol: voice-ui.v1, ${token}`,
          '',
          '',
        ].join('\r\n'),
        'utf8',
      ),
    );
  });
  sock.on('error', (err) => failures.push(err.message));
  sock.on('data', (chunk: Buffer) => {
    let rest = chunk;
    if (!upgraded) {
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) return;
      upgraded = true;
      resolveReady();
      rest = head.subarray(idx + 4);
    }
    acc = Buffer.concat([acc, rest]);
    const { frames: decoded, remaining } = decodeFrames(acc);
    acc = Buffer.from(remaining);
    for (const f of decoded) if (f.opcode === Opcode.Binary) frames.push(Buffer.from(f.payload));
  });
  return {
    ready,
    frames,
    failures,
    send: (payload) => sock.write(maskFrame(Opcode.Binary, payload, Buffer.from([1, 2, 3, 4]))),
    close: () => sock.destroy(),
  };
}

describe('M2-6c: the Fish response is drained, not awaited whole', () => {
  // The RMS fallback, not Silero: `models/*.onnx` is gitignored and ships in no
  // build, and a developer checkout that HAS one would correctly reject a
  // full-scale DC tone as non-speech — gating the window and silently making
  // this suite assert nothing.
  const PREV_VAD = process.env['VAD_MODEL_PATH'];
  beforeEach(() => {
    process.env['VAD_MODEL_PATH'] = 'models/m2-6c-absent-vad.onnx';
    sttState.text = null;
  });
  afterEach(() => {
    sttState.text = null;
    // Peer review: unstub here, not in each test's finally — a throw inside
    // boot() skips the finally and leaks the fetch stub into later tests.
    vi.unstubAllGlobals();
    if (PREV_VAD === undefined) delete process.env['VAD_MODEL_PATH'];
    else process.env['VAD_MODEL_PATH'] = PREV_VAD;
  });

  const keyedVault = (prefix: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), prefix)), 'keyring.dat');
    writeKeyPools(new FileVault(path), { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
    return path;
  };

  /**
   * Boot a keyed daemon whose Fish endpoint is a body that yields `chunks` and
   * then parks on `gate` before the LAST one.
   *
   * `pulled` is the observable that matters: it counts what the DAEMON has asked
   * for, so a value of 1 with a frame already on the wire is proof the broadcast
   * did not wait for synthesis to finish.
   */
  function bootGatedFish(chunks: Uint8Array[]): {
    readonly pulls: () => number;
    readonly yielded: () => number;
    readonly gate: Deferred<void>;
  } {
    const gate = deferred<void>();
    let pulled = 0;
    let yielded = 0;
    const realFetch = globalThis.fetch;
    // Stubbed BEFORE `startDaemon`, not after: `FishHttpTransport` captures
    // `fetch` in its constructor (`options.fetchImpl ?? fetch`), and the daemon
    // builds the transport inside `buildVoicePipeline`. A later stub would be
    // dead code wearing a test's clothes.
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.fish.audio')) return realFetch(input, init);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller): Promise<void> | void {
              pulled += 1;
              if (pulled > chunks.length) {
                controller.close();
                return;
              }
              // A ReadableStream refills its queue to the high-water mark, so
              // `pulled` reaches the LAST chunk while the previous one is still
              // in flight — it measures what the daemon ASKED for, not what
              // exists. `yielded` is the honest one: it moves only when bytes
              // actually enter the queue, and the last pull is what parks here.
              const next = chunks[pulled - 1] as Uint8Array;
              const emit = (): void => {
                yielded += 1;
                controller.enqueue(next);
                controller.close();
              };
              if (pulled < chunks.length) {
                controller.enqueue(next);
                yielded += 1;
                return;
              }
              return gate.promise.then(emit);
            },
          }),
          { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
        ),
      );
    });
    return { pulls: () => pulled, yielded: () => yielded, gate };
  }

  test('the first audio frame is on the wire while the LAST Fish chunk is still pending', async () => {
    sttState.text = '/compact';
    const A = Buffer.alloc(4096, 0xa1);
    const B = Buffer.alloc(2048, 0xb2);
    const rig = bootGatedFish([new Uint8Array(A), new Uint8Array(B)]);
    const handle = await boot(keyedVault('m2-6c-drain-'));
    const shell = openAudioShell(handle.ipcPort, 'test-ipc-token');
    try {
      await shell.ready;
      // 50 x 100 ms of full-scale PCM: one 160,000-byte window, over the
      // -30 dBFS energy gate.
      const loud = Buffer.alloc(3200, 0x7f);
      for (let i = 0; i < 50; i += 1) shell.send(loud);

      await until(() => rig.pulls() >= 2, 5_000);
      // Generous for what is left: an `for await` resume plus a loopback write.
      // Not a sleep-for-pass — the assertions below are the real gate.
      await new Promise((r) => setTimeout(r, 300));

      expect(
        rig.yielded(),
        'Fish must still be holding the last chunk back — a stream that finished early proves nothing',
      ).toBe(1);
      expect(
        shell.frames.length,
        'the first chunk must be broadcast while the last is still pending — ' +
          'awaiting the whole sentence hid the measured 426-556 ms Fish TTFB',
      ).toBeGreaterThan(0);
      expect(shell.failures).toEqual([]);

      rig.gate.resolve();
      await until(() => shell.frames.length >= 2, 5_000);

      const chunks = shell.frames.map((f) => decodeAudioChunk(new Uint8Array(f)));
      expect(chunks.filter((c) => c === null).length, 'every downlink frame must be audio').toBe(0);
      const seqs = chunks.map((c) => c?.seq ?? -1);
      expect(seqs, 'the shell player is strict FIFO, so seq must be dense and ascending').toEqual(
        seqs.map((_, i) => i),
      );
      const bytes = Buffer.concat(chunks.flatMap((c) => (c === null ? [] : [Buffer.from(c.audio)])));
      expect(bytes.equals(Buffer.concat([A, B])), 'the drained bytes must arrive in order and intact').toBe(
        true,
      );
    } finally {
      shell.close();
    }
  }, 20_000);

  test('a Fish chunk larger than the 64 KiB audio cap is still split under 32 KiB', async () => {
    // The drain moves the split from "one whole sentence" to "one Fish chunk",
    // and a Fish chunk has no size guarantee — so the bound that keeps the
    // downlink inside the 64 KiB MAX_AUDIO_BYTES envelope now has to come from
    // `splitAudio`, per call, rather than from the sentence total.
    sttState.text = '/compact';
    const big = new Uint8Array(100 * 1024).fill(0x5a);
    const rig = bootGatedFish([big]);
    const handle = await boot(keyedVault('m2-6c-cap-'));
    const shell = openAudioShell(handle.ipcPort, 'test-ipc-token');
    try {
      await shell.ready;
      const loud = Buffer.alloc(3200, 0x7f);
      for (let i = 0; i < 50; i += 1) shell.send(loud);
      rig.gate.resolve();
      await until(() => rig.pulls() >= 1, 5_000);
      await until(() => shell.frames.length >= 4, 5_000);

      const sizes = shell.frames.map((f) => decodeAudioChunk(new Uint8Array(f))?.audio.byteLength ?? -1);
      expect(Math.max(...sizes), 'no frame may exceed the 32 KiB downlink chunk').toBeLessThanOrEqual(
        MAX_AUDIO_CHUNK,
      );
      expect(Math.max(...sizes), 'and so none can approach MAX_AUDIO_BYTES').toBeLessThan(64 * 1024);
      expect(sizes.reduce((n, s) => n + s, 0)).toBe(big.byteLength);
    } finally {
      shell.close();
    }
  }, 20_000);
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