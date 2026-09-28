import { createConnection } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { decodeFrames, maskFrame, MAX_CONNECTIONS, Opcode } from './protocol.js';
import { UiServer } from './ui-server.js';

// G2 TDD — transport behavior over real loopback sockets on ephemeral ports.
// Every server is closed in afterEach so vitest never hangs on open handles.
const servers: UiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function rawSocket(port: number): Promise<{ write: (b: Buffer) => void; readText: () => Promise<string>; end: () => void }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      let head = Buffer.alloc(0);
      let upgraded = false;
      let acc = Buffer.alloc(0);
      const pending: string[] = [];
      const waiters: Array<(s: string) => void> = [];
      const deliver = (text: string): void => {
        const w = waiters.shift();
        if (w !== undefined) w(text);
        else pending.push(text);
      };
      const onFrameBytes = (chunk: Buffer): void => {
        acc = Buffer.concat([acc, chunk]);
        const { frames, remaining } = decodeFrames(acc);
        acc = Buffer.from(remaining);
        for (const f of frames) {
          if (f.opcode === Opcode.Text) {
            deliver(Buffer.from(f.payload).toString('utf8'));
          }
        }
      };
      sock.on('data', (chunk: Buffer) => {
        if (!upgraded) {
          head = Buffer.concat([head, chunk]);
          const idx = head.indexOf('\r\n\r\n');
          if (idx !== -1) {
            upgraded = true;
            const rest = head.subarray(idx + 4);
            head = Buffer.alloc(0);
            if (rest.byteLength > 0) onFrameBytes(rest);
          }
          return;
        }
        onFrameBytes(chunk);
      });
      resolve({
        write: (b: Buffer) => void sock.write(b),
        readText: () =>
          pending.length > 0
            ? Promise.resolve(pending.shift()!)
            : new Promise<string>((res) => void waiters.push(res)),
        end: () => void sock.end(),
      });
    });
    sock.on('error', reject);
  });
}

const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
function handshake(token?: string, extraHeaders: string[] = [], protocols = 'voice-ui.v1'): Buffer {
  const lines = [
    'GET /v1/ui HTTP/1.1',
    'Host: 127.0.0.1',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${WS_KEY}`,
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${protocols}`,
  ];
  if (token !== undefined) lines.push(`Authorization: Bearer ${token}`);
  lines.push(...extraHeaders, '', '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

describe('UiServer authentication (fail-closed)', () => {
  test('missing bearer token -> 401, socket closed, never upgraded', async () => {
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const raw = await new Promise<string>((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(handshake());
      });
      let acc = '';
      const timer = setTimeout(() => resolve(acc), 1000);
      sock.on('data', (chunk: Buffer) => {
        acc += chunk.toString('utf8');
        if (acc.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve(acc);
          sock.end();
        }
      });
      sock.on('error', () => {
        clearTimeout(timer);
        resolve(acc);
      });
    });
    expect(raw).toMatch(/^HTTP\/1\.1 401/);
    expect(raw).not.toContain('Sec-WebSocket-Accept');
    expect(server.connectionCount).toBe(0);
  });

  test('wrong bearer token -> 401 and zero connections', async () => {
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('wrong-token'));
    await new Promise((r) => setTimeout(r, 150));
    expect(server.connectionCount).toBe(0);
    sock.end();
  });

  test('correct bearer -> 101 upgrade + hello frame with contract version', async () => {
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('secret-token'));
    const hello = JSON.parse(await sock.readText()) as { type: string; contractVersion: string; servePort: number };
    expect(hello.type).toBe('hello');
    expect(hello.contractVersion).toBe('3.1.0');
    expect(hello.servePort).toBe(4096);
    expect(server.connectionCount).toBe(1);
    sock.end();
  });

  test('hello does not claim Laya is ready while the seam is uninstalled', async () => {
    // The frame is the only place a shell learns what the daemon has loaded, so
    // a value that disagrees with reality is worse than an absent field. This was
    // a hardcoded `true` with Laya entirely unwired. Flipping it to `true`
    // without installing the dynamic-import seam must fail here.
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('secret-token'));
    const hello = JSON.parse(await sock.readText()) as { layaReady: boolean };
    expect(hello.layaReady).toBe(false);
    sock.end();
  });

  test('a notice carrying a provider error is redacted before it reaches a shell', async () => {
    // The HUD is the one channel a user can see, so an unredacted provider
    // message is the worst possible leak. The three daemon sites that interpolate
    // `err.message` (daemon.ts:584 STT, :738 brain, :789 TTS) all flow through
    // this one sink, so a guard here covers them and any future caller.
    // Synthetic key material only — never a real credential.
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('secret-token'));
    await sock.readText(); // hello

    const detail = 'تعذّر تحويل الكلام إلى نص: 401 from https://api.groq.com with sk-or-v1-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    server.notice('stt-failed', detail, 'error');
    const frame = JSON.parse(await sock.readText()) as { type: string; detail: string };

    expect(frame.type).toBe('notice');
    expect(frame.detail).not.toContain('sk-or-v1-AAAAAAAA');
    expect(frame.detail).toContain('[REDACTED]');
    // The useful part of the message must survive, or the notice is useless.
    expect(frame.detail).toContain('تعذّر تحويل الكلام إلى نص');
    sock.end();
  });

  test('bearer carried as subprotocol token (browser path) upgrades + hello', async () => {
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake(undefined, [], 'voice-ui.v1, secret-token'));
    const hello = JSON.parse(await sock.readText()) as { type: string };
    expect(hello.type).toBe('hello');
    expect(server.connectionCount).toBe(1);
    sock.end();
  });
});

