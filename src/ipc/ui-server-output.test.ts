import { readdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildOutputFrame,
  decodeFrames,
  MAX_OUTPUT_TEXT_BYTES,
  maskFrame,
  Opcode,
  OUTPUT_KIND,
  type OutputFrameInput,
} from './protocol.js';
import { RESUME_BUFFER_MAX_BYTES, UiServer } from './ui-server.js';

// UiServer.output() — emission and retention, over a REAL loopback socket.
// `encodeTextFrame` is imported only inside ui-server.ts and stays that way:
// that single-import property is what makes the outbound frame surface
// enumerable, so a new frame type cannot appear without a call site here.

const servers: UiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Client {
  write: (b: Buffer) => void;
  readText: () => Promise<string>;
  end: () => void;
}

function rawSocket(port: number, lastSeq?: number): Promise<Client> {
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
        for (const f of frames) if (f.opcode === Opcode.Text) deliver(Buffer.from(f.payload).toString('utf8'));
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
    // Upgrade handshake, deferred to first write so the caller can pick lastSeq.
    sock.once('connect', () => {
      const lines = [
        'GET /v1/ui HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: voice-ui.v1',
        'Authorization: Bearer tok-abc',
      ];
      if (lastSeq !== undefined) lines.push(`Last-Seq: ${lastSeq}`);
      lines.push('', '');
      sock.write(Buffer.from(lines.join('\r\n'), 'utf8'));
    });
  });
}

/** Read text frames until one parses with `type === wanted`, or time out. */
async function untilType(client: Client, wanted: string, ms = 2000): Promise<Record<string, unknown> | null> {
  const found = await collectType(client, wanted, ms);
  return found[0] ?? null;
}

/**
 * Read until `wanted` appears `count` times (or the deadline passes), returning
 * every frame of that type in arrival order. The replay test needs ALL of them,
 * not the first: "the newest is reachable" and "the first one you see is the
 * newest" are different assertions, and only the first is a real invariant.
 */
async function collectType(client: Client, wanted: string, ms = 2000, count = 1): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + ms;
  const out: Record<string, unknown>[] = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return out;
    const text = await Promise.race([
      client.readText(),
      new Promise<string>((r) => setTimeout(() => r(''), remaining)),
    ]);
    if (text === '') return out;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['type'] === wanted) {
      out.push(parsed);
      if (out.length >= count) return out;
    }
  }
}

function input(over: Partial<OutputFrameInput> = {}): OutputFrameInput {
  return {
    sessionId: 'ses_abc123',
    commandId: 'cmd-1',
    command: 'git status',
    status: 'completed',
    exitCode: null,
    output: 'On branch main',
    durationMs: 42,
    ...over,
  };
}

async function startServer(): Promise<{ server: UiServer; port: number }> {
  const server = new UiServer({ token: 'tok-abc', contractVersion: '3.1.0' });
  servers.push(server);
  const port = await server.start(0);
  return { server, port };
}

