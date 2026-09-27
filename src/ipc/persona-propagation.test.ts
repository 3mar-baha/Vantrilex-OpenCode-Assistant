import { createConnection } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { decodeFrames, Opcode } from './protocol.js';
import { UiServer } from './ui-server.js';

// L22: the HUD (App.tsx) and the settings window (SettingsView.tsx) each held
// their own `persona` state. Changing it in one left the other showing — and
// speaking — the previous persona, because neither told the other and neither
// read the daemon. The daemon set `activePersona` and told nobody.
//
// Two properties, tested separately:
//
//   1. a change propagates — the notice is emitted, and `hello` carries the
//      current value so a late or reconnecting shell is not left stale;
//   2. an UNCHANGED persona emits nothing — the echo-loop guard. Without it the
//      two surfaces trade setPersona commands forever, and the symptom (a stuck
//      HUD that looks busy) resembles nothing about its cause.
//
// Real loopback sockets, same as ui-server.test.ts: the point is what a shell
// actually receives, and a mock would happily pass a frame the server never
// sends.

const servers: UiServer[] = [];
const ends: (() => void)[] = [];
afterEach(async () => {
  while (ends.length > 0) ends.pop()!();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

function handshake(token: string): Buffer {
  return Buffer.from(
    [
      'GET /v1/ui HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${WS_KEY}`,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: voice-ui.v1',
      `Authorization: Bearer ${token}`,
      '',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

interface Client {
  hello: Record<string, unknown>;
  /** Every text frame received, in order. */
  frames: Record<string, unknown>[];
  /** Settles once `count` further frames have arrived. */
  take: (count: number) => Promise<void>;
  close: () => void;
}

function connect(port: number, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      let upgraded = false;
      let head = Buffer.alloc(0);
      let acc = Buffer.alloc(0);
      const frames: Record<string, unknown>[] = [];
      const waiters: Array<() => void> = [];

      const feed = (chunk: Buffer): void => {
        acc = Buffer.concat([acc, chunk]);
        const { frames: decoded, remaining } = decodeFrames(acc);
        acc = Buffer.from(remaining);
        for (const f of decoded) {
          if (f.opcode !== Opcode.Text) continue;
          frames.push(JSON.parse(Buffer.from(f.payload).toString('utf8')) as Record<string, unknown>);
          const w = waiters.shift();
          if (w !== undefined) w();
        }
      };

      sock.on('data', (chunk: Buffer) => {
        if (!upgraded) {
          head = Buffer.concat([head, chunk]);
          const idx = head.indexOf('\r\n\r\n');
          if (idx === -1) return;
          upgraded = true;
          const rest = head.subarray(idx + 4);
          head = Buffer.alloc(0);
          if (rest.byteLength > 0) feed(rest);
          return;
        }
        feed(chunk);
      });

      sock.write(handshake(token));

      const client: Client = {
        hello: {},
        frames,
        take: (count) =>
          new Promise<void>((res) => {
            const want = frames.length + count;
            const poll = (): void => {
              if (frames.length >= want) res();
              else waiters.push(poll);
            };
            poll();
          }),
        close: () => void sock.end(),
      };
      ends.push(client.close);

      // The hello frame is the first thing a server sends.
      void client.take(1).then(() => {
        client.hello = frames[0] ?? {};
        resolve(client);
      });
    });
    sock.on('error', reject);
  });
}

interface Harness {
  port: number;
  client: Client;
  /** The daemon's setPersona callback, with the echo guard. */
  apply: (p: 'kareem' | 'nour') => void;
}

async function harness(initial?: 'kareem' | 'nour'): Promise<Harness> {
  const ui = new UiServer({
    token: 'tok',
    contractVersion: '3.1.0',
    ...(initial !== undefined ? { persona: initial } : {}),
  });
  const port = await ui.start(0);
  servers.push(ui);

  let active: 'kareem' | 'nour' = initial ?? 'kareem';
  const apply = (p: 'kareem' | 'nour'): void => {
    // The echo-loop guard, verbatim from daemon.ts.
    if (active === p) return;
    active = p;
    ui.setPersona(p);
    ui.notice('persona-changed', p, 'info');
  };

  const client = await connect(port, 'tok');
  return { port, client, apply };
}

const changed = (c: Client): { code: string; detail: string }[] =>
  c.frames
    .filter((f) => f['type'] === 'notice' && f['code'] === 'persona-changed')
    .map((f) => ({ code: String(f['code']), detail: String(f['detail']) }));

describe('a persona change reaches every surface (L22)', () => {
  test('the notice carries the new persona', async () => {
    const h = await harness('kareem');
    await h.client.take(0);
    h.apply('nour');
    await h.client.take(1);
    expect(changed(h.client)).toEqual([{ code: 'persona-changed', detail: 'nour' }]);
  });

  test('hello carries the persona, so a late shell is not on the default', async () => {
    const h = await harness('nour');
    expect(h.client.hello['persona']).toBe('nour');
  });

  test('hello reflects a change made before this shell connected', async () => {
    // The reconnect case: the HUD was closed, the settings window changed the
    // persona, the HUD came back. It must not show the default.
    const ui = new UiServer({ token: 'tok', contractVersion: '3.1.0', persona: 'kareem' });
    const port = await ui.start(0);
    servers.push(ui);
    ui.setPersona('nour');
    const client = await connect(port, 'tok');
    expect(client.hello['persona']).toBe('nour');
  });

  test('hello omits persona when the daemon has none, rather than guessing', async () => {
    const h = await harness();
    // Additive and optional: an older daemon omits it and the shell keeps what
    // it had. Inventing a default here would silently override a real choice.
    expect(h.client.hello['persona']).toBeUndefined();
  });

  test('a persona notice reaches a second, independently connected shell', async () => {
    // The real scenario: the HUD and the settings window hold separate sockets.
    // A notice is a broadcast, so both see it without either having asked.
    const h = await harness('kareem');
    await h.client.take(0);
    const second = await connect(h.port, 'tok');
    expect(second.hello['persona']).toBe('kareem');
    h.apply('nour');
    await second.take(1);
    expect(changed(second).map((n) => n.detail)).toEqual(['nour']);
  });
});

describe('the echo loop is unrepresentable (L22)', () => {
  test('re-selecting the current persona emits nothing', async () => {
    const h = await harness('kareem');
    await h.client.take(0);
    h.apply('kareem');
    // Nothing should arrive. A short bounded wait rather than a long sleep.
    await new Promise((r) => setTimeout(r, 200));
    expect(changed(h.client)).toHaveLength(0);
  });

  test('a toggle back to the original emits exactly two notices, not four', async () => {
    const h = await harness('kareem');
    await h.client.take(0);
    h.apply('nour');
    h.apply('nour'); // no-op
    h.apply('kareem');
    h.apply('kareem'); // no-op
    await h.client.take(2);
    await new Promise((r) => setTimeout(r, 200));
    expect(changed(h.client).map((n) => n.detail)).toEqual(['nour', 'kareem']);
  });

  test('ten identical commands produce one notice', async () => {
    const h = await harness('kareem');
    await h.client.take(0);
    for (let i = 0; i < 10; i += 1) h.apply('nour');
    await h.client.take(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(changed(h.client)).toHaveLength(1);
  });
});
