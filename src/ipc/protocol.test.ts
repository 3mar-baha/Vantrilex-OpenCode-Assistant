import { describe, expect, test } from 'vitest';
import {
  ACK_KIND,
  buildInventoryFrame,
  ContextFrameSchema,
  decodeFrames,
  encodeTextFrame,
  ERROR_KIND,
  FrameReassembler,
  HelloFrameSchema,
  InventoryFrameSchema,
  INVENTORY_MAX_SESSIONS,
  IPC_TOKEN_ENV,
  maskFrame,
  MAX_MESSAGE_BYTES,
  MAX_PREHEADER_BYTES,
  Opcode,
  parseSeq,
  UI_SUBPROTOCOL,
  UI_WS_PORT,
  UiCommandSchema,
  WsProtocolError,
} from './protocol.js';

// G2 TDD — pure RFC 6455 codec + protocol constants. Zero sockets here.
describe('protocol constants (ADR-010)', () => {
  test('single-supervisor IPC surface is versioned and loopback-bound', () => {
    expect(UI_WS_PORT).toBe(4096 + 1);
    expect(UI_SUBPROTOCOL).toBe('voice-ui.v1');
    expect(IPC_TOKEN_ENV).toBe('VOICE_RUNTIME_IPC_TOKEN');
  });
});

describe('encodeTextFrame (server -> client, unmasked)', () => {
  test('short payload round-trips through decodeFrames', () => {
    const wire = encodeTextFrame('{"type":"hello"}');
    expect(wire[0]).toBe(0x81); // FIN + text
    expect(wire[1]! & 0x80).toBe(0); // server frames are never masked
    const { frames, remaining } = decodeFrames(wire);
    expect(remaining.byteLength).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ opcode: Opcode.Text, fin: true });
    expect(Buffer.from(frames[0]!.payload).toString('utf8')).toBe('{"type":"hello"}');
  });

  test('16-bit extended length path (>125 bytes)', () => {
    const payload = 'x'.repeat(300);
    const wire = encodeTextFrame(payload);
    expect(wire[1]! & 0x7f).toBe(126);
    const { frames } = decodeFrames(wire);
    expect(Buffer.from(frames[0]!.payload).toString('utf8')).toBe(payload);
  });

  test('64-bit extended length path (>65535 bytes)', () => {
    const payload = 'y'.repeat(70_000);
    const wire = encodeTextFrame(payload);
    expect(wire[1]! & 0x7f).toBe(127);
    const { frames } = decodeFrames(wire);
    expect(frames[0]!.payload.byteLength).toBe(70_000);
  });

  test('partial frame is buffered, not emitted', () => {
    const wire = encodeTextFrame('hello');
    const { frames, remaining } = decodeFrames(wire.subarray(0, 3));
    expect(frames).toHaveLength(0);
    expect(remaining.byteLength).toBe(3);
  });
});

describe('masked client frames (browsers always mask)', () => {
  test('masked text decodes to the same payload', () => {
    const payload = Buffer.from('{"id":"cmd-1"}', 'utf8');
    const wire = maskFrame(Opcode.Text, payload, Buffer.from([1, 2, 3, 4]));
    expect(wire[1]! & 0x80).toBe(0x80);
    const { frames } = decodeFrames(wire);
    expect(Buffer.from(frames[0]!.payload).toString('utf8')).toBe('{"id":"cmd-1"}');
  });

  test('fragmented message reassembles across continuation frames', () => {
    const a = maskFrame(Opcode.Text, Buffer.from('hel', 'utf8'), Buffer.from([9, 9, 9, 9]), false);
    const b = maskFrame(Opcode.Continuation, Buffer.from('lo', 'utf8'), Buffer.from([7, 7, 7, 7]), true);
    const { frames } = decodeFrames(Buffer.concat([a, b]));
    expect(frames).toHaveLength(1);
    expect(Buffer.from(frames[0]!.payload).toString('utf8')).toBe('hello');
  });

  test('ping yields a ping frame; close yields a close frame', () => {
    const ping = maskFrame(Opcode.Ping, Buffer.alloc(0), Buffer.from([0, 0, 0, 0]));
    const close = maskFrame(Opcode.Close, Buffer.from([0x03, 0xe8]), Buffer.from([0, 0, 0, 0]));
    expect(decodeFrames(ping).frames[0]!.opcode).toBe(Opcode.Ping);
    expect(decodeFrames(close).frames[0]!.opcode).toBe(Opcode.Close);
  });
});