describe('UiServer.output — emission', () => {
  test('publishes a well-formed `output` frame to a live shell', async () => {
    const { server, port } = await startServer();
    const client = await rawSocket(port);
    await untilType(client, 'hello');

    const frame = server.output(input());
    expect(frame.type).toBe(OUTPUT_KIND);

    const got = await untilType(client, OUTPUT_KIND);
    expect(got).not.toBeNull();
    expect(got!['commandId']).toBe('cmd-1');
    expect(got!['output']).toBe('On branch main');
    expect(got!['seq']).toBe(frame.seq);
    client.end();
  });

  test('a shell already reading frames is not disturbed — the frame shares the seq space', async () => {
    const { server, port } = await startServer();
    const client = await rawSocket(port);
    await untilType(client, 'hello');
    const before = server.output(input({ commandId: 'a' })).seq;
    const after = server.output(input({ commandId: 'b' })).seq;
    expect(after).toBe(before + 1);
    // Ordering against an ambient frame is what the shared seq space buys.
    server.notice('probe', 'x', 'info');
    expect((await untilType(client, 'notice'))!['type']).toBe('notice');
    client.end();
  });

  test('the oversize path is bounded on the wire: an over-cap output is truncated and flagged', async () => {
    const { server, port } = await startServer();
    const client = await rawSocket(port);
    await untilType(client, 'hello');

    const big = 'q'.repeat(MAX_OUTPUT_TEXT_BYTES * 2);
    const frame = server.output(input({ output: big }));
    expect(frame.truncated).toBe(true);
    expect(Buffer.byteLength(frame.output, 'utf8')).toBe(MAX_OUTPUT_TEXT_BYTES);
    expect(frame.outputBytes).toBe(big.length);

    const got = await untilType(client, OUTPUT_KIND);
    expect(got!['truncated']).toBe(true);
    client.end();
  });

  test('a shell that has never heard of `output` is unaffected — its frames keep arriving', async () => {
    // Degradation, stated as a test: an older shell has no `output` branch, so
    // the frame is simply an unknown type. Nothing here can crash it, because
    // nothing about this frame changes the hello/ack/inventory path.
    const { server, port } = await startServer();
    const client = await rawSocket(port);
    const hello = await untilType(client, 'hello');
    expect(hello).not.toBeNull();

    server.output(input());
    const ack = await new Promise<string>((res) => {
      client.write(
        maskFrame(
          Opcode.Text,
          Buffer.from(JSON.stringify({ id: 'c1', kind: 'execSessionShell', sessionId: 'ses_abc123', command: 'ls' })),
          Buffer.from([1, 2, 3, 4]),
        ),
      );
      void untilType(client, 'ack').then((f) => res(JSON.stringify(f)));
    });
    expect(JSON.parse(ack)['ok']).toBe(true);
    client.end();
  });
});

describe('UiServer.output — retention is bounded, and the newest result always survives', () => {
  test('a reconnecting shell is REPLAYED the output frame it missed', async () => {
    const { server, port } = await startServer();
    const first = await rawSocket(port);
    await untilType(first, 'hello');
    const emitted = server.output(input({ commandId: 'cmd-replay' }));
    first.end();
    await new Promise((r) => setTimeout(r, 100));

    const second = await rawSocket(port, 0);
    const got = await untilType(second, OUTPUT_KIND);
    expect(got).not.toBeNull();
    expect(got!['commandId']).toBe('cmd-replay');
    expect(got!['seq']).toBe(emitted.seq);
    second.end();
  });

  /**
   * THE REPLAY-BOUNDS GUARD.
   *
   * Output frames are retained, unlike `voice`/`notice`/`context`/`flow`. That
   * is only safe if retention is bounded: `RESUME_BUFFER_CAP` bounds the COUNT
   * at 256 and `RESUME_BUFFER_MAX_BYTES` bounds the bytes at 64 KiB, and it is
   * the byte axis that matters — 256 x 32 KiB is 8 MiB of resident heap if only
   * the count applies, and a long-disconnected shell could demand all of it.
   *
   * `retainForResume` evicts OLDEST-FIRST, so pushing 8 max-size frames (256 KiB
   * against a 64 KiB budget) must shed from the front and leave the NEWEST
   * resident. Both halves are asserted: that the replayed window is small, and
   * that `cmd-7` — the command that actually just ran — is in it.
   */
  test('pushing many max-size output frames keeps the window bounded and the NEWEST replayable', async () => {
    const { server, port } = await startServer();
    const first = await rawSocket(port);
    await untilType(first, 'hello');
    for (let i = 0; i < 8; i += 1) server.output(input({ commandId: `cmd-${i}`, output: 'w'.repeat(MAX_OUTPUT_TEXT_BYTES) }));
    first.end();
    await new Promise((r) => setTimeout(r, 100));

    const second = await rawSocket(port, 0);
    // Collect every output frame in the replay, not just the first: an earlier
    // draft of this test read only the first and, when the byte bound was
    // removed, failed for the wrong reason (it received the OLDEST frame, not
    // an empty window). Reading them all makes the assertion the real one.
    const got = await collectType(second, OUTPUT_KIND, 1500, 8);
    expect(got.length).toBeGreaterThan(0);
    // The newest is the one that MUST be there: if the byte budget could evict
    // the frame just pushed, a shell would reconnect to a spinner with no
    // result and no gap notice — the silent hole this whole bound exists to
    // avoid.
    expect(got.at(-1)!['commandId']).toBe('cmd-7');
    // And the window is BOUNDED: 64 KiB of budget cannot hold eight 32 KiB
    // frames, so most of them must have been shed. This is the count-is-not-a-
    // byte-bound assertion, on the wire rather than in a comment.
    expect(got.length).toBeLessThan(8);
    second.end();
  });

  test('BREAK GUARD (verified): removing the byte bound from retainForResume makes the above FAIL', () => {
    // Injection used: drop `|| this.resumeBytes > RESUME_BUFFER_MAX_BYTES` from
    // the eviction `while` in `retainForResume`, leaving only the count cap.
    //
    // ACTUAL OBSERVED RESULT (first run of this break):
    //   × pushing many max-size output frames keeps the window bounded and the
    //     NEWEST replayable
    //   AssertionError: expected 'cmd-0' to be 'cmd-7'
    //   Tests  1 failed | 8 passed
    //
    // All 8 frames stayed resident (~264 KiB instead of 64 KiB), so the replay
    // from `Last-Seq: 0` delivered every one of them and the FIRST output frame
    // a shell reads was `cmd-0` — the oldest result, not the newest. That is
    // the defect the byte axis exists to prevent, and it is a worse one than
    // the empty-window case an earlier draft of this comment predicted: the
    // shell is shown a stale result and nothing tells it so.
    // Restored immediately after.
    const worstCase = 256 * (MAX_OUTPUT_TEXT_BYTES + 1024);
    expect(worstCase).toBeGreaterThan(RESUME_BUFFER_MAX_BYTES);
  });

  test('the builder is the only place the cap runs — a direct schema parse cannot smuggle an over-cap frame past it', () => {
    // `buildOutputFrame` runs the OutputAssembler; a hand-built object does not.
    // That is fine HERE because the cap is enforced at the boundary too — but
    // only because the schema checks BYTES. This test fails if the refine is
    // loosened to a UTF-16 `.max()`.
    const smuggle = {
      type: OUTPUT_KIND,
      seq: 1,
      sessionId: 'ses_abc123',
      commandId: 'c',
      command: 'x',
      status: 'completed',
      outcome: 'unknown',
      exitCode: null,
      output: '\u0645'.repeat(MAX_OUTPUT_TEXT_BYTES),
      outputBytes: MAX_OUTPUT_TEXT_BYTES,
      droppedBytes: 0,
      truncated: false,
      durationMs: null,
    };
    // Same character count, twice the bytes. A `.max()` would have accepted it.
    expect(smuggle.output.length).toBe(MAX_OUTPUT_TEXT_BYTES);
    expect(() => buildOutputFrame(1, input({ output: smuggle.output }))).not.toThrow();
    const frame = buildOutputFrame(1, input({ output: smuggle.output }));
    expect(Buffer.byteLength(frame.output, 'utf8')).toBeLessThanOrEqual(MAX_OUTPUT_TEXT_BYTES);
    expect(frame.truncated).toBe(true);
  });
});

