import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { redactString, REDACTION_MARKER } from '../common/logger.js';
import { loadConfig } from '../common/config.js';
import { probeHealth } from '../launcher/index.js';
import { UI_SUBPROTOCOL } from '../ipc/protocol.js';
import { KEY_POOLS, FileVault, type KeyPool } from '../voice/vault.js';
import { readKeyPools } from '../voice/key-store.js';

// M5 — `doctor --bundle`: one redacted JSON artifact for a PUBLIC ticket.
//
// WHY THE SHAPE IS WHAT IT IS.
//
// 1. NO `daemon.ts` import, and nothing that starts a daemon. This artifact is
//    most needed when the daemon is DOWN; asking the composition root "is the
//    daemon down?" is the inversion that makes today's diagnosis hand-
//    assembled. `bundle.test.ts` pins the absence against the file's own text,
//    with a positive control so the guard cannot pass on a renamed import.
//
// 2. SCHEMA. Every declared key is ALWAYS present, and an unavailable source is
//    `null`. A consumer diffing two bundles must be able to tell "this run could
//    not read the vault" from "the vault held no keys" by reading a VALUE, not by
//    testing whether a key exists. A source that THROWS yields `null`; a source
//    that reports a problem yields a populated entry carrying the error — the
//    two are different failures and collapsing them would lose one of them.
//
// 3. REDACTION at the READ BOUNDARY, per line. `opencode.log` is upstream
//    stdout captured by the Rust supervisor: it never passed through
//    `UiServer.notice()` or any other sink, so a sink-level scrub would miss it
//    completely. Per line is also what makes a bad line survivable —
//    `[REDACTION-REFUSED]` replaces THAT line and the rest of the file still ships.
//
// 4. `docsVerify` runs LIVE with `--json`. A remembered result would put a lie
//    in a public ticket, which is the exact failure class this repo keeps
//    finding. `skipped` is legitimate in an installed payload (no `scripts/`
//    ships) and is labelled informational.
//
// 5. `parseDoctorFlags` exists because `doctor` read bare `argv[3]`. The no-flag
//    path must reach the untouched `doctor()` in `cli.ts`; a diagnostics flag
//    that alters the legacy output is a regression wearing a feature's clothes.

// ── constants ───────────────────────────────────────────────────────────────

export const BUNDLE_SCHEMA_VERSION = 1;

/** The five runtime files the supervisor maintains, in the order an operator reads them. */
export const LOG_FILES = [
  'daemon.log',
  'daemon-stdout.log',
  'opencode.log',
  'opencode-stdout.log',
  'supervisor.log',
] as const;

export const TELEMETRY_FILE = 'voice-runtime.jsonl';

/**
 * A key shorter than this is not fingerprinted, and the reason is arithmetic
 * rather than caution: `sha256:<10 hex>` is a 40-bit prefix, which reveals
 * nothing about a 128-bit key and is a dictionary lookup against a 4-byte one.
 * The floor keeps "we could not fingerprint it" and "we fingerprinted a guessable
 * value" as two different answers.
 */
export const KEY_ENTROPY_FLOOR_BYTES = 16;

const MAX_LOG_LINES = 200;
const MAX_LINE_CHARS = 2000;
const MAX_TELEMETRY_ROWS = 50;
const REFUSED = '[REDACTION-REFUSED]';

/** The contract version this build speaks; mirrors `ui-server`'s default. */
export const UI_CONTRACT_VERSION = '3.1.0';

/**
 * Control bytes that are neither whitespace nor text. Tab, CR and LF are
 * EXCLUDED deliberately — a log line legitimately contains them, and calling a
 * line binary because it has a tab would flag every real file.
 */
/** Control characters are exactly what this bundle has to find, so `no-control-regex`
 *  is inverted for these two lines — a rule that forbids the character class
 *  would forbid the detector. `slash.ts` carries the same class for the same
 *  reason; the disables there are the audit's pre-existing baseline, not a
 *  precedent for adding more without cause. */
const CONTROL_BYTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g; // oxlint-disable-line no-control-regex
const HAS_CONTROL_BYTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/; // oxlint-disable-line no-control-regex

// ── CLI flags ───────────────────────────────────────────────────────────────

export interface DoctorFlags {
  readonly bundle: boolean;
  readonly json: boolean;
  readonly out: string | null;
  readonly unknown: readonly string[];
  /** Non-null means the invocation is a usage error. Reported, never thrown. */
  readonly error: string | null;
  /** True only when the untouched legacy `doctor()` must run. */
  readonly legacy: boolean;
}

/**
 * Parse `doctor`'s flags. `argv` is `process.argv.slice(3)`.
 *
 * A bare call is the no-flag invocation and must return `legacy: true` WITHOUT
 * throwing: a crash here would take the working `doctor` output down with the
 * new feature, and a caller that forgot to slice argv would get exactly that.
 */
export function parseDoctorFlags(argv: readonly string[] = []): DoctorFlags {
  let bundle = false;
  let json = false;
  let out: string | null = null;
  const unknown: string[] = [];
  let error: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === '') continue;
    if (arg === '--bundle') {
      bundle = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--bundle-out') {
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('--')) {
        // Reported, not ignored: silently dropping it would make
        // `doctor --bundle --bundle-out` look like it wrote a file.
        error = `--bundle-out requires a path (argv[${i + 3}] was ${next === undefined ? 'end of argv' : `"${next}"`})`;
        out = null;
      } else {
        out = next;
      }
      i += 1;
    } else {
      unknown.push(arg);
      error = `unknown flag: ${arg}`;
    }
  }

  // A usage error always takes over: reporting the legacy report for
  // `doctor --bunlde` would send the operator off reading a healthy system. A
  // `--bundle-out` path takes over too — honouring the path and nothing else
  // would be the worst of both readings.
  const legacy = unknown.length === 0 && error === null && !bundle && !json && out === null;
  return { bundle, json, out, unknown, error, legacy };
}

// ── schema ──────────────────────────────────────────────────────────────────

export type PortRole = 'serve' | 'ui-bridge';

export type PortRefusal =
  | 'none'
  | 'not-probed'
  | 'unreachable'
  | 'timeout'
  | 'unauthenticated'
  | 'not-our-contract'
  | 'unexpected-status'
  | 'no-credential'
  | 'probe-error';

export interface PortEntry {
  readonly role: PortRole;
  readonly port: number;
  readonly bindAddress: string;
  readonly ownerPid: number | null;
  readonly bound: boolean;
  readonly probe: 'serve-health' | 'ui-ws-handshake' | 'none';
  readonly healthy: boolean;
  /** HTTP status for 4096, WS handshake status for 4097. `null` = never spoke. */
  readonly status: number | null;
  readonly refusal: PortRefusal;
  readonly detail: string | null;
}

export type DaemonClassification = 'Cold' | 'Ours' | 'Foreign';

export interface BringUpMirror {
  readonly derivedBy: 'cli';
  readonly action: 'spawn' | 'adopt' | 'refuse';
  /** Always false: the shell's decision is authoritative; this mirrors it. */
  readonly authoritative: false;
}

export interface DaemonEntry {
  readonly ownerMarkerPresent: boolean;
  readonly ownerMarkerError: string | null;
  readonly pid: number | null;
  readonly ipcPort: number | null;
  readonly contractVersion: string | null;
  readonly ownerKeyMatch: boolean | null;
  readonly pidAlive: boolean | null;
  readonly classification: DaemonClassification;
  readonly reason: string;
  readonly expectedContractVersion: string;
  readonly contractMatches: boolean | null;
  readonly bringUp: BringUpMirror | null;
}