describe('parseSeq (strict Last-Seq)', () => {
  test('digits parse; trailing garbage, empties, and nulls do not', () => {
    expect(parseSeq('12')).toBe(12);
    expect(parseSeq('0')).toBe(0);
    expect(Number.isNaN(parseSeq('12abc'))).toBe(true);
    expect(Number.isNaN(parseSeq(''))).toBe(true);
    expect(Number.isNaN(parseSeq(null))).toBe(true);
    expect(Number.isNaN(parseSeq(undefined))).toBe(true);
  });
});

describe('FrameReassembler (cross-chunk fragments)', () => {
  test('fragment split across two pushes reassembles', () => {
    const re = new FrameReassembler();
    const mask = Buffer.from([1, 2, 3, 4]);
    const first = maskFrame(Opcode.Text, Buffer.from('hel', 'utf8'), mask, false);
    const second = maskFrame(Opcode.Continuation, Buffer.from('lo', 'utf8'), mask, true);
    // Split mid-frame: first byte alone, then the rest.
    expect(re.push(first.subarray(0, 1))).toHaveLength(0);
    const frames = re.push(Buffer.concat([first.subarray(1), second]));
    expect(frames).toHaveLength(1);
    expect(Buffer.from(frames[0]!.payload).toString('utf8')).toBe('hello');
  });

  test('reserved opcode throws WsProtocolError (fail-closed)', () => {
    const re = new FrameReassembler();
    expect(() => re.push(Buffer.from([0x83, 0x00]))).toThrow(WsProtocolError);
  });

  test('absurd 64-bit length throws instead of allocating', () => {
    const re = new FrameReassembler();
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeUInt32BE(1, 2); // hi != 0
    header.writeUInt32BE(0, 6);
    expect(() => re.push(header)).toThrow(WsProtocolError);
  });

  test('fragmented control frame throws', () => {
    const re = new FrameReassembler();
    expect(() => re.push(Buffer.from([0x09, 0x00]))).toThrow(WsProtocolError); // FIN=false ping
  });

  // --- M3 B.1 — pre-header buffer cap ---------------------------------------
  //
  // `push()` concatenates every inbound chunk into `this.buffer`, and until a
  // FULL header parses the only thing consulted is `parseHeader` returning null.
  // Two measurements taken against this revision shaped the four tests below;
  // both are reproducible from `dist/` and neither is an assumption:
  //
  //   1. A 1-byte dribble is SELF-LIMITING, not unbounded. The head frame
  //      drains at header(14) + declared(<= MAX_MESSAGE_BYTES) = 1_048_590 B,
  //      because `parseHeader` refuses any declared length above the cap, so
  //      the loop cannot stall behind a frame larger than that. 4_000_000
  //      single-byte pushes threw nothing. The cap is therefore crossed by ONE
  //      inbound chunk, not by patience — and a real socket hands `onData` at
  //      most 65_536 B per 'data' event (measured on the upgrade socket), so
  //      2x MAX_MESSAGE_BYTES is defence-in-depth against a future larger read
  //      buffer rather than a path a peer can drive today. The dribble prefix
  //      is kept because it is the attack's shape; 4096 is where the O(n^2)
  //      concat stops being free.
  //   2. A legal MAX_MESSAGE_BYTES message pushed in ONE call already needs
  //      1_048_590 B of buffer, so a 1x cap would reject legal traffic. That is
  //      precisely what the 2x buys, and B.1-P3b is the test that pins it.
  describe('M3 B.1 pre-header cap', () => {
    /** Client frame header declaring `declared` bytes: masked, 64-bit length. */
    const head = (declared: number, opcode: Opcode, fin: boolean): Buffer => {
      const h = Buffer.alloc(14);
      h[0] = (fin ? 0x80 : 0x00) | opcode;
      h[1] = 0x80 | 127;
      h.writeUInt32BE(0, 2);
      h.writeUInt32BE(declared, 6);
      return h; // masking key stays 0x00 — XOR 0 is identity, so payloads read plain
    };

    // P1 — the guard exists, and it bounds the right thing.
    test('B.1-P1: dribbling is uncounted, and one push over the cap throws', () => {
      const re = new FrameReassembler();
      // The head frame declares the largest legal length, so the parse loop
      // never completes it and `buffer` grows one byte per push with no cap
      // consulted. All of this is legal and must not throw.
      let pushed = 0;
      for (const b of head(MAX_MESSAGE_BYTES, Opcode.Text, false)) {
        expect(re.push(Buffer.from([b]))).toHaveLength(0);
        pushed += 1;
      }
      while (pushed < 4096) {
        expect(re.push(Buffer.from([0x41]))).toHaveLength(0);
        pushed += 1;
      }
      // One push over the cap throws. The bound is on the post-concat buffer —
      // what `Buffer.concat` actually allocates — so it fires on the FIRST push
      // that overshoots, however little was retained behind it.
      expect(() => re.push(Buffer.alloc(MAX_PREHEADER_BYTES))).toThrow(WsProtocolError);
    });

    // P2 — the off-by-one pin. `>` not `>=`: a post-concat buffer of exactly the
    // cap is legal. Change the comparison and BOTH halves of this test fail.
    //
    // Each case needs its own reassembler, and that is a measured property
    // rather than tidiness: a buffer of exactly the cap does not STAY at the
    // cap, because the parse loop inside that same push drains the head frame
    // (it cannot exceed 1_048_590 B by construction). So "retained at the cap,
    // then one more byte" is not a state a peer can produce, and a test that
    // asserted it would pin a fiction.
    test('B.1-P2: exactly the cap passes, one byte more throws', () => {
      const atCap = new FrameReassembler();
      expect(() => atCap.push(Buffer.alloc(MAX_PREHEADER_BYTES, 0x41))).not.toThrow();

      const overCap = new FrameReassembler();
      expect(() => overCap.push(Buffer.alloc(MAX_PREHEADER_BYTES + 1, 0x41))).toThrow(WsProtocolError);
    });

    // P3 — legal traffic survives. (a) is the brief's fragmentation case and (b)
    // is the one that actually discriminates 1x from 2x: a 1 MiB message in a
    // single push is 1_048_590 B of buffer, so a 1x cap would kill it.
    test('B.1-P3: legitimate messages still reassemble under the cap', () => {
      const mask = Buffer.from([9, 8, 7, 6]);
      const split = new FrameReassembler();
      const whole = 'z'.repeat(512 * 1024);
      const chunks = Math.ceil(whole.length / 4096);
      for (let i = 0; i < chunks; i += 1) {
        const isLast = i === chunks - 1;
        const piece = whole.slice(i * 4096, Math.min((i + 1) * 4096, whole.length));
        // Only the FIRST piece may be Text: a new data frame mid-message
        // discards the fragment in flight, so the chain is Text(!fin) then
        // Continuations, per RFC 6455 §5.4.
        const opcode = i === 0 ? Opcode.Text : Opcode.Continuation;
        const frames = split.push(maskFrame(opcode, Buffer.from(piece, 'utf8'), mask, isLast));
        if (isLast) {
          expect(frames).toHaveLength(1);
          expect(frames[0]!.payload.byteLength).toBe(512 * 1024);
        } else {
          expect(frames).toHaveLength(0);
        }
      }

      const oneShot = new FrameReassembler();
      const frames = oneShot.push(maskFrame(Opcode.Text, Buffer.alloc(MAX_MESSAGE_BYTES, 0x41), mask));
      expect(frames).toHaveLength(1);
      expect(frames[0]!.payload.byteLength).toBe(MAX_MESSAGE_BYTES);
    });

    // P4 — the throw RESETS, it does not merely throw. Two halves, both of which
    // a "throw and leave the buffer" fix would fail: the pre-header buffer is
    // zeroed (a valid small frame decodes next), and the in-flight fragment is
    // discarded (its continuation is dropped as a stray rather than concatenated
    // onto stale parts).
    test('B.1-P4: the throw resets buffer and pending state', () => {
      const re = new FrameReassembler();
      re.push(maskFrame(Opcode.Text, Buffer.from('in-flight'), Buffer.from([1, 1, 1, 1]), false));
      expect(() => re.push(Buffer.alloc(MAX_PREHEADER_BYTES + 1, 0x41))).toThrow(WsProtocolError);

      // Pending discarded, checked FIRST: the abandoned fragment's continuation
      // is a stray and yields nothing. Order matters — a new data frame also
      // discards the fragment, so probing this after any valid frame would
      // clear the very state under test and pass whatever the throw did.
      expect(re.push(maskFrame(Opcode.Continuation, Buffer.from('orphaned'), Buffer.from([3, 3, 3, 3])))).toHaveLength(0);

      // Buffer zeroed: a small legal frame decodes with its real payload.
      const frames = re.push(maskFrame(Opcode.Text, Buffer.from('{"kind":"ping"}'), Buffer.from([2, 2, 2, 2])));
      expect(frames).toHaveLength(1);
      expect(Buffer.from(frames[0]!.payload).toString('utf8')).toBe('{"kind":"ping"}');
    });
  });

  describe('M3 B.6 — the opening fragment counts toward the cumulative cap', () => {
    // Found next door to B.1: the head of a fragmented message was pushed
    // WITHOUT accountFor, so head(1 MiB, uncharged) + continuation(1 MiB,
    // charged as 1 MiB) assembled 2 MiB silently — while `decodeFrames` on
    // the identical wire threw. The cap was 2x loose in the live path.
    const mask = Buffer.from([5, 5, 5, 5]);
    const MiB = 1024 * 1024;

    test('B.6-P1: head + continuation exceeding the cap throws', () => {
      const re = new FrameReassembler();
      re.push(maskFrame(Opcode.Text, Buffer.alloc(MiB, 0x41), mask, false));
      // Break: remove the accountFor on the head and this never throws —
      // the continuation alone charges exactly 1 MiB, at (not over) the cap.
      expect(() =>
        re.push(maskFrame(Opcode.Continuation, Buffer.alloc(MiB, 0x42), mask, true)),
      ).toThrow(WsProtocolError);
    });

    test('B.6-P2: a legal split still assembles', () => {
      const re = new FrameReassembler();
      const half = MiB / 2;
      re.push(maskFrame(Opcode.Text, Buffer.alloc(half, 0x41), mask, false));
      const frames = re.push(maskFrame(Opcode.Continuation, Buffer.alloc(half, 0x42), mask, true));
      expect(frames).toHaveLength(1);
      expect(frames[0]!.payload.byteLength).toBe(MiB);
    });
  });
});