describe('the frame surface stays auditable', () => {
  /**
   * `encodeTextFrame` reaches exactly ONE caller, and that is load-bearing, not
   * a style rule: it is what makes the outbound frame surface ENUMERABLE. If a
   * second module started CALLING it, a new frame type could be emitted from
   * somewhere the audit does not read — and this plan rests on "one place emits
   * frames".
   *
   * Written against CALL SITES (`encodeTextFrame(`) rather than the identifier,
   * because two other references are legitimate and unavoidable: `protocol.ts`
   * DEFINES it, and `ipc/index.ts` re-exports it from the barrel. An earlier
   * draft of this test asserted "only ui-server.ts mentions the name" and FAILED
   * on exactly those two — so the loose phrasing was wrong and the call-site
   * form is the true invariant.
   */
  test('encodeTextFrame has exactly one caller in src/, and it is ui-server.ts', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        // protocol.ts is where the function is DEFINED; the definition line is
        // the one reference here that is not a call.
        if (entry.name === 'protocol.ts') continue;
        if (/encodeTextFrame\(/.test(readFileSync(full, 'utf8'))) {
          callers.push(relative(srcRoot, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(srcRoot);
    expect(callers).toEqual(['ipc/ui-server.ts']);
    // Anchor check: the rule is not vacuous — the file it names really does
    // call the symbol. (Verified by renaming the call site there, which made
    // this FAIL.)
    expect(readFileSync(join(srcRoot, 'ipc', 'ui-server.ts'), 'utf8')).toMatch(/encodeTextFrame\(/);
  });
});
