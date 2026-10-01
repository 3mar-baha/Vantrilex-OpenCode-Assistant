// Voxaura bridge — renderer side of the ws://127.0.0.1:4097/v1/ui channel.
// Mirrors src/ipc/protocol.ts. Browsers cannot set upgrade headers, so the
// bearer travels as an extra subprotocol token and resume as ?lastSeq=N.

export const UI_WS_URL = 'ws://127.0.0.1:4097/v1/ui';
export const UI_SUBPROTOCOL = 'voice-ui.v1';
export const RECONNECT_BASE_MS = 50;
export const RECONNECT_JITTER_MS = 30;
export const RECONNECT_CAP_MS = 2500;
export const ACK_TIMEOUT_MS = 5000;

export interface HelloMsg {
  readonly type: 'hello';
  readonly contractVersion: string;
  readonly nodePid: number;
  readonly servePort: number;
  readonly layaReady: boolean;
  readonly seq: number;
  /**
   * L22: the daemon's current persona. Optional because the field was added
   * after the contract shipped — a daemon that predates it simply omits it and
   * the shell keeps whatever persona it already had.
   */
  readonly persona?: 'kareem' | 'nour';
  /**
   * M3 B.3: the daemon's authoritative backpressure state at connect time.
   * Optional for the same reason as `persona` — a daemon that predates the
   * field omits it, and the shell keeps the pre-B.3 behaviour (no pause) rather
   * than inventing one. Present-or-absent, not defaulted to `false`, so an older
   * daemon can never be mistaken for one that has checked and found no pause.
   */
  readonly uplinkPaused?: boolean;
}

export interface EventMsg {
  readonly type: 'event';
  readonly seq: number;
  readonly eventId: string;
  readonly state: string;
}

export interface NoticeMsg {
  readonly type: 'notice';
  readonly seq: number;
  readonly code: string;
  readonly detail: string;
  readonly level: 'info' | 'warn' | 'error';
}

export interface VoiceMsg {
  readonly type: 'voice';
  readonly seq: number;
  readonly phase: 'idle' | 'listening' | 'thinking' | 'speaking';
  readonly transcript?: string;
}

/** Phase 4: context-window occupancy. `limit`/`percent` null when unknown. */
export interface ContextMsg {
  readonly type: 'context';
  readonly seq: number;
  readonly sessionId: string;
  readonly used: number;
  readonly limit: number | null;
  readonly percent: number | null;
  readonly messageCount: number;
}

function isContextMsg(m: ContextMsg): boolean {
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return (
    m.type === 'context' &&
    typeof m.sessionId === 'string' &&
    /^ses_[A-Za-z0-9_-]{1,120}$/.test(m.sessionId) &&
    isInt(m.used) &&
    isInt(m.messageCount) &&
    (m.limit === null || (typeof m.limit === 'number' && m.limit > 0)) &&
    (m.percent === null || (typeof m.percent === 'number' && m.percent >= 0 && m.percent <= 100))
  );
}

/**
 * M3 B.3: backpressure watermark transition from the daemon's ingest buffer.
 *
 * The whole point of the frame is one instruction — stop putting audio on the
 * wire — so it carries a `seq` and nothing else, exactly like the frames around
 * it. A shell that predates it has no branch for `flow` and ignores the type,
 * which degrades to the pre-B.3 behaviour (no backpressure) rather than to
 * silence.
 */
export interface FlowMsg {
  readonly type: 'flow';
  readonly seq: number;
  readonly state: 'pause' | 'resume';
}

/** Whole-shape guard: an unrecognised `state` must not be treated as a pause. */
function isFlowMsg(m: FlowMsg): boolean {
  return (
    m.type === 'flow' &&
    (m.state === 'pause' || m.state === 'resume') &&
    Number.isInteger(m.seq) &&
    m.seq >= 0
  );
}