describe('inventory frames (Phase 2b)', () => {
  test('serializer output validates; empty array is the error/unready shape', () => {
    const frame = buildInventoryFrame(7, [
      { sessionId: 'ses_a', state: 'running' },
      { sessionId: 'ses_b', state: 'idle' },
    ]);
    expect(InventoryFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame).toMatchObject({ type: 'inventory', seq: 7 });
    const empty = buildInventoryFrame(8, []);
    expect(InventoryFrameSchema.safeParse(empty).success).toBe(true);
    expect(empty.sessions).toEqual([]);
  });

  test('B.2a: 250 sessions -> exactly 200, FIRST 200 kept, truncation recorded', () => {
    // The snapshot was emitted whole, so a busy server could put an unbounded
    // session list on the wire (and in the retained `lastInventory` copy). The
    // cap is on the SCHEMA, not just the producer, so the 201st entry is
    // rejected wherever it comes from.
    const many = Array.from({ length: 250 }, (_, i) => ({ sessionId: `ses_${i}`, state: 'running' }));
    const frame = buildInventoryFrame(9, many);
    expect(INVENTORY_MAX_SESSIONS).toBe(200);
    expect(frame.sessions).toHaveLength(200);
    // FIRST 200, not last 200 and not a sorted sample: the oldest session
    // survives and the newest is what gets dropped. A `slice(-200)` or a
    // `.reverse().slice(0,200)` implementation fails these two.
    expect(frame.sessions[0]!.sessionId).toBe('ses_0');
    expect(frame.sessions[199]!.sessionId).toBe('ses_199');
    // Truncation must be RECORDED, not silent — a shell that shows 200 rows
    // with no count has been told less than it needs to know.
    expect(frame.totalSessions).toBe(250);
    expect(
      InventoryFrameSchema.safeParse({ type: 'inventory', seq: 0, sessions: many }).success,
    ).toBe(false);
    // ...and it must be ABSENT when nothing was truncated. An always-present
    // field passes every assertion above and silently mis-signals truncation on
    // every ordinary snapshot — the additive-field trap: a consumer that reads
    // `totalSessions !== undefined` as "there are more" is wrong forever.
    const exact = buildInventoryFrame(10, many.slice(0, INVENTORY_MAX_SESSIONS));
    expect(exact.sessions).toHaveLength(INVENTORY_MAX_SESSIONS);
    expect(exact.totalSessions, 'no truncation, so no truncation field').toBeUndefined();
    expect(buildInventoryFrame(11, []).totalSessions).toBeUndefined();
  });

  test('malformed sessions throw at the producer, never on the wire', () => {
    expect(() => buildInventoryFrame(0, [{ sessionId: '', state: 'x' }])).toThrow();
    expect(() => buildInventoryFrame(-1, [])).toThrow();
    expect(InventoryFrameSchema.safeParse({ type: 'inventory', seq: 0, sessions: [{ sessionId: 'a' }] }).success).toBe(false);
    expect(InventoryFrameSchema.safeParse({ type: 'event', seq: 0, sessions: [] }).success).toBe(false);
  });
});

