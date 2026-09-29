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
  IPC_TOKEN_ENV,
  maskFrame,
  MAX_MESSAGE_BYTES,
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
