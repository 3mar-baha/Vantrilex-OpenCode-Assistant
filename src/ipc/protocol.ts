import { z } from 'zod';
import { redactString } from '../common/logger.js';
// Voxaura UI IPC protocol — ADR-010. Zero-dependency RFC 6455 codec +
// versioned frame schemas for the ws://127.0.0.1:4097/v1/ui channel.
// The daemon is the sole supervisor; the renderer never assigns `seq`.
export const UI_WS_PORT = 4096 + 1;
export const UI_WS_PATH = '/v1/ui';
export const UI_SUBPROTOCOL = 'voice-ui.v1';
export const IPC_TOKEN_ENV = 'VOICE_RUNTIME_IPC_TOKEN';
export const SERVE_PORT = 4096;
export const PING_INTERVAL_MS = 5000;
export const MISSED_PINGS_LIMIT = 3;
/**
 * L15: hard cap on simultaneous WS-4097 clients. The surface is loopback-only
 * and single-user, so this is generous for legitimate use while bounding what a
 * stuck or hostile local client can accumulate — the connection set was
 * previously unbounded, so every broadcast fanned out to all of it.
 */
export const MAX_CONNECTIONS = 8;
export const RESUME_BUFFER_CAP = 256;
/** Hard inbound message cap — a single frame may never exceed this. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** M3 B.1: hard cap on the pre-header buffer — see FrameReassembler.push. */
export const MAX_PREHEADER_BYTES = 2 * MAX_MESSAGE_BYTES;
/** Voice capture contract (P4): 16 kHz mono Int16 PCM over binary frames. */
export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_FRAME_MS = 100;
export const AUDIO_FRAME_BYTES = ((AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS) / 1000) * 2;
/** Per-chunk audio cap — glitches get an error frame, never a dropped socket. */
export const MAX_AUDIO_BYTES = 64 * 1024;
export const ACK_KIND = 'ack';
export const ERROR_KIND = 'error';
export const OUTPUT_KIND = 'output';

export enum Opcode {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

export interface WsFrame {
  readonly fin: boolean;
  readonly opcode: Opcode;
  readonly payload: Uint8Array;
}

/** Server → client text frame: FIN + text, never masked (RFC 6455 §5.1). */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.byteLength;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Server-side binary frame (unmasked, FIN set). Payloads stay small by contract. */
export function encodeBinaryFrame(payload: Uint8Array): Buffer {
  const len = payload.byteLength;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([0x82, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, Buffer.from(payload)]);
}

/** Test helper — build a masked client frame (browsers always mask, §5.3). */
export function maskFrame(opcode: Opcode, payload: Buffer, mask: Buffer, fin = true): Buffer {
  if (mask.byteLength < 4) throw new Error('mask must be at least 4 bytes');
  const len = payload.byteLength;
  const first = (fin ? 0x80 : 0x00) | opcode;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.from([first, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask.subarray(0, 4), masked]);
}

/**
 * Incremental frame parser. Returns complete messages (continuations
 * reassembled); control frames pass through as single-frame messages.
 * Incomplete trailing bytes come back in `remaining`.
 *
 * NOTE: reassembly state must persist across TCP chunks — use
 * FrameReassembler for socket input. Calling decodeFrames per chunk drops
 * fragments split across packets.
 */
export function decodeFrames(input: Uint8Array): { frames: WsFrame[]; remaining: Uint8Array } {
  const frames: WsFrame[] = [];
  let offset = 0;
  let pendingOpcode: Opcode | null = null;
  const pendingParts: Uint8Array[] = [];
  let pendingBytes = 0;
  const buf = Buffer.from(input);

  while (offset + 2 <= buf.byteLength) {
    const fin = (buf[offset]! & 0x80) !== 0;
    const opcode = (buf[offset]! & 0x0f) as Opcode;
    const masked = (buf[offset + 1]! & 0x80) !== 0;
    let length = buf[offset + 1]! & 0x7f;
    let head = offset + 2;
    if (length === 126) {
      if (head + 2 > buf.byteLength) break;
      length = buf.readUInt16BE(head);
      head += 2;
    } else if (length === 127) {
      if (head + 8 > buf.byteLength) break;
      const hi = buf.readUInt32BE(head);
      const lo = buf.readUInt32BE(head + 4);
      if (hi !== 0 || lo > 0x7fffffff) break; // refuse absurd allocations
      length = lo;
      head += 8;
    }
    // This function is a SECOND reassembler, and it shipped with neither limit:
    // no per-frame cap and no cumulative cap, so it had the unbounded path the
    // class above was fixed for. It is not what `ui-server.ts` calls (that uses
    // FrameReassembler), but it is exported from `src/ipc/index.ts`, so it is one
    // import away from being the live path. Both caps are applied here for the
    // same reason: an exported helper that is one caller away from production
    // should not be weaker than the one in production.
    if (length > MAX_MESSAGE_BYTES) {
      throw new WsProtocolError('frame exceeds message cap — refusing allocation');
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (head + 4 > buf.byteLength) break;
      mask = buf.subarray(head, head + 4);
      head += 4;
    }
    if (head + length > buf.byteLength) break;
    let payload = buf.subarray(head, head + length);
    if (mask !== null) {
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) out[i] = payload[i]! ^ mask[i % 4]!;
      payload = out;
    }
    offset = head + length;

    if (opcode === Opcode.Continuation) {
      if (pendingOpcode === null) continue; // stray continuation — drop
      // Cumulative cap, same rule and same order as FrameReassembler: checked
      // BEFORE the part is stored, because capping at concat time still
      // allocates. This function had no cap of either kind.
      pendingBytes += payload.byteLength;
      if (pendingBytes > MAX_MESSAGE_BYTES) {
        pendingBytes = 0;
        pendingParts.length = 0;
        pendingOpcode = null;
        throw new WsProtocolError('assembled message exceeds message cap — refusing allocation');
      }
      pendingParts.push(payload);
      if (fin) {
        frames.push({ fin: true, opcode: pendingOpcode, payload: Buffer.concat(pendingParts) });
        pendingOpcode = null;
        pendingParts.length = 0;
        pendingBytes = 0;
      }
      continue;
    }
    if (opcode === Opcode.Text || opcode === Opcode.Binary) {
      if (!fin) {
        // Abandon an in-flight fragment before charging this one, so an orphan
        // cannot make a later legal message fail. Same order as the class above.
        pendingOpcode = null;
        pendingParts.length = 0;
        pendingBytes = 0;
        pendingOpcode = opcode;
        pendingBytes = payload.byteLength;
        if (pendingBytes > MAX_MESSAGE_BYTES) {
          pendingBytes = 0;
          throw new WsProtocolError('frame exceeds message cap — refusing allocation');
        }
        pendingParts.push(payload);
        continue;
      }
      frames.push({ fin: true, opcode, payload });
      continue;
    }
    frames.push({ fin: true, opcode, payload }); // Close / Ping / Pong
  }
  return { frames, remaining: buf.subarray(offset) };
}

/** Thrown when a peer violates the frame contract — the connection must die. */
export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

