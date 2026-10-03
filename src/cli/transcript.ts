import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { redactObject } from '../common/logger.js';

// THE DRIVER TRANSCRIPT — a complete, greppable JSONL record of one text turn
// session against the agent core.
//
// WHY THIS IS NOT `TelemetryWriter`. The telemetry schema forbids free text on
// purpose (`src/telemetry/writer.ts:6-8`, enforced by
// `src/policy/telemetry-wired.test.ts:109`): it is a machine diagnostics bus that
// adversarial VOICE input must never be able to write prose into. A transcript is
// the opposite of that — the user's utterance, the gate's own ask and the tool
// arguments are the whole point, and a schema that refused them would refuse the
// feature. So this is a separate sink with its own redaction discipline rather
// than a hole in the telemetry schema, and `TelemetryWriter` is never imported
// here. `src/cli/driver.test.ts` pins that (a grep for the import, plus a run
// that writes a secret-shaped tool arg and asserts `containsSecret` is false).
//
// WHY REDACT EVERY ROW ANYWAY. Redaction at the telemetry sink is a property of
// that schema; this file writes whatever the chain produces, including strings
// nobody chose to be safe. `redactObject` (`common/logger.ts:378`) is applied to
// every row BEFORE `JSON.stringify`, for the same structural reason it documents:
// a scrubbed value keeps its quotes, so the line stays parseable JSONL. A
// post-serialisation regex would corrupt the file it was protecting.
//
// WHY `appendFileSync`. The same call `TelemetryWriter.flush` uses
// (`telemetry/writer.ts:151`): a per-event append cannot lose the rows written
// before a crash, and a transcript whose last event is missing is exactly the
// transcript that is needed. It is also what makes the file usable while the REPL
// is still running — `tail -f` on a JSONL file is the whole interaction model.
//
// WHAT IS NOT HERE. No metric, no counter, no aggregate. A transcript that
// summarised would be a report, and a report can disagree with what happened;
// this file writes one event per thing that happened, in order, with `seq`.

/** Every event type this sink accepts. The union is closed on purpose. */
export type TranscriptEventType =
  | 'session.start'
  | 'serve.probe'
  | 'daemon.start'
  | 'daemon.stop'
  | 'input'
  | 'phase'
  | 'permission.prompt'
  | 'permission.decision'
  | 'dispatch'
  | 'tool'
  | 'result'
  | 'error'
  | 'command'
  | 'session.end';

export interface SessionStartEvent {
  readonly type: 'session.start';
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly serveBaseUrl: string;
  readonly servePort: number;
  readonly passwordSource: string;
  readonly session: string | null;
  readonly transcriptFile: string | null;
  /**
   * The sentence that must appear in every transcript of this shape.
   *
   * `opencode serve` is a SEPARATE PROCESS started by the Rust supervisor
   * (`apps/desktop/src-tauri/src/main.rs`), not by Node. A reader who finds a
   * transcript with no statement about who owns the serve process will assume the
   * driver started it, and a driver that cannot start or kill serve is a fact
   * worth reading rather than inferring.
   */
  readonly supervisor: string;
}

export interface ServeProbeEvent {
  readonly type: 'serve.probe';
  readonly baseUrl: string;
  readonly port: number;
  readonly passwordSource: string;
  readonly healthy: boolean;
  readonly ms: number;
}

export interface DaemonStartEvent {
  readonly type: 'daemon.start';
  /** `false` when `--daemon` was not passed; the reason is then in `detail`. */
  readonly started: boolean;
  readonly requested: boolean;
  readonly ipcPort: number | null;
  readonly ms: number;
  readonly detail: string;
}

export interface DaemonStopEvent {
  readonly type: 'daemon.stop';
  readonly stopped: boolean;
  readonly ms: number;
  readonly detail: string;
}

export interface InputEvent {
  readonly type: 'input';
  /** VERBATIM. Never trimmed, never normalised, never re-cased. */
  readonly text: string;
  readonly chars: number;
  readonly bytes: number;
}

export interface PhaseEvent {
  readonly type: 'phase';
  /** Which part of the chain: `intake`, `gate`, `plan`, `dispatch`, `tools`, … */
  readonly phase: string;
  readonly detail: string | null;
  readonly ms: number | null;
}

export interface PermissionPromptEvent {
  readonly type: 'permission.prompt';
  readonly slotId: string;
  readonly taskEn: string;
  readonly sessionId: string;
  readonly askAr: string;
  readonly openedAt: number;
}