export interface ConfigEntry {
  readonly servePort: number | null;
  readonly voice: string | null;
  readonly briefings: string | null;
  readonly mic: string | null;
  readonly captureMode: string | null;
  readonly sttModel: string | null;
  readonly ttsModel: string | null;
  readonly brainModel: string | null;
  readonly brainGoldenMs: number | null;
  readonly brainCeilingMs: number | null;
  readonly logLevel: string | null;
  readonly vadModelPath: string | null;
  readonly vadThreshold: number | null;
  /** Presence ONLY. A value here is the leak this module exists to prevent. */
  readonly envPresent: Readonly<Record<string, boolean>>;
  readonly error: string | null;
}

export interface KeyFingerprint {
  readonly index: number;
  readonly fingerprint: string | null;
  readonly reason?: 'below-entropy-floor';
}

export interface KeyPoolEntry {
  readonly pool: KeyPool;
  readonly count: number;
  readonly fingerprints: readonly KeyFingerprint[];
  readonly suppressedByEntropyFloor: number;
  readonly undecryptable: boolean;
}

export interface KeysEntry {
  readonly path: string | null;
  readonly present: boolean;
  readonly error: string | null;
  readonly entropyFloorBytes: number;
  readonly pools: readonly KeyPoolEntry[];
  readonly undecryptable: readonly string[];
  readonly total: number;
}

export interface LogEntry {
  readonly name: string;
  readonly path: string;
  readonly present: boolean;
  readonly bytes: number | null;
  readonly lineCount: number | null;
  readonly included: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly lines: readonly string[];
  readonly scrubbed: number;
  readonly refused: number;
  readonly error: string | null;
}

export interface TelemetryRow {
  readonly timestamp: string | null;
  readonly seq: number | null;
  readonly subsystem: string | null;
  readonly status: string | null;
  readonly latencyMs: number | null;
  readonly errorCode: string | null;
  readonly sanitizedErrorClass: string | null;
  readonly remediationAttempted: string | null;
  readonly unparsed: boolean;
  /** Only for an unparsed (torn) row: the scrubbed text, kept as evidence. */
  readonly raw: string | null;
}

export interface TelemetryEntry {
  readonly path: string | null;
  readonly present: boolean;
  readonly error: string | null;
  readonly totalRows: number | null;
  readonly returned: number;
  readonly codeHistogram: Readonly<Record<string, number>>;
  readonly subsystemHistogram: Readonly<Record<string, number>>;
  readonly statusHistogram: Readonly<Record<string, number>>;
  readonly firstFaultAt: string | null;
  readonly daysSinceFirstFault: number | null;
  readonly rows: readonly TelemetryRow[];
}

export type DocsVerifyStatus = 'ran' | 'skipped' | 'failed';

export interface DocsVerifyEntry {
  readonly status: DocsVerifyStatus;
  /** True only for `skipped`: informational, never a failure. */
  readonly informational: boolean;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly total: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly unverified: number | null;
  readonly failures: readonly string[];
  readonly durationMs: number | null;
}

export interface RedactionEntry {
  readonly scanned: number;
  readonly scrubbed: number;
  readonly refused: number;
  readonly wholeBundleSafe: boolean;
}

export interface DiagnosticBundle {
  readonly schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  readonly tool: 'voxaura-doctor-bundle';
  readonly generatedAt: string;
  readonly outcome: 'healthy' | 'degraded' | 'collection-failed';
  readonly exitCode: 0 | 1 | 2;
  readonly header: {
    readonly pasteSafe: boolean;
    readonly note: string;
    readonly redactionMarker: string;
    readonly refusedMarker: string;
  };
  readonly runtime: { readonly dir: string | null; readonly node: string; readonly platform: string };
  readonly paths: {
    readonly vault: string | null;
    readonly ipcToken: string | null;
    readonly ownerMarker: string | null;
  };
  readonly ports: readonly PortEntry[];
  readonly daemon: DaemonEntry | null;
  readonly config: ConfigEntry | null;
  readonly keys: KeysEntry | null;
  readonly telemetry: TelemetryEntry | null;
  readonly docsVerify: DocsVerifyEntry | null;
  readonly logs: readonly LogEntry[];
  readonly redactions: RedactionEntry;
  readonly notes: readonly string[];
}

export interface CollectResult {
  readonly bundle: DiagnosticBundle;
  readonly outcome: DiagnosticBundle['outcome'];
  readonly exitCode: DiagnosticBundle['exitCode'];
  readonly notes: readonly string[];
}

/** Thrown by the whole-bundle tripwire. Never escapes `collectBundle`. */
export class RedactionTrip extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionTrip';
  }
}

// ── injectable sources ──────────────────────────────────────────────────────

export interface ServeProbeResult {
  readonly healthy: boolean;
  readonly status: number | null;
  readonly refusal: PortRefusal;
  readonly detail: string | null;
}

export interface UiProbeResult {
  readonly bound: boolean;
  readonly healthy: boolean;
  readonly status: number | null;
  readonly refusal: PortRefusal;
  readonly detail: string | null;
}

export interface OwnerMarkerRead {
  readonly present: boolean;
  readonly raw: string | null;
  readonly error: string | null;
}

export interface KeysRead {
  readonly path: string;
  readonly present: boolean;
  readonly error: string | null;
  readonly pools: readonly {
    readonly pool: KeyPool;
    readonly count: number;
    /** Read, then immediately hashed. Never stored on anything serialisable. */
    readonly material: readonly string[];
    readonly undecryptable: boolean;
  }[];
}

export interface TelemetryRead {
  readonly path: string;
  readonly present: boolean;
  readonly error: string | null;
  readonly text: string;
}

export interface DocsVerifyRun {
  readonly status: DocsVerifyStatus;
  readonly informational: boolean;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly total: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly unverified: number | null;
  readonly failures: readonly string[];
  readonly durationMs: number | null;
}

export interface BundleSources {
  readonly now: () => number;
  readonly runtimeDir: string | null;
  readonly ports: readonly { readonly role: PortRole; readonly port: number }[];
  readonly servePassword: string;
  readonly ipcToken: string;
  /** The install identity the SHELL holds. `null` when the CLI cannot know it. */
  readonly ownerKey?: string | null;
  readonly paths?: { vault: string | null; ipcToken: string | null; ownerMarker: string | null };
  readonly probeServe: ((port: number, password: string) => Promise<ServeProbeResult>) | null;
  readonly probeUiBridge: ((port: number, token: string) => Promise<UiProbeResult>) | null;
  readonly readConfig: (() => ConfigEntry) | null;
  readonly readKeys: (() => KeysRead) | null;
  readonly readOwnerMarker: (() => OwnerMarkerRead) | null;
  readonly readTextFile: ((path: string) => string | null) | null;
  readonly readTelemetry: (() => TelemetryRead) | null;
  readonly runDocsVerify: (() => Promise<DocsVerifyRun>) | null;
  readonly pidAlive: ((pid: number) => boolean) | null;
}

// ── redaction ───────────────────────────────────────────────────────────────