describe('UiServer resume + broadcast', () => {
  test('?lastSeq= query replays missed frames (browser resume path)', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    server.broadcast({ type: 'event', eventId: 'e-1', state: 'running' });
    server.broadcast({ type: 'event', eventId: 'e-2', state: 'complete' });
    const port = await server.start(0);
    const sock = await rawSocket(port);
    const raw = handshake('t').toString('utf8').replace('GET /v1/ui ', 'GET /v1/ui?lastSeq=1 ');
    sock.write(Buffer.from(raw, 'utf8'));
    await sock.readText(); // hello
    const replayed = JSON.parse(await sock.readText()) as { eventId: string; seq: number };
    expect(replayed.eventId).toBe('e-2');
    expect(replayed.seq).toBe(2);
    sock.end();
  });

  test('Last-Seq replays missed frames, dedupe by eventId at the edge', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    server.broadcast({ type: 'event', eventId: 'e-1', state: 'running' });
    server.broadcast({ type: 'event', eventId: 'e-2', state: 'complete' });
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t', ['Last-Seq: 1']));
    const hello = JSON.parse(await sock.readText()) as { type: string; seq: number };
    expect(hello.type).toBe('hello');
    const replayed = JSON.parse(await sock.readText()) as { eventId: string; seq: number };
    expect(replayed.eventId).toBe('e-2');
    expect(replayed.seq).toBe(2);
    sock.end();
  });

  test('renderer commands arrive parsed with ids (masked client frames)', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    const seen = new Promise<unknown>((res) => server.onCommand = res as (c: unknown) => void);
    sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify({ id: 'cmd-9', kind: 'abort' })), Buffer.from([5, 6, 7, 8])));
    const cmd = (await seen) as { id: string; kind: string };
    expect(cmd.id).toBe('cmd-9');
    expect(cmd.kind).toBe('abort');
    sock.end();
  });

  test('switchSession command validates, acks, and surfaces the session id', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    const seen = new Promise<unknown>((res) => server.onCommand = res as (c: unknown) => void);
    sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify({ id: 'cmd-s', kind: 'switchSession', sessionId: 'ses_b' })), Buffer.from([1, 1, 1, 1])));
    const cmd = (await seen) as { id: string; kind: string; sessionId: string };
    expect(cmd.kind).toBe('switchSession');
    expect(cmd.sessionId).toBe('ses_b');
    const ack = JSON.parse(await sock.readText()) as { type: string; id: string; ok: boolean };
    expect(ack).toMatchObject({ type: 'ack', id: 'cmd-s', ok: true });
    sock.end();
  });

  test('publishInventory broadcasts a typed snapshot with the next seq', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    const frame = server.publishInventory([{ sessionId: 'a', state: 'running' }]);
    expect(frame.seq).toBe(1);
    const received = JSON.parse(await sock.readText());
    expect(received).toMatchObject({ type: 'inventory', seq: 1, sessions: [{ sessionId: 'a', state: 'running' }] });
    sock.end();
  });

  test('resume replays the latest inventory snapshot when newer than lastSeq', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    server.broadcast({ type: 'event', eventId: 'e-1', state: 'running' });
    server.publishInventory([{ sessionId: 'a', state: 'running' }]);
    server.publishInventory([
      { sessionId: 'a', state: 'complete' },
      { sessionId: 'b', state: 'idle' },
    ]);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t', ['Last-Seq: 1']));
    await sock.readText(); // hello
    const replayed = JSON.parse(await sock.readText()) as { type: string; sessions: Array<{ sessionId: string }> };
    expect(replayed.type).toBe('inventory');
    expect(replayed.sessions.map((x) => x.sessionId).sort()).toEqual(['a', 'b']);
    sock.end();
  });
  test('onCommand failure surfaces a structured ack (ok:false + detail), socket survives', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    server.onCommand = async (cmd) => (cmd.kind === 'execSessionShell' ? { ok: false, detail: 'no active session' } : { ok: true });
    sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify({ id: 'cmd-e', kind: 'execSessionShell', command: 'ls' })), Buffer.from([2, 2, 2, 2])));
    const ack = JSON.parse(await sock.readText()) as { ok: boolean; detail?: string };
    expect(ack).toMatchObject({ type: 'ack', ok: false, detail: 'no active session' });
    sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify({ id: 'cmd-m', kind: 'mute' })), Buffer.from([3, 3, 3, 3])));
    const okAck = JSON.parse(await sock.readText()) as { ok: boolean };
    expect(okAck.ok).toBe(true);
    sock.end();
  });

  test('onCommand throw is contained as ok:false, never crashes the server', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText();
    server.onCommand = () => {
      throw new Error('boom');
    };
    sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify({ id: 'cmd-t', kind: 'arm' })), Buffer.from([4, 4, 4, 4])));
    const ack = JSON.parse(await sock.readText()) as { ok: boolean; detail?: string };
    expect(ack.ok).toBe(false);
    expect(ack.detail).toBe('boom');
    expect(server.listening).toBe(true);
    sock.end();
  });

  test('close() terminates cleanly: no connections, not listening', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText();
    expect(server.connectionCount).toBe(1);
    sock.end();
    await server.close();
    expect(server.connectionCount).toBe(0);
    expect(server.listening).toBe(false);
  });
});


