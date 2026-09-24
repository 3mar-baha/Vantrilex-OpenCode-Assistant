import { createConnection } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { decodeFrames, maskFrame, Opcode } from './protocol.js';
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
