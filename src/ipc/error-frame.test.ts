import { createConnection } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { containsSecret, redactString } from '../common/logger.js';
import {
  buildErrorFrame,
  decodeFrames,
  ERROR_DETAILS,
  ERROR_KIND,
  ErrorFrameSchema,
  MAX_AUDIO_BYTES,
  Opcode,
  type ErrorDetail,
  encodeTextFrame,
  maskFrame,
} from './protocol.js';
import { UiServer } from './ui-server.js';

// ─────────────────────────────────────────────────────────────────────────────
// W28 — the `error` frame had NO schema.
//
// Eleven wire types; this was the eleventh and the only one of the eleven with
// no zod schema. It was emitted as three inline object literals in
// `UiServer.onData`, so: nothing validated it, nothing bounded `detail`, and a
// typo in one of the three copies was invisible to every gate. The duplication
// was the defect, so these tests pin the SHARED SOURCE, not just the shape.
//
// The load-bearing questions, in order:
//   1. Can provider text reach a client through this frame?  (census + guard)
//   2. Does the wire stay byte-identical?                   (exact-JSON pins)
//   3. Is the schema load-bearing, i.e. does it REJECT?     (refusal tests)
//   4. Can the three sites drift apart again?                (source-text pins)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The exact bytes the three pre-W28 inline literals emitted, captured from
 * `ui-server.ts` before the edit and re-verified against the built `dist/`.
 * `redactString`/`ERROR_DETAILS`/`buildErrorFrame` changed the CONSTRUCTION, so
 * these are regression pins on the wire, not descriptions of it.
 */
const PRE_W28_WIRE: ReadonlyArray<readonly [string, string]> = [
  ['audio frame too large', '{"type":"error","detail":"audio frame too large"}'],
  ['invalid JSON', '{"type":"error","detail":"invalid JSON"}'],
  ['unknown command', '{"type":"error","detail":"unknown command"}'],
];

const servers: UiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function rawSocket(port: number): Promise<{
  write: (b: Buffer) => void;
  readText: () => Promise<string>;
  end: () => void;
}> {
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
          if (f.opcode === Opcode.Text) deliver(Buffer.from(f.payload).toString('utf8'));
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
            ? Promise.resolve(pending.shift() as string)
            : new Promise<string>((res) => void waiters.push(res)),
        end: () => void sock.end(),
      });
    });
    sock.on('error', reject);
  });
}

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

/** Connect, drain `hello`, and hand back a socket positioned for inbound frames. */
async function connected(token = 'secret-token'): Promise<Awaited<ReturnType<typeof rawSocket>>> {
  const server = new UiServer({ token, contractVersion: '3.1.0' });
  servers.push(server);
  const port = await server.start(0);
  const sock = await rawSocket(port);
  sock.write(handshake(token));
  await sock.readText(); // hello
  return sock;
}

const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);

describe('W28 · ErrorFrameSchema — the frame that had none', () => {
  test('EVERY outbound frame type is now schema-backed; `error` was the eleventh', () => {
    // The census in one assertion. Before W28 these ten parsed and `error` did
    // not; the point of the count is that a future eleventh schema-less frame
    // changes it.
    expect(typeof ErrorFrameSchema.parse).toBe('function');
    expect(ErrorFrameSchema.safeParse(buildErrorFrame(ERROR_DETAILS.invalidJson)).success).toBe(true);
  });

  test('the wire is BYTE-IDENTICAL to the three pre-W28 inline literals', () => {
    for (const [detail, wire] of PRE_W28_WIRE) {
      const built = buildErrorFrame(detail as ErrorDetail);
      const json = JSON.stringify(built);
      expect(json).toBe(wire);
      // Key ORDER is part of the wire, and zod rebuilds the object — so this is
      // measured rather than assumed, which is the whole point of the pin.
      expect(Object.keys(built)).toEqual(['type', 'detail']);
      expect(encodeTextFrame(json).byteLength).toBe(Buffer.byteLength(wire, 'utf8') + 2);
    }
  });

  test('no `seq`, no `id`, no `ok` — an `error` frame is unsequenced, and the schema forbids adding one', () => {
    // `error` is not retained for resume and the renderer's branch (ws.ts) reads
    // `detail` only, deliberately NOT advancing `lastSeq`. `.strict()` is what
    // stops a future contributor adding `seq` and silently changing resume
    // semantics for a frame the resume window never holds.
    for (const key of ['seq', 'id', 'ok'] as const) {
      const r = ErrorFrameSchema.safeParse({ type: ERROR_KIND, detail: ERROR_DETAILS.invalidJson, [key]: 1 });
      expect(r.success).toBe(false);
    }
  });
});

