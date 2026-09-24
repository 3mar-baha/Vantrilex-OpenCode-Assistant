import { describe, expect, test } from 'vitest';
import {
  ACK_KIND,
  decodeFrames,
  encodeTextFrame,
  ERROR_KIND,
  FrameReassembler,
  HelloFrameSchema,
  IPC_TOKEN_ENV,
  maskFrame,
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
    for (const kind of ['abort', 'mute', 'deafen', 'arm', 'setPersona', 'switchSession'] as const) {
      const parsed = UiCommandSchema.safeParse({ id: 'cmd-1', kind });
      expect(parsed.success).toBe(true);
    }
    expect(UiCommandSchema.safeParse({ id: 'cmd-1', kind: 'format-disk' }).success).toBe(false);
    expect(UiCommandSchema.safeParse({ kind: 'abort' }).success).toBe(false);
  });

  test('ack and error kinds are namespaced', () => {
    expect(ACK_KIND).toBe('ack');
    expect(ERROR_KIND).toBe('error');
  });
});