function parseHeader(
  buf: Buffer,
  offset: number,
): { fin: boolean; opcode: Opcode; masked: boolean; length: number; head: number } | null {
  if (offset + 2 > buf.byteLength) return null;
  const fin = (buf[offset]! & 0x80) !== 0;
  const opcode = (buf[offset]! & 0x0f) as Opcode;
  const masked = (buf[offset + 1]! & 0x80) !== 0;
  let length = buf[offset + 1]! & 0x7f;
  let head = offset + 2;
  if (length === 126) {
    if (head + 2 > buf.byteLength) return null;
    length = buf.readUInt16BE(head);
    head += 2;
  } else if (length === 127) {
    if (head + 8 > buf.byteLength) return null;
    const hi = buf.readUInt32BE(head);
    const lo = buf.readUInt32BE(head + 4);
    if (hi !== 0 || lo > 0x7fffffff) {
      throw new WsProtocolError('absurd frame length — refusing allocation');
    }
    length = lo;
    head += 8;
  }
  if (length > MAX_MESSAGE_BYTES) {
    throw new WsProtocolError('frame exceeds message cap — refusing allocation');
  }
  return { fin, opcode, masked, length, head };
}

const CONTROL_OPCODES: ReadonlySet<number> = new Set([Opcode.Close, Opcode.Ping, Opcode.Pong]);
const KNOWN_OPCODES: ReadonlySet<number> = new Set([
  Opcode.Continuation,
  Opcode.Text,
  Opcode.Binary,
  Opcode.Close,
  Opcode.Ping,
  Opcode.Pong,
]);

/**
 * Connection-scoped reassembler — the fix for fragments split across TCP
 * chunks. Feed every inbound chunk to push(); complete messages come out.
 * Protocol violations throw WsProtocolError; the caller must destroy the
 * connection.
 *
 * Both halves of that last sentence are load-bearing, and the second one used to
 * be false. `MAX_MESSAGE_BYTES` was enforced on each FRAME by `parseHeader`, not
 * on the ASSEMBLED message: `pendingParts` accumulated with no running total and
 * the message was then built with a single `Buffer.concat(pendingParts)`. A client
 * could send any number of continuation frames each just under 1 MiB and the
 * result grew to the sum, so the effective limit was the client's patience rather
 * than the constant. Now a cumulative total is checked BEFORE a part is stored, so
 * the payload is never copied into the array past the cap — capping at concat
 * time would still have allocated it.
 *
 * The same root cause weakened the project's `MAX_AUDIO_BYTES` guarantee: that
 * check runs on the REASSEMBLED payload, so an oversized fragmented binary
 * message used to be fully allocated and only then rejected. "Never reaches the
 * pipeline" was always true; "bounded" is now true too.
 */
export class FrameReassembler {
  private buffer = Buffer.alloc(0);
  private pendingOpcode: Opcode | null = null;
  private readonly pendingParts: Uint8Array[] = [];
  /** Running total of `pendingParts` — the assembled size, not the frame size. */
  private pendingBytes = 0;

  /** Reject a message that has already grown past the cap. */
  private accountFor(bytes: number): void {
    this.pendingBytes += bytes;
    if (this.pendingBytes > MAX_MESSAGE_BYTES) {
      // Reset first: a throw leaves the connection to be destroyed by the caller,
      // and a half-cleared assembler must not be reusable if it is.
      this.pendingBytes = 0;
      this.pendingParts.length = 0;
      this.pendingOpcode = null;
      throw new WsProtocolError('assembled message exceeds message cap — refusing allocation');
    }
  }

  /** Drop an in-flight fragment. Counters MUST go with it. */
  private discardPending(): void {
    this.pendingOpcode = null;
    this.pendingParts.length = 0;
    this.pendingBytes = 0;
  }

  push(chunk: Uint8Array): WsFrame[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    // M3 B.1 — pre-header cap. Everything above is per-MESSAGE accounting: it
    // only starts once a full header parses, so a peer that keeps the head frame
    // incomplete grew this buffer with no counter consulted. Measured, though,
    // the head frame CANNOT be larger than the cap (parseHeader refuses a larger
    // declared length), so a 1-byte dribble is self-limiting at
    // 1_048_590 B and 4_000_000 single-byte pushes threw nothing; a real socket
    // also hands onData at most 65_536 B per 'data' event. This is therefore
    // defence-in-depth against a future larger read buffer, not a path a peer
    // can drive today — and it is why the bound is 2x rather than 1x: a legal
    // MAX_MESSAGE_BYTES message arriving in one push needs 1_048_590 B of buffer,
    // so 1x would reject valid traffic (pinned by B.1-P3).
    if (this.buffer.byteLength > MAX_PREHEADER_BYTES) {
      // Reset first, for the same reason `accountFor` does: the caller destroys
      // the connection on the throw, and a half-cleared assembler must not be
      // reusable if it is.
      this.buffer = Buffer.alloc(0);
      this.discardPending();
      throw new WsProtocolError('pre-header buffer exceeds cap — refusing accumulation');
    }
    const frames: WsFrame[] = [];
    for (;;) {
      const header = parseHeader(this.buffer, 0);
      if (header === null) return frames; // need more bytes
      if (!KNOWN_OPCODES.has(header.opcode)) {
        throw new WsProtocolError(`reserved opcode ${header.opcode}`);
      }
      const isControl = CONTROL_OPCODES.has(header.opcode);
      if (isControl && (!header.fin || header.length > 125)) {
        throw new WsProtocolError('fragmented or oversized control frame');
      }
      let head = header.head;
      if (header.masked) {
        if (head + 4 > this.buffer.byteLength) return frames;
        head += 4;
      }
      if (head + header.length > this.buffer.byteLength) return frames; // need more bytes
      let payload = this.buffer.subarray(head, head + header.length);
      if (header.masked) {
        const mask = this.buffer.subarray(header.head, header.head + 4);
        const out = Buffer.alloc(header.length);
        for (let i = 0; i < header.length; i += 1) out[i] = payload[i]! ^ mask[i % 4]!;
        payload = out;
      }
      this.buffer = this.buffer.subarray(head + header.length);

      if (header.opcode === Opcode.Continuation) {
        if (this.pendingOpcode === null) continue; // stray continuation — drop
        this.accountFor(payload.byteLength);
        this.pendingParts.push(payload);
        if (header.fin) {
          frames.push({ fin: true, opcode: this.pendingOpcode, payload: Buffer.concat(this.pendingParts) });
          this.discardPending();
        }
        continue;
      }
      if (header.opcode === Opcode.Text || header.opcode === Opcode.Binary) {
        // A new data frame while a fragment is in flight discards the fragment.
        //
        // Without this, an abandoned fragment leaves its bytes charged against
        // the running total forever, so the NEXT legal fragmented message can be
        // rejected for a total the client never sent in one message. A code review
        // found that the cumulative cap turned an orphaned fragment into a false
        // rejection - a defect the pre-fix code did not have, since it ignored the
        // total entirely and emitted a wrong-opcode frame instead.
        //
        // Discarding is the RFC-compatible reading: a fragmented message is
        // aborted by starting another one. Charging nothing and keeping nothing
        // is also fail-closed, because the connection stays protocol-consistent.
        this.discardPending();
        if (!header.fin) {
          this.pendingOpcode = header.opcode;
          // M3-B.6: the opening fragment counts too. Without this, a 1 MiB
          // head (uncharged) plus a 1 MiB continuation (charged: 1 MiB total)
          // assembled 2 MiB silently — the cap was 2x loose in the live path
          // while `decodeFrames` on the identical wire threw.
          this.accountFor(payload.byteLength);
          this.pendingParts.push(payload);
          continue;
        }
        frames.push({ fin: true, opcode: header.opcode, payload });
        continue;
      }
      frames.push({ fin: true, opcode: header.opcode, payload });
    }
  }
}