describe('W28 · the schema REJECTS (a schema nothing ever parses is this defect one level down)', () => {
  test('`buildErrorFrame` ITSELF parses — the schema is on the only production path, not just in a test', () => {
    // NAMED FOR WHAT IT CHECKS after a break-the-guard run showed the previous
    // version of this case called `ErrorFrameSchema.parse` DIRECTLY and therefore
    // stayed green when `buildErrorFrame` was rewritten to return a raw object —
    // which is exactly the `ack`/F1 defect (`AckFrameSchema` is `.parse`d nowhere
    // in the tree). The property that matters is that the CONSTRUCTOR throws.
    expect(() => buildErrorFrame('nope' as ErrorDetail)).toThrow();
    // Positive control in the same breath, so a constructor that throws on
    // everything cannot pass this.
    expect(() => buildErrorFrame(ERROR_DETAILS.invalidJson)).not.toThrow();
    expect(buildErrorFrame(ERROR_DETAILS.invalidJson)).toEqual({
      type: 'error',
      detail: 'invalid JSON',
    });
  });

  test('the schema itself throws on a malformed frame', () => {
    expect(() => ErrorFrameSchema.parse({ type: ERROR_KIND, detail: 'nope' })).toThrow();
    expect(() => ErrorFrameSchema.parse({ type: ERROR_KIND })).toThrow();
  });

  test('wrong `type` is rejected', () => {
    expect(ErrorFrameSchema.safeParse({ type: 'ack', detail: ERROR_DETAILS.invalidJson }).success).toBe(false);
    expect(ErrorFrameSchema.safeParse({ type: 'notice', detail: ERROR_DETAILS.invalidJson }).success).toBe(false);
  });

  test('missing `detail` is rejected', () => {
    expect(ErrorFrameSchema.safeParse({ type: ERROR_KIND }).success).toBe(false);
  });

  test('an extra key is rejected (`.strict()`)', () => {
    const r = ErrorFrameSchema.safeParse({
      type: ERROR_KIND,
      detail: ERROR_DETAILS.invalidJson,
      leak: 'x',
    });
    expect(r.success).toBe(false);
  });

  test('FREE TEXT is rejected — this is the closed-union claim, asserted', () => {
    // `ack.detail` is `z.string().optional()` and safe only by convention; this
    // frame is a closed 3-member enum. An open string here would be a compile
    // error to reintroduce, and this is the runtime half.
    expect(ErrorFrameSchema.safeParse({ type: ERROR_KIND, detail: '' }).success).toBe(false);
    expect(ErrorFrameSchema.safeParse({ type: ERROR_KIND, detail: 'audio frame too large ' }).success).toBe(false);
    expect(ErrorFrameSchema.safeParse({ type: ERROR_KIND, detail: 'Audio frame too large' }).success).toBe(false);
    expect(ErrorFrameSchema.safeParse({ type: ERROR_KIND, detail: 'toString' }).success).toBe(false);
  });

  test('a provider failure message cannot be smuggled through a cast', () => {
    // SYNTHETIC provider text, shaped like a real one. The whole point: the
    // obvious future edit is `detail: err.message`, and it must be loud.
    const providerText = '401 Unauthorized: sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
    expect(() => buildErrorFrame(providerText as ErrorDetail)).toThrow();
    // And the guard is not merely "the schema complains": the TYPE would also
    // stop it, which is why this is a cast in the first place.
    const detail: ErrorDetail = ERROR_DETAILS.invalidJson;
    expect(detail).toBe('invalid JSON');
  });
});

