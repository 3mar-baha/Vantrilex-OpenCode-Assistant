import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Persistence. A queue that forgets loses a 20-minute test run when the window
 * closes, so state is durable; what is durable is narrow on purpose.
 *
 * DURABLE: id, seq, kind, label, payload, effective timeout, state, timestamps,
 * failure, restoredFrom.
 * NOT DURABLE: the promise, the timeout timer, the AbortController, any output
 * buffer. None of those survive a process and pretending otherwise is how a
 * restart turns into a phantom "running" task.
 *
 * THE WRITE IS ATOMIC: temp file + `renameSync`, the same discipline
 * `FileVault.save` uses in `src/voice/`. A crash mid-write therefore leaves
 * either the previous snapshot or the new one, never a truncated file. The
 * `fs` port is injectable precisely so the failure path is testable — a rename
 * that throws must leave the previous snapshot readable and must not leave its
 * temp file behind.
 *
 * RECOVERY CONTRACT (enforced by `TaskQueue`, not here):
 *  - `queued`  on load → REPLAYED in seq order. The user asked for it and
 *    nothing about the process dying cancels their intent.
 *  - `running` on load → `failed` / `interrupted`. It did not finish, and
 *    "done" is the one state a user would be badly misled by.
 *  - terminal  on load → kept as-is.
 */

/** Snapshot version. Bump on any shape change; `read` rejects what it cannot parse. */
export const SNAPSHOT_VERSION = 1;

/** The node:fs surface this module needs. Injected so failures are testable. */
export interface FsPort {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  unlinkSync(path: string): void;
}

export const nodeFs: FsPort = { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync };

export interface TaskSnapshot {
  readonly v: number;
  readonly tasks: readonly unknown[];
}

export type StoreRead =
  | { readonly ok: true; readonly snapshot: TaskSnapshot | null }
  /** Unreadable or malformed. The queue starts empty and REPORTS this. */
  | { readonly ok: false; readonly error: string };

/** The persistence port. The queue is written against this, never against fs. */
export interface TaskStore {
  read(): StoreRead;
  write(snapshot: TaskSnapshot): void;
}

/** Thrown by a store so the queue can count the failure instead of dying. */
export class TaskStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'TaskStoreError';
  }
}

export class FileTaskStore implements TaskStore {
  private tmpCounter = 0;

  constructor(
    private readonly filePath: string,
    private readonly fs: FsPort = nodeFs,
  ) {}

  read(): StoreRead {
    let raw: string;
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Absent file is the normal first-run case, not an error.
      return { ok: true, snapshot: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `unparseable snapshot: ${(err as Error).message}` };
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== SNAPSHOT_VERSION ||
      !Array.isArray((parsed as { tasks?: unknown }).tasks)
    ) {
      return { ok: false, error: `unsupported snapshot shape (expected v=${SNAPSHOT_VERSION})` };
    }
    return { ok: true, snapshot: { v: SNAPSHOT_VERSION, tasks: (parsed as { tasks: unknown[] }).tasks } };
  }

  write(snapshot: TaskSnapshot): void {
    // Unique per write so two queues on one file (or a crashed leftover) can
    // never clobber each other's temp.
    this.tmpCounter += 1;
    const tmp = `${this.filePath}.${process.pid}.${this.tmpCounter}.tmp`;
    const body = JSON.stringify(snapshot);
    try {
      this.fs.mkdirSync(dirname(this.filePath), { recursive: true });
      this.fs.writeFileSync(tmp, body, 'utf8');
      this.fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Best-effort cleanup of OUR temp only, then rethrow as a typed error so
      // the queue can count it. A leftover temp is cosmetic; a corrupted
      // snapshot is not, which is why the rename happened and not a direct write.
      try {
        this.fs.unlinkSync(tmp);
      } catch {
        /* the temp may never have been created; nothing to clean */
      }
      throw new TaskStoreError(`snapshot write failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

/** In-memory store. Used by FSM tests that have no business touching a disk. */
export class MemoryTaskStore implements TaskStore {
  private snapshot: TaskSnapshot | null = null;
  writes = 0;
  failNext: string | null = null;

  read(): StoreRead {
    return { ok: true, snapshot: this.snapshot };
  }

  write(snapshot: TaskSnapshot): void {
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      throw new TaskStoreError(message);
    }
    this.writes += 1;
    this.snapshot = snapshot;
  }
}
