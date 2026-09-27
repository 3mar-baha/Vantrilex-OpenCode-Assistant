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
export const RESUME_BUFFER_CAP = 256;
/** Hard inbound message cap — a single frame may never exceed this. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
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
      pendingParts.push(payload);
      if (fin) {
        frames.push({ fin: true, opcode: pendingOpcode, payload: Buffer.concat(pendingParts) });
        pendingOpcode = null;
        pendingParts.length = 0;
      }
      continue;
    }
    if (opcode === Opcode.Text || opcode === Opcode.Binary) {
      if (!fin) {
        pendingOpcode = opcode;
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
 * connection (fail-closed, no unbounded buffering).
 */
export class FrameReassembler {
  private buffer = Buffer.alloc(0);
  private pendingOpcode: Opcode | null = null;
  private readonly pendingParts: Uint8Array[] = [];

  push(chunk: Uint8Array): WsFrame[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
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
        this.pendingParts.push(payload);
        if (header.fin) {
          frames.push({ fin: true, opcode: this.pendingOpcode, payload: Buffer.concat(this.pendingParts) });
          this.pendingOpcode = null;
          this.pendingParts.length = 0;
        }
        continue;
      }
      if (header.opcode === Opcode.Text || header.opcode === Opcode.Binary) {
        if (!header.fin) {
          this.pendingOpcode = header.opcode;
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

export const InventoryFrameSchema = z.object({
  type: z.literal('inventory'),
  seq: z.number().int().nonnegative(),
  sessions: z.array(InventorySessionSchema),
});
export type InventoryFrame = z.infer<typeof InventoryFrameSchema>;

/** Producer-side constructor — throws on malformed input (fail-fast, never on the wire). */
export function buildInventoryFrame(
  seq: number,
  sessions: ReadonlyArray<{ sessionId: string; state: string }>,
): InventoryFrame {
  return InventoryFrameSchema.parse({ type: 'inventory', seq, sessions: [...sessions] });
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
