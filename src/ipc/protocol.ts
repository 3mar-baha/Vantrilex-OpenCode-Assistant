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

/** Test helper — build a masked client frame (browsers always mask, §5.3). */
export function maskFrame(opcode: Opcode, payload: Buffer, mask: Buffer, fin = true): Buffer {
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

// --- Versioned frames (zod boundaries) ---

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

export const UiCommandSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['abort', 'mute', 'deafen', 'arm', 'setPersona']),
  persona: z.enum(['kareem', 'nour']).optional(),
  minutes: z.number().int().positive().optional(),
});
export type UiCommand = z.infer<typeof UiCommandSchema>;

export const AckFrameSchema = z.object({
  type: z.literal(ACK_KIND),
  id: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().optional(),
});
