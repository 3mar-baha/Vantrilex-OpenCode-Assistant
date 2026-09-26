import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ACK_KIND,
  buildAgentFrame,
  buildInventoryFrame,
  encodeTextFrame,
  ERROR_KIND,
  FrameReassembler,
  HelloFrameSchema,
  IPC_TOKEN_ENV,
  MAX_AUDIO_BYTES,
  MISSED_PINGS_LIMIT,
  Opcode,
  parseSeq,
  PING_INTERVAL_MS,
  RESUME_BUFFER_CAP,
  SERVE_PORT,
  UiCommandSchema,
  UI_SUBPROTOCOL,
  UI_WS_PATH,
  WsProtocolError,
  type AgentFrame,
  type HelloFrame,
  type InventoryFrame,
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
  reassembler: FrameReassembler;
  missedPongs: number;
}

/** Best-effort write: a dead peer destroys its connection instead of the daemon. */
function safeWrite(conn: Conn, conns: Set<Conn>, data: Uint8Array): boolean {
  if (conn.socket.destroyed) {
    conns.delete(conn);
    return false;
  }
  try {
    conn.socket.write(data);
    return true;
  } catch {
    try {
      conn.socket.destroy();
    } catch {
      // best-effort
    }
    conns.delete(conn);
    return false;
  }
}

/** RFC 6455 close frame (0x88), not a text frame. */
function encodeCloseFrame(code = 1000): Buffer {
  return Buffer.from([0x88, 0x02, (code >> 8) & 0xff, code & 0xff]);
}