// --- Versioned frames (zod boundaries) ---

/** Strict non-negative integer parse for Last-Seq values (header + query). */
export function parseSeq(raw: string | null | undefined): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return Number.NaN;
  return Number.parseInt(raw, 10);
}

export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  contractVersion: z.string().min(1),
  nodePid: z.number().int().positive(),
  servePort: z.literal(SERVE_PORT),
  layaReady: z.boolean(),
  seq: z.number().int().nonnegative(),
  /**
   * L22: the daemon's current persona, so a shell that connects (or reconnects)
   * after a change is not left showing the default. Optional and additive: an
   * older shell ignores it, and a shell that sees no persona simply keeps
   * whatever it already had.
   */
  persona: z.enum(['kareem', 'nour']).optional(),
  /**
   * M3 B.3: the daemon's authoritative backpressure state at connect time.
   *
   * Carried in `hello` rather than left to the `flow` frame alone, because
   * `flow()` writes to live sockets only and is not retained for resume. A shell
   * that connects after a pause — or after the release that would have undone
   * it — never receives the frame, and a latched shell drops its uplink while
   * the accumulator sits below the pause threshold forever. Both halves stall.
   * Same reasoning as `persona`: the daemon is the single source, and a shell
   * that arrives late must be told rather than left on a default.
   *
   * Required (not optional) on the wire, so a shell can distinguish "the daemon
   * checked and found no pause" from a daemon that predates the field. The
   * shell's own type keeps it optional, so an old daemon degrades to the
   * pre-B.3 behaviour instead of to a false pause.
   */
  uplinkPaused: z.boolean(),
});
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

export const UiEventSchema = z.object({
  type: z.literal('event'),
  seq: z.number().int().nonnegative(),
  eventId: z.string().min(1),
  state: z.string().min(1),
});
export type UiEvent = z.infer<typeof UiEventSchema>;

/**
 * L23 — the command envelope is the trust boundary.
 *
 * It previously accepted arbitrary unknown keys (a typo vanished and the command
 * did something other than what the caller believed) and unbounded free strings
 * for every field that later reaches a shell or a filesystem path. Now:
 * `.strict()`, length-bounded ids, an opaque `ses_`-prefixed session id, a
 * restricted charset for the identifiers forwarded to serve, and a command
 * length cap enforced at the schema rather than only in the router.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
/**
 * The same character class, global, for the ONE place a control character is
 * scrubbed rather than refused (`buildAckFrame`). Derived from `CONTROL_CHARS_RE`
 * rather than written out again: a second copy of the class is a second thing to
 * forget, and the schema's `refine` and the builder's sanitiser must agree on
 * exactly which characters are "control".
 */
const CONTROL_CHARS_GLOBAL_RE = new RegExp(CONTROL_CHARS_RE.source, 'g');
/** Identifiers forwarded to serve: `provider/id`, agent and skill names. */
const IDENT_RE = /^[A-Za-z0-9._:/-]+$/;

