import { createConnection } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { decodeFrames, maskFrame, MAX_CONNECTIONS, Opcode } from './protocol.js';
import { RESUME_BUFFER_MAX_BYTES, UiServer } from './ui-server.js';

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

    const detail = 'تعذّر تحويل الكلام إلى نص: 401 from https://api.groq.com with sk-or-v1-' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    server.notice('stt-failed', detail, 'error');
    const frame = JSON.parse(await sock.readText()) as { type: string; detail: string };

    expect(frame.type).toBe('notice');
    expect(frame.detail).not.toContain('sk-or-v1-' + 'AAAAAAAA');
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

  test('B.5: an ack.detail carrying a provider error is redacted at the sink', async () => {
    // `dispatchCommand`'s catch forwards `err.message` verbatim, so one throwing
    // `onCommand` reaches the HUD unredacted. That is the entire class: the
    // property is "no provider text escapes a frame", not "today's router
    // returns literals". BOTH asserts matter — the second is what proves the
    // value was scrubbed rather than dropped or never set. Synthetic material.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText();
    server.onCommand = () => {
      throw new Error('401 from https://api.groq.com with sk-or-v1-' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    };
    sock.write(maskFrame(Opcode.Text, Buffer.from(JSON.stringify({ id: 'cmd-b5', kind: 'arm' })), Buffer.from([4, 5, 6, 7])));
    const ack = JSON.parse(await sock.readText()) as { ok: boolean; detail?: string };
    expect(ack.ok).toBe(false);
    expect(ack.detail).not.toContain('sk-or-v1-' + 'AAAAAAAA');
    expect(ack.detail).toContain('[REDACTED]');
    sock.end();
  });

  test('B.5: a voice transcript carrying a provider error is redacted at the sink', async () => {
    // Intended behaviour change, stated rather than discovered: a user who
    // SPEAKS a key into the mic sees it masked on their own HUD. That is the
    // fail-closed direction — the frame reaches a client-side log/bug-report
    // path, and failing open here would be the one branch worth being wrong
    // about. Ordinary transcript text is untouched.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t'));
    await sock.readText(); // hello
    server.voice('speaking', 'المفتاح sk-or-v1-' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA انتهى');
    const frame = JSON.parse(await sock.readText()) as { type: string; phase: string; transcript?: string };
    expect(frame.type).toBe('voice');
    expect(frame.phase).toBe('speaking');
    expect(frame.transcript).not.toContain('sk-or-v1-' + 'AAAAAAAA');
    expect(frame.transcript).toContain('[REDACTED]');
    expect(frame.transcript).toContain('انتهى');
    sock.end();
  });

  test('B.3: flow() emits a seq-bearing frame and hello states the pause to a NEW shell', async () => {
    // The two halves the ingest tests cannot reach, because they live on the
    // transport. Peer review: `flow()` writes to live sockets only and is NOT
    // retained for resume, so a resume raised while a shell was away never
    // arrives as a frame — the shell keeps its latch, drops its uplink, and the
    // accumulator at zero bytes never crosses PAUSE_BYTES to send the release.
    // Permanent silence behind a green pill. `hello` is the resync, on the same
    // reasoning as `persona`.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);

    // (a) the frame itself: correct shape, and it consumes the shared seq space
    // so a reconnecting cursor counts it.
    const live = await rawSocket(port);
    live.write(handshake('t'));
    const hello = JSON.parse(await live.readText()) as Record<string, unknown>;
    expect(hello['uplinkPaused'], 'nothing is paused yet').toBe(false);
    const before = Number(hello['seq']);
    server.flow('pause');
    const frame = JSON.parse(await live.readText()) as Record<string, unknown>;
    expect(frame['type']).toBe('flow');
    expect(frame['state']).toBe('pause');
    expect(Number(frame['seq']), 'the shared counter moved').toBeGreaterThan(before);

    // (b) the resync: a shell connecting AFTER the pause, with no frame to be
    // told by, is told anyway.
    const late = await rawSocket(port);
    late.write(handshake('t'));
    const lateHello = JSON.parse(await late.readText()) as Record<string, unknown>;
    expect(lateHello['uplinkPaused'], 'a late shell must adopt the pause, not default to live').toBe(true);

    // (c) and the release reaches the next connect too — the half that strands
    // the shell if hello only ever says "paused".
    server.flow('resume');
    const later = await rawSocket(port);
    later.write(handshake('t'));
    const laterHello = JSON.parse(await later.readText()) as Record<string, unknown>;
    expect(laterHello['uplinkPaused'], 'and the release is equally authoritative').toBe(false);

    live.end();
    late.end();
    later.end();
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


describe('M3 B.2 — bounded resume window (byte budget) + resume-gap', () => {
  interface RetainedEvent {
    seq: number;
    eventId: string;
  }
  /**
   * `resume` is private, so this reads it through the type the server actually
   * keeps. The byte total is recomputed HERE from the retained frames rather
   * than read off a counter the server maintains, so the assertion measures the
   * buffer's real contents instead of agreeing with the implementation.
   */
  function retained(server: UiServer): RetainedEvent[] {
    return (server as unknown as { resume: RetainedEvent[] }).resume;
  }
  /**
   * The private byte counter, read the same way `resume` is. Peer review: the
   * budget test recomputed bytes FROM the array, so it measured the array and
   * not the accounting the cap exists to protect — a missing `-=` (silent
   * under-eviction, i.e. the budget violated) or a doubled one (over-eviction,
   * i.e. data loss) both left the suite green, because over-eviction still
   * drops the oldest and keeps the newest. Asserting the counter against a
   * fresh recomputation pins BOTH directions at once.
   */
  function resumeBytesCounter(server: UiServer): number {
    return (server as unknown as { resumeBytes: number }).resumeBytes;
  }
  function retainedBytes(frames: ReadonlyArray<RetainedEvent>): number {
    return frames.reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f), 'utf8'), 0);
  }
  function gapNotices(frames: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
    return frames.filter((f) => f['type'] === 'notice' && f['code'] === 'resume-gap');
  }
  /**
   * `readText` with a deadline. A frame the server never sends must fail an
   * ASSERTION, not hang the test until the runner's timeout — a hang is a weak
   * red: it cannot be told apart from a broken harness.
   */
  function readWithin(sock: { readText: () => Promise<string> }, ms: number): Promise<Record<string, unknown> | null> {
    return Promise.race([
      sock.readText().then((t) => JSON.parse(t) as Record<string, unknown>),
      new Promise<null>((res) => { setTimeout(() => res(null), ms); }),
    ]);
  }

  test('B.2b: frames are retained under a 64 KiB byte budget, oldest evicted first', () => {
    // RESUME_BUFFER_CAP=256 already bounds the COUNT, so 40 frames of ~4 KiB
    // clear the count cap untouched and sit at 166 KiB with no byte bound at
    // all. This asserts the second bound exists AND that it evicts OLDEST: the
    // newest frame must survive, which a `slice(-n)` or a full clear would not.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    const big = 'x'.repeat(4096);
    for (let i = 0; i < 40; i += 1) {
      server.broadcast({ type: 'event', eventId: `e-${i}-${big}`, state: 'running' });
    }
    const kept = retained(server);
    expect(RESUME_BUFFER_MAX_BYTES).toBe(64 * 1024);
    // > 2, not > 0: a degenerate `slice(-1)` (keep only the newest) also drops
    // the oldest and stays under budget, so both-ends alone would not catch it.
    expect(kept.length).toBeGreaterThan(2);
    expect(retainedBytes(kept)).toBeLessThanOrEqual(RESUME_BUFFER_MAX_BYTES);
    // The counter, not just the array — see `resumeBytesCounter`.
    expect(resumeBytesCounter(server)).toBe(retainedBytes(kept));
    // Oldest evicted, newest kept — both ends asserted, so dropping from the
    // wrong end, or clearing the buffer, fails here rather than passing on the
    // byte total alone.
    expect(kept.some((f) => f.eventId.startsWith('e-0-'))).toBe(false);
    expect(kept[kept.length - 1]!.eventId.startsWith('e-39-')).toBe(true);
  });

  test('B.2c: a client whose lastSeq predates retention gets ONE resume-gap warn naming the range', async () => {
    // Retention holds the LAST 256 frames, so a client resuming from seq 1 has
    // missed events 2..(oldest retained - 1) and cannot tell that from
    // "nothing happened". Exactly one notice, naming the real range.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    for (let i = 1; i <= 300; i += 1) {
      server.broadcast({ type: 'event', eventId: `e-${i}`, state: 'running' });
    }
    const keptOnServer = retained(server);
    const oldest = keptOnServer[0]!.seq;
    const newest = keptOnServer[keptOnServer.length - 1]!.seq;
    expect(oldest).toBeGreaterThan(1);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t', ['Last-Seq: 1']));
    await sock.readText(); // hello
    // Replay drains first; the notice is written after it, so read in order.
    // The loop does NOT stop at the first gap frame: "ONE" is a requirement,
    // and breaking early would make a duplicate-emitting regression pass a
    // test named for exactly the property it stopped checking.
    const seen: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 400; i += 1) {
      const frame = await readWithin(sock, 300);
      if (frame === null) break;
      seen.push(frame);
    }
    const gaps = gapNotices(seen);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!['level']).toBe('warn');
    // The detail must NAME the real range (both ends), not a hardcoded string:
    // change the retention depth and this has to follow.
    const detail = String(gaps[0]!['detail']);
    expect(detail).toContain(String(oldest));
    expect(detail).toContain(String(newest));
    expect(detail).toContain('1');
    sock.end();
  });

  test('B.2c: a client whose lastSeq is INSIDE the retained range gets NO resume-gap', async () => {
    // The negative case. Without it, "always warn on any resume" passes test 3
    // and is wrong for every healthy reconnect — a gap warning the user cannot
    // act on trains them to ignore the frame that matters.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    for (let i = 1; i <= 300; i += 1) {
      server.broadcast({ type: 'event', eventId: `e-${i}`, state: 'running' });
    }
    const kept = retained(server);
    const lastSeq = kept[kept.length - 2]!.seq; // inside retention, older than newest
    expect(kept[0]!.seq).toBeLessThanOrEqual(lastSeq);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t', [`Last-Seq: ${lastSeq}`]));
    await sock.readText(); // hello
    const seen: Array<Record<string, unknown>> = [];
    // Read until the socket goes quiet; a gap notice would arrive here.
    for (let i = 0; i < 200; i += 1) {
      const frame = await readWithin(sock, 250);
      if (frame === null) break;
      seen.push(frame);
      if (gapNotices(seen).length > 0) break;
    }
    expect(gapNotices(seen)).toEqual([]);
    // Sanity: the replay still happened, so this is a real negative and not a
    // client that was refused and never sent anything.
    expect(seen.some((f) => f['seq'] === kept[kept.length - 1]!.seq)).toBe(true);
  });

  test('B.2c-d: a cold launch gets NO resume-gap — nothing was ever droppable', async () => {
    // THE FALSE-POSITIVE GUARD, and the one the other three tests cannot see.
    //
    // Measured against `dist/` before this test existed: a server that published
    // only `publishInventory` + `publishAgents` — the entire production shape,
    // since `broadcast()` has zero non-test callers — fired `resume-gap` on a
    // first connection carrying `lastSeq=0`, saying the shell had missed every
    // event. It had missed none: no event was ever produced, `resume` is empty
    // because there was nothing to retain, and the level-triggered inventory
    // and agent snapshots that DID advance `seq` are replayed in full above.
    //
    // So `seq > 0` is not a gap. A gap requires frames that were retained and
    // then dropped. A warn the user cannot act with, shown on every cold
    // launch, is the exact defect class this file exists to catch.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    server.publishInventory([{ sessionId: 'ses_a', state: 'idle' }]);
    server.publishAgents([{ id: 'build', name: 'build' }]);
    expect(retained(server)).toHaveLength(0);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t', ['Last-Seq: 0']));
    await sock.readText(); // hello
    const seen: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i += 1) {
      const frame = await readWithin(sock, 250);
      if (frame === null) break;
      seen.push(frame);
      if (gapNotices(seen).length > 0) break;
    }
    expect(gapNotices(seen)).toEqual([]);
    // Not a vacuous negative: the snapshots really did replay, so seq moved and
    // the client really was behind. Only the notice is wrong.
    expect(seen.some((f) => f['type'] === 'inventory')).toBe(true);
    expect(seen.some((f) => f['type'] === 'agents')).toBe(true);
    sock.end();
  });

  test('B.2c-e: a frame that exceeds the whole byte budget IS a gap — eviction emptied the buffer', async () => {
    // Pins the `resumeEvicted` counter itself. B.2c-d proves the notice is
    // suppressed when nothing was ever dropped; this proves the OTHER half —
    // an empty buffer is a gap when a drop is what emptied it. Delete the
    // `resumeEvicted += 1` and every other test in this file still passes,
    // because the one frame here is dropped on arrival and leaves `resume`
    // empty, which looks identical to a cold launch from the buffer alone.
    const server = new UiServer({ token: 't', contractVersion: '3.1.0' });
    server.broadcast({ type: 'event', eventId: 'e-1', state: 'x'.repeat(RESUME_BUFFER_MAX_BYTES) });
    expect(retained(server), 'the single frame outgrew the budget and was dropped').toHaveLength(0);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('t', ['Last-Seq: 0']));
    await sock.readText(); // hello
    const seen: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i += 1) {
      const frame = await readWithin(sock, 250);
      if (frame === null) break;
      seen.push(frame);
      if (gapNotices(seen).length > 0) break;
    }
    expect(gapNotices(seen)).toHaveLength(1);
    sock.end();
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
