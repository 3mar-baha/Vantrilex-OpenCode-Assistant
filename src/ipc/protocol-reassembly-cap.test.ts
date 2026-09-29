import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
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
    // Sized so that SEVERAL messages are needed to reach the cap on their own:
    // 5 x 200,000 = 1,000,000 is close to but under MAX_MESSAGE_BYTES, so if the
    // total leaked across messages the next message would trip it.
    //
    // The first version sent 5 x 2,000 bytes against a 1,048,576 cap, which is
    // three orders of magnitude too small to ever reach the limit - it passed
    // against the pre-fix code, against the reset-removed code, and against the
    // current code, so it could not detect the property in its own name. A test
    // that passes in every world is not a test.
    const part = new Uint8Array(200_000);
    const r = new FrameReassembler();
    const rounds = Math.ceil(MAX_MESSAGE_BYTES / part.byteLength);
    for (let i = 0; i < rounds; i += 1) {
      r.push(frame(Opcode.Text, part, false));
      const out = r.push(frame(Opcode.Continuation, new Uint8Array(part), true));
      expect(out, `message ${i + 1} was rejected`).toHaveLength(1);
      expect(out[0]!.payload.byteLength).toBe(2 * part.byteLength);
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

  test('an abandoned fragment does not charge the NEXT message', () => {
    // Found by a code review: starting a new data frame while a fragment is in
    // flight left the orphan's bytes counted against the running total, so a
    // subsequent LEGAL fragmented message was rejected for a total the client
    // never sent in one message. The cumulative cap turned a pre-existing
    // misbehaviour into a false rejection.
    //
    // Repro: orphan a partial Text(fin=false), abandon it, then send a message
    // that fits the cap on its own. It must complete.
    const r = new FrameReassembler();
    r.push(frame(Opcode.Text, new Uint8Array(600_000), false)); // never finished
    // A new data frame abandons it.
    r.push(frame(Opcode.Text, new Uint8Array(1000), false));
    const out = r.push(frame(Opcode.Continuation, new Uint8Array(1000), true));
    expect(out, 'the message after an abandoned fragment was rejected').toHaveLength(1);
    expect(out[0]!.payload.byteLength).toBe(2000);
  });

  test('a full-size fragmented message is still accepted after an orphan', () => {
    // The case the review reported as a concrete false rejection: 716,800 bytes
    // orphaned, then a 1,024,000-byte fragmented message against a 1,048,576 cap.
    // Before the discard this was rejected; it must not be.
    const r = new FrameReassembler();
    r.push(frame(Opcode.Text, new Uint8Array(716_800), false));
    r.push(frame(Opcode.Text, new Uint8Array(1000), false)); // abandons the 716,800
    const big = new Uint8Array(1_024_000 - 1000);
    r.push(frame(Opcode.Text, big, false));
    const out = r.push(frame(Opcode.Continuation, new Uint8Array(1000), true));
    expect(out, 'a legal full-size message was rejected by a leaked total').toHaveLength(1);
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
    // the defect class, not the comment.
    //
    // The first version of this test asserted `String(FrameReassembler)` is
    // truthy, which is true for ANY class and passed with the original
    // "no unbounded buffering" comment restored. A code review found it and
    // called it provably vacuous, which it was. This asserts the claim is gone.
    const src = readFileSync('src/ipc/protocol.ts', 'utf8');
    expect(src).not.toMatch(/no unbounded buffering/);
    // And the replacement comment must not make a NEW unchecked claim either.
    // "fail-closed, no unbounded buffering" was false; the guarded version says
    // the cap is checked before storing, which IS enforced by accountFor.
    expect(src).toMatch(/accountFor/);
  });
});