export const UiCommandSchema = z
  .object({
    id: z.string().min(1).max(128).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters'),
    kind: z.enum([
      'abort',
      // M2 Pattern 2 — speech-only barge-in. ADDITIVE: an old shell never sends
      // it, a new shell against an old daemon gets `unsupported command` and the
      // audio simply keeps playing (degraded, never wrong). It is NOT `abort`:
      // a voice burst must not cancel the turn the user is paying for.
      'stopSpeech',
      // M2 Pattern 3 — completion ≠ delivery. The renderer's player tells the
      // daemon ONCE per utterance that audio actually began, which is the only
      // evidence the daemon has that there is a live shell able to take audio.
      // Without it the daemon cannot tell "the assistant is speaking" from "the
      // assistant finished and nobody heard it", and a delivery into that gap is
      // silence the user reads as being ignored. ADDITIVE, like `stopSpeech`: an
      // old shell never sends it and a new shell against an old daemon gets
      // `unsupported command`.
      'playbackStarted',
      'mute',
      'deafen',
      'arm',
      'setPersona',
      'switchSession',
      'setSessionAgent',
      'setSessionModel',
      'toggleSessionSkill',
      'execSessionShell',
      'saveApiKeys',
      'confirm',
      // Phase 4 — OpenCode 360° session manager.
      'sessionContext',
      'createSession',
    ]),
    persona: z.enum(['kareem', 'nour']).optional(),
    minutes: z.number().int().positive().max(1440).optional(),
    sessionId: z
      .string()
      .regex(/^ses_[A-Za-z0-9_-]{1,120}$/, 'session id must be an opaque ses_ token')
      .optional(),
    agent: z.string().min(1).max(64).regex(IDENT_RE, 'invalid agent').optional(),
    model: z.string().min(1).max(128).regex(IDENT_RE, 'invalid model').optional(),
    skill: z.string().min(1).max(128).regex(IDENT_RE, 'invalid skill').optional(),
    skillAction: z.enum(['attach', 'detach']).optional(),
    command: z.string().min(1).max(512).optional(),
    // Keys are opaque secrets: no control characters, so a key can never be
    // used to forge a log line.
    groqKey: z.string().min(1).max(512).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    fishKey: z.string().min(1).max(512).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    openrouterKey: z.string().min(1).max(512).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    confirmId: z.string().min(1).max(128).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters').optional(),
    approve: z.boolean().optional(),
    /**
     * M2 Pattern 3 — optional correlation id for `playbackStarted`, bounded to
     * 64 chars with no control characters. It is a LOG correlation token, not a
     * path or a session handle, so it is deliberately NOT an opaque `ses_` id
     * (that shape is reserved for things that reach `client.*`) and NOT parsed:
     * bounded and printable is the whole requirement. Absent is valid — a shell
     * that does not correlate simply says "something started".
     */
    playbackId: z
      .string()
      .min(1)
      .max(64)
      // Restricted charset, not just control-char-free: this is a correlation
      // token that lands in `daemon.log`, so an unfiltered string would let a
      // shell forge log lines. Same reasoning as `IDENT_RE`, without the
      // path-ish `/-` this value has no use for.
      .regex(/^[A-Za-z0-9._:-]{1,64}$/, 'invalid playback id')
      .optional(),
    /** Phase 4: directory for `createSession`; model context limit for `sessionContext`. */
    title: z.string().min(1).max(200).optional(),
    contextLimit: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();
export type UiCommand = z.infer<typeof UiCommandSchema>;

// ── Command ack ──────────────────────────────────────────────────────────────
// W29. This is the frame that ended a session's "was it received?" question, and
// it was the last frame in `src/ipc/` with a schema nothing applied: declared at
// this line, re-exported from `src/ipc/index.ts`, and `.parse`d NOWHERE. The
// producer was an inline object literal in `UiServer.dispatchCommand`, so
// `detail` reached the wire with no length bound, no character bound, and no
// schema behind it — a frame whose declared contract and emitted bytes had
// nothing to do with each other.
//
// ── WHERE PROVIDER TEXT ENTERS, AND WHY THE SHAPE IS NOT `error`'s ──────────
// `dispatchCommand` catches whatever `onCommand` throws and puts the raw
// `err.message` in `detail`, so provider text reaches a client through this
// frame. That was ALREADY scrubbed before W29 — but by an inline
// `redactString(...)` in the emit site, which is the exact arrangement the
// `output` frame's own comment rejects ("Wrapping `UiServer.output()` instead
// would leave `buildOutputFrame` reachable unscrubbed"). The `ack` path never
// went through `UiServer.notice()`, the documented sink; it had a second,
// per-call-site scrub that only covered its one call site.
//
// SO `error` GETS A CLOSED ENUM AND `ack` GETS A BRANDED FRAME, and the reason
// is that `ack.detail` is legitimately open — it carries command outcomes
// ('persona-set', 'shell-outcome-unknown', 'no active session'), so closing it
// would mean inventing a vocabulary the router already owns. Closing it anyway
// would be the W28 shape applied where it does not fit.
//
// WHAT REPLACES THE ENUM'S GUARANTEE. `error.detail` is unrepresentable because
// the TYPE admits three strings. `ack.detail` cannot be unrepresentable without
// a closed vocabulary, so the guarantee is moved one level up, to the frame:
// `AckFrame` is BRANDED, so the only way to obtain one is `buildAckFrame`, and
// an emit site that hand-rolls the literal is a COMPILE ERROR. That is the same
// property `buildErrorFrame` gives, and it is what makes the sink below
// unavoidable rather than merely recommended.
//
// WHAT THIS DOES NOT CATCH, stated rather than discovered later:
//   · It does not make the OUTCOME unrepresentable. `CommandOutcome.detail` is
//     still an open `string` (see `ui-server.ts`), so a future router branch
//     forwarding provider text still COMPILES — it is scrubbed at the sink
//     instead. Converting the type to a branded `scrubAckDetail()` result would
//     make that a compile error too, at a MEASURED cost of 48 detail sites in
//     `command-router.ts`, one in `daemon.ts`, and ~64 assertions across 7 test
//     files (several of which pin the current source text verbatim). That
//     refactor is available and is not done here; the wire property holds
//     without it, because the scrub is at the producer of the frame.
//   · It does not bound a CLIENT's input. `ack` is server→client only; nothing
//     here validates what a shell sends (that is `UiCommandSchema`).
//   · It does not cover a DIFFERENT DAEMON BUILD. A shell talking to an older
//     daemon gets that daemon's frames, branded or not.
//
// (`ACK_KIND` is declared at the top of this file with the other wire constants;
// it is not repeated here.)

/**
 * `detail` cap, in UTF-16 code units (zod's unit, and `String.length`'s).
 *
 * MEASURED against every detail the router can produce — the longest shipped
 * literals are `'shell-outcome-failed'` and the Arabic
 * `جلسة جديدة: ses_…`, i.e. under 40 units — so 200 is ~5x headroom and cannot
 * fire on any legitimate outcome. What it DOES bound is the case that was live
 * before: an `onCommand` that throws a provider error with a long body shipped a
 * 5 065-byte ack frame (captured, `w29` before-image) carrying 5 000 characters
 * of someone else's text into a HUD row.
 */
export const ACK_MAX_DETAIL_CHARS = 200;
/**
 * Matches `UiCommandSchema.id`'s `.max(128)`. The bound CANNOT fire on the live
 * path — `dispatchCommand` only ever passes an id that `UiCommandSchema` already
 * validated — so this is a second line of defence on the frame's declared
 * contract, not a new constraint on any real traffic.
 */
export const ACK_MAX_ID_CHARS = 128;

export const AckFrameSchema = z
  .object({
    type: z.literal(ACK_KIND),
    id: z.string().min(1).max(ACK_MAX_ID_CHARS).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters'),
    ok: z.boolean(),
    /**
     * OPEN, deliberately — see the W29 note above. It is bounded and
     * control-character-free, not closed: the frame's job is to answer a
     * question the router phrases, and the router's vocabulary is not this
     * module's to enumerate.
     */
    detail: z
      .string()
      .max(ACK_MAX_DETAIL_CHARS)
      .refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters')
      .optional(),
  })
  // `.strict()` for the reason `ErrorFrameSchema` gives: every ack is built by
  // `buildAckFrame`, so an unexpected key can only mean the constructor and the
  // schema have diverged, which must throw at the producer rather than ship a
  // frame the client has no branch for. (That comment used to say the opposite
  // of this about `ack` — correctly, while `ack` had no constructor.)
  .strict();

/**
 * The BRANDED frame. A `z.infer` type would let any object literal stand in for
 * an ack, which is how the inline literal in `dispatchCommand` came to exist;
 * the brand makes "was this built by `buildAckFrame`" a question the compiler
 * answers. There is no runtime representation — see the cast in the builder.
 */
declare const ACK_FRAME_BRAND: unique symbol;
export type AckFrame = z.infer<typeof AckFrameSchema> & { readonly [ACK_FRAME_BRAND]: true };

/**
 * Producer-side input. `detail` is an OPEN `string` on purpose: this is the
 * UNTRUSTED side of the boundary, and typing it as a scrubbed brand would only
 * move the same obligation one call site up. The obligation is met inside.
 */
export interface AckOutcomeInput {
  readonly ok: boolean;
  readonly detail?: string;
}

/** What a truncated detail says about what it dropped, and by how much. */
function truncationMarker(dropped: number): string {
  return `…(+${dropped} chars)`;
}

/**
 * Producer-side constructor — the single function every `ack` frame passes
 * through, and the redaction SINK for this frame type.
 *
 * `.parse`, not `.safeParse`, for `buildErrorFrame`'s reason: a swallowed
 * failure would emit a frame nothing validates and a re-thrown one would escape
 * a `void`-ed promise. It cannot throw for any input this function admits,
 * because `detail` is sanitised before the parse rather than after it:
 *
 *   1. `redactString` — the sink. Idempotent on its own `[REDACTED]`, so a
 *      producer that pre-redacts is not double-processed. It runs FIRST because
 *      `[REDACTED]` is longer than the secret it replaces, so redaction after
 *      the cap could push an already-at-cap detail past `ACK_MAX_DETAIL_CHARS`
 *      and throw. `buildOutputFrame` documents the same ordering for the same
 *      reason.
 *   2. Control characters become SPACES. Not rejected: `parse` rejecting here
 *      would throw inside `dispatchCommand`, which `onData` calls as
 *      `void` — an unhandled rejection, i.e. a dead daemon, in exchange for a
 *      detail string that is never useful. A newline is a HUD-forging hazard,
 *      not information, so it is neutralised rather than preserved. The
 *      schema's own `refine` still REJECTS one, so a caller reaching
 *      `AckFrameSchema.parse` directly gets a refusal instead of a silent pass.
 *   3. Truncation keeps a PREFIX and names the loss (`…(+N chars)`), because a
 *      silent trim is the `INVENTORY_MAX_SESSIONS` defect class `totalSessions`
 *      was added to fix. If a trailing high surrogate would be orphaned by the
 *      cut it is dropped, so the frame never carries half a code unit.
 *   4. `parse` then validates — and it cannot fail on 1–3's output.
 *
 * `id` is the one field not sanitised, deliberately: an id is a correlation
 * token, so mangling it would break the pairing with the shell's own pending
 * map. A control character in one is a forgery attempt and the `refine` throws.
 *
 * BYTE-IDENTICAL for every value the pre-W29 code could emit, and that was
 * measured rather than assumed — SHA-256 of the JSON and of the full RFC 6455
 * frame, key order and frame length, captured before the edit and re-verified
 * after (`src/ipc/ack-frame.test.ts` pins the exact bytes). `ack` carries no
 * `seq`, is not retained for resume, and zod rebuilds the object in SHAPE
 * ORDER, which is `type, id, ok, detail` — the order the old literal used.
 */
export function buildAckFrame(id: string, outcome: AckOutcomeInput): AckFrame {
  const detail =
    outcome.detail === undefined
      ? undefined
      : boundAckDetail(redactString(outcome.detail).replace(CONTROL_CHARS_GLOBAL_RE, ' '));
  return AckFrameSchema.parse({
    type: ACK_KIND,
    id,
    ok: outcome.ok,
    ...(detail !== undefined ? { detail } : {}),
    // The brand. `parse` returns a plain `z.infer` value, and this cast is the
    // only way to add the marker — which is precisely the point: the marker is
    // unobtainable by any route except this function.
  }) as AckFrame;
}

/**
 * Keep a prefix that fits the cap and say how much did not. Exported for the
 * test that pins the marker; not exported for reuse.
 */
function boundAckDetail(detail: string): string {
  if (detail.length <= ACK_MAX_DETAIL_CHARS) return detail;
  const marker = truncationMarker(detail.length - ACK_MAX_DETAIL_CHARS);
  const keep = ACK_MAX_DETAIL_CHARS - marker.length;
  let head = detail.slice(0, keep);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // orphaned high surrogate
  return head + marker;
}

// --- Error stream: a PROTOCOL fault the shell could not have avoided.
// W28. This frame had NO schema at all: it was emitted as three inline object
// literals in `UiServer.onData`, so nothing parsed it, nothing bounded it, and a
// typo in one of the three was invisible to every gate. Eleven wire types, ten
// of them schema-validated; this was the eleventh.
//
// DELIBERATELY NOT `ack`'s PRECEDENT, AND `ack` IS ITS SIBLING HERE.
// `AckFrameSchema` was declared and exported and `.parse`d NOWHERE in the tree
// (the dossier's F1) — a schema nothing ever applies, i.e. this defect one level
// down. `error` therefore got what `ack` never got: a producer-side constructor
// every emit site is forced through, so the parse is on the only production path
// rather than only in a test. W29 gave `ack` that same constructor; the two
// siblings now differ only in what `detail` may CONTAIN, never in whether
// anything checks it. `ack`'s REDACTION handling, by contrast, IS worth
// inheriting — except that here it is redundant, and the comment says why.
//
// `detail` IS A CLOSED 3-MEMBER ENUM, NOT AN OPEN STRING. `ack.detail` is open and
// safe only by convention; `dispatchCommand` already forwards a raw `err.message`
// through it, one branch away from reaching a client. This frame must not inherit
// that. An `error` frame is the channel a future contributor reaches for when
// something fails, and the obvious next edit is `detail: err.message` — which is
// how provider text would enter a frame that today carries none. Making `detail`
// a union makes that edit a COMPILE ERROR and, if forced with a cast, a throw
// inside `parse`. Provider failure text has a channel already, and it is `notice`
// (`code` + Arabic `detail`, redacted at `UiServer.notice()`); a protocol-fault
// frame is a different job and does not need free text to do it.
//
// CONSEQUENCE, STATED RATHER THAN DISCOVERED LATER: widening this enum is the
// deliberate, reviewed act that a free-text `error.detail` would have been an
// accident of. Whoever widens it inherits this comment.
export const ERROR_DETAILS = {
  /** Binary uplink frame over `MAX_AUDIO_BYTES` (`ui-server.ts` `onData`). */
  audioTooLarge: 'audio frame too large',
  /** A TEXT frame whose payload is not parseable JSON (`onData`). */
  invalidJson: 'invalid JSON',
  /** Valid JSON that fails `UiCommandSchema` (`onData`). */
  unknownCommand: 'unknown command',
} as const;
/** The complete `error.detail` domain. The type AND the runtime enum read this. */
export type ErrorDetail = (typeof ERROR_DETAILS)[keyof typeof ERROR_DETAILS];

export const ErrorFrameSchema = z
  .object({
    type: z.literal(ERROR_KIND),
    /**
     * `.strict()` here for the reason it is `.strict()` on every other frame in
     * this file: the frames are built by a constructor and nowhere else, so an
     * unexpected key can only mean the constructor and the schema have diverged
     * — which should throw at the producer, not ship a frame the client has no
     * branch for. (This comment used to contrast `error` with `ack` by saying
     * `ack` is not strict; W29 gave `ack` a constructor, so it now is.)
     */
    detail: z.enum([
      ERROR_DETAILS.audioTooLarge,
      ERROR_DETAILS.invalidJson,
      ERROR_DETAILS.unknownCommand,
    ]),
  })
  .strict();
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

/**
 * Producer-side constructor — the single function every `error` frame passes
 * through, which is what makes the schema load-bearing rather than decorative.
 *
 * `.parse`, not `.safeParse`: this runs inside `onData`, i.e. a raw socket
 * `data` handler, where a swallowed parse failure would emit a malformed frame
 * and a re-thrown one would escape into an EventEmitter listener. It cannot
 * throw on any call the type admits — `detail` is a member of the enum the
 * schema checks — so the choice is between failing loudly on an unrepresentable
 * input and emitting a frame nothing validates. Same posture as
 * `buildOutputFrame`.
 *
 * BYTE-COMPATIBLE WITH THE THREE PRE-W28 LITERALS, and that was measured rather
 * than assumed: the emitted JSON is `{"type":"error","detail":"<d>"}` with the
 * keys in that order and no `seq`, `id` or `ok`, exactly as before. `error` is
 * NOT in the retained resume window and is NOT sequenced, so the renderer's
 * branch at `ws.ts` (which reads `detail` only and does not advance `lastSeq`)
 * is unaffected. `detail` is a literal, so no cap or bound can fire on it; the
 * `z.enum` is the whole bound.
 */
export function buildErrorFrame(detail: ErrorDetail): ErrorFrame {
  return ErrorFrameSchema.parse({ type: ERROR_KIND, detail });
}

// --- Inventory stream (Phase 2b): level-triggered session snapshot.
// Shares the server seq space with UiEvent so Last-Seq resume stays ordered.
// sessions:[] is the error/unready shape — clients render active-only.
export const InventorySessionSchema = z.object({
  sessionId: z.string().min(1),
  state: z.string().min(1),
});

/**
 * M3 B.2a: hard cap on one outbound inventory snapshot. The daemon publishes
 * every session it can enumerate, so a long-lived or multi-project workspace
 * made the frame, the JSON, and the retained `lastInventory` copy grow with
 * the session list rather than with anything the shell can display. The cap is
 * on the SCHEMA, not only the producer, so 201 entries are rejected wherever
 * they come from instead of being trimmed by one call site.
 */
export const INVENTORY_MAX_SESSIONS = 200;

export const InventoryFrameSchema = z.object({
  type: z.literal('inventory'),
  seq: z.number().int().nonnegative(),
  sessions: z.array(InventorySessionSchema).max(INVENTORY_MAX_SESSIONS),
  /**
   * Total sessions the producer held, present ONLY when the snapshot was
   * truncated. A shell that renders 200 rows with no count has been told less
   * than it needs; a silent trim would look identical to a 200-session
   * workspace, which is the same "asserts nothing is missing" defect class as
   * `layaReady: true`. Additive and optional: an older shell ignores it, and a
   * frame without it simply means the snapshot was complete.
   */
  totalSessions: z.number().int().nonnegative().optional(),
});
export type InventoryFrame = z.infer<typeof InventoryFrameSchema>;

/**
 * Producer-side constructor — throws on malformed input (fail-fast, never on the wire).
 *
 * FIRST `INVENTORY_MAX_SESSIONS`, in producer order: not a random sample, not a
 * sort, and not the LAST N. The producer's own order is the daemon's inventory
 * order, so keeping the head keeps the sessions it already considered
 * front-of-house; taking the tail would silently change which ones a user
 * sees, and sorting would make the frame order differ from every other call
 * site that iterates the same list.
 */
export function buildInventoryFrame(
  seq: number,
  sessions: ReadonlyArray<{ sessionId: string; state: string }>,
): InventoryFrame {
  const truncated = sessions.length > INVENTORY_MAX_SESSIONS;
  const kept = truncated ? sessions.slice(0, INVENTORY_MAX_SESSIONS) : [...sessions];
  return InventoryFrameSchema.parse({
    type: 'inventory',
    seq,
    sessions: kept,
    ...(truncated ? { totalSessions: sessions.length } : {}),
  });
}

// --- Agents stream (final polish): level-triggered discovered-agent snapshot.
export const AgentEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const AgentFrameSchema = z.object({
  type: z.literal('agents'),
  seq: z.number().int().nonnegative(),
  agents: z.array(AgentEntrySchema),
});
export type AgentFrame = z.infer<typeof AgentFrameSchema>;
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

export function buildAgentFrame(seq: number, agents: ReadonlyArray<{ id: string; name: string }>): AgentFrame {
  return AgentFrameSchema.parse({ type: 'agents', seq, agents: [...agents] });
}

// --- Notice stream: recoverable problems + first-run guidance. Additive; old
// shells ignore unknown frame types, so this never breaks the contract.
export const NoticeFrameSchema = z.object({
  type: z.literal('notice'),
  seq: z.number().int().nonnegative(),
  /** Machine-readable code (e.g. 'voice-disabled-no-keys', 'stt-failed'). */
  code: z.string().min(1),
  /** Arabic, human-readable. Never key material. */
  detail: z.string().min(1),
  level: z.enum(['info', 'warn', 'error']),
});
export type NoticeFrame = z.infer<typeof NoticeFrameSchema>;

// --- Voice phase stream: drives the listening/thinking/speaking HUD states.
export const VoicePhaseSchema = z.enum(['idle', 'listening', 'thinking', 'speaking']);
export type VoicePhase = z.infer<typeof VoicePhaseSchema>;

export const VoiceFrameSchema = z.object({
  type: z.literal('voice'),
  seq: z.number().int().nonnegative(),
  phase: VoicePhaseSchema,
  /** Last transcript/reply (display only; never a control path). */
  transcript: z.string().optional(),
});
export type VoiceFrame = z.infer<typeof VoiceFrameSchema>;

// --- Context window telemetry (Phase 4). ADDITIVE: an older shell ignores an
// unknown frame type, so this cannot break a deployed client.
export const ContextFrameSchema = z.object({
  type: z.literal('context'),
  seq: z.number().int().nonnegative(),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/),
  /** Tokens currently occupying the window (not lifetime spend). */
  used: z.number().int().nonnegative(),
  /** The model's context window, or null when unknown. */
  limit: z.number().int().positive().nullable(),
  /** 0..100, or null when the limit is unknown. Never guessed. */
  percent: z.number().min(0).max(100).nullable(),
  messageCount: z.number().int().nonnegative(),
});
export type ContextFrame = z.infer<typeof ContextFrameSchema>;

// --- Flow control (M3 B.3): backpressure watermarks. ADDITIVE, like every other
// frame here: an older shell has no `flow` branch and ignores the type, and a
// newer shell against an older daemon simply never receives one — which is
// exactly the pre-B.3 behaviour, so the pair degrades to "no backpressure"
// rather than to "no audio".
//
// It carries a `seq` and nothing else. Deliberately NOT a request/response: the
// shell is not asked to confirm, cannot refuse, and has no way to satisfy the
// daemon except by obeying. Anything richer (a credit count, an ack) would be a
// protocol the two halves can disagree about, and the one property that matters
// — does the accumulator still hold what it was holding — is already known on
// both sides.
export const FlowFrameSchema = z.object({
  type: z.literal('flow'),
  seq: z.number().int().nonnegative(),
  state: z.enum(['pause', 'resume']),
});
export type FlowFrame = z.infer<typeof FlowFrameSchema>;
export type FlowState = FlowFrame['state'];

// --- Shell output stream (Phase 1 of the agentic bridge).
//
// ADDITIVE, like every frame above: an older shell has no `output` branch and
// ignores the type, and a NEW shell against an OLDER daemon simply never
// receives one — which is exactly the pre-Phase-1 behaviour. Neither half can
// crash on the other.
//
// THE ENDPOINT DOES NOT STREAM. Measured live against opencode 1.18.32 on
// 2026-09-30, `POST /session/{id}/shell` (v1 — the ONLY route that exists; the
// `/api/session/{id}/shell` path this repo used was never a route at all, see
// `ServeClient.execSessionShell`):
//
//   command                     HTTP  t_firstbyte  t_end   tool state
//   --------------------------  ----  -----------  ------  -----------
//   echo hi                       200       1348 ms  1348 ms  completed
//   exit 3                        200        249 ms   249 ms  completed  <- output ""
//   <nonexistent binary>          200        359 ms   359 ms  completed  <- PS error text
//   node -e 'x'.repeat(20000)    200        554 ms   554 ms  completed  <- 40884 B body
//   ping -n 8 127.0.0.1           200       7384 ms  7384 ms  completed
//
// `transfer-encoding: null` and `t_firstbyte == t_headers == t_end` on every
// probe: it COMPLETES THEN RETURNS, it does not stream, and it BLOCKS until the
// command is done (a 7 s ping took 7.4 s). So this frame is a SUMMARY ON
// COMPLETION. There is no partial-output path to build and no `delta` field to
// be tempted into faking.
//
// Two measured facts shape every field below, and both were invisible while the
// response was discarded and `{ ok: true }` fabricated:
//
//  1. `ToolStateCompleted` in serve's own OpenAPI has NO exit code — measured
//     against the live `/doc` spec, every tool-state variant is
//     `{status, input, output|error, title, metadata, time}` and none carries
//     one. `exit 3` comes back `status: "completed"` with `output: ""`. So a
//     failed command is INDISTINGUISHABLE from a silent success, by the server
//     itself, forever. `exitCode` is therefore `null` in practice, and
//     `outcome` is `unknown` for anything serve did not flag as an error. A
//     frame that reported `ok` here would be a lie with a schema on it.
//  2. The response is UNBOUNDED — 20 000 chars of output produced a 40 884-byte
//     body with no truncation. `cat` on a large file would produce megabytes on
//     the wire and in the retained resume window. Hence the cap below.

/**
 * Cumulative per-MESSAGE cap on one assembled `output` frame's text, enforced
 * BEFORE a fragment is stored. The same class of bound as `MAX_MESSAGE_BYTES`,
 * for the same reason: a security audit found `FrameReassembler` accumulated
 * `pendingParts` with no running total and then did one `Buffer.concat`, so a
 * peer could send N continuation frames just under 1 MiB each and the assembled
 * message grew to the sum — the effective limit was the peer's patience, not
 * the constant. `OutputAssembler` is that same accumulator, on the daemon's own
 * output stream, so the fix is not a one-caller special case.
 *
 * 32 KiB, not 1 MiB, and the number is not arbitrary in the way it looks:
 * `RESUME_BUFFER_MAX_BYTES` (ui-server.ts) is 64 KiB and the resume window
 * evicts OLDEST-FIRST to stay under it. An output frame larger than half that
 * budget would evict the whole buffer INCLUDING ITSELF, so a shell that
 * reconnected could never be shown the result of the command it just ran — a
 * silent hole of exactly the `layaReady: true` kind. At 32 KiB the newest
 * output frame always fits and at least one is always replayable; two
 * max-size frames do not, which is the accepted trade and is pinned by a test.
 */
export const MAX_OUTPUT_TEXT_BYTES = 32 * 1024;
/** Matches `UiCommandSchema.command`, so an echoed command is always legal. */
export const OUTPUT_MAX_COMMAND_CHARS = 512;
/** Correlation token for the `execSessionShell` command that caused this. */
export const OUTPUT_MAX_COMMAND_ID_CHARS = 128;

/**
 * Verbatim serve-side tool state, normalised.
 *
 * MEASURED values on 1.18.32: `completed` for a command that succeeded, a
 * command that exited 3, AND a command that did not exist. `error` is in the
 * serve schema (`ToolStateError`) and is the only value that means "failed"
 * today. `pending`/`running` are in the schema and are reachable if a future
 * serve answers before the tool settles. `unknown` is OURS: the 200 carried no
 * tool part, so we say we do not know rather than defaulting to a success.
 */
export const ShellOutputStatusSchema = z.enum(['completed', 'error', 'pending', 'running', 'unknown']);

/**
 * What can honestly be concluded about the command.
 *
 * `unknown` is the common case and it is the whole point: serve reports no exit
 * code, so a completed tool call proves only that the tool ran. Deriving `ok`
 * from `status: 'completed'` is precisely the fabricated `{ ok: true }` this
 * frame exists to replace — it would be a lie wearing a zod schema.
 */
export const ShellOutputOutcomeSchema = z.enum(['ok', 'failed', 'unknown']);

/**
 * Derive the outcome from ONLY what serve reported. Exported so the client and
 * the frame builder cannot disagree — two derivations of the same judgement is
 * how a frame and a log start telling different stories.
 */
export function deriveShellOutcome(
  status: z.infer<typeof ShellOutputStatusSchema>,
  exitCode: number | null,
): z.infer<typeof ShellOutputOutcomeSchema> {
  if (status === 'error') return 'failed';
  if (exitCode !== null) return exitCode === 0 ? 'ok' : 'failed';
  // MEASURED: no exit code exists. `completed` is not `ok`.
  return 'unknown';
}

/**
 * Cumulative output accumulator — the `FrameReassembler` cap, on a stream the
 * daemon produces rather than a peer sends.
 *
 * THE ORDER IS THE WHOLE POINT: `push` consults the running total BEFORE the
 * fragment is retained, exactly as `FrameReassembler.accountFor` does before
 * `pendingParts.push`. Capping at `text()` time instead would still have
 * stored — and therefore allocated — every oversized fragment, so the bound
 * would hold only after the memory was already spent. `bytes` is therefore
 * INVARIANTLY <= `MAX_OUTPUT_TEXT_BYTES`, which is the property the test
 * asserts and the property a moved check would break.
 *
 * Unlike the frame path this does NOT throw. An over-cap output is the
 * DAEMON's condition, not a peer protocol violation, and `WsProtocolError`
 * means "destroy the connection" — a shell that ran `cat bigfile` must not
 * lose its socket. The overflow is reported instead: `truncated` and
 * `droppedBytes` ride the frame, so a shell is told it is seeing partial
 * output. A silent trim is the `INVENTORY_MAX_SESSIONS` defect class that
 * `totalSessions` was added to fix.
 */
export class OutputAssembler {
  private readonly parts: Uint8Array[] = [];
  private storedBytes = 0;
  private droppedBytes = 0;

  /** Bytes actually STORED. Never exceeds `MAX_OUTPUT_TEXT_BYTES`. */
  get bytes(): number {
    return this.storedBytes;
  }

  /** Bytes refused by the cumulative cap, across every rejected fragment. */
  get dropped(): number {
    return this.droppedBytes;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  /** Store a fragment, or refuse it. Returns whether it was kept. */
  push(fragment: Uint8Array): boolean {
    const n = fragment.byteLength;
    // Cap FIRST. Nothing is retained past the limit, so `storedBytes` cannot
    // drift over it no matter how many fragments arrive.
    if (this.storedBytes + n > MAX_OUTPUT_TEXT_BYTES) {
      this.droppedBytes += n;
      return false;
    }
    this.storedBytes += n;
    this.parts.push(fragment);
    return true;
  }

  /** Convenience for the streaming case. Same all-or-nothing contract. */
  pushText(text: string): boolean {
    return this.push(Buffer.from(text, 'utf8'));
  }

  /**
   * Store as much of `text` as fits and drop the remainder. Returns the bytes
   * kept.
   *
   * WHY THIS EXISTS, and it is not redundancy. `push` is deliberately
   * all-or-nothing because the streaming case is a tail: by the time a fragment
   * arrives the earlier bytes are already the prefix, and refusing the whole
   * fragment loses nothing. The SINGLE-SHOT case is different, and the first
   * version of this class got it wrong in a way its own test caught: the whole
   * output arrives as ONE oversized fragment, `push` refused it, and the frame
   * went out carrying `output: ''` with `truncated: true` and `outputBytes:
   * 37 KiB` — honest, and completely useless. A caller whose command printed a
   * megabyte would be shown nothing at all.
   *
   * The accounting is unchanged and still pre-storage: `kept` is computed
   * BEFORE anything is retained, and it is `min(n, cap - stored)`, so
   * `storedBytes` still cannot exceed the cap and the dropped tail is still
   * counted rather than silently discarded.
   */
  pushPrefixText(text: string): number {
    const buf = Buffer.from(text, 'utf8');
    const room = MAX_OUTPUT_TEXT_BYTES - this.storedBytes;
    if (room <= 0) {
      this.droppedBytes += buf.byteLength;
      return 0;
    }
    if (buf.byteLength <= room) {
      this.storedBytes += buf.byteLength;
      this.parts.push(buf);
      return buf.byteLength;
    }
    this.parts.push(buf.subarray(0, room));
    this.storedBytes = MAX_OUTPUT_TEXT_BYTES;
    this.droppedBytes += buf.byteLength - room;
    return room;
  }

  /** The stored prefix. Bounded by the cap; may cut a multi-byte char. */
  text(): string {
    if (this.parts.length === 0) return '';
    return Buffer.concat(this.parts.map((p) => Buffer.from(p))).toString('utf8');
  }

  /** Drop everything. The `discardPending` analogue — counters MUST go too. */
  reset(): void {
    this.parts.length = 0;
    this.storedBytes = 0;
    this.droppedBytes = 0;
  }
}

/**
 * The `output` frame. `seq` is REQUIRED on the wire so a retained copy can be
 * replayed through the same `seq > lastSeq` filter as every other frame — a
 * shell must be able to order a command's result against the events around it.
 */
export const OutputFrameSchema = z.object({
  type: z.literal(OUTPUT_KIND),
  seq: z.number().int().nonnegative(),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]{1,120}$/),
  /** The `execSessionShell` command id, so a shell can match result to spinner. */
  commandId: z.string().min(1).max(OUTPUT_MAX_COMMAND_ID_CHARS).refine((v) => !CONTROL_CHARS_RE.test(v), 'control characters'),
  command: z.string().max(OUTPUT_MAX_COMMAND_CHARS),
  status: ShellOutputStatusSchema,
  outcome: ShellOutputOutcomeSchema,
  /**
   * The command's own exit code, or null. Null is the MEASURED case: serve has
   * no such field (see `ToolStateCompleted` above). It is carried anyway so a
   * future serve has a home for it — and so a shell can read "no exit code"
   * rather than inferring 0.
   */
  exitCode: z.number().int().nullable(),
  /** CAPPED, tail-truncated text. See `MAX_OUTPUT_TEXT_BYTES`. */
  output: z
    .string()
    // BYTES, not zod's `.max()` units. `.max()` counts UTF-16 code units, so a
    // 32 KiB cap there would admit 128 KiB of Arabic/CJK (2 or 3 bytes per
    // unit) and quietly blow the budget. The assembler already enforces bytes;
    // this is the boundary check that makes a producer which bypasses it fail
    // loudly instead of shipping an over-cap frame.
    .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_OUTPUT_TEXT_BYTES, 'output exceeds MAX_OUTPUT_TEXT_BYTES'),
  /** Byte length of the output BEFORE the cap. `output` alone under-reports. */
  outputBytes: z.number().int().nonnegative(),
  /** Bytes refused by the cumulative cap. 0 unless `truncated`. */
  droppedBytes: z.number().int().nonnegative(),
  /** True when `output` is NOT the whole story. Never set silently. */
  truncated: z.boolean(),
  /** Wall time the command took, or null when serve reported no timing. */
  durationMs: z.number().int().nonnegative().nullable(),
});
export type OutputFrame = z.infer<typeof OutputFrameSchema>;