/**
 * Case-insensitive sweep for the live provider prefixes.
 *
 * MEASURED, and the reason this exists instead of a bare `redactString` call:
 * the shared redactor's prefix patterns carry no `i` flag, so `SK-OR-V1-AAAA…`
 * passes through `redactString` untouched — and through `containsSecret` too,
 * which is why the tripwire below runs its own case-insensitive scan instead of
 * trusting `containsSecret` to notice. An uppercased key in a log line is
 * uncommon but real, and this artifact is designed for a public ticket.
 */
function sweepCaseInsensitive(input: string): string {
  let out = input;
  out = out.replace(/sk-or-v1-[A-Za-z0-9_-]{8,}/gi, REDACTION_MARKER);
  out = out.replace(/sk-fish-[A-Za-z0-9_-]{8,}/gi, REDACTION_MARKER);
  out = out.replace(/gsk_[A-Za-z0-9]{8,}/gi, REDACTION_MARKER);
  return out;
}

export interface ScrubbedLine {
  readonly text: string;
  readonly scrubbed: boolean;
  readonly refused: boolean;
  readonly capped: boolean;
  readonly binary: boolean;
}

/**
 * Scrub ONE line at the read boundary.
 *
 * Order is load-bearing:
 *  1. `redactString` — the project's shared redactor, quoted-value aware;
 *  2. the case-insensitive sweep — the hole step 1 leaves;
 *  3. the control-byte replacement and the character cap;
 *  4. the residual check.
 *
 * The cap comes AFTER the scrub on purpose. Capping first could cut a secret in
 * half, and a half-secret matches no pattern, so the residue would be invisible
 * to step 4 and would ship. Scrubbing first costs a longer intermediate string
 * and makes the residue detectable.
 *
 * Step 4 emits `[REDACTION-REFUSED]`. A bundle that refuses to exist is worse
 * than one missing a line, so only THAT line is replaced and the rest of the
 * file is still collected.
 */
export function scrubLogLine(raw: string): ScrubbedLine {
  const binary = HAS_CONTROL_BYTES.test(raw);
  const first = redactString(raw);
  const second = sweepCaseInsensitive(first);
  const scrubbed = first !== raw || second !== first;
  let text = binary ? second.replace(CONTROL_BYTES, '\uFFFD') : second;
  const capped = text.length > MAX_LINE_CHARS;
  if (capped) text = text.slice(0, MAX_LINE_CHARS);
  if (hasResidualMaterial(text)) {
    // Residual MATERIAL: this line cannot be proven safe, so it does not ship.
    return { text: REFUSED, scrubbed, refused: true, capped, binary };
  }
  return { text, scrubbed, refused: false, capped, binary };
}

// ── fingerprinting ──────────────────────────────────────────────────────────

/**
 * Structural rule: key material only ever enters `createHash`.
 *
 * `material` is a function PARAMETER, not a field on any object that is ever
 * handed to `JSON.stringify`, so no reference to the plaintext can reach the
 * artifact. That is why this is a helper taking the array instead of an inline
 * `pool.material.map(...)` in the collector: the array is a local that dies with
 * the call, and the only thing that escapes is a fingerprint.
 */
function fingerprintsOf(material: readonly string[]): {
  readonly fingerprints: KeyFingerprint[];
  readonly suppressed: number;
} {
  const fingerprints: KeyFingerprint[] = [];
  let suppressed = 0;
  for (const [index, secret] of material.entries()) {
    if (Buffer.byteLength(secret) < KEY_ENTROPY_FLOOR_BYTES) {
      fingerprints.push({ index, fingerprint: null, reason: 'below-entropy-floor' });
      suppressed += 1;
      continue;
    }
    const digest = createHash('sha256').update(secret).digest('hex').slice(0, 10);
    fingerprints.push({ index, fingerprint: `sha256:${digest}` });
  }
  return { fingerprints, suppressed };
}

// ── the whole-bundle tripwire ───────────────────────────────────────────────

/**
 * Does `text` still hold key MATERIAL?
 *
 * Deliberately NOT `containsSecret(text)`, and the reason is measured rather
 * than theoretical: `containsSecret('apiKey=[REDACTED]')` is TRUE. The shared
 * redactor preserves the field label, and the marker is itself a legal value
 * for the assignment pattern, so the very check meant to confirm a clean line
 * rejects it. A whole-bundle `containsSecret === false` assertion — which is
 * what the brief asked for verbatim — is therefore unsatisfiable for a
 * correctly redacted bundle.
 *
 * So the invariant is checked as what it means: no material.
 *  - provider prefixes, case-insensitively (the shared patterns have no `i`
 *    flag, so `containsSecret` would miss an uppercased key entirely);
 *  - a Bearer/Basic credential that is not already the marker;
 *  - an assignment whose VALUE is non-empty and is not the marker.
 *
 * The assignment branch parses the value itself instead of testing the whole
 * line, which is what makes it immune to the JSON-quoting artefact: in
 * `{"apiKey="]}` the value alternation would otherwise match across a distant
 * quote and report a secret that is not there.
 */
