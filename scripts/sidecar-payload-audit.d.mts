// Type declarations for scripts/sidecar-payload-audit.mjs.
//
// Hand-written because the script is plain JS with JSDoc and a `.mjs` extension,
// which TypeScript will not infer across under `moduleResolution: NodeNext`. This
// is NOT a second implementation — it is the shape the exported functions already
// document at their definitions, transcribed so `npm run typecheck:tests` can see
// it. If a function's behaviour changes and this file is not updated, the tests
// that call it through this surface fail to compile, which is the intended signal.

/** One declared dynamic bare-specifier miss. */
export interface DynamicMissingOk {
  /** The bare package name that will not resolve, e.g. `onnxruntime-node`. */
  readonly spec: string;
  /** The payload-relative module that imports it, e.g. `runtime/vad.js`. */
  readonly module: string;
  /** Why the failure is survivable. MUST name a source anchor. */
  readonly reason: string;
}

export interface AuditOptions {
  /** Sidecar root: the directory holding `dist/` and `node_modules/`. */
  payloadDir: string;
  /** The emitted `dist/` to audit. Defaults to `<payloadDir>/dist`. */
  distDir?: string;
  /** Entry points, relative to `distDir`. Defaults to `['cli.js', 'daemon.js']`. */
  entrypoints?: string[];
  /** Bare specifiers that ARE installable. Defaults to what is in `node_modules`. */
  availablePackages?: string[];
}

export interface AuditResult {
  /** True when `fatal` is empty. */
  readonly ok: boolean;
  /** Count of shipped `.js` modules. */
  readonly modules: number;
  /** Count reachable through static edges only. */
  readonly staticReachable: number;
  /** Requested entrypoints absent from the payload. Non-empty means `ok` is false. */
  readonly absentEntrypoints: string[];
  /** Shipped modules no edge reaches from the entrypoints. */
  readonly unreachable: string[];
  /** Every problem. Empty means the payload's graph resolves. */
  readonly fatal: string[];
  /** Declared dynamic misses that were tolerated, with their reasons. */
  readonly allowed: string[];
}

export declare const DYNAMIC_MISSING_OK: DynamicMissingOk[];

/** Remove comments; preserve string and template bodies verbatim. */
export declare function stripComments(src: string): string;

/** Static specifiers and dynamic specifiers, separately. */
export declare function specifiersOf(source: string): { static: string[]; dynamic: string[] };

/**
 * Classify every static import in the payload by reachability and resolvability.
 *
 * @returns fatal when a statically reachable import does not resolve (the v0.6.0
 *   shape), when an UNREACHABLE module carries an unresolvable import (a landmine),
 *   when a relative target is absent, or when an entrypoint does not exist. A
 *   dynamically reached miss is fatal unless it is in `DYNAMIC_MISSING_OK`.
 */
export declare function auditPayload(opts: AuditOptions): AuditResult;