export interface PermissionDecisionEvent {
  readonly type: 'permission.decision';
  readonly slotId: string;
  /** The operator's own keystrokes, verbatim. */
  readonly answer: string;
  readonly approved: boolean;
  /** The utterance actually sent as the next turn; names the LIVE slot id. */
  readonly utterance: string;
  /** Whether the product's `PermissionSlot` is empty after the decision. */
  readonly consumed: boolean;
  readonly dispatches: number;
  readonly detail: string;
}

export interface DispatchEvent {
  readonly type: 'dispatch';
  readonly receipt: string | null;
  readonly state: string;
  readonly delivered: boolean;
  readonly ms: number;
  readonly at: string;
  readonly bytes: number;
  readonly text: string;
  readonly failure: string | null;
}

export interface ToolEvent {
  readonly type: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly status: string;
  /** Redacted by the sink before serialisation, not by this module. */
  readonly args: unknown;
  readonly result: string | null;
  readonly error: string | null;
  readonly title: string | null;
  /**
   * The TOOL's own duration, from the `time.start`/`time.end` serve reports on
   * the part. `null` when serve sent no timing — never substituted with the
   * reader's own wait, which measures something else.
   */
  readonly ms: number | null;
  /** How long THIS read spent polling. A different number, and labelled as such. */
  readonly readWaitMs: number;
  readonly rowId: string;
}

export interface ResultEvent {
  readonly type: 'result';
  readonly ok: boolean;
  readonly detail: string | null;
  readonly replyAr: string | null;
  readonly taskEn: string | null;
  readonly receipt: string | null;
  readonly ms: number;
  readonly intakeModel: string | null;
  readonly gateDecision: string | null;
  readonly steps: number | null;
  readonly needsPermission: boolean;
  readonly failure: string | null;
}

export interface ErrorEvent {
  readonly type: 'error';
  /** `err.secretSafeMessage` for a typed error, `err.message` otherwise. */
  readonly message: string;
  /** The product's own code, or `'internal'` for anything unclassified. */
  readonly code: string;
  /** `null` when the throw carried no retryable flag. Never guessed. */
  readonly retryable: boolean | null;
  readonly where: string;
}

export interface CommandEvent {
  readonly type: 'command';
  readonly name: string;
  readonly argument: string;
  readonly routed: boolean;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
  readonly code: string | null;
}

export interface SessionEndEvent {
  readonly type: 'session.end';
  readonly turns: number;
  readonly inputs: number;
  readonly commands: number;
  readonly refused: number;
  readonly errors: number;
  readonly tools: number;
  readonly dispatches: number;
  readonly delivered: number;
  readonly prompted: number;
  readonly approved: number;
  readonly denied: number;
  readonly ms: number;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly reason: string;
}

export type TranscriptEvent =
  | SessionStartEvent
  | ServeProbeEvent
  | DaemonStartEvent
  | DaemonStopEvent
  | InputEvent
  | PhaseEvent
  | PermissionPromptEvent
  | PermissionDecisionEvent
  | DispatchEvent
  | ToolEvent
  | ResultEvent
  | ErrorEvent
  | CommandEvent
  | SessionEndEvent;

/** One serialised row: the event, plus the two fields every row carries. */
export type TranscriptRow = { readonly seq: number; readonly ts: string } & TranscriptEvent;

export interface TranscriptOptions {
  /**
   * Per-session file, or `null` for a stdout-only transcript.
   *
   * `null` is a real mode rather than a degenerate one: a CI job that pipes
   * stdout into a collector wants one artefact, and writing a second copy into
   * `~/.opencode-voice-runtime/` from inside a container is a write into a
   * directory the job did not ask for.
   */
  readonly file: string | null;
  /** One line, no newline. Defaults to `process.stdout.write`. */
  readonly write: ((line: string) => void) | null;
  readonly now: () => number;
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The append-only sink. Every event goes to stdout AND to the per-session file,
 * redacted once, in `seq` order.
 *
 * THE WRITE IS BEST-EFFORT AND SAYS SO. `appendFileSync` can fail on a full disk
 * or a revoked ACL, and a transcript that threw there would take the turn down
 * with it — the run would report a failure of the RECORDER rather than of the
 * thing being recorded. So the row is still written to stdout, `writeFailures`
 * counts the misses, and `close()` reports them. The count is on the handle
 * because "the file is best-effort" is only true if something says how often it
 * was not.
 */
export class Transcript {
  private seq = 0;
  private readonly emitted: TranscriptRow[] = [];
  private failures = 0;
  private failureDetail: string | null = null;

