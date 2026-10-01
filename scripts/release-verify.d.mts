// Type declarations for scripts/release-verify.mjs.
//
// Hand-written for the same reason as the other two .d.mts files: the script is
// plain JS and TypeScript cannot infer across a `.mjs` import under NodeNext.
//
// Everything declared here is a PURE function or a constant. Importing this module
// performs no stage — `RUNNING_AS_CLI` guards everything that installs, launches or
// kills anything — which is what makes it safe for a test to drive the boot verdict
// without a 40-minute Tauri build.

/** A log stream as captured by `snapshotDaemonLogs`. */
export interface StreamSnapshot {
  /** Byte offset and size at snapshot time; `sha` is a content hash. */
  readonly files: Record<string, { readonly offset: number; readonly size: number; readonly sha: string }>;
}

/** One reason stage 6 refused. `code` is stable; `detail` is for the operator. */
export interface BootFailure {
  readonly code:
    | 'stdout-capture-missing'
    | 'stdout-silent'
    | 'stdout-error-marker'
    | 'stderr-capture-missing'
    | 'stderr-not-quiet'
    | 'log-truncated';
  readonly detail: string;
}

export interface BootVerdict {
  readonly ok: boolean;
  /** Every failure, not just the first. */
  readonly failures: BootFailure[];
  /** Positive observations, so a PASS is distinguishable from "nothing checked". */
  readonly notes: string[];
}

/** Every `daemon*.log` in `dir`, including the `-stdout` and `LogPlan::Fallback` forms. */
export declare function daemonLogFiles(dir: string): string[];

/** Byte offset, size and content hash per stream. Absence is recorded as absence. */
export declare function snapshotDaemonLogs(dir: string): StreamSnapshot;

/**
 * The bytes appended to `name` between two snapshots. '' when absent either side.
 *
 * `dir` is explicit rather than read from a module constant so a test can point it
 * at a temp directory; the CLI stages rely on the default.
 */
export declare function logDelta(
  before: StreamSnapshot,
  after: StreamSnapshot,
  name: string,
  dir?: string,
): string;

/**
 * THE STAGE-6 VERDICT. Pure, so it is provable without an installed build.
 *
 * @param readDelta reads what one stream gained; injected so the function does no IO
 */
export declare function evaluateBoot(args: {
  before: StreamSnapshot;
  after: StreamSnapshot;
  readDelta: (name: string) => string;
}): BootVerdict;

/**
 * Archive the runtime dir so a run exercises secret CREATION and the logs judged
 * belong to this boot. Moves, never deletes: `machine.key` decrypts the vault.
 *
 * @returns the archive path, or null when there was nothing to archive
 */
export declare function archiveRuntimeDir(dir: string, stamp: string): string | null;

/**
 * Did any sidecar `node.exe` survive the supervisor's death? That survival means
 * KILL_ON_JOB_CLOSE is not taking effect.
 *
 * @returns null when none survived, else a description of the survivors
 */
export declare function orphanedSidecarProcesses(installDir: string, timeoutMs?: number): string | null;

/** Preflight rows whose MISS stage 2 tolerates: stage 3 produces them. */
export declare const PREFLIGHT_DEFERRABLE: ReadonlySet<string>;

/**
 * Preflight rows whose MISS is a KNOWN FALSE NEGATIVE, settled by probing the
 * environment the row could not reach rather than trusted or ignored.
 */
export declare const PREFLIGHT_FALSE_NEGATIVE: ReadonlySet<string>;

export interface PreflightRow {
  readonly ok: boolean;
  readonly name: string;
  readonly detail: string;
}

/** Parse `packaging-preflight.mjs` output. Empty `rows` means the caller must fail. */
export declare function parsePreflight(out: string): {
  rows: PreflightRow[];
  blocking: string[];
};