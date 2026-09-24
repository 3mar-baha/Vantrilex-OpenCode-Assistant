import { nowIso } from '../common/brands.js';

// Session inventory poller (Phase 1) — periodic discovery of all active
// OpenCode sessions via listSessions(). Emits added/removed/updated diffs;
// a failed poll keeps the last snapshot and emits error (degraded, not death).
// Slow serves never overlap polls: a tick while a poll is in flight is skipped.
export interface SessionRecord {
  readonly sessionId: string;
  readonly state: string;
  readonly lastSeen: string;
}

export type InventoryEvent =
  | { readonly kind: 'added'; readonly sessionId: string; readonly state: string }
  | { readonly kind: 'removed'; readonly sessionId: string }
  | { readonly kind: 'updated'; readonly sessionId: string; readonly state: string }
  | { readonly kind: 'error'; readonly detail: string };

export interface InventoryClient {
  listSessions(): Promise<Array<{ sessionId: string; state: string }>>;
}

export interface InventoryOptions {
  readonly intervalMs?: number;
  readonly onEvent?: (event: InventoryEvent) => void;
}

export class SessionInventory {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly intervalMs: number;
  private readonly onEvent: ((event: InventoryEvent) => void) | undefined;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private disposed = false;

  constructor(
    private readonly client: InventoryClient,
    options: InventoryOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 15_000;
    this.onEvent = options.onEvent;
  }

  snapshot(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  async pollOnce(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    try {
      const listed = await this.client.listSessions();
      const seen = new Set<string>();
      for (const { sessionId, state } of listed) {
        seen.add(sessionId);
        const prev = this.sessions.get(sessionId);
        if (prev === undefined) {
          this.sessions.set(sessionId, { sessionId, state, lastSeen: nowIso() });
          this.onEvent?.({ kind: 'added', sessionId, state });
        } else if (prev.state !== state) {
          this.sessions.set(sessionId, { sessionId, state, lastSeen: nowIso() });
          this.onEvent?.({ kind: 'updated', sessionId, state });
        } else {
          this.sessions.set(sessionId, { ...prev, lastSeen: nowIso() });
        }
      }
      for (const id of [...this.sessions.keys()]) {
        if (!seen.has(id)) {
          this.sessions.delete(id);
          this.onEvent?.({ kind: 'removed', sessionId: id });
        }
      }
    } catch (err) {
      this.onEvent?.({ kind: 'error', detail: err instanceof Error ? err.message : 'unknown' });
    } finally {
      this.inFlight = false;
    }
  }

  /** Immediate poll, then interval. Timer is unref'd — never keeps us alive. */
  start(): void {
    if (this.timer !== null || this.disposed) return;
    void this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
