import { z } from 'zod';

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

export const AckFrameSchema = z.object({
  type: z.literal(ACK_KIND),
  id: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional(),
});

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