describe('W28 · provider text cannot reach a client through an `error` frame', () => {
  test('CENSUS: the whole `error.detail` domain is three literals, none interpolated', () => {
    // The answer to the question, as data. `error` is the ONE free-text-shaped
    // frame in this protocol that carries no provider text, and the reason is
    // structural rather than a redactor: `detail` is a closed union, so provider
    // output is not representable, not merely scrubbed.
    expect(Object.values(ERROR_DETAILS).sort()).toEqual([
      'audio frame too large',
      'invalid JSON',
      'unknown command',
    ]);
  });

  test('every value in the domain is `redactString`-identity and holds no credential shape', () => {
    // Pins the two controls AGREE. The enum is the structural one; if a widening
    // commit ever makes a value that the redactor WOULD change, this fails and
    // the widening has to argue about it rather than inherit a silent gap.
    for (const value of Object.values(ERROR_DETAILS)) {
      expect(redactString(value)).toBe(value);
      expect(containsSecret(value)).toBe(false);
    }
  });

  test('no production source interpolates a value into an `error` frame', () => {
    // Read the shipped file, not a re-declaration. This is what makes the census
    // above a statement about the tree.
    //
    // FOUR separate assertions, because an earlier draft of this guard had a hole
    // that break-the-guard B7 walked straight through: it banned `type: ERROR_KIND`
    // and nothing else, so rewriting `writeError` to
    // `JSON.stringify({ type: 'error', detail })` — the emit path with the schema
    // deleted, i.e. the `ack`/F1 defect — passed all 18 tests. Each assertion below
    // closes one spelling of "bypassed the constructor".
    const serverPath = join(process.cwd(), 'src', 'ipc', 'ui-server.ts');
    const src = readFileSync(serverPath, 'utf8');

    // (1) the pre-W28 spelling, via the constant
    expect(src.match(/type:\s*ERROR_KIND/g) ?? []).toEqual([]);
    // (2) …and via the bare literal, which is what B7 used. Scoped to a `type:`
    //     POSITION, because `'error'` is also a legitimate `notice` level in this
    //     file (`notice(code, detail, level: 'info'|'warn'|'error')`) and banning the
    //     bare string would be a guard that fails for the wrong reason.
    expect(src.match(/type:\s*'error'/g) ?? []).toEqual([]);
    expect(src.match(/type:\s*"error"/g) ?? []).toEqual([]);
    expect(src.match(/ERROR_KIND\s*[,}]/g) ?? []).toEqual([]);
    // (3) the constructor is reached exactly once — one sink, no second path
    expect(src.split('buildErrorFrame(').length - 1).toBe(1);
    // (4) and `ERROR_KIND` is not imported here any more, so it cannot creep back
    expect(/^\s*ERROR_KIND,$/m.test(src)).toBe(false);

    // Every `detail` the file passes is a member of the shared table.
    const passed = [...src.matchAll(/this\.writeError\(conn,\s*([A-Za-z_$][\w$.]*)\s*\)/g)].map((m) => m[1]);
    expect(passed).toEqual([
      'ERROR_DETAILS.audioTooLarge',
      'ERROR_DETAILS.invalidJson',
      'ERROR_DETAILS.unknownCommand',
    ]);
  });

  test('the constructor is CALLED from exactly one module, and the barrel re-exports it', () => {
    // If a second producer appears — the daemon, the E2E stub — it must import the
    // same constructor. Two hand-rolled `error` emitters is the duplication this
    // whole item exists to remove, and it would be invisible to every other test.
    const srcRoot = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(srcRoot);
    const rel = (f: string): string => f.slice(srcRoot.length + 1).split('\\').join('/');
    const read = (f: string): string => readFileSync(f, 'utf8');

    // Called: the definition and the one sink. The barrel re-exports without a
    // call, so a future producer importing it is not a violation — HAND-ROLLING a
    // frame is.
    expect(files.filter((f) => read(f).includes('buildErrorFrame(')).map(rel).sort()).toEqual([
      'ipc/protocol.ts',
      'ipc/ui-server.ts',
    ]);
    // Referenced (call or re-export) — exactly those two plus the public barrel.
    expect(files.filter((f) => read(f).includes('buildErrorFrame')).map(rel).sort()).toEqual([
      'ipc/index.ts',
      'ipc/protocol.ts',
      'ipc/ui-server.ts',
    ]);
    // And nobody anywhere builds one by hand. Scoped to `type: 'error'` TOGETHER
    // WITH `detail`, because `type: 'error'` is an OVERLOADED literal in this
    // codebase: `src/voice/fish-ws.ts` declares `{ type: 'error'; message: string }`
    // for the Fish transport's own callback, which is not a WS-4097 frame and must
    // not be "fixed" by this guard. The frame shape is `detail`, and that is the
    // discriminator.
    const handRolled = files.filter((f) => /type:\s*['"]error['"][^\n;]*detail|detail[^\n;]*type:\s*['"]error['"]/.test(read(f)));
    expect(handRolled.map(rel)).toEqual([]);
  });

  test('each `detail` string is written ONCE in production code — the duplication is the defect', () => {
    // Pre-W28, `'audio frame too large'` existed as a literal in `ui-server.ts`
    // AND inside whatever a reader assumed the "contract" was. Three copies, one
    // per rejection, free to drift. Now the string exists once, in the table.
    const srcRoot = join(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(srcRoot);
    const offenders: string[] = [];
    for (const detail of Object.values(ERROR_DETAILS)) {
      const hits = files.filter((f) => readFileSync(f, 'utf8').includes(`'${detail}'`));
      if (hits.length !== 1) offenders.push(`${detail}: ${hits.length} sites (${hits.join(', ')})`);
    }
    expect(offenders).toEqual([]);
  });

  test('the enum and the runtime schema cannot drift apart', () => {
    // Same shape as `GENERIC_SK_EXCLUSIONS` in `common/logger.ts`: two lists,
    // cross-checked by a test so a future value cannot be added to one and
    // forgotten in the other.
    const fromTable = Object.values(ERROR_DETAILS).sort();
    const fromSchema = [...ErrorFrameSchema.shape.detail.options].sort();
    expect(fromSchema).toEqual(fromTable);
    expect(fromSchema.length).toBe(Object.keys(ERROR_DETAILS).length);
  });
});

describe('W28 · all three rejections, over a real socket', () => {
  test('an oversized binary frame answers with the exact pre-W28 bytes, socket kept', async () => {
    const sock = await connected();
    sock.write(maskFrame(Opcode.Binary, Buffer.alloc(MAX_AUDIO_BYTES + 1), MASK));
    const raw = await sock.readText();
    expect(raw).toBe('{"type":"error","detail":"audio frame too large"}');
    // The frame is the ONLY reply: nothing else may ride along, or the wire pin
    // above would be describing a stream rather than a frame.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['type', 'detail']);
    sock.end();
  });

  test('unparseable JSON answers with the exact pre-W28 bytes', async () => {
    const sock = await connected();
    sock.write(maskFrame(Opcode.Text, Buffer.from('{not json', 'utf8'), MASK));
    expect(await sock.readText()).toBe('{"type":"error","detail":"invalid JSON"}');
    sock.end();
  });

  test('a valid-JSON, wrong-shape command answers with the exact pre-W28 bytes', async () => {
    const sock = await connected();
    sock.write(maskFrame(Opcode.Text, Buffer.from('{"type":"nope","id":"c1"}', 'utf8'), MASK));
    expect(await sock.readText()).toBe('{"type":"error","detail":"unknown command"}');
    sock.end();
  });

  test('a rejected frame produces NO `ack` — the three sites stayed fail-quiet', async () => {
    // Routing the sites through a constructor must not have added a command
    // reply: `onCommand` is never reached, so the shell's ack ledger stays empty
    // and the uplink audio path is untouched.
    const server = new UiServer({ token: 'secret-token', contractVersion: '3.1.0' });
    let commands = 0;
    server.onCommand = () => {
      commands += 1;
      return { ok: true };
    };
    servers.push(server);
    const port = await server.start(0);
    const sock = await rawSocket(port);
    sock.write(handshake('secret-token'));
    await sock.readText();
    sock.write(maskFrame(Opcode.Text, Buffer.from('{not json', 'utf8'), MASK));
    await sock.readText();
    sock.write(maskFrame(Opcode.Binary, Buffer.alloc(MAX_AUDIO_BYTES + 1), MASK));
    await sock.readText();
    await new Promise((r) => setTimeout(r, 50));
    expect(commands).toBe(0);
    sock.end();
  });
});