const ASSIGNMENT_SCAN =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|auth)\b["']?\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|[^\s,;)}\]]+)/gi;

/** Marker text, brackets, quotes and separators: noise around a redacted value. */
const NOISE = /[[\]"'\s,;)}]*/g;

function isNoiseOnly(value: string): boolean {
  // The bracket is optional on purpose: the assignment value class stops at the
  // first `]`, so an unquoted redacted value arrives as `[REDACTED` — the marker
  // minus its closing bracket. Requiring both would classify a correctly
  // scrubbed `apiKey=[REDACTED]` as residual material and refuse the line.
  return value.replace(/\[?REDACTED\]?/g, '').replace(NOISE, '') === '';
}

/**
 * Exported because it is the ORACLE, not an internal detail: a consumer
 * assembling a different artifact (a support page, a CI annotation) needs the
 * same material-level check, and re-implementing "does this still hold a key?"
 * is how two tools end up disagreeing about what is safe to publish.
 */
export function hasResidualMaterial(text: string): boolean {
  // 1. Provider prefixes, in ANY case.
  if (sweepCaseInsensitive(text) !== text) return true;
  // 2. A Bearer/Basic credential that is not already the marker.
  if (/Bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{4,}/i.test(text)) return true;
  if (/Basic\s+(?!\[REDACTED)[A-Za-z0-9+/=]{8,}/i.test(text)) return true;
  // 3. An assignment whose value holds more than the marker.
  ASSIGNMENT_SCAN.lastIndex = 0;
  for (let m = ASSIGNMENT_SCAN.exec(text); m !== null; m = ASSIGNMENT_SCAN.exec(text)) {
    const value = (m[2] ?? '').replace(/^["']|["']$/g, '');
    if (value.length > 0 && !isNoiseOnly(value)) return true;
  }
  // A fourth check used to live here: the ESCAPE ARTEFACT, which detected the
  // shape `'"[REDACTED]"' <4+ chars>` left behind when the shared redactor cut a
  // JSON value short at an inner quote. That defect is FIXED (`0b11ba9` made the
  // quoted-value alternative consume escapes, and the bracketed alternative now
  // consumes `]` too), and the check has become actively harmful: a quoted marker
  // followed by an ordinary word — `"[REDACTED]"auth`, which is what a
  // `"key":"value","kind":"auth"` fragment reduces to — matches it and refuses a
  // line that is perfectly clean. A guard for a fixed bug, firing on good input,
  // is worse than no guard: it trains the reader to ignore refusals. The
  // regression it watched for is now pinned in `logger.test.ts` instead, at the
  // place where it can actually happen.
  return false;
}

/**
 * Assert the FINISHED bundle carries no key material.
 *
 * Runs on the whole serialised document, not per source, because a source that
 * bypasses the read-boundary scrub is only catchable here. It never throws out
 * of `collectBundle`: the trip is converted into a `collection-failed` result
 * with the schema intact, so a consumer can still parse the failure.
 */
export function assertRedactionSafe(bundle: unknown): void {
  const text = JSON.stringify(bundle) ?? '';
  if (hasResidualMaterial(text)) {
    throw new RedactionTrip(
      'diagnostic bundle still contains key material after redaction — refusing to emit it',
    );
  }
}

/** Stable, pretty-printed rendering. Deterministic for a fixed clock. */
export function renderBundle(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}

// ── probes ──────────────────────────────────────────────────────────────────

/**
 * 4096 via the existing `probeHealth`, PLUS the status code.
 *
 * The code is the point. `probeHealth` returns a boolean, and `false` is
 * ambiguous between "nothing is listening" and "something is listening and
 * rejected our password" — different diagnoses, and the second is the L17
 * signature of a present-but-unusable credential. So the boolean decides health
 * and the code decides the reason; both go in the artifact.
 *
 * `probeHealth` is INJECTED so the probe is testable on an ephemeral port
 * without a real serve process.
 */
export async function probeServePort(options: {
  readonly port: number;
  readonly password: string;
  readonly timeoutMs?: number;
  readonly probeHealth?: (port: number, password: string, timeoutMs?: number) => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
}): Promise<ServeProbeResult> {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (options.password.length === 0) {
    // No password → no Authorization header is sent at all. Sending
    // `Basic opencode:` would produce a 401 that reads as a WRONG password when
    // the truth is that none was available.
    return { healthy: false, status: null, refusal: 'no-credential', detail: 'no serve password available' };
  }
  const health = options.probeHealth ?? ((p, pw, t) => probeHealth(p, pw, t));
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const healthy = await health(options.port, options.password, timeoutMs);
    let status: number | null = null;
    try {
      const res = await doFetch(`http://127.0.0.1:${options.port}/api/session`, {
        headers: { Authorization: basicServeAuth(options.password) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
    } catch {
      status = null;
    }
    const refusal: PortRefusal = healthy
      ? 'none'
      : status === null
        ? 'unreachable'
        : status === 401
          ? 'unauthenticated'
          : status >= 200 && status < 300
            ? 'probe-error'
            : 'unexpected-status';
    return {
      healthy,
      status,
      refusal,
      detail:
        healthy || status === null ? null : `probeHealth said unhealthy; /api/session answered HTTP ${status}`,
    };
  } catch (err) {
    return { healthy: false, status: null, refusal: 'probe-error', detail: safeMessage(err) };
  }
}

function basicServeAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/** RFC 6455 §1.3 test vector; the accept key below is derived from it. */
const WS_TEST_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * 4097 via an AUTHENTICATED WebSocket handshake over a raw `net.Socket`.
 *
 * CONFIRMED, not guessed — the roadmap flagged this UNVERIFIED. Three routes
 * were measured against a real `UiServer` on an ephemeral port:
 *
 *  - `fetch`: has no `Sec-WebSocket-Protocol` option at all, so it cannot
 *    present the bearer and cannot answer the question.
 *  - global `WebSocket` (Node 22+): it DOES take subprotocols and the server
 *    accepts the handshake, but a failure surfaces as a bare `error` event with
 *    no status, so 401 (bearer rejected) and 400 (wrong path/version) are
 *    indistinguishable. Both mean "not ours" and they are worth telling apart.
 *  - raw `net.Socket`: returns the exact status line, so the refusal is
 *    three-way. Implemented here.
 *
 * `wsAccept` is derived locally rather than imported from `ui-server.ts`:
 * there it is module-private, and this milestone is scoped to zero edits under
 * `src/ipc/`. The RFC 6455 §1.3 vector is asserted in the test so the
 * derivation cannot drift silently.
 */
export async function probeUiBridgeHandshake(options: {
  readonly port: number;
  readonly token: string;
  readonly timeoutMs?: number;
}): Promise<UiProbeResult> {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (options.token.length === 0) {
    return { bound: false, healthy: false, status: null, refusal: 'no-credential', detail: 'no IPC token available' };
  }
  return new Promise<UiProbeResult>((settle) => {
    const socket = connect(options.port, '127.0.0.1');
    let done = false;
    const finish = (result: UiProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
      settle(result);
    };
    const timer = setTimeout(
      () => finish({ bound: true, healthy: false, status: null, refusal: 'timeout', detail: `no response within ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref();
    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        bound: false,
        healthy: false,
        status: null,
        refusal: err.code === 'ECONNREFUSED' ? 'unreachable' : 'probe-error',
        detail: err.code ?? safeMessage(err),
      });
    });
    socket.on('connect', () => {
      socket.write(
        [
          'GET /v1/ui HTTP/1.1',
          `Host: 127.0.0.1:${options.port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${WS_TEST_KEY}`,
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Protocol: ${UI_SUBPROTOCOL}, ${options.token}`,
          'Last-Seq: 0',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      const head = chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const statusLine = head.split('\r\n')[0] ?? '';
      const raw = /^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1];
      const status = raw === undefined ? null : Number.parseInt(raw, 10);
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1] ?? null;
      const acceptOk = accept === wsAccept(WS_TEST_KEY);
      finish({
        bound: true,
        healthy: status === 101 && acceptOk,
        status,
        refusal:
          status === 101
            ? acceptOk
              ? 'none'
              : 'not-our-contract'
            : status === 401
              ? 'unauthenticated'
              : status === 400
                ? 'not-our-contract'
                : 'unexpected-status',
        detail: status === 101 && acceptOk ? null : statusLine,
      });
    });
  });
}

function safeMessage(err: unknown): string {
  return redactString(err instanceof Error ? err.message : String(err));
}

function readSecretFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

// ── default wiring ──────────────────────────────────────────────────────────

export interface DefaultSourceOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
  readonly readTextFile: (path: string) => string | null;
  /** Overrides the resolved `scripts/docs-verify.mjs`. */
  readonly docsVerifyScript?: string;
  /** Overrides the env-derived ports. This is what makes the probes testable on
   *  ephemeral ports without a second code path — the fixed-port topology is the
   *  whole reason a squatter on 4097 is dangerous, so a test must not silently
   *  probe 4096/4097 for real. */
  readonly ports?: readonly { readonly role: PortRole; readonly port: number }[];
}

export interface DefaultSources extends BundleSources {
  readonly vaultPath: string;
  readonly ipcTokenPath: string;
  /** The `docs:verify` this build would run. Reported so `skipped` is
   *  distinguishable from "we looked in the wrong place". */
  readonly docsVerifyScript: string;
}

/**
 * Resolve the same paths the daemon and the shell resolve.
 *
 * `VOICE_RUNTIME_DIR` is the Rust supervisor's override (`runtime_dir()` in
 * `main.rs`); the vault precedence mirrors `vaultPathFromEnv` in `daemon.ts` —
 * `VOXAURA_VAULT_PATH`, then `VOXAURA_VAULT_DIR/keyring.dat`, then
 * `<cwd>/vault/keyring.dat`. The test asserts all of it against the daemon's OWN
 * exported resolvers, because a mirror that drifts is a wrong answer presented
 * confidently.
 *
 * The daemon's own `vaultPathFromEnv` is deliberately NOT called, for the
 * same reason as everything else in this file: the daemon is the thing most
 * likely to be down.
 */
export function defaultBundleSources(options: DefaultSourceOptions): DefaultSources {
  const { env, cwd, home } = options;
  const runtimeDir = env['VOICE_RUNTIME_DIR'] ?? join(home, '.opencode-voice-runtime');
  const vaultPath =
    env['VOXAURA_VAULT_PATH'] ?? join(env['VOXAURA_VAULT_DIR'] ?? join(cwd, 'vault'), 'keyring.dat');
  const ipcTokenPath = join(runtimeDir, 'ipc.token');
  const ownerMarkerPath = join(runtimeDir, 'daemon.owner');
  const override = options.docsVerifyScript;
  const docsVerifyScript =
    override ??
    join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'scripts', 'docs-verify.mjs');

  return {
    now: () => Date.now(),
    runtimeDir,
    vaultPath,
    ipcTokenPath,
    docsVerifyScript,
    paths: { vault: vaultPath, ipcToken: ipcTokenPath, ownerMarker: ownerMarkerPath },
    ports: options.ports ?? [
      { role: 'serve', port: intOr(env['OPENCODE_PORT'], 4096) },
      { role: 'ui-bridge', port: intOr(env['VOICE_IPC_PORT'], 4097) },
    ],
    servePassword: env['OPENCODE_SERVER_PASSWORD'] ?? readSecretFile(join(runtimeDir, 'serve.pass')),
    ipcToken: env['VOICE_RUNTIME_IPC_TOKEN'] ?? readSecretFile(ipcTokenPath),
    ownerKey: env['VOXAURA_OWNER_KEY'] ?? readSecretFile(join(runtimeDir, 'owner.key')),
    probeServe: async (port, password) => probeServePort({ port, password }),
    probeUiBridge: async (port, token) => probeUiBridgeHandshake({ port, token }),
    readConfig: () => configFromEnv(env),
    readKeys: () => {
      try {
        const pools = readKeyPools(new FileVault(vaultPath));
        return {
          path: vaultPath,
          present: existsSync(vaultPath),
          error: null,
          pools: KEY_POOLS.map((pool) => ({
            pool,
            count: pools[pool].length,
            material: pools[pool],
            undecryptable: false,
          })),
        };
      } catch (err) {
        // A vault that will not decrypt is the single most useful thing a
        // bundle can say, so the pools stay declared and empty rather than
        // absent — the schema rule is a present key, and "readable, no keys" is a
        // different answer from "unreadable".
        return {
          path: vaultPath,
          present: existsSync(vaultPath),
          error: safeMessage(err),
          pools: KEY_POOLS.map((pool) => ({ pool, count: 0, material: [] as string[], undecryptable: true })),
        };
      }
    },
    readOwnerMarker: () => {
      try {
        return { present: existsSync(ownerMarkerPath), raw: readFileSync(ownerMarkerPath, 'utf8'), error: null };
      } catch (err) {
        return { present: existsSync(ownerMarkerPath), raw: null, error: safeMessage(err) };
      }
    },
    readTextFile: options.readTextFile,
    readTelemetry: () => {
      const path = join(runtimeDir, TELEMETRY_FILE);
      let text: string | null = null;
      let error: string | null = null;
      try {
        text = options.readTextFile(path);
      } catch (err) {
        error = safeMessage(err);
      }
      return { path, present: text !== null, error, text: text ?? '' };
    },
    runDocsVerify:
      override === undefined && insideTestRun()
        ? skipInsideTestRun
        : () => runDocsVerifyProcess(docsVerifyScript),
    pidAlive: isProcessAlive,
  };
}

/**
 * True when this process is a test run.
 *
 * MEASURED, and the reason for the guard in `defaultBundleSources`: the
 * `docs:verify` gate derives its test-count claims by RUNNING the suite, and
 * the suite includes the tests for this module. A bundle collected from inside
 * `vitest run` therefore re-enters docs:verify, which re-enters the suite,
 * which re-enters docs:verify — observed here as a fork bomb that reached ~120
 * node processes before it was killed. The guard applies only when the script
 * is the repository's own; an explicit `docsVerifyScript` override is the
 * caller saying they know what they are pointing at.
 */
export function insideTestRun(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return env['VITEST'] !== undefined || /vitest/i.test(argv[1] ?? '');
}

function skipInsideTestRun(): Promise<DocsVerifyRun> {
  return Promise.resolve({
    status: 'skipped',
    informational: true,
    reason: 'docs-verify is not run from inside a test run (it runs the suite, which would re-enter it)',
    exitCode: null,
    total: null,
    passed: null,
    failed: null,
    unverified: null,
    failures: [],
    durationMs: null,
  });
}

function intOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function configFromEnv(env: NodeJS.ProcessEnv): ConfigEntry {
  try {
    const cfg = loadConfig(env);
    return {
      servePort: cfg.serve.port,
      voice: cfg.voice.default,
      briefings: cfg.briefings,
      mic: cfg.capture.micDefault,
      captureMode: cfg.capture.mode,
      sttModel: cfg.voice.sttModel,
      ttsModel: cfg.voice.ttsModel,
      // The LLM slugs live in `coordinator.ts`/`narrator.ts`/`brain.ts`; pulling
      // those modules in to read three constants would drag the planner graph
      // into a diagnostics run, so the field is declared and reported as null
      // rather than guessed.
      brainModel: null,
      brainGoldenMs: cfg.voice.brainGoldenMs,
      brainCeilingMs: cfg.voice.brainCeilingMs,
      logLevel: cfg.logLevel,
      vadModelPath: cfg.vad.modelPath,
      vadThreshold: cfg.vad.threshold,
      envPresent: presenceOf(env),
      error: null,
    };
  } catch (err) {
    // A malformed env var must not cost the rest of the artifact.
    return { ...EMPTY_CONFIG, envPresent: presenceOf(env), error: safeMessage(err) };
  }
}

/** Env PRESENCE, never env values. */
function presenceOf(env: NodeJS.ProcessEnv): Record<string, boolean> {
  const names = [
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_PORT',
    'VOICE_IPC_PORT',
    'VOICE_RUNTIME_IPC_TOKEN',
    'VOXAURA_OWNER_KEY',
    'VOXAURA_MACHINE_KEY',
    'VOXAURA_VAULT_DIR',
    'VOXAURA_VAULT_PATH',
    'VOICE_RUNTIME_DIR',
    'GROQ_API_KEYS',
    'FISH_AUDIO_KEYS',
    'OPENROUTER_API_KEYS',
  ];
  const out: Record<string, boolean> = {};
  for (const name of names) out[name] = (env[name] ?? '').length > 0;
  return out;
}

/**
 * Run `docs-verify.mjs --json` LIVE.
 *
 * Never a cached or remembered result: a remembered "docs verify passed" is a
 * claim nobody re-derived, which is the exact failure this artifact exists to
 * replace. `--json` is additive to the script and does not change its default
 * output; the runner parses JSON, never the human table.
 *
 * An absent script means an installed payload, which ships `dist/` only. That is
 * `skipped` and informational — NOT a failure.
 */
/** The last non-empty stdout line that parses as JSON, or null. */
function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines.reverse()) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Not the payload; keep walking backwards.
    }
  }
  return null;
}

function runDocsVerifyProcess(script: string): Promise<DocsVerifyRun> {
  if (!existsSync(script)) {
    return Promise.resolve({
      status: 'skipped',
      informational: true,
      reason: `scripts/docs-verify.mjs is not in this payload (looked in ${script})`,
      exitCode: null,
      total: null,
      passed: null,
      failed: null,
      unverified: null,
      failures: [],
      durationMs: null,
    });
  }
  const started = Date.now();
  const proc = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const durationMs = Date.now() - started;
  const fail = (reason: string): DocsVerifyRun => ({
    status: 'failed',
    informational: false,
    reason,
    exitCode: typeof proc.status === 'number' ? proc.status : null,
    total: null,
    passed: null,
    failed: null,
    unverified: null,
    failures: [],
    durationMs,
  });
  if (proc.error !== undefined) return Promise.resolve(fail(`docs-verify could not run: ${safeMessage(proc.error)}`));
  const Shape = z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    unverified: z.number(),
    failedNames: z.array(z.string()),
  });
  // The LAST line that parses as JSON, not the whole stream. `--json` mode is
  // contractually one document (the banner is suppressed there), but a script
  // that grows one warning line must not become "the tool could not read the
  // result" — that reports a contract change as a health finding, and the two are
  // not the same thing to whoever reads the ticket.
  const payload = lastJsonLine(proc.stdout);
  if (payload === null) {
    // Not a claim failure — a contract failure, and it is reported as `failed` so
    // it can never be mistaken for a pass.
    return Promise.resolve(fail(`docs-verify did not emit JSON (exit ${String(proc.status)})`));
  }
  const shape = Shape.safeParse(payload);
  if (!shape.success) return Promise.resolve(fail('docs-verify JSON did not match the expected shape'));
  const data = shape.data;
  const ok = data.failed === 0 && data.unverified === 0;
  return Promise.resolve({
    status: ok ? 'ran' : 'failed',
    informational: false,
    reason: ok ? null : `${data.failed} failed / ${data.unverified} unverified`,
    exitCode: typeof proc.status === 'number' ? proc.status : null,
    total: data.total,
    passed: data.passed,
    failed: data.failed,
    unverified: data.unverified,
    failures: data.failedNames,
    durationMs,
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without signalling, so
    // this cannot kill anything. On Windows it maps to OpenProcess: a missing pid
    // throws, an existing one does not.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = it exists but belongs to another user, which is still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── collection ──────────────────────────────────────────────────────────────

const EMPTY_CONFIG: ConfigEntry = {
  servePort: null,
  voice: null,
  briefings: null,
  mic: null,
  captureMode: null,
  sttModel: null,
  ttsModel: null,
  brainModel: null,
  brainGoldenMs: null,
  brainCeilingMs: null,
  logLevel: null,
  vadModelPath: null,
  vadThreshold: null,
  envPresent: {},
  error: null,
};

const EMPTY_TELEMETRY: TelemetryEntry = {
  path: null,
  present: false,
  error: null,
  totalRows: null,
  returned: 0,
  codeHistogram: {},
  subsystemHistogram: {},
  statusHistogram: {},
  firstFaultAt: null,
  daysSinceFirstFault: null,
  rows: [],
};

function unprobedPort(role: PortRole, port: number): PortEntry {
  return {
    role,
    port,
    bindAddress: '127.0.0.1',
    ownerPid: null,
    bound: false,
    probe: 'none',
    healthy: false,
    status: null,
    refusal: 'not-probed',
    detail: null,
  };
}

/**
 * Collect the bundle. Every source is injected, so a test drives the whole path
 * with no filesystem, no sockets and — critically — no daemon.
 */
export async function collectBundle(sources: BundleSources): Promise<CollectResult> {
  const now = sources.now();
  const notes: string[] = [];
  const counters = { scanned: 0, scrubbed: 0, refused: 0 };

  // ── ports ──
  const ports: PortEntry[] = [];
  for (const configured of sources.ports) {
    if (configured.role === 'serve') {
      if (sources.probeServe === null) {
        ports.push(unprobedPort('serve', configured.port));
        continue;
      }
      try {
        const result = await sources.probeServe(configured.port, sources.servePassword);
        ports.push({
          role: 'serve',
          port: configured.port,
          bindAddress: '127.0.0.1',
          // A TCP/HTTP probe cannot report a pid; nothing here would be honest.
          ownerPid: null,
          bound: result.healthy || result.status !== null,
          healthy: result.healthy,
          probe: 'serve-health',
          status: result.status,
          refusal: result.refusal,
          detail: result.detail === null ? null : redactString(result.detail),
        });
      } catch (err) {
        ports.push({
          role: 'serve',
          port: configured.port,
          bindAddress: '127.0.0.1',
          ownerPid: null,
          bound: false,
          healthy: false,
          probe: 'serve-health',
          status: null,
          refusal: 'probe-error',
          detail: safeMessage(err),
        });
      }
      continue;
    }
    if (sources.probeUiBridge === null) {
      ports.push(unprobedPort('ui-bridge', configured.port));
      continue;
    }
    try {
      const result = await sources.probeUiBridge(configured.port, sources.ipcToken);
      ports.push({
        role: 'ui-bridge',
        port: configured.port,
        bindAddress: '127.0.0.1',
        ownerPid: null,
        bound: result.bound,
        healthy: result.healthy,
        probe: 'ui-ws-handshake',
        status: result.status,
        refusal: result.refusal,
        detail: result.detail === null ? null : redactString(result.detail),
      });
    } catch (err) {
      ports.push({
        role: 'ui-bridge',
        port: configured.port,
        bindAddress: '127.0.0.1',
        ownerPid: null,
        bound: false,
        healthy: false,
        probe: 'ui-ws-handshake',
        status: null,
        refusal: 'probe-error',
        detail: safeMessage(err),
      });
    }
  }

  // ── daemon identity ──
  let daemon: DaemonEntry | null = null;
  if (sources.readOwnerMarker !== null && sources.probeUiBridge !== null) {
    let marker: OwnerMarkerRead;
    try {
      marker = sources.readOwnerMarker();
    } catch (err) {
      marker = { present: false, raw: null, error: safeMessage(err) };
    }
    const portOpen = ports.find((p) => p.role === 'ui-bridge')?.bound ?? false;
    daemon = classifyDaemon({ marker, portOpen, ownerKey: sources.ownerKey ?? null, pidAlive: sources.pidAlive });
  }

  // ── config ──
  let config: ConfigEntry | null = null;
  if (sources.readConfig !== null) {
    try {
      config = sources.readConfig();
    } catch {
      // Threw: the source is unavailable, so the key is null. A source that
      // RETURNS an error is a different failure and keeps its key.
      config = null;
    }
  }

  // ── keys ──
  let keys: KeysEntry | null = null;
  if (sources.readKeys !== null) {
    try {
      const read = sources.readKeys();
      const pools: KeyPoolEntry[] = read.pools.map((pool) => {
        const { fingerprints, suppressed } = fingerprintsOf(pool.material);
        return {
          pool: pool.pool,
          count: pool.count,
          fingerprints,
          suppressedByEntropyFloor: suppressed,
          undecryptable: pool.undecryptable,
        };
      });
      keys = {
        path: read.path,
        present: read.present,
        error: read.error === null ? null : redactString(read.error),
        entropyFloorBytes: KEY_ENTROPY_FLOOR_BYTES,
        pools,
        undecryptable: pools.filter((p) => p.undecryptable).map((p) => p.pool),
        total: pools.reduce((n, p) => n + p.count, 0),
      };
    } catch {
      keys = null;
    }
  }

  // ── logs ──
  const logs: LogEntry[] = [];
  if (sources.readTextFile === null) {
    for (const name of LOG_FILES) {
      logs.push({
        name,
        path: sources.runtimeDir === null ? '' : join(sources.runtimeDir, name),
        present: false,
        bytes: null,
        lineCount: null,
        included: 0,
        truncated: false,
        binary: false,
        lines: [],
        scrubbed: 0,
        refused: 0,
        error: 'no file reader injected',
      });
    }
  } else {
    for (const name of LOG_FILES) {
      const path = sources.runtimeDir === null ? '' : join(sources.runtimeDir, name);
      let text: string | null = null;
      let error: string | null = null;
      try {
        text = sources.readTextFile(path);
      } catch (err) {
        error = safeMessage(err);
      }
      if (text === null) {
        logs.push({
          name,
          path,
          present: false,
          bytes: null,
          lineCount: null,
          included: 0,
          truncated: false,
          binary: false,
          lines: [],
          scrubbed: 0,
          refused: 0,
          error,
        });
        continue;
      }
      const all = text.split('\n');
      // A torn final line (no trailing newline) is the normal artifact of a
      // process killed mid-write. It is KEPT: it is usually the last thing that
      // happened, which is precisely what a diagnostic bundle is for.
      if (all.length > 0 && all[all.length - 1] === '') all.pop();
      const window = all.slice(-MAX_LOG_LINES);
      const lines: string[] = [];
      let scrubbed = 0;
      let refused = 0;
      let binary = false;
      for (const line of window) {
        const out = scrubLogLine(line);
        counters.scanned += 1;
        if (out.scrubbed) {
          scrubbed += 1;
          counters.scrubbed += 1;
        }
        if (out.refused) {
          refused += 1;
          counters.refused += 1;
        }
        if (out.binary) binary = true;
        lines.push(out.text);
      }
      logs.push({
        name,
        path,
        present: true,
        bytes: Buffer.byteLength(text, 'utf8'),
        lineCount: all.length,
        included: window.length,
        truncated: all.length > MAX_LOG_LINES,
        binary,
        lines,
        scrubbed,
        refused,
        error,
      });
    }
  }

  // ── telemetry ──
  let telemetry: TelemetryEntry | null = null;
  if (sources.readTelemetry !== null) {
    try {
      telemetry = summariseTelemetry(sources.readTelemetry(), now);
    } catch {
      telemetry = null;
    }
  }

  // ── docsVerify ──
  let docsVerify: DocsVerifyEntry | null = null;
  if (sources.runDocsVerify !== null) {
    try {
      const run = await sources.runDocsVerify();
      docsVerify = {
        status: run.status,
        informational: run.informational,
        reason: run.reason === null ? null : redactString(run.reason),
        exitCode: run.exitCode,
        total: run.total,
        passed: run.passed,
        failed: run.failed,
        unverified: run.unverified,
        failures: run.failures.map((f) => redactString(f)),
        durationMs: run.durationMs,
      };
    } catch (err) {
      // A source that THROWS is unavailable, so its key is null; a source that
      // RETURNS a failure keeps its key and says why. Collapsing the two would
      // lose the difference between "we could not check" and "we checked".
      docsVerify = null;
      notes.push(`docsVerify: could not run (${safeMessage(err)})`);
    }
  }

  if (docsVerify !== null && docsVerify.status === 'skipped') {
    notes.push('docsVerify: skipped — informational only (this payload ships no scripts/), not a pass and not a failure');
  }
  if (counters.refused > 0) {
    notes.push(
      `redaction: ${counters.refused} line(s) emitted as [REDACTION-REFUSED]; the bundle was still collected, and that is the only loss`,
    );
  }

  const serve = ports.find((p) => p.role === 'serve');
  const ui = ports.find((p) => p.role === 'ui-bridge');
  const degraded = [
    ['ports', ports.some((p) => p.healthy === false)],
    ['serve credential', serve?.refusal === 'no-credential'],
    ['ui-bridge credential', ui?.refusal === 'no-credential'],
    ['keys', keys === null || keys.total === 0],
    ['docsVerify', docsVerify === null || docsVerify.status === 'failed'],
    ['daemon owner', daemon !== null && daemon.classification === 'Foreign'],
  ]
    .filter(([, bad]) => bad)
    .map(([name]) => String(name));
  const outcome: DiagnosticBundle['outcome'] = degraded.length === 0 ? 'healthy' : 'degraded';
  if (degraded.length > 0) notes.push(`degraded because: ${degraded.join(', ')}`);

  const bundle: DiagnosticBundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    tool: 'voxaura-doctor-bundle',
    generatedAt: new Date(now).toISOString(),
    outcome,
    exitCode: outcome === 'healthy' ? 0 : 1,
    header: {
      pasteSafe: true,
      note: 'Redacted for a public bug report. Paths, versions and log tails are included deliberately — attach this whole file.',
      redactionMarker: REDACTION_MARKER,
      refusedMarker: REFUSED,
    },
    runtime: { dir: sources.runtimeDir, node: process.version, platform: process.platform },
    paths: sources.paths ?? { vault: null, ipcToken: null, ownerMarker: null },
    ports,
    daemon,
    config,
    keys,
    telemetry,
    docsVerify,
    logs,
    redactions: { scanned: counters.scanned, scrubbed: counters.scrubbed, refused: counters.refused, wholeBundleSafe: true },
    notes,
  };

  // The tripwire runs on the FINISHED bundle, not per source: a source that
  // bypasses the read-boundary scrub is only catchable here. `withheld` keeps the
  // schema intact so a consumer can still parse the failure.
  try {
    assertRedactionSafe(bundle);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'redaction trip';
    const failed: DiagnosticBundle = {
      ...bundle,
      outcome: 'collection-failed',
      exitCode: 2,
      redactions: { ...bundle.redactions, wholeBundleSafe: false },
    };
    return {
      bundle: failed,
      outcome: 'collection-failed',
      exitCode: 2,
      notes: [...notes, `collection failed: ${message}`],
    };
  }

  return { bundle, outcome, exitCode: bundle.exitCode, notes };
}

/**
 * Classify who holds 4097, mirroring `holder_from_probe` in `main.rs`.
 *
 * `pidAlive` is injected so "the marker names a dead process" is reachable
 * without waiting for a real one to die — which is the silent-adoption case: our
 * daemon is gone, something else took the port, and the file on disk still names
 * the old pid.
 *
 * The order matches the shell exactly — port, marker shape, identity, then pid —
 * because identity outranks liveness: a marker written by anything other than a
 * daemon this install started can influence the answer only as "not ours".
 */
function classifyDaemon(args: {
  readonly marker: OwnerMarkerRead;
  readonly portOpen: boolean;
  readonly ownerKey: string | null;
  readonly pidAlive: ((pid: number) => boolean) | null;
}): DaemonEntry {
  const { marker, portOpen } = args;
  const base = {
    ownerMarkerPresent: marker.present,
    ownerMarkerError: marker.error === null ? null : redactString(marker.error),
    expectedContractVersion: UI_CONTRACT_VERSION,
  };
  const verdict = (
    classification: DaemonClassification,
    reason: string,
    action: BringUpMirror['action'],
  ): Pick<DaemonEntry, 'classification' | 'reason' | 'bringUp'> => ({
    classification,
    reason,
    bringUp: { derivedBy: 'cli', action, authoritative: false },
  });

  if (!portOpen) {
    return {
      ...base,
      ...verdict('Cold', 'nothing answered on the UI-bridge port', 'spawn'),
      pid: null,
      ipcPort: null,
      contractVersion: null,
      ownerKeyMatch: null,
      pidAlive: null,
      contractMatches: null,
    };
  }
  if (marker.raw === null) {
    return {
      ...base,
      ...verdict(
        'Foreign',
        marker.error === null
          ? "no daemon.owner marker, so the holder never received this install's identity"
          : `daemon.owner could not be read (${marker.error})`,
        'refuse',
      ),
      pid: null,
      ipcPort: null,
      contractVersion: null,
      ownerKeyMatch: null,
      pidAlive: null,
      contractMatches: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(marker.raw);
  } catch (err) {
    return {
      ...base,
      ...verdict('Foreign', `daemon.owner is unreadable (${safeMessage(err)})`, 'refuse'),
      pid: null,
      ipcPort: null,
      contractVersion: null,
      ownerKeyMatch: null,
      pidAlive: null,
      contractMatches: null,
    };
  }
  const m = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const pid = typeof m['pid'] === 'number' && Number.isInteger(m['pid']) ? m['pid'] : null;
  const ipcPort = typeof m['ipcPort'] === 'number' ? m['ipcPort'] : null;
  const contractVersion = typeof m['contractVersion'] === 'string' ? m['contractVersion'] : null;
  const ownerKey = typeof m['ownerKey'] === 'string' ? m['ownerKey'] : null;
  const tail = {
    pid,
    ipcPort,
    contractVersion,
    ownerKeyMatch: ownerKey === null || args.ownerKey === null ? null : ownerKey === args.ownerKey,
    contractMatches: contractVersion === null ? null : contractVersion === UI_CONTRACT_VERSION,
  };

  if (m['v'] !== 1) {
    return { ...base, ...tail, ...verdict('Foreign', `daemon.owner is version ${String(m['v'])} and this build speaks version 1`, 'refuse'), pidAlive: null };
  }
  if (ownerKey === null || args.ownerKey === null) {
    return {
      ...base,
      ...tail,
      ...verdict('Foreign', 'this shell holds no install identity, so the holder cannot be proven ours', 'refuse'),
      pidAlive: null,
    };
  }
  if (ownerKey !== args.ownerKey) {
    return {
      ...base,
      ...tail,
      ...verdict('Foreign', 'daemon.owner carries a different install identity (another user, or another install)', 'refuse'),
      pidAlive: null,
    };
  }
  if (pid === null || pid === 0) {
    return { ...base, ...tail, ...verdict('Foreign', 'daemon.owner names pid 0', 'refuse'), pidAlive: null };
  }
  let alive: boolean | null = null;
  if (args.pidAlive !== null) {
    try {
      alive = args.pidAlive(pid);
    } catch {
      alive = null;
    }
  }
  if (alive === false) {
    return {
      ...base,
      ...tail,
      ...verdict('Foreign', `daemon.owner names pid ${pid}, which is not running — our daemon is gone and something else took the port`, 'refuse'),
      pidAlive: false,
    };
  }
  return {
    ...base,
    ...tail,
    ...verdict('Ours', "daemon.owner names a live process holding this install's identity", 'adopt'),
    pidAlive: alive,
  };
}

/**
 * Derive the telemetry summary from the jsonl TEXT.
 *
 * `daysSinceFirstFault` comes from the row timestamps, never from a rebuilt
 * `TtsCreditMonitor`: the monitor is in-process state a CLI run has no access
 * to, and re-deriving one would be a guess. The jsonl is the durable record and
 * it carries the timestamps.
 */
function summariseTelemetry(read: TelemetryRead, now: number): TelemetryEntry {
  if (!read.present) return { ...EMPTY_TELEMETRY, path: read.path, present: false, error: read.error };
  const rawLines = read.text.split('\n').filter((l) => l.trim().length > 0);
  const codeHistogram: Record<string, number> = {};
  const subsystemHistogram: Record<string, number> = {};
  const statusHistogram: Record<string, number> = {};
  let firstFaultAt: string | null = null;
  let firstFaultMs = Number.POSITIVE_INFINITY;
  const rows: TelemetryRow[] = [];
  for (const line of rawLines) {
    // Redaction happens HERE, at the read boundary, because the jsonl is a
    // durable on-disk file and a torn row is kept as evidence.
    const scrubbed = scrubLogLine(line);
    let row: TelemetryRow;
    try {
      const obj = JSON.parse(scrubbed.text) as Record<string, unknown>;
      const timestamp = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : null;
      const status = typeof obj['status'] === 'string' ? obj['status'] : null;
      const subsystem = typeof obj['subsystem'] === 'string' ? obj['subsystem'] : null;
      const errorCode = typeof obj['errorCode'] === 'string' ? obj['errorCode'] : null;
      row = {
        timestamp,
        seq: typeof obj['seq'] === 'number' ? obj['seq'] : null,
        subsystem,
        status,
        latencyMs: typeof obj['latencyMs'] === 'number' ? obj['latencyMs'] : null,
        errorCode,
        sanitizedErrorClass:
          typeof obj['sanitizedErrorClass'] === 'string' ? obj['sanitizedErrorClass'] : null,
        remediationAttempted:
          typeof obj['remediationAttempted'] === 'string' ? obj['remediationAttempted'] : null,
        unparsed: false,
        raw: null,
      };
      if (subsystem !== null) subsystemHistogram[subsystem] = (subsystemHistogram[subsystem] ?? 0) + 1;
      if (status !== null) statusHistogram[status] = (statusHistogram[status] ?? 0) + 1;
      if (errorCode !== null) codeHistogram[errorCode] = (codeHistogram[errorCode] ?? 0) + 1;
      if (status === 'ERROR' && timestamp !== null) {
        const ms = Date.parse(timestamp);
        if (Number.isFinite(ms) && ms < firstFaultMs) {
          firstFaultMs = ms;
          firstFaultAt = timestamp;
        }
      }
    } catch {
      row = {
        timestamp: null,
        seq: null,
        subsystem: null,
        status: null,
        latencyMs: null,
        errorCode: null,
        sanitizedErrorClass: null,
        remediationAttempted: null,
        unparsed: true,
        raw: scrubbed.text,
      };
    }
    rows.push(row);
  }
  const window = rows.slice(-MAX_TELEMETRY_ROWS);
  return {
    path: read.path,
    present: true,
    error: read.error,
    totalRows: rawLines.length,
    returned: window.length,
    codeHistogram,
    subsystemHistogram,
    statusHistogram,
    firstFaultAt,
    daysSinceFirstFault: firstFaultAt === null ? null : Math.max(0, Math.floor((now - firstFaultMs) / 86_400_000)),
    rows: window,
  };
}