// ── The `output` frame ───────────────────────────────────────────────────────
//
// Phase 1 of the agentic bridge. The daemon emits ONE frame per `execSessionShell`
// command, carrying the whole result: `buildOutputFrame` → `OutputFrameSchema`
// (`src/ipc/protocol.ts:908`). This block is a STRUCTURAL mirror of that schema,
// declared rather than imported for the reason `TerminalDrawer.OutputFrameLike`
// gives — the root `src/` tree is outside the desktop tsconfig's `include`, and
// importing it would drag zod and the whole frame module into the Vite bundle.
//
// ── THE RECONCILIATION AGAINST THE REAL SCHEMA, FIELD BY FIELD ────────────────
//
// `OutputFrameSchema` declares thirteen fields. The terminal drawer's
// `OutputFrameLike` reads TEN of them — it gained `outcome` and `sessionId` when
// its owner found the two were losses rather than decoration. All ten exist in
// the real frame with identical types, so the real `OutputFrame` satisfies the
// projection by construction and the declared seam type is a strict SUPERSET of
// what the drawer needs — which is what lets `App` hand this bridge a handler
// typed `(frame: OutputFrameLike) => void`.
//
// THREE FIELDS THE PROJECTION IGNORES, and why each still earns its place here:
//
//   `type`        the branch key. Carried so a value is never structurally
//                 indistinguishable from any other frame.
//   `seq`         REQUIRED on the wire (the protocol says so explicitly) so a
//                 retained copy can be replayed through the same `seq > lastSeq`
//                 filter as everything else. The bridge CONSUMES it — see the
//                 branch — and the drawer does not need it, because
//                 `linesFromOutputFrame` mints line ids from `commandId`, which
//                 is what makes a re-delivered frame dedupe rather than double.
//   `outputBytes` the length BEFORE the cap. `output.length` under-reports a
//                 truncated frame by exactly the amount the producer refused, and
//                 `droppedBytes` alone does not distinguish "the producer capped
//                 this" from "this is all there was".
//
// WHAT THE DRAWER NOW DOES WITH THE TWO THAT USED TO BE UNREAD, because a
// comment that misdescribes a collaborator is how the next change to either
// file is made wrong:
//
//   `sessionId` the frame says which session produced the output, and the router
//               really does carry `createSession` / `switchSession`, so a
//               workspace holds several sessions. EVERY line now renders its own
//               `terminal-line-session` chip — per line, not per block, so
//               attribution survives a single line copied out of the log — with
//               `sessionLabel` abbreviating the token and `title` plus
//               `data-session` carrying the full id. There is no unlabelled
//               two-session log any more.
//   `outcome`   `'ok' | 'failed' | 'unknown'`, DERIVED by the daemon in
//               `deriveShellOutcome`. `exitCode` is `null` in the measured case
//               (serve has no exit-code field at all), so this is the only
//               honest verdict the frame carries — `completed` is NOT `ok`. The
//               drawer READS it: `resolveShellOutcome` returns the frame's own
//               value, so there is no second derivation to drift from the
//               producer's. `deriveShellOutcomeFallback` survives only for a
//               frame that carries NO `outcome`, and when that path is taken the
//               drawer pushes a visible `warn` line saying so rather than passing
//               a guess off as the producer's verdict.
//
// WHAT THE RENDERER MUST NOT DO WITH `output`: clamp it. The producer owns
// `MAX_OUTPUT_TEXT_BYTES` (32 KiB, cumulative, enforced pre-store by
// `OutputAssembler`) and says so on the frame via `truncated` / `droppedBytes`.
// A renderer that re-clamped would hide a real drop and assert a completeness
// the frame never claimed — the `INVENTORY_MAX_SESSIONS` defect class, in a
// place where the user is reading a build log. So `isOutputFrame` below checks
// the frame's TYPES and its bounded `command` / `commandId` echoes, and is
// deliberately silent about the length of `output`; the bound is enforced
// upstream by `buildOutputFrame`, which every frame on the wire went through.
export type ShellOutputStatus = 'completed' | 'error' | 'pending' | 'running' | 'unknown';
export type ShellOutputOutcome = 'ok' | 'failed' | 'unknown';

