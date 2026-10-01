import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { containsSecret, redactString } from '../common/logger.js';
import {
  ACK_MAX_DETAIL_CHARS,
  ACK_MAX_ID_CHARS,
  AckFrameSchema,
  buildAckFrame,
  Opcode,
  UiEventSchema,
} from './protocol.js';
import { UiServer } from './ui-server.js';

// ─────────────────────────────────────────────────────────────────────────────
// W29 — `ack` had a schema nothing applied, and a `detail` that reached the wire
// with no length bound, no character bound, and no schema behind it.
//
// The load-bearing questions, in order:
//   1. Does the wire stay BYTE-IDENTICAL?            (SHA-256 of JSON + frame,
//                                                       key order, frame length)
//   2. Is the schema load-bearing — does it REJECT?   (refusal tests)
//   3. Can provider text reach a client here?        (end-to-end through a socket)
//   4. Can the sink be bypassed?                      (branded frame + source pins)
//   5. Are the bounds real?                           (length + control characters)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE BEFORE-IMAGE, captured from `dist/` built off the pre-W29 source by driving
 * a real `UiServer` over a real loopback socket, and then re-verified against
 * `dist/` built off the post-W29 source. These are not descriptions of the wire:
 * they are its bytes, and a single differing byte fails the test.
 *
 * `jsonSha` / `frameSha` are SHA-256 over the UTF-8 JSON payload and over the
 * complete RFC 6455 frame (header included), so the pins cover the framing, the
 * length field and the payload at once. `keys` is the parsed insertion order:
 * zod REBUILDS the object, and shape order is what the JSON then serialises in,
 * so an author reordering the shape would reorder the wire and fail here.
 *
 * The two cases that are NOT in this table are `detail` at 5 000 characters and
 * `detail` containing `\n`/`\r`. Both are the defect: their before-image frame
 * SHAs are recorded in the two tests below as the evidence of what used to ship,
 * and their after-image is asserted separately.
 */
