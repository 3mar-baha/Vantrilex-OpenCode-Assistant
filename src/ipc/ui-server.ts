import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { redactString } from '../common/logger.js';
import {
  ACK_KIND,
  buildAgentFrame,
  buildInventoryFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  ERROR_KIND,
  FrameReassembler,
  HelloFrameSchema,
  IPC_TOKEN_ENV,
  MAX_AUDIO_BYTES,
  MISSED_PINGS_LIMIT,
  MAX_CONNECTIONS,
  NoticeFrameSchema,
  Opcode,
  type OutputFrame,
  type OutputFrameInput,
  buildOutputFrame,
  parseSeq,
  PING_INTERVAL_MS,
  RESUME_BUFFER_CAP,
  SERVE_PORT,
  UiCommandSchema,
  UI_SUBPROTOCOL,
  UI_WS_PATH,
  VoiceFrameSchema,
  ContextFrameSchema,
  FlowFrameSchema,
  type AgentFrame,
  type ContextFrame,
  type FlowFrame,
  type FlowState,
  type HelloFrame,
  type InventoryFrame,
  type NoticeFrame,
  type UiCommand,
  type UiEvent,
  type VoiceFrame,
  type VoicePhase,
  WsProtocolError,
} from './protocol.js';
import { encodeAudioChunk, splitAudio } from './audio.js';

// Voxaura UI bridge — ADR-010. Zero-dependency RFC 6455 server on
// 127.0.0.1:4097. Fail-closed: no token → the server refuses to start;
// wrong/missing bearer → 401, never upgraded. The daemon owns `seq`.

/**
 * M3 B.2b: byte budget for the retained Last-Seq resume window. Paired with
 * `RESUME_BUFFER_CAP`, which bounds frames and this bounds bytes — see
 * `retainForResume` for why the second bound is prophylactic rather than a fix.
 */
export const RESUME_BUFFER_MAX_BYTES = 64 * 1024;

/**
 * Anything the resume window can replay.
 *
 * `UiEvent` alone was the whole type when `broadcast()` was the only writer.
 * The `output` frame joins it, and the union is declared HERE rather than at
 * each use site so a third retained family is a deliberate edit instead of an
 * inferred `any`. Both members carry `seq`, which is the only field the replay
 * filter reads, and `frameBytes` only serialises.
 */
type RetainedFrame = UiEvent | OutputFrame;

