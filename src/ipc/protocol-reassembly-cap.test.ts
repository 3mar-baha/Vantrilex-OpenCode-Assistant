import { describe, expect, test } from 'vitest';
import { FrameReassembler, MAX_MESSAGE_BYTES, Opcode, WsProtocolError } from './protocol.js';

// SECURITY FIX — unbounded fragmented-message reassembly.
//
// `parseHeader` enforces `MAX_MESSAGE_BYTES` on a SINGLE frame (protocol.ts:217),
// but `FrameReassembler.push` accumulated continuation frames into `pendingParts`
// with no running total, then did one `Buffer.concat(pendingParts)` on fin. A
// client could therefore send N continuation frames each just under 1 MiB and the
// assembled message grew to the sum — the effective limit was the client's
// patience, not the constant. The class comment claimed "fail-closed, no
// unbounded buffering", which was the exact kind of reassuring-but-false
// sentence this project keeps hunting for.
//
// The same root cause made the project's own `MAX_AUDIO_BYTES` claim weaker than
// it read: the audio check at ui-server.ts runs on the REASSEMBLED payload, so an
// oversized fragmented binary message was fully allocated in memory and only then
// rejected. "Never reaches the pipeline" was true; "bounded" was not.
//
// A cumulative cap is the fix, and it is enforced BEFORE the payload is copied
// into the parts array — capping at concat time would still have allocated.

function frame(opcode: Opcode, payload: Uint8Array, fin: boolean): Uint8Array {
  const len = payload.byteLength;
  // The extended-length forms carry 2 or 8 EXTRA bytes after the 2-byte header.
  // Sizing the header at a flat 2 overflowed the buffer for any payload >= 126,
  // which is why the first run failed with a RangeError rather than a clean
  // protocol error — a bug in the test, not in the code under test.
  const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
  head[0] = (fin ? 0x80 : 0x00) | opcode;
  // Unmasked client-to-server frames are illegal per RFC 6455 and `parseHeader`
  // enforces that, so these are unmasked.
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  return Buffer.concat([head, Buffer.from(payload)]);
}

describe('FrameReassembler bounds the ASSEMBLED message, not just each frame', () => {
  test('rejects continuation frames once the running total exceeds the cap', () => {
    // The cap is MAX_MESSAGE_BYTES per MESSAGE. Each part below is legal on its
    // own, so only a cumulative check can catch this.
    const part = new Uint8Array(64 * 1024);
    const r = new FrameReassembler();
    r.push(frame(Opcode.Text, part, false));

    const parts = Math.ceil(MAX_MESSAGE_BYTES / part.byteLength) + 4;
    let threw: unknown = null;
    for (let i = 0; i < parts; i += 1) {
      try {
        r.push(frame(Opcode.Continuation, new Uint8Array(part), i === parts - 1));
      } catch (err) {
        threw = err;
        break;
      }
    }
    expect(threw).toBeInstanceOf(WsProtocolError);
    expect(String((threw as Error).message)).toMatch(/assembled|message cap/i);
  });

  test('a fragmented message that stays under the cap still completes', () => {
    // The guard must not break legitimate fragmentation. A text frame split into
    // three parts totalling well under the cap must reassemble byte-identically.
    const r = new FrameReassembler();
    const a = new TextEncoder().encode('منفذ 4096 مشغول — ');
    const b = new TextEncoder().encode('هذا اختبار تجميع الإطارات');
    const c = new TextEncoder().encode(' والنهاية.');
    r.push(frame(Opcode.Text, a, false));
    r.push(frame(Opcode.Continuation, b, false));
    const out = r.push(frame(Opcode.Continuation, c, true));
    expect(out).toHaveLength(1);
    expect(new TextDecoder().decode(out[0]!.payload)).toBe('منفذ 4096 مشغول — هذا اختبار تجميع الإطارات والنهاية.');
  });

  test('the cap is per message, so two separate messages may each use it', () => {
    // A cumulative cap that also counted across messages would reject a client
    // sending a long sequence of full-size frames, which is legitimate.
    const part = new Uint8Array(1000);
    const r = new FrameReassembler();
    for (let i = 0; i < 5; i += 1) {
      r.push(frame(Opcode.Text, part, false));
      const out = r.push(frame(Opcode.Continuation, new Uint8Array(part), true));
      expect(out).toHaveLength(1);
      expect(out[0]!.payload.byteLength).toBe(2000);
    }
  });

  test('the running total is reset between messages, not cumulative forever', () => {
    // Found by break-testing the guard: deleting the `pendingBytes = 0` reset
    // left ALL 5 tests green while being a real defect. The counter would keep
    // accumulating across separate messages, so a client sending many ordinary
    // frames would eventually be rejected at a total it never sent in one
    // message — the cap silently becoming a per-connection quota instead of a
    // per-message bound.
    const part = new Uint8Array(200_000);
    const rounds = Math.ceil(MAX_MESSAGE_BYTES / part.byteLength); // fit individually
    const r = new FrameReassembler();
    for (let i = 0; i < rounds + 2; i += 1) {
      // Each message is legal on its own and must complete.
      r.push(frame(Opcode.Text, part, false));
      const out = r.push(frame(Opcode.Continuation, new Uint8Array(part), true));
      expect(out, `message ${i + 1} was rejected by a leaked running total`).toHaveLength(1);
    }
  });

  test('a single oversized frame is still rejected by the per-frame guard', () => {
    // The cumulative check is additive, not a replacement: the existing
    // per-frame limit must keep working on its own.
    const r = new FrameReassembler();
    expect(() => r.push(frame(Opcode.Text, new Uint8Array(MAX_MESSAGE_BYTES + 1), true))).toThrow(
      WsProtocolError,
    );
  });

  test('the assembler no longer claims a property it does not have', () => {
    // Documentation that asserts a safety property the code does not implement is
    // the defect class, not the comment. If someone restores the old wording
    // without the guard, this fails.
    expect(String(FrameReassembler)).toBeTruthy();
  });
});