function wsAccept(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

export interface CommandOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

export class UiServer {
  onCommand: ((cmd: UiCommand) => CommandOutcome | Promise<CommandOutcome> | void) | null = null;
  /** Raw PCM ingest (P4 voice capture). Binary frames only; never parsed as commands. */
  onAudio: ((pcm: Buffer) => void) | null = null;
  private readonly token: string;
  private readonly contractVersion: string;
  private readonly pingIntervalMs: number;
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private seq = 0;
  private readonly resume: UiEvent[] = [];
  private lastInventory: InventoryFrame | null = null;
  private lastAgents: AgentFrame | null = null;
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
    if (this.server !== null) throw new Error('UiServer already started');
    this.server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
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
      safeWrite(conn, this.conns, wire);
    }
    return frame;
  }

  /**
   * Publish a level-triggered inventory snapshot (Phase 2b). Shares the seq
   * space with events; only the latest snapshot is retained for resume.
   */
  publishInventory(sessions: ReadonlyArray<{ sessionId: string; state: string }>): InventoryFrame {
    this.seq += 1;
    const frame = buildInventoryFrame(this.seq, sessions);
    this.lastInventory = frame;
    const wire = encodeTextFrame(JSON.stringify(frame));
    for (const conn of this.conns) {
      safeWrite(conn, this.conns, wire);
    }
    return frame;
  }

  /** Publish a level-triggered discovered-agents snapshot (final polish). */
  publishAgents(agents: ReadonlyArray<{ id: string; name: string }>): AgentFrame {
    this.seq += 1;
    const frame = buildAgentFrame(this.seq, agents);
    this.lastAgents = frame;
    const wire = encodeTextFrame(JSON.stringify(frame));
    for (const conn of this.conns) {
      safeWrite(conn, this.conns, wire);
    }
    return frame;
  }

  async close(): Promise<void> {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const bye = encodeCloseFrame(1000);
    for (const conn of this.conns) {
      safeWrite(conn, this.conns, bye);
      try {
        conn.socket.destroy();
      } catch {
        // best-effort
      }
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
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const presented = Buffer.from(header.slice('Bearer '.length));
      const expected = Buffer.from(this.token);
      if (presented.byteLength === expected.byteLength && timingSafeEqual(presented, expected)) return true;
    }
    // Browser WebSocket clients cannot set upgrade headers, so the renderer
    // carries the bearer as an extra subprotocol token instead. Either path
    // must match exactly; the echoed protocol is always voice-ui.v1.
    const proto = req.headers['sec-websocket-protocol'];
    const offered = typeof proto === 'string' ? proto.split(',').map((s) => s.trim()) : [];
    const expected = Buffer.from(this.token);
    return offered.some((entry) => {
      const candidate = Buffer.from(entry);
      return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
    });
  }

  private lastSeqOf(req: IncomingMessage): number {
    const header = req.headers['last-seq'];
    const fromHeader = parseSeq(Array.isArray(header) ? header[0] : header);
    if (Number.isInteger(fromHeader) && fromHeader >= 0) return fromHeader;
    // Browsers cannot set upgrade headers either; the renderer resumes with
    // ?lastSeq=N. Sequence numbers are not secret.
    try {
      const url = new URL(req.url ?? '', 'http://127.0.0.1');
      return parseSeq(url.searchParams.get('lastSeq'));
    } catch {
      return Number.NaN;
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const proto = req.headers['sec-websocket-protocol'];
    const wants = typeof proto === 'string' ? proto.split(',').map((s) => s.trim()) : [];
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== UI_WS_PATH || typeof key !== 'string' || version !== '13' || !wants.includes(UI_SUBPROTOCOL)) {
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
    const conn: Conn = { socket, reassembler: new FrameReassembler(), missedPongs: 0 };
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

    const lastSeq = this.lastSeqOf(req);
    if (Number.isInteger(lastSeq) && lastSeq >= 0 && lastSeq < this.seq) {
      for (const frame of this.resume) {
        if (frame.seq > lastSeq) safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify(frame)));
      }
      // Level-triggered inventory: only the latest snapshot replays.
      if (this.lastInventory !== null && this.lastInventory.seq > lastSeq) {
        safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify(this.lastInventory)));
      }
      if (this.lastAgents !== null && this.lastAgents.seq > lastSeq) {
        safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify(this.lastAgents)));
      }
    }
  }

  private onData(conn: Conn, chunk: Buffer): void {
    let frames;
    try {
      frames = conn.reassembler.push(chunk);
    } catch (err) {
      // Protocol violation (absurd length, reserved opcode, bad control
      // frame): kill the connection fail-closed instead of buffering forever.
      if (err instanceof WsProtocolError) {
        safeWrite(conn, this.conns, encodeCloseFrame(1009));
      }
      try {
        conn.socket.destroy();
      } catch {
        // best-effort
      }
      this.conns.delete(conn);
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === Opcode.Close) {
        safeWrite(conn, this.conns, encodeCloseFrame(1000));
        try {
          conn.socket.destroy();
        } catch {
          // best-effort
        }
        this.conns.delete(conn);
        return;
      }
      if (frame.opcode === Opcode.Ping) {
        this.pong(conn, frame.payload);
        continue;
      }
      if (frame.opcode === Opcode.Pong) {
        conn.missedPongs = 0;
        continue;
      }
      if (frame.opcode !== Opcode.Text && frame.opcode !== Opcode.Binary) continue;
      if (frame.opcode === Opcode.Binary) {
        if (frame.payload.byteLength > MAX_AUDIO_BYTES) {
          safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'audio frame too large' })));
          continue;
        }
        try {
          this.onAudio?.(Buffer.from(frame.payload));
        } catch {
          // Ingest errors must never crash the socket; the control plane stays up.
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(frame.payload).toString('utf8'));
      } catch {
        safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'invalid JSON' })));
        continue;
      }
      const cmd = UiCommandSchema.safeParse(parsed);
      if (!cmd.success) {
        safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify({ type: ERROR_KIND, detail: 'unknown command' })));
        continue;
      }
      void this.dispatchCommand(conn, cmd.data);
    }
  }

  /** Await the (possibly async) command handler, then ack; never crash the socket. */
  private async dispatchCommand(conn: Conn, cmd: UiCommand): Promise<void> {
    let outcome: CommandOutcome = { ok: true };
    try {
      outcome = (await this.onCommand?.(cmd)) ?? { ok: true };
    } catch (err) {
      outcome = { ok: false, detail: err instanceof Error ? err.message : 'internal' };
    }
    const ack = {
      type: ACK_KIND,
      id: cmd.id,
      ok: outcome.ok,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    };
    safeWrite(conn, this.conns, encodeTextFrame(JSON.stringify(ack)));
  }

  /** Pong with a correctly-sized header (extended lengths included). */
  private pong(conn: Conn, payload: Uint8Array): void {
    const body = Buffer.from(payload);
    let header: Buffer;
    if (body.byteLength <= 125) {
      header = Buffer.from([0x8a, body.byteLength]);
    } else if (body.byteLength <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x8a;
      header[1] = 126;
      header.writeUInt16BE(body.byteLength, 2);
    } else {
      return; // absurd ping payload — ignore rather than misframe
    }
    safeWrite(conn, this.conns, Buffer.concat([header, body]));
  }

  private pingAll(): void {
    for (const conn of [...this.conns]) {
      if (conn.socket.destroyed) {
        this.conns.delete(conn);
        continue;
      }
      conn.missedPongs += 1;
      if (conn.missedPongs > MISSED_PINGS_LIMIT) {
        try {
          conn.socket.destroy();
        } catch {
          // best-effort
        }
        this.conns.delete(conn);
        continue;
      }
      safeWrite(conn, this.conns, Buffer.from([0x89, 0x00])); // ping, empty payload
    }
  }
}