/** Echoed-command bounds, mirrored from `protocol.ts` (`OUTPUT_MAX_*_CHARS`). */
const OUTPUT_MAX_COMMAND_CHARS = 512;
const OUTPUT_MAX_COMMAND_ID_CHARS = 128;

export interface OutputFrameMsg {
  readonly type: 'output';
  readonly seq: number;
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: string;
  readonly status: ShellOutputStatus;
  readonly outcome: ShellOutputOutcome;
  readonly exitCode: number | null;
  /** ALREADY capped and tail-truncated by the producer. Not a line stream. */
  readonly output: string;
  /** Byte length BEFORE the cap. `output` alone under-reports. */
  readonly outputBytes: number;
  readonly droppedBytes: number;
  readonly truncated: boolean;
  readonly durationMs: number | null;
}

const OUTPUT_STATUSES: readonly string[] = ['completed', 'error', 'pending', 'running', 'unknown'];
const OUTPUT_OUTCOMES: readonly string[] = ['ok', 'failed', 'unknown'];

/**
 * Whole-shape guard, like `isContextMsg` and `isFlowMsg` before it: a frame this
 * shell cannot fully understand must never reach a handler that will read it as
 * a complete result. A partial read is the false affordance in its purest form —
 * `truncated: false` on a frame that arrived truncated means the drawer says
 * "اكتمل الأمر" over half a build log.
 *
 * The socket SURVIVES a rejection (`onErrorFrame` only), exactly as for every
 * other malformed frame: one bad frame from a peer is not a reason to drop a
 * live shell.
 */
function isOutputFrame(m: OutputFrameMsg): boolean {
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const isCountOrNull = (v: unknown): v is number | null => v === null || isCount(v);
  // `exitCode` is `z.number().int().nullable()` in the protocol — no lower bound,
  // because a process can be killed by a signal. So a negative integer is legal
  // here and rejecting it would drop a real frame.
  const isIntOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v));
  return (
    m.type === 'output' &&
    isCount(m.seq) &&
    typeof m.sessionId === 'string' &&
    /^ses_[A-Za-z0-9_-]{1,120}$/.test(m.sessionId) &&
    typeof m.commandId === 'string' &&
    m.commandId.length > 0 &&
    m.commandId.length <= OUTPUT_MAX_COMMAND_ID_CHARS &&
    typeof m.command === 'string' &&
    m.command.length <= OUTPUT_MAX_COMMAND_CHARS &&
    OUTPUT_STATUSES.includes(m.status) &&
    OUTPUT_OUTCOMES.includes(m.outcome) &&
    isIntOrNull(m.exitCode) &&
    typeof m.output === 'string' &&
    isCount(m.outputBytes) &&
    isCount(m.droppedBytes) &&
    typeof m.truncated === 'boolean' &&
    isCountOrNull(m.durationMs)
  );
}

export type CommandKind =
  | 'abort'
  // M2 Pattern 2 — barge-in stops the SPEECH; the button above stops the TURN.
  | 'stopSpeech'
  | 'mute'
  | 'deafen'
  | 'arm'
  | 'setPersona'
  | 'switchSession'
  | 'setSessionAgent'
  | 'setSessionModel'
  | 'toggleSessionSkill'
  | 'execSessionShell'
  | 'saveApiKeys'
  | 'confirm'
  | 'sessionContext'
  | 'createSession'
  // M2 Pattern 3 — the player's `onStart`, once per utterance. Telemetry of the
  // audio path, NOT a control path: the renderer never waits on the ack and the
  // daemon must never narrate it.
  | 'playbackStarted';