  constructor(private readonly options: TranscriptOptions) {
    if (options.file !== null) {
      mkdirSync(dirname(options.file), { recursive: true });
    }
  }

  /** The file being appended to, or `null` in stdout-only mode. */
  get file(): string | null {
    return this.options.file;
  }

  /** Events emitted so far, in order. Used by the tests and the session summary. */
  get rows(): readonly TranscriptRow[] {
    return this.emitted;
  }

  get count(): number {
    return this.emitted.length;
  }

  /** Rows the FILE could not take. Stdout still received every one of them. */
  get writeFailures(): number {
    return this.failures;
  }

  get lastWriteFailure(): string | null {
    return this.failureDetail;
  }

  /**
   * Serialise, redact, append, echo. Returns the row as written.
   *
   * `redactObject` runs on the WHOLE row, not on the payload: a secret can sit in
   * a header-like key at any depth (`text`, `detail`, `askAr`), and redacting the
   * payload would leave `ts`/`seq` — and anything a future event adds at the top
   * level — unscrubbed by default rather than by decision.
   */
  emit(event: TranscriptEvent): TranscriptRow {
    this.seq += 1;
    const row = {
      seq: this.seq,
      ts: new Date(this.options.now()).toISOString(),
      ...event,
    } as TranscriptRow;
    const safe = redactObject(row);
    const line = JSON.stringify(safe);
    this.emitted.push(row);
    if (this.options.file !== null) {
      try {
        appendFileSync(this.options.file, `${line}\n`, 'utf8');
      } catch (err) {
        this.failures += 1;
        this.failureDetail = err instanceof Error ? err.message : 'unknown';
      }
    }
    (this.options.write ?? defaultWrite)(line);
    return row;
  }

  /** Append a closing sentinel without the summary in `SessionEndEvent`. */
  close(): void {
    this.emit({
      type: 'session.end',
      turns: 0,
      inputs: 0,
      commands: 0,
      refused: 0,
      errors: 0,
      tools: 0,
      dispatches: 0,
      delivered: 0,
      prompted: 0,
      approved: 0,
      denied: 0,
      ms: 0,
      ok: false,
      exitCode: 0,
      reason: 'transcript closed without a session summary — the session did not reach its end',
    });
  }
}

/**
 * Where a session's file goes, unless the caller named one.
 *
 * The runtime directory is the one the supervisor provisions, with the same
 * `VOICE_RUNTIME_DIR` override the rest of the product honours, so a container that
 * moves its runtime state does not silently accumulate transcripts in the
 * operator's home directory.
 *
 * THE LABEL IS SANITISED TO `[A-Za-z0-9_-]` AND `.` IS NOT ON THE LIST. A session
 * id is served by OpenCode and is `ses_…`, so a dot is not a character this needs
 * to keep — and keeping it would let a hostile `--session ../../etc/passwd` put
 * `..` in a filename. Separators and dots are removed, not escaped, because a
 * label that cannot contain a path metacharacter cannot be one.
 */
export function defaultTranscriptPath(input: {
  readonly runtimeDir: string;
  readonly session: string | null;
  readonly now: Date;
}): string {
  const stamp = input.now.toISOString().replace(/[:.]/g, '-');
  // The timestamp is already in the name, so the session-less label does NOT repeat
  // it — `…-no-session-<stamp>-<stamp>.jsonl` is a filename nobody types twice and
  // nobody greps by eye.
  const label = input.session === null ? 'no-session' : input.session.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(input.runtimeDir, 'driver', `${stamp}-${label}.jsonl`);
}

/**
 * The sentence that names who owns the `opencode serve` process.
 *
 * Exported so the driver, its tests and the usage text cannot disagree about the
 * wording. It is a constant rather than prose at the call site for the same
 * reason `GATE_TTL_MS` is re-exported from `turn.ts`: a fact that must appear in
 * a report should have exactly one spelling.
 */
export const SERVE_SUPERVISOR_NOTE =
  'opencode serve is a separate process started by the Rust supervisor (apps/desktop/src-tauri/src/main.rs); this Node process neither spawns nor kills it and only adopts what it finds on the port';