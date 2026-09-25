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

export interface SocketLike {
  send(data: string): void;
  close(): void;
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
  readonly onHello?: (hello: HelloMsg) => void;
  readonly onEvent?: (event: EventMsg) => void;
  readonly onInventory?: (sessions: InventorySession[]) => void;
  readonly onAgents?: (agents: AgentEntry[]) => void;
  readonly onRefusal?: (info: { expected: string; got: string }) => void;
  readonly onErrorFrame?: (detail: string) => void;
  /** Fired when a hello arrives with a lower seq — the daemon restarted. */
  readonly onGap?: () => void;
  readonly onClose?: () => void;
}

export class VoxauraBridge {
  private readonly opts: BridgeOptions;
  private socket: SocketLike | null = null;
  private disposed = false;
  private refused = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = -1;
  private readonly pending = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  get connectionAttempt(): number {
    return this.attempt;
  }

  connect(): void {
    if (this.disposed || this.refused || this.socket !== null) return;
    const base = this.opts.url ?? UI_WS_URL;
    const url = this.lastSeq >= 0 ? withQuery(base, 'lastSeq', String(this.lastSeq)) : base;
    const create = this.opts.createSocket ?? ((u, p) => new WebSocket(u, p) as unknown as SocketLike);
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
    const socket = this.socket;
    if (socket === null) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        resolve(false);
      }, ACK_TIMEOUT_MS);
      this.pending.set(cmd.id, { resolve, timer });
      try {
        socket.send(JSON.stringify(cmd));
      } catch {
        clearTimeout(timer);
        this.pending.delete(cmd.id);
        resolve(false);
      }
    });
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
      p.resolve(false);
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
    if (msg['type'] === 'ack') {
      const id = (msg as { id?: unknown })['id'];
      const ok = (msg as { ok?: unknown })['ok'];
      if (typeof id === 'string') {
        const entry = this.pending.get(id);
        if (entry !== undefined) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.resolve(ok !== false);
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
