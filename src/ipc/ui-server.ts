import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ACK_KIND,
  decodeFrames,
  encodeTextFrame,
  ERROR_KIND,
  HelloFrameSchema,
  IPC_TOKEN_ENV,
  MISSED_PINGS_LIMIT,
  Opcode,
  PING_INTERVAL_MS,
  RESUME_BUFFER_CAP,
  SERVE_PORT,
  UiCommandSchema,
  UI_SUBPROTOCOL,
  UI_WS_PATH,
  type HelloFrame,
  type UiCommand,
  type UiEvent,
} from './protocol.js';

// Voxaura UI bridge — ADR-010. Zero-dependency RFC 6455 server on
// 127.0.0.1:4097. Fail-closed: no token → the server refuses to start;
// wrong/missing bearer → 401, never upgraded. The daemon owns `seq`.
export interface UiServerOptions {
  readonly token: string;
  readonly contractVersion: string;
  readonly port?: number;
  readonly pingIntervalMs?: number;
}

interface Conn {
  socket: Duplex;
  buffer: Buffer;
  missedPongs: number;
}

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

export class UiServer {
  onCommand: ((cmd: UiCommand) => void) | null = null;
  private readonly token: string;
  private readonly contractVersion: string;
  private readonly pingIntervalMs: number;
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private seq = 0;
  private readonly resume: UiEvent[] = [];
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(options: UiServerOptions) {
    if (options.token.length === 0) {
      throw new Error(`refusing to start: ${IPC_TOKEN_ENV} is empty (fail-closed)`);
    }
    this.token = options.token;
    this.contractVersion = options.contractVersion;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Start on 127.0.0.1. `port: 0` binds an ephemeral port (tests). Resolves the bound port. */
  async start(port: number): Promise<number> {
    this.server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    await new Promise<void>((resolve) => {
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    const bound = typeof addr === 'object' && addr !== null ? addr.port : port;
    this.pingTimer = setInterval(() => this.pingAll(), this.pingIntervalMs);
    this.pingTimer.unref();
    return bound;
  }

  /** Assign the next seq, retain for Last-Seq resume, fan out to all sockets. */
  broadcast(input: Omit<UiEvent, 'type' | 'seq'> & { type?: 'event' }): UiEvent {
    this.seq += 1;
    const frame: UiEvent = { type: 'event', seq: this.seq, eventId: input.eventId, state: input.state };
    this.resume.push(frame);
    if (this.resume.length > RESUME_BUFFER_CAP) this.resume.shift();
    const wire = encodeTextFrame(JSON.stringify(frame));
    for (const conn of this.conns) {
      if (!conn.socket.destroyed) conn.socket.write(wire);
    }
    return frame;
  }

  async close(): Promise<void> {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const conn of this.conns) {
      try {
        conn.socket.write(encodeTextFrame(''));
      } catch {
        // best-effort close frame; destroy below regardless
      }
      conn.socket.destroy();
    }
    this.conns.clear();
    if (this.server !== null) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  private bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const presented = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(this.token);
    return presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const proto = req.headers['sec-websocket-protocol'];
    const wants = typeof proto === 'string' ? proto.split(',').map((s) => s.trim()) : [];
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (req.url !== UI_WS_PATH || typeof key !== 'string' || version !== '13' || !wants.includes(UI_SUBPROTOCOL)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.bearerOk(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${wsAccept(key)}`,
        `Sec-WebSocket-Protocol: ${UI_SUBPROTOCOL}`,
        '',
        '',
      ].join('\r\n'),
      'utf8',
    );
    const conn: Conn = { socket, buffer: Buffer.alloc(0), missedPongs: 0 };
    this.conns.add(conn);
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk));
    socket.on('close', () => void this.conns.delete(conn));
    socket.on('error', () => void this.conns.delete(conn));

    const hello: HelloFrame = HelloFrameSchema.parse({
      type: 'hello',
      contractVersion: this.contractVersion,
      nodePid: process.pid,
      servePort: SERVE_PORT,
      layaReady: true,
      seq: this.seq,
    });
    socket.write(encodeTextFrame(JSON.stringify(hello)));

    const lastSeqRaw = req.headers['last-seq'];
    const lastSeq = typeof lastSeqRaw === 'string' ? Number.parseInt(lastSeqRaw, 10) : Number.NaN;
    if (Number.isInteger(lastSeq) && lastSeq >= 0 && lastSeq < this.seq) {
      for (const frame of this.resume) {
        if (frame.seq > lastSeq) socket.write(encodeTextFrame(JSON.stringify(frame)));
      }
    }
  }

  private onData(conn: Conn, chunk: Buffer): void {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    const { frames, remaining } = decodeFrames(conn.buffer);
    conn.buffer = Buffer.from(remaining);
    for (const frame of frames) {
      if (frame.opcode === Opcode.Close) {
        conn.socket.destroy();
        this.conns.delete(conn);
        return;
      }
      if (frame.opcode === Opcode.Ping) {
        const pong = Buffer.alloc(frame.payload.byteLength + 2);
        pong[0] = 0x8a;
        pong[1] = frame.payload.byteLength;
        Buffer.from(frame.payload).copy(pong, 2);
        conn.socket.write(pong);
        continue;
      }
      if (frame.opcode === Opcode.Pong) {
        conn.missedPongs = 0;
        continue;
      }
      if (frame.opcode !== Opcode.Text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(frame.payload).toString('utf8'));
      } catch {
        conn.socket.write(encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'invalid JSON' })));
        continue;
      }
      const cmd = UiCommandSchema.safeParse(parsed);
      if (!cmd.success) {
        conn.socket.write(encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'unknown command' })));
        continue;
      }
      this.onCommand?.(cmd.data);
      conn.socket.write(encodeTextFrame(JSON.stringify({ type: ACK_KIND, id: cmd.data.id, ok: true })));
    }
  }

  private pingAll(): void {
    for (const conn of [...this.conns]) {
      if (conn.socket.destroyed) {
        this.conns.delete(conn);
        continue;
      }
      conn.missedPongs += 1;
      if (conn.missedPongs > MISSED_PINGS_LIMIT) {
        conn.socket.destroy();
        this.conns.delete(conn);
        continue;
      }
      conn.socket.write(Buffer.from([0x89, 0x00])); // ping, empty payload
    }
  }
}