/** Producer-side input: everything except the seq the server assigns. */
export interface OutputFrameInput {
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: string;
  readonly status: z.infer<typeof ShellOutputStatusSchema>;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number | null;
}

/**
 * Producer-side constructor — throws on malformed input (fail-fast, never on
 * the wire), and runs `output` through the SAME `OutputAssembler` the
 * streaming path uses.
 *
 * That last part is deliberate: it means the cumulative cap is on the only
 * production path, not on a test-only one. A cap reachable only from a test
 * proves nothing about the producer, and a cap the producer can skip is not a
 * cap. `buildOutputFrame` therefore cannot emit a frame the cap would have
 * rejected, and cannot emit an over-cap one either.
 *
 * ── REDACTION, AT THIS SINK AND NOT AT THE CALL SITE ──────────────────────
 *
 * `output` carries up to 32 KiB (`MAX_OUTPUT_TEXT_BYTES`) of UNBOUNDED shell
 * stdout, and `command` carries the shell command line. Both are free text off
 * a subprocess: `cat .env.local`, `env`, a failing `npm config list`, or a
 * `curl` whose header is echoed in an error all put live credentials into that
 * string. The frame then goes to the renderer AND into the retained resume
 * window, so a leak here is both immediate and replayable.
 *
 * This was the one frame type with NO redaction anywhere: `notice`, `voice`
 * and `ack.detail` were each scrubbed, and `protocol.ts` had zero `redact`
 * matches. The gap is not the call sites — `UiServer.output()` and
 * `shell-tasks.ts` both build through here — it is that the frame had no sink.
 *
 * The sink is HERE, in the one function every `output` frame must pass through,
 * so a future producer gets redaction for free. Wrapping `UiServer.output()`
 * instead would leave `buildOutputFrame` reachable unscrubbed, and the barrel
 * exports it.
 *
 * ORDER: redaction runs BEFORE the assembler, and that is load-bearing rather
 * than stylistic. `[REDACTED]` is 10 bytes, so redacting after the cap could
 * GROW an already-at-cap string past `MAX_OUTPUT_TEXT_BYTES` and throw inside
 * `OutputFrameSchema.parse` — a redaction that takes down the producer. The
 * consequence, stated plainly: `outputBytes` is the byte length of the REDACTED
 * text, not of the raw stdout. That is also the safer direction to be wrong in,
 * since reporting the raw length would leak the length of the secret removed.
 *
 * `redactString` is idempotent on its own marker, so a producer that
 * pre-redacts is not double-processed, and a pre-redacted `output` is already
 * covered by the assembler's byte accounting.
 */
export function buildOutputFrame(seq: number, input: OutputFrameInput): OutputFrame {
  const asm = new OutputAssembler();
  const safeOutput = redactString(input.output);
  const safeCommand = redactString(input.command);
  // `pushPrefixText`, not `pushText`: a single-shot producer already holds the
  // whole string, and all-or-nothing would ship an EMPTY output for every
  // command that printed more than the cap. The single-shot case keeps a
  // prefix; the streaming case (`push`) refuses the fragment. See
  // `OutputAssembler.pushPrefixText` for why both exist.
  asm.pushPrefixText(safeOutput);
  const outputBytes = Buffer.byteLength(safeOutput, 'utf8');
  return OutputFrameSchema.parse({
    type: OUTPUT_KIND,
    seq,
    sessionId: input.sessionId,
    commandId: input.commandId,
    command: safeCommand,
    status: input.status,
    outcome: deriveShellOutcome(input.status, input.exitCode),
    exitCode: input.exitCode,
    output: asm.text(),
    outputBytes,
    droppedBytes: asm.dropped,
    truncated: asm.truncated,
    durationMs: input.durationMs,
  });
}