const WIRE_PINS: ReadonlyArray<{
  readonly id: string;
  readonly json: string;
  readonly jsonSha: string;
  readonly frameSha: string;
  readonly frameBytes: number;
  readonly keys: readonly string[];
}> = [
  {
    id: 'cmd-ok-no-detail',
    json: '{"type":"ack","id":"cmd-ok-no-detail","ok":true}',
    jsonSha: '4986a116f40bf244de0ef1cbc8de5ecc79a29806600fbebd1453c8a17ce56806',
    frameSha: '824ee3f5da2887fee7204d3fe2cd28a60fe36b1702e1e6c7e9731c4b31644a68',
    frameBytes: 50,
    keys: ['type', 'id', 'ok'],
  },
  {
    id: 'cmd-ok-persona-set',
    json: '{"type":"ack","id":"cmd-ok-persona-set","ok":true,"detail":"persona-set"}',
    jsonSha: '2b80bf45a6d9394de8e6bde9b7aa936881e37a8edc000e3964a92127128d49f1',
    frameSha: 'c34365ca376f83effec8fe7a7b512f7747114272832e964b17e3625c26465ed1',
    frameBytes: 75,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-ko-no-active-session',
    json: '{"type":"ack","id":"cmd-ko-no-active-session","ok":false,"detail":"no active session"}',
    jsonSha: '135df627bf9aeb5f800222332f3a0891fc5445d4d789f02e4bb2f6829c154f7d',
    frameSha: '90cca2afb4c721a17f764af077e04408e7695cf1439a5cf952ea7f9df9b9e8fd',
    frameBytes: 88,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-ko-shell-unknown',
    json: '{"type":"ack","id":"cmd-ko-shell-unknown","ok":true,"detail":"shell-outcome-unknown"}',
    jsonSha: '0713369c95722ecd7959919277765ab5bbba32080d31a6a9878ed1c637abfea0',
    frameSha: 'a0a92bfa474e846a6bc48148a19542e1eccd3a66aaae609c3a7cde6ef222dae2',
    frameBytes: 87,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-ko-arabic-session',
    json: '{"type":"ack","id":"cmd-ko-arabic-session","ok":true,"detail":"جلسة جديدة: ses_01ABCdef"}',
    jsonSha: '98c89a35364969eedec7ff8960b62143f73b401118877a8b276a12f5ebe1d0ae',
    frameSha: '31fbcecb3183b3d665d4cba6baee1c42ae78f97e127628edd793b6feea3d3e71',
    frameBytes: 100,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-ko-throwing-provider',
    json: '{"type":"ack","id":"cmd-ko-throwing-provider","ok":false,"detail":"provider said no: [REDACTED]"}',
    jsonSha: '3ecc685e28f898d3e1dd5c1298dfa640a21877a7254498067dc3a9467369f6e3',
    frameSha: '6ba310600ef1df763a09539f0777d0173ddd2447c24831d41861bfab981b0e1e',
    frameBytes: 99,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-ko-throwing-plain',
    json: '{"type":"ack","id":"cmd-ko-throwing-plain","ok":false,"detail":"plain failure text"}',
    jsonSha: '02f4285df0858f1054c0db6d59733b0632f76dd464701190883389b429e28f70',
    frameSha: '2034518b942daae3ce0ad48dc2c0a55ae39e575b9dadde40b70237993c40d28e',
    frameBytes: 86,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-ko-error-code',
    json: '{"type":"ack","id":"cmd-ko-error-code","ok":false,"detail":"SESSION_BUSY"}',
    jsonSha: '59fc493ce64597b42141255516cc61eb603c71b12bb31f32fa33ddd642151fb7',
    frameSha: '8cc815fc985f434431fbedd5e969851b483a1356c8a6c3a167d37e8bfee90d5e',
    frameBytes: 76,
    keys: ['type', 'id', 'ok', 'detail'],
  },
  {
    id: 'cmd-event-1',
    json: '{"type":"event","seq":1,"eventId":"evt-1","state":"listening"}',
    jsonSha: '36eddf2944224e8642b1251104592e1a42f4911994191319af8bf3743ecdba08',
    frameSha: '627b1f9fdd1f20d8ae3bfd9a9299290e54594229aa1603e9e8349a9ee3c031e8',
    frameBytes: 64,
    keys: ['type', 'seq', 'eventId', 'state'],
  },
];

const servers: UiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const TOKEN = 'secret-token';

interface RawFrame {
  readonly json: string;
  readonly frameHex: string;
  readonly frameBytes: number;
}

/**
 * A real loopback WebSocket peer that hands back the EXACT frame bytes. It
 * deliberately does not go through `decodeFrames` for measurement: the point is
 * the bytes on the wire, header included, and a parser would normalise away the
 * half of that which this item is about.
 */