describe('UiServer binary audio ingest (P4 voice capture)', () => {
  function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (cond()) {
          resolve();
          return;
        }
        if (Date.now() - start > ms) {
          reject(new Error('waitFor timeout'));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  test('binary PCM frame reaches onAudio with exact bytes', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    const received: Buffer[] = [];
    server.onAudio = (pcm) => void received.push(pcm);
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    sock.write(maskFrame(Opcode.Binary, pcm, Buffer.from([9, 9, 9, 9])));
    await waitFor(() => received.length > 0);
    expect(received[0]).toEqual(pcm);
    sock.end();
  });

  test('oversized binary frame gets an error frame, no onAudio, socket survives', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    let called = 0;
    server.onAudio = () => {
      called += 1;
    };
    const big = Buffer.alloc(65 * 1024, 7);
    sock.write(maskFrame(Opcode.Binary, big, Buffer.from([1, 2, 3, 4])));
    const err = JSON.parse(await sock.readText()) as { type: string };
    expect(err.type).toBe('error');
    expect(called).toBe(0);
    expect(server.listening).toBe(true);
    sock.end();
  });
});

describe('UiServer audio broadcast (P4b downlink)', () => {
  test('broadcastAudio fans sequenced binary chunks to every shell', async () => {
    const { decodeFrames: decode, Opcode: Op } = await import('./protocol.js');
    const { decodeAudioChunk } = await import('./audio.js');
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const mp3 = Buffer.alloc(70 * 1024, 0xab);
    const received: Array<{ seq: number; bytes: number }> = [];
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(handshake('t'));
      });
      let acc = Buffer.alloc(0);
      let helloSeen = false;
      let broadcast = false;
      const timer = setTimeout(() => reject(new Error('audio broadcast timeout')), 5000);
      sock.on('data', (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);
        if (!helloSeen) {
          const idx = acc.indexOf('\r\n\r\n');
          if (idx === -1) return;
          acc = acc.subarray(idx + 4);
          helloSeen = true;
        }
        const { frames, remaining } = decode(acc);
        acc = Buffer.from(remaining);
        for (const f of frames) {
          if (f.opcode === Op.Text && !broadcast) {
            broadcast = true;
            server.broadcastAudio(mp3);
          } else if (f.opcode === Op.Binary) {
            const decoded = decodeAudioChunk(new Uint8Array(f.payload));
            if (decoded !== null) received.push({ seq: decoded.seq, bytes: decoded.audio.byteLength });
            if (received.length === 3) {
              clearTimeout(timer);
              sock.end();
              resolve();
            }
          }
        }
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    // 70 KiB over 32 KiB chunks → 3 chunks, ascending seq, lossless bytes.
    expect(received).toHaveLength(3);
    expect(received.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(received.reduce((a, r) => a + r.bytes, 0)).toBe(mp3.byteLength);
  });
});