/** Retained cost of one frame: its JSON payload, which is what a replay re-sends. */
function frameBytes(frame: RetainedFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

export interface UiServerOptions {
  readonly token: string;
  readonly contractVersion: string;
  readonly port?: number;
  readonly pingIntervalMs?: number;
  /** L22: current persona, echoed in hello so a reconnecting shell is not stale. */
  readonly persona?: 'kareem' | 'nour';
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
  /** L22: read at connect time, so a late shell gets the live persona. */
  private persona: 'kareem' | 'nour' | undefined;
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private seq = 0;
  private audioSeq = 0;
  private readonly resume: RetainedFrame[] = [];
  /** Running total of retained payload bytes — the B.2b budget's live figure. */
  private resumeBytes = 0;
  /**
   * Frames dropped from `resume` by either cap. Zero means nothing has ever been
   * droppable, which is the state a cold launch is in — see `noticeResumeGap`,
   * where the distinction is the difference between an honest warning and one
   * shown on every first connection.
   */
  private resumeEvicted = 0;
  private lastInventory: InventoryFrame | null = null;
  private lastAgents: AgentFrame | null = null;
  /**
   * M3 B.3: the backpressure state a shell must adopt on connect, because the
   * `flow` frame that would have told it is not retained. Authoritative, and
   * echoed unconditionally in `hello`.
   */
  private uplinkPaused = false;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(options: UiServerOptions) {
    if (options.token.length === 0) {
      throw new Error(`refusing to start: ${IPC_TOKEN_ENV} is empty (fail-closed)`);
    }
    this.token = options.token;
    this.contractVersion = options.contractVersion;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.persona = options.persona;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /**
   * L22: record a persona change so the NEXT connection is told. Existing
   * connections get the `persona-changed` notice instead; this is only the
   * snapshot a late or reconnecting shell reads from `hello`.
   */
  setPersona(persona: 'kareem' | 'nour'): void {
    this.persona = persona;
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

  /**
   * M3 B.2b: byte budget for the retained resume window, evicting OLDEST first.
   *
   * PROPHYLACTIC, and the framing matters: `RESUME_BUFFER_CAP` already bounds
   * the COUNT at 256 frames, and `broadcast()` — the only writer to this
   * buffer — has zero production callers. So this is NOT a live memory fix;
   * it is a second, independent bound for the first caller that does exist,
   * where "256 frames" is a count and counts do not bound bytes. A future
   * `eventId`/`state` carrying a transcript or a diff turns 256 frames from
   * ~20 KiB into megabytes, and the count cap would not notice. Bound both axes
   * now so that caller cannot reintroduce it.
   *
   * JSON payload bytes, not wire bytes: the RFC 6455 header is <= 10 B per
   * frame and is itself bounded by the count cap, so charging it would be
   * precision applied to the wrong term.
   */
  private retainForResume(frame: RetainedFrame): void {
    this.resume.push(frame);
    this.resumeBytes += frameBytes(frame);
    while (this.resume.length > RESUME_BUFFER_CAP || this.resumeBytes > RESUME_BUFFER_MAX_BYTES) {
      const dropped = this.resume.shift();
      if (dropped === undefined) break;
      this.resumeBytes -= frameBytes(dropped);
      this.resumeEvicted += 1;
    }
  }

  /** Assign the next seq, retain for Last-Seq resume, fan out to all sockets. */
  broadcast(input: Omit<UiEvent, 'type' | 'seq'> & { type?: 'event' }): UiEvent {
    this.seq += 1;
    const frame: UiEvent = { type: 'event', seq: this.seq, eventId: input.eventId, state: input.state };
    this.retainForResume(frame);
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

  /** Broadcast a notice/voice frame to every shell (additive UX signals). */
  broadcastFrame(frame: NoticeFrame | VoiceFrame | ContextFrame | FlowFrame): number {
    this.seq += 1;
    const wire = encodeTextFrame(JSON.stringify({ ...frame, seq: this.seq }));
    let sent = 0;
    for (const conn of this.conns) {
      if (safeWrite(conn, this.conns, wire)) sent += 1;
    }
    return sent;
  }

  /**
   * Publish the result of an `execSessionShell` command.
   *
   * THE FRAME IS A SUMMARY ON COMPLETION, NOT A STREAM. Measured live against
   * opencode 1.18.32 on 2026-09-30: `POST /session/{id}/shell` has
   * `transfer-encoding: null` and `t_firstbyte == t_headers == t_end` on every
   * probe, and a 7-second `ping` took 7 384 ms end to end. It blocks until the
   * command is done and then returns the whole thing. So there is nothing to
   * chunk, no partial text to append, and no `delta` field here to be tempted
   * into faking later.
   *
   * RETAINED, unlike `voice`/`notice`/`context`/`flow`. Those are ambient
   * signals where a stale copy is worse than none — "the assistant is speaking"
   * from four minutes ago is a lie. This is not ambient: it is the payload of a
   * request the shell itself made and already holds an `ack` for, so a shell
   * that misses it has a spinner with no result and no way to learn the command
   * finished. Dropping it would manufacture the indefinite-pending defect this
   * frame exists to end.
   *
   * AND THE RETENTION IS BOUNDED ON BOTH AXES. `RESUME_BUFFER_CAP` (256) bounds
   * the count; `RESUME_BUFFER_MAX_BYTES` (64 KiB) bounds the bytes, and it is
   * the byte axis that matters here because a 256 KiB output frame x 256 frames
   * is 64 MiB of resident heap. `retainForResume` evicts OLDEST-FIRST until both
   * hold, so a long-disconnected shell can demand a bounded replay and not an
   * OOM. `MAX_OUTPUT_TEXT_BYTES` (32 KiB, in protocol.ts) is deliberately HALF
   * that budget: an output frame bigger than the whole budget would evict the
   * buffer including itself, so the newest result would never be replayable —
   * a silent hole, the same defect class as `layaReady: true`. At 32 KiB one
   * always fits; two max-size frames do not, which is the accepted trade.
   */
  output(input: OutputFrameInput): OutputFrame {
    this.seq += 1;
    // The cap runs inside `buildOutputFrame`, on the only production path — a
    // cap reachable only from a test would not be a cap.
    const frame = buildOutputFrame(this.seq, input);
    this.retainForResume(frame);
    const wire = encodeTextFrame(JSON.stringify(frame));
    for (const conn of this.conns) {
      safeWrite(conn, this.conns, wire);
    }
    return frame;
  }

  /**
   * Publish a notice to every connected shell.
   *
   * `detail` is REDACTED HERE, at the single sink, rather than at each call
   * site. Three sites interpolated a raw provider `err.message` into user-facing
   * Arabic text (daemon.ts:584 STT, :738 brain, :789 TTS), and a provider error
   * string is untrusted input: it can echo the Authorization header, the key
   * prefix, or a request URL carrying a credential. The telemetry writer and the
   * JSON-lines logger were both redacted in Wave 2, but this path was not — so
   * the one channel that reaches the user's screen was the one that would have
   * shown a secret. Redacting here covers those three AND any future caller,
   * which site-by-site wrapping cannot promise.
   *
   * `redactString` is idempotent on its own `[REDACTED]` output, so a caller that
   * pre-redacts is not double-processed.
   */
  notice(code: string, detail: string, level: 'info' | 'warn' | 'error' = 'warn'): number {
    return this.broadcastFrame(
      NoticeFrameSchema.parse({ type: 'notice', seq: 0, code, detail: redactString(detail), level }),
    );
  }

  /**
   * `transcript` is the user's own speech, so masking a spoken key here is a
   * deliberate fail-closed trade: the frame reaches a client-side log or bug
   * report, and failing open would be the one branch worth being wrong about.
   * Redaction happens INSIDE the conditional spread, i.e. before
   * `VoiceFrameSchema.parse`, so a scrubbed string is still a string and
   * parsing cannot break. Redaction is idempotent on its own marker.
   */
  voice(phase: VoicePhase, transcript?: string): number {
    return this.broadcastFrame(
      VoiceFrameSchema.parse({ type: 'voice', seq: 0, phase, ...(transcript !== undefined ? { transcript: redactString(transcript) } : {}) }),
    );
  }

  /**
   * Publish context-window occupancy (Phase 4).
   *
   * `limit`/`percent` are nullable on purpose: when the model's context window
   * is unknown we say so rather than dividing by a guess, because a gauge that
   * invents its own denominator is worse than no gauge.
   */
  context(
    sessionId: string,
    used: number,
    limit: number | null,
    percent: number | null,
    messageCount: number,
  ): number {
    return this.broadcastFrame(
      ContextFrameSchema.parse({
        type: 'context',
        seq: 0,
        sessionId,
        used,
        limit,
        percent,
        messageCount,
      }),
    );
  }

  /**
   * M3 B.3: announce a backpressure watermark transition to every shell.
   *
   * Shares the seq space with the other additive frames, so a shell that
   * reconnects mid-pause resumes from a cursor that includes the pause and
   * cannot be talked into believing the daemon said nothing.
   *
   * Fire-and-forget with no ack and no delivery guarantee, which is the correct
   * shape here rather than a shortcut: the alternative failure of NOT sending
   * is unbounded buffering, and a missed pause is recovered by the next
   * transition. A pause that a shell never receives costs the buffer headroom
   * (704 KiB above `PAUSE_BYTES`, see `ingest.ts`); a pause that is never
   * released costs the session.
   */
  flow(state: FlowState): number {
    // Tracked so the NEXT connect can be told, not just the sockets that happen
    // to be attached when the edge fires. See the hello comment.
    this.uplinkPaused = state === 'pause';
    return this.broadcastFrame(FlowFrameSchema.parse({ type: 'flow', seq: 0, state }));
  }

  /**
   * Broadcast synthesized speech (P4b downlink). MP3 bytes are split into
   * sequenced binary chunks and fanned out to every connected shell — the
   * companion is single-user, so audio needs no per-session routing while
   * control stays per-session. Returns the chunk count sent.
   */
  broadcastAudio(mp3: Uint8Array): number {
    const chunks = splitAudio(mp3, this.audioSeq);
    for (const { seq, chunk } of chunks) {
      this.audioSeq = (seq + 1) % 65_536;
      const wire = encodeBinaryFrame(encodeAudioChunk(seq, chunk));
      for (const conn of this.conns) {
        safeWrite(conn, this.conns, wire);
      }
    }
    return chunks.length;
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
    // L15: the connection set was unbounded, so a loopback client could open
    // sockets indefinitely and every broadcast would fan out to all of them.
    // A companion is single-user, so a handful is generous; evict the OLDEST,
    // which is the least likely to be the live shell.
    this.conns.add(conn);
    while (this.conns.size > MAX_CONNECTIONS) {
      const oldest = this.conns.values().next();
      if (oldest.done === true) break;
      const victim = oldest.value;
      this.conns.delete(victim);
      // The eviction is visible in the connection count, which `ui connections`
      // already reports; no logging facility exists in this module.
      try {
        victim.socket.end();
      } catch {
        // best-effort; already removed from the set
      }
    }
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk));
    socket.on('close', () => void this.conns.delete(conn));
    socket.on('error', () => void this.conns.delete(conn));

    const hello: HelloFrame = HelloFrameSchema.parse({
      type: 'hello',
      contractVersion: this.contractVersion,
      nodePid: process.pid,
      servePort: SERVE_PORT,
      // HONEST BY DEFAULT. This used to be a hardcoded `true`, which told every
    // shell that Laya System-1 was ready while the daemon never loaded it: the
    // dynamic-import seam is deliberately NOT installed (laya-m7-int8.onnx is
    // 294 MB and layaLoad has zero consumers, so wiring it would cost a model
    // load per daemon start for no behaviour change). A frame that asserts a
    // feature is live when it is not is the exact defect class this project
    // keeps hunting, so the default must be the truth. Flip this to `true` in
    // the same commit that installs the seam, and only once it is verified.
    layaReady: false,
      seq: this.seq,
      // L22: the daemon is the single source for persona, so a shell that
      // connects after a change must be told, not left on the default.
      ...(this.persona !== undefined ? { persona: this.persona } : {}),
      // M3 B.3, same reasoning applied to a boolean the daemon owns.
      //
      // `flow()` writes to LIVE sockets only and is not retained for resume, so
      // a `resume` raised while a shell was disconnected is simply lost — and
      // the shell is dropping its uplink while waiting for exactly that frame.
      // Its latch survives `socket.onclose` (that only clears the socket), and
      // the backwards-`seq` branch below is NOT a substitute: for a same-daemon
      // reconnect the daemon's seq only moves forward, so `hello.seq < lastSeq`
      // is false and the latch would never be cleared. The accumulator that
      // raised the pause is at zero bytes and can never cross PAUSE_BYTES again,
      // so it will never send the resume either — permanent silence behind a
      // green pill. Stated in hello on every connect, unconditionally, so the
      // accumulator is authoritative and the renderer needs no heuristic.
      uplinkPaused: this.uplinkPaused,
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
      // M3 B.2c: the replay above is silently PARTIAL whenever the client asked
      // for a seq the buffer no longer holds. The shell then renders a session
      // list and an agent list and has no way to know that events it would have
      // applied are missing — the same hole `onGap` covers for daemon restarts,
      // which is the only case it was built for. Announce the gap once, AFTER
      // the replay, so it is the last frame a sequential client reads.
      this.noticeResumeGap(lastSeq);
    }
  }

  /**
   * Emit `resume-gap` when `lastSeq` predates retention: either it is below the
   * oldest retained frame, or the buffer is empty while the server has moved on
   * (only `publishInventory`/`publishAgents`/`broadcastFrame` have, so seq > 0
   * with nothing retained is a real state and not a contradiction).
   *
   * The detail names BOTH ends of what is actually retained, computed from the
   * live buffer rather than written out as a constant, because the number that
   * matters is the one that moved when the caps did. Goes through `notice()`,
   * the single redaction sink — not a direct `safeWrite` of a NoticeFrame, and
   * not a re-redaction here.
   *
   * Once per connection by construction: `handleUpgrade` runs once per
   * connection, and this is called from exactly one place in it. The fan-out
   * that `notice()` implies (every attached shell sees it) is accepted on a
   * loopback single-user channel capped at MAX_CONNECTIONS; a shell that was not
   * the one that lost frames shows one extra warn line, which is the honest
   * direction to err in.
   *
   * SCOPE, and it is narrow on purpose: this covers `broadcast()` EVENTS only.
   * `voice`, `context` and `notice` frames consume a seq but are neither
   * retained nor replayable — they are transient by design (a stale "the
   * assistant is speaking" is worse than none), and inventory/agents are
   * level-triggered, so a reconnect re-sends them regardless. So a shell can
   * miss those without a gap notice, correctly. It is also why, with zero
   * non-test `broadcast()` callers, this notice CANNOT fire in a shipped build
   * today: the first real caller is the seam it is waiting behind. Like the
   * byte budget above, it is installed ahead of its producer, not because of
   * a live fault.
   */
  private noticeResumeGap(lastSeq: number): void {
    const oldest = this.resume.length > 0 ? this.resume[0]!.seq : null;
    if (oldest !== null && lastSeq >= oldest) return;
    // Empty retention is only a gap if something was DROPPED to make it empty.
    // Without this, `seq > 0` alone decides, and every cold launch trips it:
    // `publishInventory`/`publishAgents` advance `seq` and hold no events, the
    // replay above sends both snapshots in full, and the client has missed
    // nothing. Measured against the real topology before the guard existed
    // (pinned by the B.2c-d test). A warn the user cannot act on, on every
    // first connection, is worse than the silence it replaced.
    if (oldest === null && this.resumeEvicted === 0) return;
    // The upper bound is the NEWEST RETAINED seq, not `this.seq`. The latter
    // counts snapshots and transient frames that were never retained, so
    // quoting it promises a range the server does not hold — over-claiming, and
    // still wrong in a user-facing number. (Peer review; the B.2c test asserts
    // this exact value, so the fix cannot silently revert to `this.seq`.)
    const newest = this.resume.length > 0 ? this.resume[this.resume.length - 1]!.seq : null;
    const detail =
      oldest === null
        ? `فاتتك كل الأحداث المحفوظة، وآخر حدث محفوظ رقمه ${newest ?? 'ما في'} وبديتك من ${lastSeq}.`
        : `فاتتك أحداث: بديت من ${lastSeq} والمحفوظ عندنا من ${oldest} إلى ${newest}.`;
    this.notice('resume-gap', detail, 'warn');
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
      // `detail` is an OPEN string, not an `ErrorCode` union: `dispatch` returns
      // locally generated literals today, but the catch above forwards a raw
      // `err.message`, so a single throwing `onCommand` reaches the HUD
      // unredacted. Scrubbing at the sink covers the current callers AND every
      // future one, which per-caller wrapping cannot promise.
      ...(outcome.detail !== undefined ? { detail: redactString(outcome.detail) } : {}),
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
