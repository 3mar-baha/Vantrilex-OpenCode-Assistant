// Type declarations for scripts/provision-sidecar.mjs.
//
// Hand-written for the same reason as sidecar-payload-audit.d.mts: the script is
// plain JS with JSDoc, and under `moduleResolution: NodeNext` TypeScript cannot
// infer across a `.mjs` import. Every exported function that matters to a test is
// PURE and side-effect-free; the destructive part of the script (rmSync of the
// whole sidecar, the 87 MB node.exe copy, `npm ci`) is behind `RUNNING_AS_CLI`
// and is deliberately not reachable from an import.

import type { AuditOptions, AuditResult } from './sidecar-payload-audit.mjs';

/** One entry of `PRUNED_SUBTREES`: a subtree deliberately not shipped. */
export interface PrunedSubtree {
  /** Payload-relative path, e.g. `runtime/laya`. */
  readonly path: string;
  /** Why it is safe to not ship. Shown in the provision transcript. */
  readonly reason: string;
}

export interface DiffOptions {
  /**
   * Source-relative files INTENTIONALLY absent from the payload, matched by EXACT
   * path. Anything else missing is still reported, and a named file that IS
   * present is reported as `PRUNE NOT APPLIED`.
   */
  readonly expectedAbsent?: readonly string[];
}

/**
 * Compare two trees by CONTENT hash, in both directions.
 *
 * @returns human-readable differences; empty means identical (modulo
 *   `expectedAbsent`).
 */
export declare function diffTrees(
  sourceDir: string,
  targetDir: string,
  opts?: DiffOptions,
): string[];

/**
 * May this declared prune proceed? null = yes.
 *
 * A non-null result means the subtree is reachable from the production roots, so
 * deleting it would remove live code — a dist/ that boots in dev and dies only in
 * an installed build.
 */
export declare function pruneRefusal(entry: PrunedSubtree, unreachable: readonly string[]): string | null;

/** The modules a declared prune covers: those proved unreachable under its path. */
export declare function prunedModulesFor(
  entry: PrunedSubtree,
  unreachable: readonly string[],
): string[];

/**
 * W18's guard as a pure function over two JSON documents.
 *
 * @param lock the parsed committed lockfile, or null when it does not exist
 * @returns every problem; empty means the manifest and lock are usable together.
 *   An unpinned version and a disagreeing lock are reported independently so an
 *   operator fixes them in one pass rather than one per run.
 */
export declare function manifestLockProblems(
  manifest: { name?: string; version?: string; dependencies?: Record<string, string> } | null,
  lock: {
    name?: string; version?: string;
    packages?: Record<string, { dependencies?: Record<string, string> }>;
  } | null,
): string[];

/**
 * Is the payload's node.exe fit to ship? null = yes.
 *
 * Rejects, in order: absent; below 1 MiB; not runnable; reporting a version other
 * than `expectedVersion`. `run` is injected so a test can supply a binary of any
 * shape without copying 87 MB per case.
 */
export declare function nodeExeProblem(
  path: string,
  expectedVersion: string,
  run?: (path: string) => string,
): string | null;

export type { AuditOptions, AuditResult };