export interface CommandMsg {
  readonly id: string;
  readonly kind: CommandKind;
  readonly persona?: 'kareem' | 'nour';
  readonly minutes?: number;
  readonly sessionId?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly skill?: string;
  readonly skillAction?: 'attach' | 'detach';
  readonly command?: string;
  readonly groqKey?: string;
  readonly fishKey?: string;
  readonly openrouterKey?: string;
  readonly confirmId?: string;
  readonly approve?: boolean;
  /** M2 Pattern 3 — optional correlation id for `playbackStarted`, ≤64 chars. */
  readonly playbackId?: string;
  /**
   * W24. `UiCommandSchema` is `.strict()` (`src/ipc/protocol.ts:543`), so a field
   * the schema does not declare is not merely ignored on the way in — it is a
   * VALIDATION FAILURE, and the command is refused before the router ever sees
   * it. That is why this type is not a convenience mirror: it is the set of keys
   * the shell is permitted to put on the wire at all, and a key missing here
   * cannot be sent even when the daemon has a handler for it.
   *
   * `title` (schema `protocol.ts:540`, `z.string().min(1).max(200)`). Declared
   * there as "directory for `createSession`" and read NOWHERE on the daemon side:
   * `command-router.ts:672` takes the directory from `deps.projectDirectory()`
   * and deliberately ignores the payload, pinned by
   * `command-router.test.ts:211` ('createSession ignores any directory supplied
   * in the payload'). So this field is PARITY, not capability — it exists so a
   * shell can express the whole schema, and sending it changes no behaviour. That
   * asymmetry is the point of the declaration: the schema says a field is legal
   * and the router says it is ignored, and a renderer that could not send it
   * would have to guess which of the two it was.
   */
  readonly title?: string;
  /**
   * W24. `contextLimit` (schema `protocol.ts:541`,
   * `z.number().int().positive().max(10_000_000)`), and this one IS live:
   * `command-router.ts:660` forwards it to `deps.client.contextUsage(session,
   * cmd.contextLimit)`, pinned by `command-router.test.ts:155` ('sessionContext
   * passes the model limit through when supplied'). Without the field here the
   * shell cannot state a limit, and `sessionContext` always reports
   * `الحد غير معروف` (limit unknown) for every session.
   */
  readonly contextLimit?: number;
}

export interface CommandOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SocketLike {
  send(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(): void;
  /** True when the underlying socket is OPEN. Optional for test fakes. */
  isOpen?(): boolean;
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  onclose: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
}

export interface InventorySession {
  readonly sessionId: string;
  readonly state: string;
}

export interface AgentEntry {
  readonly id: string;
  readonly name: string;
}

/** Whole-shape guard for agent frames (bridge boundary validation). */
function isAgentList(value: unknown): value is AgentEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      (entry as { id: string }).id.length > 0 &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      (entry as { name: string }).name.length > 0,
  );
}

/** Whole-shape guard for inventory frames (bridge boundary validation). */
function isInventoryList(value: unknown): value is InventorySession[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { sessionId?: unknown }).sessionId === 'string' &&
      (entry as { sessionId: string }).sessionId.length > 0 &&
      typeof (entry as { state?: unknown }).state === 'string' &&
      (entry as { state: string }).state.length > 0,
  );
}

/** Minimal hello shape guard — a misconfigured daemon must not show green. */
function isWellFormedHello(hello: HelloMsg): boolean {
  return (
    typeof hello.nodePid === 'number' &&
    hello.servePort === 4096 &&
    typeof hello.layaReady === 'boolean' &&
    Number.isInteger(hello.seq) &&
    (hello.seq as number) >= 0 &&
    typeof hello.contractVersion === 'string'
  );
}

/** Staggered reconnect: base doubling with jitter, hard cap. Pure — tested. */
export function computeBackoff(
  attempt: number,
  baseMs = RECONNECT_BASE_MS,
  jitterMs = RECONNECT_JITTER_MS,
  capMs = RECONNECT_CAP_MS,
  rand: () => number = Math.random,
): number {
  const grown = baseMs * 2 ** Math.max(0, attempt);
  return Math.min(grown + rand() * jitterMs, capMs);
}

/** Append a query param without breaking an existing query string. */
export function withQuery(base: string, key: string, value: string): string {
  return base.includes('?') ? `${base}&${key}=${value}` : `${base}?${key}=${value}`;
}

