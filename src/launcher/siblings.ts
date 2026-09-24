import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Sibling-serve protection (Phase 1) — sibling project daemons register their
// supervised `opencode serve` PIDs so our orphan sweeper never kills them.
// Two channels: in-process SiblingRegistry (same daemon) and heartbeat files
// (cross-process, one JSON per PID). Stale heartbeats expire; corrupt files
// are ignored, never fatal.
export interface SiblingEntry {
  readonly pid: number;
  readonly project: string;
  readonly servePort: number;
}

export interface HeartbeatFile extends SiblingEntry {
  readonly updatedAt: string;
  readonly updatedAtMs: number;
}

/** Three missed 30s heartbeats — matches the sweeper's 60s cadence with margin. */
export const SIBLING_STALE_MS = 90_000;

export function siblingDir(homeDir?: string): string {
  const home = homeDir ?? process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  return join(home, '.opencode-voice-runtime', 'siblings');
}

export class SiblingRegistry {
  private readonly entries = new Map<number, { project: string; servePort: number; updatedAtMs: number }>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  register(pid: number, entry: { project: string; servePort: number }): void {
    this.entries.set(pid, { ...entry, updatedAtMs: this.now() });
  }

  heartbeat(pid: number, nowMs?: number): void {
    const prev = this.entries.get(pid);
    if (prev !== undefined) this.entries.set(pid, { ...prev, updatedAtMs: nowMs ?? this.now() });
  }

  unregister(pid: number): void {
    this.entries.delete(pid);
  }

  isProtected(pid: number, nowMs?: number): boolean {
    const entry = this.entries.get(pid);
    if (entry === undefined) return false;
    return (nowMs ?? this.now()) - entry.updatedAtMs <= SIBLING_STALE_MS;
  }

  list(nowMs?: number): SiblingEntry[] {
    const now = nowMs ?? this.now();
    const out: SiblingEntry[] = [];
    for (const [pid, entry] of this.entries) {
      if (now - entry.updatedAtMs <= SIBLING_STALE_MS) {
        out.push({ pid, project: entry.project, servePort: entry.servePort });
      }
    }
    return out;
  }
}

function siblingFile(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

/** Atomic (tmp + rename) heartbeat write — readers never see torn JSON. */
export function writeHeartbeat(
  dir: string,
  entry: { pid: number; project: string; servePort: number; updatedAt: string },
  nowMs?: number,
): void {
  mkdirSync(dir, { recursive: true });
  const body: HeartbeatFile = { ...entry, updatedAtMs: nowMs ?? Date.now() };
  const tmp = join(dir, `.${entry.pid}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(body), 'utf8');
  renameSync(tmp, siblingFile(dir, entry.pid));
}

export function removeHeartbeat(dir: string, pid: number): void {
  try {
    unlinkSync(siblingFile(dir, pid));
  } catch {
    // already gone — shutdown paths must never throw
  }
}

/** Read live heartbeats; corrupt, mismatched, or stale files are skipped. */
export function readHeartbeats(dir: string, nowMs: number, staleMs: number = SIBLING_STALE_MS): HeartbeatFile[] {
  const out: HeartbeatFile[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match?.[1] === undefined) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<HeartbeatFile>;
      if (parsed.pid !== Number(match[1])) continue;
      if (typeof parsed.project !== 'string' || typeof parsed.servePort !== 'number') continue;
      if (typeof parsed.updatedAtMs !== 'number' || nowMs - parsed.updatedAtMs > staleMs) continue;
      out.push(parsed as HeartbeatFile);
    } catch {
      continue; // torn/corrupt write — the next heartbeat repairs it
    }
  }
  return out;
}

/**
 * Crash hygiene: delete stale heartbeat files (abnormal daemon death leaves
 * them behind). Returns the removed count. Fresh and corrupt-but-unparseable
 * handling: corrupt files are left for their owner to overwrite — prune only
 * removes provably-stale entries.
 */
export function pruneHeartbeats(dir: string, nowMs: number, staleMs: number = SIBLING_STALE_MS): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match?.[1] === undefined) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<HeartbeatFile>;
      if (typeof parsed.updatedAtMs === 'number' && nowMs - parsed.updatedAtMs > staleMs) {
        unlinkSync(join(dir, name));
        removed += 1;
      }
    } catch {
      continue;
    }
  }
  return removed;
}

// --- Sweeper (moved from sweeper.ts; that module now re-exports) ---

export interface SweepResult {
  readonly scannedAt: string;
  readonly liveServePids: number[];
  readonly reaped: number[];
}

export interface SweepOptions {
  /** Sibling/protected PIDs survive regardless of ownership. */
  readonly isProtected?: (pid: number) => boolean;
  /** Heartbeat dir: fresh heartbeats protect live PIDs (crash-safe coordination). */
  readonly heartbeatDir?: string;
  /** Clock override (tests). Defaults to Date.now(). */
  readonly nowMs?: number;
  /** Injectable process enumeration (tests). Default: tasklist on win32. */
  readonly list?: () => Promise<number[]>;
  /** Injectable killer (tests). Default: taskkill /T /F on win32. */
  readonly kill?: (pid: number) => Promise<void>;
}

function tasklistCsv(): Promise<string> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq opencode*', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

async function defaultList(): Promise<number[]> {
  const pids: number[] = [];
  if (process.platform === 'win32') {
    const out = await tasklistCsv();
    for (const line of out.split('\n')) {
      const match = /"opencode[^"]*","(\d+)"/.exec(line);
      if (match?.[1] !== undefined) pids.push(Number(match[1]));
    }
  }
  return pids;
}

async function defaultKill(pid: number): Promise<void> {
  if (process.platform !== 'win32') return;
  await new Promise<void>((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

export async function sweepOrphans(ownedPids: readonly number[], opts: SweepOptions = {}): Promise<SweepResult> {
  const owned = new Set(ownedPids);
  const isProtected = opts.isProtected ?? (() => false);
  const list = opts.list ?? defaultList;
  const kill = opts.kill ?? defaultKill;
  const liveServePids = await list();
  const live = new Set(liveServePids);
  // Heartbeat coordination: a fresh heartbeat protects a PID only while that
  // PID is actually live (recycled-PID guard). Stale or ghost entries protect
  // nothing.
  const heartbeatProtected = new Set<number>();
  if (opts.heartbeatDir !== undefined) {
    const now = opts.nowMs ?? Date.now();
    for (const entry of readHeartbeats(opts.heartbeatDir, now)) {
      if (live.has(entry.pid)) heartbeatProtected.add(entry.pid);
    }
  }
  const reaped: number[] = [];
  for (const pid of liveServePids) {
    if (owned.has(pid) || isProtected(pid) || heartbeatProtected.has(pid)) continue;
    try {
      await kill(pid);
      reaped.push(pid);
    } catch {
      continue; // killer failure never aborts the sweep
    }
  }
  return { scannedAt: new Date().toISOString(), liveServePids, reaped };
}

export function startSweeper(
  ownedPids: () => readonly number[],
  intervalMs = 60_000,
  opts: SweepOptions = {},
): () => void {
  const timer = setInterval(() => {
    void sweepOrphans(ownedPids(), opts);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