describe('frame schemas', () => {
  test('hello frame validates; version mismatch is detectable', () => {
    const ok = HelloFrameSchema.safeParse({
      type: 'hello', contractVersion: '3.1.0', nodePid: 1234,
      servePort: 4096, layaReady: true, seq: 0,
    });
    expect(ok.success).toBe(true);
    const bad = HelloFrameSchema.safeParse({
      type: 'hello', contractVersion: '9.9.9', nodePid: 1234,
      servePort: 4096, layaReady: true, seq: 0,
    });
    // Schema accepts any semver-shaped string; the RENDERER refuses mismatch.
    expect(bad.success).toBe(true);
    expect((bad as { success: true; data: { contractVersion: string } }).data.contractVersion).not.toBe('3.1.0');
  });

  test('renderer commands are closed-vocabulary with ids', () => {
    for (const kind of [
      'abort',
      // M2 Pattern 2 — speech-only barge-in. ADDITIVE, so a daemon that predates
      // it keeps working and an old shell simply never sends it.
      'stopSpeech',
      'mute',
      'deafen',
      'arm',
      'setPersona',
      'switchSession',
      'setSessionAgent',
      'setSessionModel',
      'toggleSessionSkill',
      'execSessionShell',
    ] as const) {
      const parsed = UiCommandSchema.safeParse({ id: 'cmd-1', kind });
      expect(parsed.success).toBe(true);
    }
    expect(UiCommandSchema.safeParse({ id: 'cmd-1', kind: 'format-disk' }).success).toBe(false);
    expect(UiCommandSchema.safeParse({ kind: 'abort' }).success).toBe(false);
  });

  // M2 Pattern 2 — the vocabulary is CLOSED, and `stopSpeech` is the one kind
  // whose name a misspelling would silently degrade into the wrong behaviour.
  // A shell that sent `stopSpeach` was reaching for speech-only barge-in; if
  // that typo parsed, the router would answer `unsupported command` and the user
  // would hear the assistant keep talking over them — a refusal, not a repair.
  test('M2-P2: stopSpeech parses; its near-miss spellings are refused', () => {
    for (const kind of ['stopSpeech'] as const) {
      expect(UiCommandSchema.safeParse({ id: 'cmd-1', kind }).success).toBe(true);
    }
    for (const typo of ['stopSpeach', 'stop_speech', 'stopspeech', 'StopSpeech', 'abortSpeech']) {
      expect(
        UiCommandSchema.safeParse({ id: 'cmd-1', kind: typo }).success,
        `${typo} must not be accepted`,
      ).toBe(false);
    }
  });

  // L23 — the command envelope is the trust boundary. It accepted arbitrary
  // extra keys and unbounded free strings for every field that later reaches a
  // shell or a filesystem path.
  describe('L23 command envelope hardening', () => {
    const base = { id: 'cmd-1', kind: 'switchSession' } as const;

    test('rejects unknown keys instead of silently dropping them', () => {
      // A typo in a field name used to vanish, leaving a command that did
      // something other than what the caller believed.
      expect(UiCommandSchema.safeParse({ ...base, sessinId: 'ses_x' }).success).toBe(false);
      expect(UiCommandSchema.safeParse({ ...base, __proto__: { polluted: true } }).success).toBe(false);
    });

    test('every field the shell sends still parses', () => {
      // Regression guard: .strict() must not break the real client.
      const real = [
        { ...base, sessionId: 'ses_abc123' },
        { id: 'c', kind: 'setPersona', persona: 'nour' },
        { id: 'c', kind: 'mute' },
        { id: 'c', kind: 'arm', minutes: 5 },
        { id: 'c', kind: 'setSessionAgent', sessionId: 'ses_a', agent: 'explore' },
        { id: 'c', kind: 'setSessionModel', sessionId: 'ses_a', model: 'opencode/muse' },
        { id: 'c', kind: 'toggleSessionSkill', sessionId: 'ses_a', skill: 'mission-handoff', skillAction: 'attach' },
        { id: 'c', kind: 'execSessionShell', sessionId: 'ses_a', command: 'rm -rf build' },
        { id: 'c', kind: 'saveApiKeys', groqKey: 'g', fishKey: 'f', openrouterKey: 'o' },
        { id: 'c', kind: 'confirm', confirmId: 'x1', approve: true },
      ];
      for (const cmd of real) {
        const r = UiCommandSchema.safeParse(cmd);
        expect(r.success, `${JSON.stringify(cmd)} -> ${r.success ? '' : r.error.message}`).toBe(true);
      }
    });

    test('sessionId must be an opaque ses_ token, never a path', () => {
      const ok = (v: string): boolean => UiCommandSchema.safeParse({ ...base, sessionId: v }).success;
      expect(ok('ses_abc123')).toBe(true);
      expect(ok('../../etc/passwd')).toBe(false);
      expect(ok('..\\..\\windows')).toBe(false);
      expect(ok('ses_a/../ses_b')).toBe(false);
      expect(ok('ses_a b')).toBe(false);
      // Newlines in an id become header/log injection downstream.
      expect(ok('ses_a\nX-Injected: 1')).toBe(false);
      expect(ok('a'.repeat(200))).toBe(false);
    });

    test('agent, model and skill are length-bounded and charset-checked', () => {
      const withField = (k: string, v: string): boolean =>
        UiCommandSchema.safeParse({ id: 'c', kind: 'setSessionAgent', sessionId: 'ses_a', [k]: v }).success;
      expect(withField('agent', 'explore')).toBe(true);
      expect(withField('agent', 'a'.repeat(300))).toBe(false);
      expect(withField('agent', 'a\nb')).toBe(false);
    });

    test('command length is bounded at the schema, not only in the router', () => {
      const cmd = (v: string): boolean =>
        UiCommandSchema.safeParse({ id: 'c', kind: 'execSessionShell', sessionId: 'ses_a', command: v }).success;
      expect(cmd('rm -rf build')).toBe(true);
      expect(cmd('x'.repeat(5000))).toBe(false);
    });

    test('key fields cannot smuggle control characters', () => {
      const r = UiCommandSchema.safeParse({
        id: 'c',
        kind: 'saveApiKeys',
        groqKey: 'gsk-a\nBARE',
        fishKey: 'f',
        openrouterKey: 'o',
      });
      expect(r.success).toBe(false);
    });

    test('id is length-bounded so it cannot be used to flood a log line', () => {
      expect(UiCommandSchema.safeParse({ id: 'c'.repeat(500), kind: 'abort' }).success).toBe(false);
    });
  });

  test('ack and error kinds are namespaced', () => {
    expect(ACK_KIND).toBe('ack');
    expect(ERROR_KIND).toBe('error');
  });

  // Phase 4 — the context-window frame. Additive: an older shell that does not
  // know `context` must simply ignore it, which the WS contract guarantees.
  describe('context frame (Phase 4)', () => {
    const ok = {
      type: 'context' as const,
      seq: 3,
      sessionId: 'ses_a',
      used: 10_850,
      limit: 200_000,
      percent: 5.4,
      messageCount: 2,
    };

    test('round-trips a known-limit frame', () => {
      const r = ContextFrameSchema.safeParse(ok);
      expect(r.success).toBe(true);
      expect(r.success && r.data.percent).toBe(5.4);
    });

    test('accepts an unknown limit with a null percent rather than guessing', () => {
      // Divide by a guessed context window is how a gauge ends up lying.
      const r = ContextFrameSchema.safeParse({ ...ok, limit: null, percent: null });
      expect(r.success).toBe(true);
      expect(r.success && r.data.percent).toBeNull();
    });

    test('rejects a percent outside 0..100', () => {
      expect(ContextFrameSchema.safeParse({ ...ok, percent: 140 }).success).toBe(false);
      expect(ContextFrameSchema.safeParse({ ...ok, percent: -1 }).success).toBe(false);
    });

    test('rejects a non-numeric or negative usage', () => {
      expect(ContextFrameSchema.safeParse({ ...ok, used: 'lots' }).success).toBe(false);
      expect(ContextFrameSchema.safeParse({ ...ok, used: -5 }).success).toBe(false);
    });

    test('rejects a non-opaque session id', () => {
      expect(ContextFrameSchema.safeParse({ ...ok, sessionId: '../../etc' }).success).toBe(false);
    });

    test('is a NEW frame type, so an old shell ignores it rather than failing', () => {
      // The additive contract: unknown types are dropped, never fatal.
      expect(ContextFrameSchema.shape.type.value).toBe('context');
      expect(ok.type).not.toBe(HelloFrameSchema.shape.type.value);
    });
  });
});

describe('inbound message cap (DoS guard)', () => {
  test('a declared length above the cap is refused before allocation', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127; // 64-bit length form
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(MAX_MESSAGE_BYTES + 1, 6);
    const r = new FrameReassembler();
    expect(() => r.push(header)).toThrowError(/message cap/);
  });

  test('the cap is a sane megabyte-scale bound', () => {
    expect(MAX_MESSAGE_BYTES).toBe(1024 * 1024);
  });
});