export interface BridgeOptions {
  readonly url?: string;
  readonly token: string;
  readonly contractVersion: string;
  readonly createSocket?: (url: string, protocols: string[]) => SocketLike;
  /** Fired on ANY inbound frame — transport liveness, independent of payload. */
  readonly onFrame?: () => void;
  readonly onHello?: (hello: HelloMsg) => void;
  /** Recoverable notices + first-run guidance (additive). */
  readonly onNotice?: (notice: NoticeMsg) => void;
  /** Voice phase (listening/thinking/speaking) for the HUD. */
  readonly onVoice?: (voice: VoiceMsg) => void;
  readonly onEvent?: (event: EventMsg) => void;
  readonly onInventory?: (sessions: InventorySession[]) => void;
  readonly onAgents?: (agents: AgentEntry[]) => void;
  /** Speech downlink chunks (MP3 payload, header already stripped). */
  readonly onAudio?: (audio: Uint8Array) => void;
  readonly onRefusal?: (info: { expected: string; got: string }) => void;
  readonly onErrorFrame?: (detail: string) => void;
  /** Fired when a hello arrives with a lower seq — the daemon restarted. */
  readonly onGap?: () => void;
  readonly onClose?: () => void;
  /** Phase 4: context-window telemetry for the HUD gauge. */
  readonly onContext?: (ctx: ContextMsg) => void;
  /**
   * M3 B.3: the daemon is asking the uplink to pause or resume. The bridge
   * applies it to `sendPcm` itself — see the `uplinkPaused` comment for why the
   * callback is notification, not control.
   */
  readonly onFlow?: (flow: FlowMsg) => void;
  /**
   * Phase 1 of the agentic bridge: one shell command's whole result, already
   * capped by the producer. Fired ONLY for `type: 'output'` — the handler is not
   * widened to a general frame callback, because the only thing that may render
   * a 32 KiB untrusted text blob is a drawer that was built for it.
   */
  readonly onOutput?: (frame: OutputFrameMsg) => void;
  /**
   * Fired once when the bridge is torn down for good (component unmount).
   * Distinct from `onClose`, which fires on every socket drop and is followed
   * by a reconnect — releasing the AudioContext on that would cut off speech
   * mid-reply.
   */
  readonly onDispose?: () => void;
}