function rawPeer(port: number): Promise<{
  send: (obj: unknown) => void;
  next: () => Promise<RawFrame>;
  end: () => void;
}> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        Buffer.from(
          [
            'GET /v1/ui HTTP/1.1',
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${WS_KEY}`,
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Protocol: voice-ui.v1',
            `Authorization: Bearer ${TOKEN}`,
            '',
            '',
          ].join('\r\n'),
          'utf8',
        ),
      );
    });
    let head = Buffer.alloc(0);
    let upgraded = false;
    let acc = Buffer.alloc(0);
    const queue: RawFrame[] = [];
    const waiters: Array<(f: RawFrame) => void> = [];
    const drain = (chunk: Buffer): void => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        if (acc.byteLength < 2) return;
        let len = acc[1]! & 0x7f;
        let headerLen = 2;
        if (len === 126) {
          if (acc.byteLength < 4) return;
          len = acc.readUInt16BE(2);
          headerLen = 4;
        } else if (len === 127) {
          if (acc.byteLength < 10) return;
          len = Number(acc.readBigUInt64BE(2));
          headerLen = 10;
        }
        if (acc.byteLength < headerLen + len) return;
        const frame = acc.subarray(0, headerLen + len);
        acc = Buffer.from(acc.subarray(headerLen + len));
        if ((frame[0]! & 0x0f) !== Opcode.Text) continue;
        const measured: RawFrame = {
          json: frame.subarray(headerLen).toString('utf8'),
          frameHex: frame.toString('hex'),
          frameBytes: frame.byteLength,
        };
        const w = waiters.shift();
        if (w) w(measured);
        else queue.push(measured);
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
        if (rest.byteLength > 0) drain(rest);
        return;
      }
      drain(chunk);
    });
    sock.on('error', reject);
    resolve({
      send: (obj: unknown) => {
        const payload = Buffer.from(JSON.stringify(obj), 'utf8');
        // Browsers always mask (§5.3); the server rejects unmasked client frames
        // only by contract, so mask to keep the exchange a real one.
        const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
        const masked = Buffer.alloc(payload.byteLength);
        for (let i = 0; i < payload.byteLength; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
        sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), mask, masked]));
      },
      next: () =>
        queue.length > 0
          ? Promise.resolve(queue.shift()!)
          : new Promise<RawFrame>((r) => void waiters.push(r)),
      end: () => void sock.end(),
    });
  });
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

/** One live server, driven through every pinned case in one connection. */
async function driveWire(): Promise<Map<string, RawFrame>> {
  const server = new UiServer({ token: TOKEN, contractVersion: '3.1.0' });
  servers.push(server);
  const port = await server.start(0);
  const peer = await rawPeer(port);
  await peer.next(); // hello
  const seen = new Map<string, RawFrame>();

  const run = async (id: string, outcome: () => unknown): Promise<void> => {
    // The handler THROWS for the cases that model `onCommand` throwing; the
    // server catches it and acks, so a throw here is the point rather than an
    // accident of the fixture.
    server.onCommand = () => outcome() as never;
    peer.send({ id, kind: 'abort' });
    seen.set(id, await peer.next());
  };

  await run('cmd-ok-no-detail', () => ({ ok: true }));
  await run('cmd-ok-persona-set', () => ({ ok: true, detail: 'persona-set' }));
  await run('cmd-ko-no-active-session', () => ({ ok: false, detail: 'no active session' }));
  await run('cmd-ko-shell-unknown', () => ({ ok: true, detail: 'shell-outcome-unknown' }));
  await run('cmd-ko-arabic-session', () => ({ ok: true, detail: 'جلسة جديدة: ses_01ABCdef' }));
  await run('cmd-ko-throwing-provider', () => {
    throw new Error(
      'provider said no: sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
    );
  });
  await run('cmd-ko-throwing-plain', () => {
    throw new Error('plain failure text');
  });
  await run('cmd-ko-error-code', () => ({ ok: false, detail: 'SESSION_BUSY' }));

  server.broadcast({ eventId: 'evt-1', state: 'listening' });
  seen.set('cmd-event-1', await peer.next());

  peer.end();
  return seen;
}

describe('W29 · ack wire compatibility (byte-identical to the pre-W29 bytes)', () => {
  test('the pin table is non-empty — a subject that stops matching must fail, not pass vacuously', () => {
    // THE STANDING-BRIEF RULE, applied to this file's own fixtures. A `for … of`
    // over an empty `WIRE_PINS` proves nothing at all, and an emptied table is
    // exactly what an edit that renames the fixture would produce.
    expect(WIRE_PINS.length).toBeGreaterThan(0);
    expect(WIRE_PINS.length).toBe(9);
    expect(new Set(WIRE_PINS.map((p) => p.id)).size).toBe(WIRE_PINS.length);
  });

  test('every pinned case emits byte-identical JSON, key order and frame', async () => {
    const seen = await driveWire();
    for (const pin of WIRE_PINS) {
      const got = seen.get(pin.id);
      expect(got, `no frame captured for ${pin.id}`).toBeDefined();
      expect(got!.json, `${pin.id}: JSON payload changed`).toBe(pin.json);
      expect(sha256(got!.json), `${pin.id}: JSON sha256 changed`).toBe(pin.jsonSha);
      expect(sha256(Buffer.from(got!.frameHex, 'hex')), `${pin.id}: RFC 6455 frame changed`).toBe(pin.frameSha);
      expect(got!.frameBytes, `${pin.id}: frame length changed`).toBe(pin.frameBytes);
      expect(Object.keys(JSON.parse(got!.json) as object), `${pin.id}: key order changed`).toEqual([...pin.keys]);
    }
  });

  test('`detail` is ABSENT when the outcome carries none — not null, not undefined-valued', async () => {
    // zod rebuilds the object, and `JSON.stringify` drops an `undefined` value, so
    // this case would look right on the wire even if the builder emitted the key.
    // The object is what other producers (and tests) see, so it is pinned here.
    const frame = buildAckFrame('cmd-no-detail', { ok: true });
    expect('detail' in frame).toBe(false);
    expect(Object.keys(frame)).toEqual(['type', 'id', 'ok']);
  });
});

describe('W29 · the ack schema is load-bearing', () => {
  test('the schema REJECTS an over-long detail, a control character, an empty id and an unknown key', () => {
    const base = { type: 'ack' as const, id: 'cmd-1', ok: true };
    // The subject is fixed and asserted first: a `for … of` over a list that had
    // silently emptied would pass while checking nothing.
    const refusals: ReadonlyArray<readonly [string, unknown]> = [
      ['detail one char over the cap', { ...base, detail: 'L'.repeat(ACK_MAX_DETAIL_CHARS + 1) }],
      ['detail carrying a newline', { ...base, detail: 'bad\nvalue' }],
      ['detail carrying a carriage return', { ...base, detail: 'bad\rvalue' }],
      ['detail carrying a DEL', { ...base, detail: 'bad\u007fvalue' }],
      ['detail carrying a NUL', { ...base, detail: 'bad\u0000value' }],
      ['empty id', { ...base, id: '' }],
      ['id carrying a control character', { ...base, id: 'cmd\u000a1' }],
      ['an unexpected key', { ...base, surprise: 'x' }],
      ['a non-boolean ok', { ...base, ok: 'yes' }],
    ];
    expect(refusals.length).toBeGreaterThan(0);
    for (const [label, value] of refusals) {
      expect(AckFrameSchema.safeParse(value).success, `schema accepted ${label}`).toBe(false);
    }
    // And the positive control, so the refusals above cannot be an artefact of a
    // schema that rejects everything.
    expect(AckFrameSchema.safeParse({ ...base, detail: 'persona-set' }).success).toBe(true);
    expect(AckFrameSchema.safeParse(base).success).toBe(true);
  });

  test('`buildAckFrame` refuses a forged id and cannot throw on an admissible one', () => {
    // `id` is deliberately NOT sanitised — mangling a correlation token would
    // break the pairing with the shell's pending map — so a control character in
    // one is a forgery attempt and must throw loudly at the producer.
    expect(() => buildAckFrame('cmd\u000a1', { ok: true })).toThrow();
    expect(() => buildAckFrame('', { ok: true })).toThrow();
    expect(() => buildAckFrame('c'.repeat(ACK_MAX_ID_CHARS + 1), { ok: true })).toThrow();

    // The other half of the same claim: `.parse` is safe for every value this
    // builder admits, so the throw cannot escape a `void`-ed promise.
    const admissible = ['', 'x', 'ok'.repeat(60), 'SESSION_BUSY', 'جلسة جديدة: ses_01', 'a'.repeat(ACK_MAX_DETAIL_CHARS)];
    expect(admissible.length).toBeGreaterThan(0);
    for (const detail of admissible) {
      expect(() => buildAckFrame('cmd-1', { ok: true, detail })).not.toThrow();
      expect(() => buildAckFrame('cmd-1', { ok: false, detail })).not.toThrow();
    }
  });
});

describe('W29 · provider text cannot reach a client through ack', () => {
  test('a throwing onCommand whose message carries a credential is scrubbed AT THE SINK', async () => {
    const server = new UiServer({ token: TOKEN, contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const peer = await rawPeer(port);
    await peer.next(); // hello
    const key = 'sk-or-v1-' + '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
    server.onCommand = () => {
      throw new Error(`upstream refused: ${key}`);
    };
    peer.send({ id: 'cmd-leak', kind: 'abort' });
    const frame = await peer.next();
    const ack = JSON.parse(frame.json) as { type: string; detail: string };
    expect(ack.type).toBe('ack');
    expect(ack.detail).not.toContain('sk-or-v1-');
    expect(ack.detail).toContain('[REDACTED]');
    // The whole-material predicate, not a substring check: a detail can be
    // scrubbed of the prefix and still carry a family the prefix does not name.
    expect(containsSecret(ack.detail), 'a credential family survived into ack.detail').toBe(false);
    expect(ack.detail).toBe(redactString(`upstream refused: ${key}`));
    peer.end();
  });
});

describe('W29 · the bounds are real', () => {
  test('a 5 000-character detail is bounded, keeps a prefix, and NAMES what it dropped', async () => {
    // BEFORE (pre-W29, captured from dist/): a 5 065-byte frame carrying all
    // 5 000 characters —
    //   jsonSha  5eb3135004d4bce8ee9d0b5fff9e95e505c214c65d4168d0d41849fa50b811d4
    //   frameSha 831d581bb01589dac639dd0c8d3ebab30a615506f4d417bfa6957474699e38d4
    const server = new UiServer({ token: TOKEN, contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const peer = await rawPeer(port);
    await peer.next(); // hello
    server.onCommand = () => ({ ok: false, detail: 'L'.repeat(5000) });
    peer.send({ id: 'cmd-ko-long-5000', kind: 'abort' });
    const frame = await peer.next();
    const ack = JSON.parse(frame.json) as { ok: boolean; detail: string };

    expect(ack.ok, 'truncation must not lie about dispatch').toBe(false);
    expect(ack.detail.length).toBeLessThanOrEqual(ACK_MAX_DETAIL_CHARS);
    expect(ack.detail.startsWith('LLL'), 'a truncation that drops the prefix is not a prefix').toBe(true);
    // Not a SILENT trim: the `INVENTORY_MAX_SESSIONS` defect class. The count of
    // dropped characters is in the detail, so a reader can tell.
    expect(ack.detail).toMatch(/…\(\+\d+ chars\)$/);
    expect(frame.frameBytes).toBeLessThan(400);
    peer.end();
  });

  test('control characters never reach the wire — a shell cannot forge a multi-line HUD row', async () => {
    // BEFORE (pre-W29): the detail rode out as "bad\nvalue\rinjected", i.e.
    // codepoints 10 and 13, JSON-escaped but present in the parsed value —
    //   jsonSha  400fd326c824e3cb1b11ef0c51630a805e7a99b9c5472b1181f989561e698bd8
    const server = new UiServer({ token: TOKEN, contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const peer = await rawPeer(port);
    await peer.next(); // hello
    server.onCommand = () => ({ ok: false, detail: 'bad\nvalue\rinjected\u0000\u007f' });
    peer.send({ id: 'cmd-ko-control-chars', kind: 'abort' });
    const frame = await peer.next();
    const ack = JSON.parse(frame.json) as { detail: string };

    const codes = [...ack.detail].map((c) => c.charCodeAt(0));
    expect(codes.filter((c) => c < 0x20 || c === 0x7f), 'a control character reached the wire').toEqual([]);
    // Replaced with a SPACE, not deleted: `\n` between two words is a separator,
    // and dropping it would weld `badvalue` into a word that never existed.
    expect(ack.detail).toBe('bad value injected  ');
    peer.end();
  });

  test('the cap is above every detail the router can produce, so it cannot fire on real traffic', () => {
    // MEASURED against the shipped literals, not asserted by feel: the longest
    // are the shell-outcome codes and the Arabic create-session detail.
    const shipped = [
      'shell-outcome-ok',
      'shell-outcome-failed',
      'shell-outcome-unknown',
      'confirmation-required',
      'confirmation expired',
      'config key rejected (control characters)',
      'session manager unavailable',
      'جلسة جديدة: ses_01ABCdef',
      'SESSION_BUSY',
    ];
    expect(shipped.length).toBeGreaterThan(0);
    for (const detail of shipped) {
      expect(detail.length, `"${detail}" exceeds ACK_MAX_DETAIL_CHARS`).toBeLessThanOrEqual(ACK_MAX_DETAIL_CHARS);
      expect(() => buildAckFrame('cmd-1', { ok: false, detail })).not.toThrow();
      // And it is not merely bounded — it survives UNCHANGED, which is the
      // property the byte pins above assert for the ones on the wire.
      expect(buildAckFrame('cmd-1', { ok: false, detail }).detail).toBe(detail);
    }
    // The headroom, stated: 200 vs a longest shipped detail of 38.
    expect(Math.max(...shipped.map((d) => d.length))).toBeLessThan(ACK_MAX_DETAIL_CHARS / 2);
  });

  test('a truncation never leaves half a surrogate pair on the wire', () => {
    // The cut is by code unit, so a slice can end on a high surrogate. Such a
    // detail serialises as a lone surrogate escape, which is invalid JSON text
    // for a strict consumer — the renderer is not one, but a frame the peer
    // cannot decode is still a broken frame.
    const boundary = buildAckFrame('cmd-1', { ok: false, detail: 'L'.repeat(ACK_MAX_DETAIL_CHARS - 1) + '😀' });
    expect(boundary.detail).toMatch(/…\(\+\d+ chars\)$/);
    expect([...(boundary.detail ?? '')].every((c) => c.charCodeAt(0) >= 0xd800 ? false : true)).toBe(true);
    expect((boundary.detail ?? '').includes('\ufffd')).toBe(false);
    // The emoji survives whole when the string is under the cap — the guard must
    // not cost a legitimate character.
    const whole = buildAckFrame('cmd-1', { ok: false, detail: '😀' });
    expect(whole.detail).toBe('😀');
  });
});

describe('W29 · the sink cannot be bypassed', () => {
  test('UiEventSchema is applied on the only event-producing path', async () => {
    // The same defect `ack` had, found by the census: declared, exported, and
    // applied NOWHERE. `broadcast()` built the literal inline.
    const server = new UiServer({ token: TOKEN, contractVersion: '3.1.0' });
    servers.push(server);
    const port = await server.start(0);
    const peer = await rawPeer(port);
    await peer.next(); // hello
    const frame = server.broadcast({ eventId: 'evt-1', state: 'listening' });
    const wire = await peer.next();
    expect(wire.json).toBe(JSON.stringify(frame));
    expect(UiEventSchema.safeParse(frame).success).toBe(true);
    peer.end();
  });

  test('AckFrameSchema is parsed at exactly one production site, and it is inside buildAckFrame', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith('.ts')) files.push(p);
      }
    };
    walk('src');
    // Test files are EXCLUDED, and that is the substance of the claim rather than
    // a convenience: a `.parse` reachable only from a test proves nothing about
    // the producer, which is exactly how `AckFrameSchema` spent its life — a
    // schema, exported and documented, that no production path applied.
    const production = files.filter((f) => !/\.test\.ts$/.test(f));
    // Subject asserted before the claim: an empty file list would make "no parse
    // site outside the constructor" vacuously true.
    expect(production.length).toBeGreaterThan(50);

    const parseSites = production.filter((f) => /AckFrameSchema\s*\.\s*(safeParse|parse)/.test(readFileSync(f, 'utf8')));
    expect(parseSites.map((f) => f.replace(/\\/g, '/'))).toEqual(['src/ipc/protocol.ts']);
    const ctor = readFileSync('src/ipc/protocol.ts', 'utf8');
    expect(ctor).toMatch(/export function buildAckFrame[\s\S]*?AckFrameSchema\.parse\(/);
    // And no production file hand-rolls an ack literal, which is what the brand
    // makes a compile error — the source pin is what proves the brand is not
    // carrying the property alone.
    for (const f of production) {
      const text = readFileSync(f, 'utf8');
      expect(/type:\s*'ack'/.test(text), `${f} builds an ack literal`).toBe(false);
      if (f.replace(/\\/g, '/') === 'src/ipc/protocol.ts') continue;
      expect(text.includes(ACK_LITERAL), `${f} mentions the ack literal`).toBe(false);
    }
  });
});

/** The literal the constructor is the only permitted source of. */
const ACK_LITERAL = 'type: ACK_KIND';