describe('UiServer connection cap (L15)', () => {
  // The connection set was previously unbounded. WS-4097 is loopback-only and
  // single-user, so a client that opened sockets without limit made every
  // broadcast fan out to an ever-growing set. The cap evicts the OLDEST, which
  // is the least likely to be the live shell.

  test('accepts up to the cap without evicting anyone', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const live: Array<Awaited<ReturnType<typeof rawSocket>>> = [];
    for (let i = 0; i < MAX_CONNECTIONS; i += 1) {
      const sock = await rawSocket(port);
      sock.write(handshake('t'));
      await sock.readText();
      live.push(sock);
    }
    expect(server.connectionCount).toBe(MAX_CONNECTIONS);
  });

  test('one over the cap evicts the OLDEST and keeps the newest', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);

    const open = async (): Promise<Awaited<ReturnType<typeof rawSocket>>> => {
      const sock = await rawSocket(port);
      sock.write(handshake('t'));
      await sock.readText(); // hello
      return sock;
    };
    // Does this socket still receive broadcasts? Proves liveness behaviourally
    // rather than by watching a close event, which is timing-sensitive.
    const alive = async (sock: Awaited<ReturnType<typeof rawSocket>>): Promise<boolean> =>
      Promise.race([
        sock.readText().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), 250)),
      ]);

    const first = await open();
    for (let i = 1; i < MAX_CONNECTIONS; i += 1) await open();
    expect(server.connectionCount).toBe(MAX_CONNECTIONS);

    const extra = await open();
    await new Promise((r) => setTimeout(r, 200));
    expect(server.connectionCount).toBe(MAX_CONNECTIONS);

    // Broadcast once: whoever is still in the connection set receives it.
    server.broadcast({ type: 'event', eventId: 'cap-probe', state: 'complete' });
    expect(await alive(extra)).toBe(true);
    // The OLDEST was shed, not the newcomer. Evicting the newest instead would
    // break the real user, who is the one that just (re)connected.
    expect(await alive(first)).toBe(false);
  });

  test('the cap is a hard bound however many clients connect', async () => {
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    for (let i = 0; i < MAX_CONNECTIONS * 3; i += 1) {
      const sock = await rawSocket(port);
      sock.write(handshake('t'));
      await sock.readText();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(server.connectionCount).toBeLessThanOrEqual(MAX_CONNECTIONS);
  });
});