/** Adapt a native browser WebSocket to the SocketLike surface (binary included). */
function adaptWebSocket(ws: WebSocket): SocketLike {
  // Binary frames must arrive as ArrayBuffer, not Blob (the browser default),
  // or the speech-downlink branch in onMessage never fires.
  ws.binaryType = 'arraybuffer';
  const adapter: SocketLike = {
    send: (data: string) => ws.send(data),
    sendBinary: (data: Uint8Array) => ws.send(data),
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = (ev: Event) => adapter.onopen?.(ev);
  ws.onmessage = (ev: MessageEvent) => adapter.onmessage?.({ data: ev.data });
  ws.onclose = (ev: CloseEvent) => adapter.onclose?.(ev);
  ws.onerror = (ev: Event) => adapter.onerror?.(ev);
  return adapter;
}

export class VoxauraBridge {
  private readonly opts: BridgeOptions;
  private socket: SocketLike | null = null;
  private disposed = false;
  private refused = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = -1;
  /**
   * M3 B.3 — backpressure latch, and the one piece of state here with a
   * deadlock on both ends, so it is worth stating the two ways it can go wrong.
   *
   * Why a DROP and not `capture.stop()`: stopping the microphone takes the
   * user's speech with it. The audio is gone — not deferred, not queued, gone —
   * so a pause implemented that way destroys the utterance it was supposed to
   * protect, and the resume has to re-acquire a device the browser may make the
   * user grant again. Dropping the uplink instead costs a hole in one
   * 5-second window while the daemon catches up. The capture graph is not
   * touched, and nothing here can reach it: `capture.ts` has no reference to the
   * bridge and this class holds no `AudioCapture`.
   *
   * Why it must be cleared on a daemon restart: a pause belongs to an
   * accumulator, not to this shell. A restarted daemon holds an EMPTY buffer, so
   * it will never cross `PAUSE_BYTES` again and will never send the 'resume' that
   * a still-paused shell is waiting for. A shell that kept the latch across the
   * restart would discard every frame for the rest of the session — which is why
   * the backwards-`seq` hello branch resets it rather than only resetting the
   * cursor.
   */
  private uplinkPaused = false;
  private readonly pending = new Map<string, { resolve: (o: CommandOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  get connectionAttempt(): number {
    return this.attempt;
  }

  /** True when the socket is OPEN. Drives the HUD pill (never a stale timer). */
  get live(): boolean {
    const socket = this.socket;
    if (socket === null) return false;
    return socket.isOpen?.() ?? true;
  }

  connect(): void {
    if (this.disposed || this.refused || this.socket !== null) return;
    const base = this.opts.url ?? UI_WS_URL;
    // Always send the resume cursor, floored at 0. Without the param the server's
    // `lastSeqOf` returns NaN and `ui-server.ts` skips the ENTIRE replay block, so
    // a first-ever connect received `hello` and nothing else — no inventory, no
    // agents — and the inventory interval only pushes on change, so a cold launch
    // sat with an empty session list and agent selector. Measured: 25 s, hello
    // only. `Math.max(0, ...)` keeps `-1` as the "never connected" sentinel used
    // by the backwards-seq check below, so only the wire format changes.
    const url = withQuery(base, 'lastSeq', String(Math.max(0, this.lastSeq)));
    const create = this.opts.createSocket ?? ((u, p) => adaptWebSocket(new WebSocket(u, p)));
    const socket = create(url, [UI_SUBPROTOCOL, this.opts.token]);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
    };
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onclose = () => {
      this.socket = null;
      this.opts.onClose?.();
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // close is best-effort; onclose drives the reconnect
      }
    };
  }

  sendCommand(cmd: CommandMsg): Promise<boolean> {
    return this.sendCommandDetailed(cmd).then((outcome) => outcome.ok);
  }

  /** Like sendCommand but surfaces the ack `detail` (e.g. confirmation-required). */
  sendCommandDetailed(cmd: CommandMsg): Promise<CommandOutcome> {
    const socket = this.socket;
    if (socket === null) return Promise.resolve({ ok: false });
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        resolve({ ok: false });
      }, ACK_TIMEOUT_MS);
      this.pending.set(cmd.id, { resolve, timer });
      try {
        socket.send(JSON.stringify(cmd));
      } catch {
        clearTimeout(timer);
        this.pending.delete(cmd.id);
        resolve({ ok: false });
      }
    });
  }

  /**
   * Fire-and-forget PCM uplink (P4 voice capture). Binary frames bypass the
   * ack ledger by design — audio is loss-tolerant, commands are not.
   *
   * M3 B.3: while the daemon holds a backpressure pause this drops the chunk and
   * reports false, which is the same answer the caller already handles for a
   * dead socket. It is deliberately the ONLY thing a pause does — commands,
   * acks, the speech downlink and the pause frame itself are untouched, because
   * a stalled audio buffer must never become a stalled control plane.
   */
  sendPcm(bytes: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null) return false;
    if (this.uplinkPaused) return false;
    try {
      socket.sendBinary(bytes);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    // Terminal teardown: release the AudioContext and anything else the shell
    // owns. `onDispose` fires only on the first transition so a double dispose
    // cannot double-free; `onClose` is deliberately NOT used here, because that
    // one fires on every socket drop and is followed by a reconnect.
    const first = !this.disposed;
    this.disposed = true;
    this.attempt = 0;
    if (first) this.opts.onDispose?.();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false });
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // best-effort
    }
    this.socket = null;
  }

  private onMessage(data: unknown): void {
    // Transport liveness: any inbound byte proves the socket is alive. The HUD
    // promotes to "live" on this signal regardless of payload type.
    this.opts.onFrame?.();
    // Speech downlink (P4b): binary frames carry a 1-byte type + u16be seq +
    // MP3 payload (see src/ipc/audio.ts). Anything else binary is ignored.
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (bytes.byteLength >= 4 && bytes[0] === 0x01) {
        this.opts.onAudio?.(bytes.subarray(3));
      }
      return;
    }
    // Defensive: a socket that still delivers Blobs (binaryType unset).
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => this.onMessage(buffer)).catch(() => undefined);
      return;
    }
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    if (msg['type'] === 'hello') {
      const hello = msg as unknown as HelloMsg;
      // Daemon restart detection: seq runs backward only across restarts.
      // Reset the cursor instead of swallowing the new epoch forever.
      if (typeof hello.seq === 'number' && hello.seq < this.lastSeq) {
        this.lastSeq = hello.seq;
        this.opts.onGap?.();
      } else if (typeof hello.seq === 'number' && hello.seq >= 0) {
        this.lastSeq = Math.max(this.lastSeq, hello.seq);
      }
      // M3 B.3: adopt the daemon's backpressure state on EVERY connect, not only
      // in the backwards-seq branch above. `flow()` is not retained for resume,
      // so a pause or resume raised while this shell was away never arrives as a
      // frame — the latch would survive, and since the shell drops its uplink
      // while latched, the two halves deadlock: the accumulator is at zero bytes
      // and will never cross PAUSE_BYTES, and the shell is not sending. The
      // backwards-seq branch was the wrong tool for it, incidentally — for a
      // same-daemon reconnect the daemon's seq only moves forward, so that branch
      // is not even taken.
      //
      // The field is echoed unconditionally by the daemon, so this is an
      // authoritative resync rather than a heuristic. An older daemon omits it,
      // which is the pre-B.3 behaviour: no backpressure, and no false pause.
      if (typeof hello.uplinkPaused === 'boolean') this.uplinkPaused = hello.uplinkPaused;
      if (!isWellFormedHello(hello)) {
        this.refused = true;
        this.opts.onRefusal?.({ expected: this.opts.contractVersion, got: 'malformed-hello' });
        try {
          this.socket?.close();
        } catch {
          // best-effort
        }
        return;
      }
      if (hello.contractVersion !== this.opts.contractVersion) {
        this.refused = true;
        this.opts.onRefusal?.({ expected: this.opts.contractVersion, got: String(hello.contractVersion) });
        try {
          this.socket?.close();
        } catch {
          // best-effort
        }
        return;
      }
      this.opts.onHello?.(hello);
      return;
    }
    if (msg['type'] === 'event') {
      const event = msg as unknown as EventMsg;
      if (typeof event.seq === 'number' && event.seq > this.lastSeq) this.lastSeq = event.seq;
      this.opts.onEvent?.(event);
      return;
    }
    if (msg['type'] === 'inventory') {
      // Contract-safe: validate the whole shape; malformed frames surface an
      // error and never touch state (socket survives).
      const sessions = (msg as { sessions?: unknown })['sessions'];
      if (!isInventoryList(sessions)) {
        this.opts.onErrorFrame?.('malformed inventory frame');
        return;
      }
      const seq = (msg as { seq?: unknown })['seq'];
      if (typeof seq === 'number' && seq > this.lastSeq) this.lastSeq = seq;
      this.opts.onInventory?.(sessions);
      return;
    }
    if (msg['type'] === 'agents') {
      const agents = (msg as { agents?: unknown })['agents'];
      if (!isAgentList(agents)) {
        this.opts.onErrorFrame?.('malformed agents frame');
        return;
      }
      const seq = (msg as { seq?: unknown })['seq'];
      if (typeof seq === 'number' && seq > this.lastSeq) this.lastSeq = seq;
      this.opts.onAgents?.(agents);
      return;
    }
    if (msg['type'] === 'context') {
      // Phase 4: context-window occupancy. Validated whole-shape; a malformed
      // frame surfaces an error and never touches state.
      const ctx = msg as unknown as ContextMsg;
      if (!isContextMsg(ctx)) {
        this.opts.onErrorFrame?.('malformed context frame');
        return;
      }
      const seq = (msg as { seq?: unknown })['seq'];
      if (typeof seq === 'number' && seq > this.lastSeq) this.lastSeq = seq;
      this.opts.onContext?.(ctx);
      return;
    }
    if (msg['type'] === 'flow') {
      // M3 B.3: the cursor moves exactly the way it does for `context` — the
      // frame shares the daemon's seq space, so it must be counted or a
      // reconnect resumes from a cursor the daemon has already moved past.
      // Validated whole-shape, like every other frame: an unknown `state` is
      // dropped rather than coerced, because guessing 'pause' would stop the
      // uplink on the strength of a malformed frame.
      const flow = msg as unknown as FlowMsg;
      if (!isFlowMsg(flow)) {
        this.opts.onErrorFrame?.('malformed flow frame');
        return;
      }
      const seq = (msg as { seq?: unknown })['seq'];
      if (typeof seq === 'number' && seq > this.lastSeq) this.lastSeq = seq;
      this.uplinkPaused = flow.state === 'pause';
      this.opts.onFlow?.(flow);
      return;
    }
    if (msg['type'] === 'output') {
      // Phase 1 of the agentic bridge. The cursor moves exactly as it does for
      // `context` and `flow`: the frame shares the daemon's seq space, and a
      // frame whose seq is not counted is a frame the daemon will never replay
      // to this shell again.
      //
      // Validated whole-shape BEFORE the cursor moves, like every other frame:
      // a malformed `output` must not consume a seq, must not reach a handler
      // that will read a half-parsed frame as a complete result, and must not
      // take the socket down. `onErrorFrame` and return.
      const output = msg as unknown as OutputFrameMsg;
      if (!isOutputFrame(output)) {
        this.opts.onErrorFrame?.('malformed output frame');
        return;
      }
      const seq = (msg as { seq?: unknown })['seq'];
      if (typeof seq === 'number' && seq > this.lastSeq) this.lastSeq = seq;
      this.opts.onOutput?.(output);
      return;
    }
    if (msg['type'] === 'notice') {
      const detail = msg['detail'];
      const level = msg['level'];
      const code = msg['code'];
      if (typeof detail === 'string' && typeof code === 'string') {
        this.opts.onNotice?.({
          type: 'notice',
          seq: typeof msg['seq'] === 'number' ? (msg['seq'] as number) : 0,
          code,
          detail,
          level: level === 'info' || level === 'error' ? level : 'warn',
        });
      }
      return;
    }
    if (msg['type'] === 'voice') {
      const phase = msg['phase'];
      if (phase === 'idle' || phase === 'listening' || phase === 'thinking' || phase === 'speaking') {
        this.opts.onVoice?.({
          type: 'voice',
          seq: typeof msg['seq'] === 'number' ? (msg['seq'] as number) : 0,
          phase,
          ...(typeof msg['transcript'] === 'string' ? { transcript: msg['transcript'] as string } : {}),
        });
      }
      return;
    }
    if (msg['type'] === 'ack') {
      const id = (msg as { id?: unknown })['id'];
      const ok = (msg as { ok?: unknown })['ok'];
      const detail = (msg as { detail?: unknown })['detail'];
      if (typeof id === 'string') {
        const entry = this.pending.get(id);
        if (entry !== undefined) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve({ ok: ok !== false, ...(typeof detail === 'string' ? { detail } : {}) });
        }
      }
      return;
    }
    if (msg['type'] === 'error') {
      const detail = (msg as { detail?: unknown })['detail'];
      this.opts.onErrorFrame?.(typeof detail === 'string' ? detail : 'unknown error');
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.refused || this.timer !== null) return;
    const delay = computeBackoff(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}
