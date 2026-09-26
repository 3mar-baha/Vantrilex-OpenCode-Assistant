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

export type CommandKind =
  | 'abort'
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
  | 'confirm';

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
    const url = this.lastSeq >= 0 ? withQuery(base, 'lastSeq', String(this.lastSeq)) : base;
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
   */
  sendPcm(bytes: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === null) return false;
    try {
      socket.sendBinary(bytes);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.attempt = 0;
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
