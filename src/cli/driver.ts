import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionId } from '../common/brands.js';
import { OrchestratorError, errorCodeFor } from '../common/errors.js';
import { Keyring, withKey } from '../voice/keyring.js';
import { FileVault } from '../voice/vault.js';
import { vaultPathFromEnv, startDaemon } from '../daemon.js';
import { UI_WS_PORT } from '../ipc/protocol.js';
import { openRouterChat } from '../voice/brain.js';
import { fuzzyPick } from '../runtime/fuzzy-match.js';
import type { ServeClient } from '../runtime/client.js';
import type { ChatFn } from '../orchestrator/coordinator.js';
import type { PendingPermission } from '../orchestrator/permission.js';
import { HeadlessBrain, type TurnTrace } from './turn.js';
import { openServeTarget, requirePassword, type ServeTarget } from './serve.js';
import { readToolInvocations } from './driver-tools.js';
import { Transcript, defaultTranscriptPath, SERVE_SUPERVISOR_NOTE } from './transcript.js';

// THE `driver` REPL — the agent core, driven by text, with a full JSONL
// transcript.
//
// WHAT IT IS. The SAME agent the voice loop runs — `Coordinator`
// (`orchestrator/coordinator.ts`), `ServeClient` (`runtime/client.ts`), the
// contextual permission gate (`orchestrator/permission.ts`) — assembled by
// `HeadlessBrain` (`cli/turn.ts`), with no webview, no microphone, no STT, no TTS
// and no daemon required. The differences from the shipped path are two: the
// input arrives as a line of text, and the output is a transcript. Both are
// stated here rather than assumed, because a harness that silently differed from
// the product would be measuring itself.
//
// WHAT IT DECIDES, AND WHAT IT DOES NOT. It decides NOTHING about intake, the
// gate, the plan or a dispatch — the gate verdict is `parseAddressee`'s, the plan
// is `PlanSchema`'s, the receipt is serve's, the tool parts come off the route
// `readTurn` already reads. It DOES route internal commands, and it does read the
// operator's answers. That split is the difference between a harness and an
// oracle, so it is written down instead of being discovered later.
//
// THE SUMMARY IS DERIVED FROM THE ROWS. `summarise` counts the transcript's own
// events rather than a parallel set of counters, so the exit code and the file can
// never disagree about what happened — the failure mode of every harness that
// keeps its own tally.

/**
 * The six internal commands, restated from `INTERNAL_COMMANDS`
 * (`runtime/opencode-bridge.ts:76`).
 *
 * That set is a module-private `Set<string>` and is NOT exported, so a driver
 * that wanted it at runtime would either edit `opencode-bridge.ts` (outside this
 * change's write-set) or invent it. Restating it is honest PROVIDED it cannot
 * drift, so `driver.test.ts` reads the bridge's source and asserts the two agree —
 * the same "derive, do not assume" rule the rest of the headless surface follows.
 */
export const DRIVER_INTERNAL_COMMANDS = ['compact', 'undo', 'clear', 'model', 'interrupt', 'revert'] as const;
export type DriverInternalCommand = (typeof DRIVER_INTERNAL_COMMANDS)[number];

export function isDriverInternalCommand(name: string): name is DriverInternalCommand {
  return (DRIVER_INTERNAL_COMMANDS as readonly string[]).includes(name);
}

// ── The operator's side: one line in, EOF out ────────────────────────────────

export interface DriverInput {
  /** One line of input, or `null` at EOF. */
  read(prompt: string): Promise<string | null>;
  close(): void;
}

/**
 * `node:readline` over stdin, with PROMPTS ON STDERR.
 *
 * The split is the reason this is readline rather than a hand-rolled stdin
 * reader: the transcript is stdout and has to stay a clean JSONL stream, so a
 * prompt on stdout would corrupt the artefact a CI job greps.
 *
 * WHY THE `line` EVENT AND NOT `rl.question`. MEASURED, and it is not a subtlety:
 * with a redirected stdin, `rl.question` settles ONCE and every remaining line is
 * delivered to the `'line'` listener with no question pending — so a piped session
 * processed exactly one line and then stopped reading. A REPL that works on a TTY
 * and silently reads one line in CI is exactly the harness that reports a passing
 * run it never ran, so lines are QUEUED on `'line'` and handed to whoever asks next.
 *
 * EOF RESOLVES `null` RATHER THAN HANGING, for every waiter at once, and a queued
 * line is never returned after it — so the session ends deterministically rather
 * than exiting with the transcript half-written and nothing saying so.
 */
export function stdinInput(): DriverInput {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  const buffered: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;

  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next === undefined) {
      buffered.push(line);
      return;
    }
    next(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiting.length > 0) waiting.shift()?.(null);
  });

  return {
    read: (prompt) => {
      // THE BUFFER IS DRAINED BEFORE `closed` IS CONSULTED, and that order IS the
      // fix. A redirected stdin delivers every line and `close` in one burst while
      // the first turn is still awaiting serve, so by the time the second `read()`
      // runs the interface is CLOSED and the remaining lines are already queued.
      // Checking `closed` first — which is what this did at first — discarded them,
      // and the session ended after one line while the file held nine.
      const ready = buffered.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      if (closed) return Promise.resolve(null);
      // Prompts go to stderr, and only when stderr is a terminal: on a piped run
      // they are noise in a log already full of JSONL.
      if (process.stderr.isTTY === true) process.stderr.write(prompt);
      return new Promise<string | null>((resolve) => waiting.push(resolve));
    },
    close: () => {
      rl.close();
    },
  };
}

/**
 * One line pre-pended to the stream, then stdin.
 *
 * This is how the `--seed` utterance runs. It is a SEQUENCE, not a separate code
 * path, deliberately: an argv-supplied turn that bypassed `handleLine` would be a
 * second, untested way to run a turn, and the two would drift within a week.
 */
export function seededInput(seed: string | null, inner: DriverInput): DriverInput {
  if (seed === null) return inner;
  let spent = false;
  return {
    read: async (prompt) => {
      if (!spent) {
        spent = true;
        return seed;
      }
      return inner.read(prompt);
    },
    close: () => inner.close(),
  };
}

// ── The brain, wired so every product-side event lands in the transcript ──────

export interface DriverBrainOptions {
  readonly chat: ChatFn;
  readonly client: ServeClient;
  readonly sessionId: () => SessionId | undefined;
  readonly transcript: Transcript;
  readonly now?: () => number;
}

/**
 * `HeadlessBrain` with the transcript attached to the two seams that matter.
 *
 * `deps.dispatch` is where a receipt exists, so a DELIVERED `dispatch` row is
 * written from inside it: `at` is the moment of the call, not the moment the turn
 * finished printing. `onPermissionRequired` is the product's single raise point
 * for an ask (`coordinator.ts:622`), so `permission.prompt` is emitted from there
 * rather than reconstructed afterwards — a prompt emitted by inference is a prompt
 * that can be wrong, and this is the one row an operator acts on.
 */
export function createDriverBrain(options: DriverBrainOptions): HeadlessBrain {
  const now = options.now ?? (() => Date.now());
  return new HeadlessBrain({
    chat: options.chat,
    activeSessionId: options.sessionId,
    dispatch: async (text) => {
      const session = options.sessionId();
      if (session === undefined) {
        throw new OrchestratorError('SESSION_NOT_FOUND', false, 'no active session — nothing to dispatch into');
      }
      const startedAt = now();
      const result = await options.client.promptSession(session, text, { origin: 'cli', actor: 'headless-driver' });
      options.transcript.emit({
        type: 'dispatch',
        receipt: result.receipt,
        state: result.state,
        delivered: true,
        ms: now() - startedAt,
        at: new Date(startedAt).toISOString(),
        bytes: Buffer.byteLength(text, 'utf8'),
        text,
        failure: null,
      });
      return { receipt: result.receipt, state: result.state };
    },
    onPermissionRequired: (pending: PendingPermission) => {
      options.transcript.emit({
        type: 'permission.prompt',
        slotId: pending.id,
        taskEn: pending.taskEn,
        sessionId: pending.sessionId,
        askAr: pending.askAr,
        openedAt: pending.openedAt,
      });
    },
  });
}

// ── Internal commands ────────────────────────────────────────────────────────

export interface InternalCommandOutcome {
  readonly name: string;
  readonly argument: string;
  readonly routed: boolean;
  readonly ok: boolean;
  readonly ms: number;
  /** The call that actually ran, or why nothing did. */
  readonly detail: string;
  readonly code: string | null;
  readonly retryable: boolean | null;
}

function refusal(name: string, argument: string, detail: string, code: string): InternalCommandOutcome {
  return { name, argument, routed: false, ok: false, ms: 0, detail, code, retryable: false };
}

/**
 * Route ONE internal command and report what happened. NEVER THROWS.
 *
 * A REPL that dies because the operator typed an unknown slash command cannot be
 * used to test what happens AFTER an unknown slash command, so a refusal is an
 * EVENT recorded in the transcript, not an exception.
 *
 * WHY THE CLIENT METHODS AND NOT `OpenCodeBridge.runInternalCommand`. Two reasons,
 * both measured rather than stylistic. `runInternalCommand` returns `{ ok: true }`
 * for `model` WITHOUT CALLING ANYTHING (`runtime/opencode-bridge.ts:201`) — a
 * switch arm that reports a success it did not perform, which in a transcript is a
 * fabricated row. And it throws a plain `Error` with no `.code` (`:191`), so a
 * refusal could not be reported in the product's own taxonomy. The four client
 * methods are the same transport with neither defect, and calling them directly is
 * what makes "report whatever actually happens, including failure" true.
 */
export async function routeInternalCommand(input: {
  readonly client: ServeClient;
  readonly sessionId: SessionId | undefined;
  readonly name: string;
  readonly argument: string;
  readonly now?: () => number;
}): Promise<InternalCommandOutcome> {
  const now = input.now ?? (() => Date.now());
  const name = input.name.replace(/^\//, '').trim().toLowerCase();
  const argument = input.argument.trim();
  const startedAt = now();

  if (!isDriverInternalCommand(name)) {
    // The wording matches `opencode-bridge.ts:191`, so the two refusals read as the
    // SAME refusal rather than as two unrelated sentences.
    return refusal(
      name,
      argument,
      `unsupported internal command: ${name.slice(0, 32)} — routable: ${DRIVER_INTERNAL_COMMANDS.join(', ')}`,
      'CONFIG_INVALID',
    );
  }

  const session = input.sessionId;
  if (session === undefined) {
    return refusal(name, argument, 'no active session — name one with --session, or create one first', 'SESSION_NOT_FOUND');
  }

  const done = (detail: string): InternalCommandOutcome => ({
    name,
    argument,
    routed: true,
    ok: true,
    ms: now() - startedAt,
    detail,
    code: null,
    retryable: null,
  });

  try {
    switch (name) {
      case 'compact': {
        await input.client.compactSession(session);
        return done('ServeClient.compactSession — POST /api/session/{id}/compact');
      }
      case 'undo': {
        // `runInternalCommand` maps `undo` to the `stage` phase (`:194-195`), and
        // so does this. Matching it is the point: a driver that reverted somewhere
        // else would be testing a different product than the voice loop drives.
        await input.client.revertSession(session, 'stage');
        return done('ServeClient.revertSession(stage) — POST /api/session/{id}/revert/stage');
      }
      case 'clear': {
        await input.client.revertSession(session, 'clear');
        return done('ServeClient.revertSession(clear) — POST /api/session/{id}/revert/clear');
      }
      case 'revert': {
        const phases = ['stage', 'commit', 'clear'] as const;
        const phase = phases.find((p) => p === argument);
        if (argument.length > 0 && phase === undefined) {
          return refusal(
            name,
            argument,
            `revert phase must be one of ${phases.join(', ')} — got "${argument.slice(0, 24)}"`,
            'CONFIG_INVALID',
          );
        }
        const chosen = phase ?? 'stage';
        await input.client.revertSession(session, chosen);
        return done(`ServeClient.revertSession(${chosen}) — POST /api/session/{id}/revert/${chosen}`);
      }
      case 'interrupt': {
        await input.client.interruptSession(session);
        return done('ServeClient.interruptSession — POST /api/session/{id}/interrupt');
      }
      case 'model': {
        if (argument.length === 0) {
          return refusal(name, argument, 'model needs a target: `/model <provider/id>` or `/model <spoken name>`', 'CONFIG_INVALID');
        }
        // Resolved against the LIVE catalog, never invented. `fuzzyPick` is the
        // product's own resolver (`runtime/opencode-bridge.ts:170`), so a name it
        // cannot resolve refuses here exactly as it refuses there.
        let catalog: string[] = [];
        try {
          catalog = (await input.client.listModels()).map((m) => m.id);
        } catch {
          // The catalog is UNAVAILABLE, not empty — a distinction this comment
          // exists to keep. The literal `provider/id` spelling below is a
          // legitimate fallback; guessing an id would not be.
          catalog = [];
        }
        let id = catalog.length > 0 ? fuzzyPick(argument, catalog) : null;
        let providerID = 'opencode';
        if (id === null && argument.includes('/')) {
          const slash = argument.indexOf('/');
          const provider = argument.slice(0, slash);
          const rest = argument.slice(slash + 1);
          if (provider.length > 0 && rest.length > 0) {
            id = rest;
            providerID = provider;
          }
        }
        if (id === null) {
          return refusal(
            name,
            argument,
            `model not resolvable: ${argument.slice(0, 40)} — ${catalog.length} model(s) in the live catalog`,
            'CONFIG_INVALID',
          );
        }
        // The REAL call. Whatever serve answers — including a refusal — is what the
        // `command` row reports. The bridge's `{ ok: true }` no-op is not
        // reproduced, and `source` above names the one place the caller looks to
        // confirm that.
        await input.client.setSessionModel(session, { id, providerID });
        return done(`ServeClient.setSessionModel({ id: "${id}", providerID: "${providerID}" }) — POST /api/session/{id}/model`);
      }
      // NO `default` ARM, and that is the point. The switch covers
      // `DriverInternalCommand` exhaustively, so a seventh name added to
      // `DRIVER_INTERNAL_COMMANDS` without a route here fails to compile
      // (`noImplicitReturns`) instead of falling through to a silent refusal at
      // runtime — which is the failure this whole file is refusing to have.
    }
  } catch (err) {
    return {
      name,
      argument,
      routed: true,
      ok: false,
      ms: now() - startedAt,
      detail: messageOf(err),
      code: errorCodeFor(err),
      retryable: err instanceof OrchestratorError ? err.retryable : null,
    };
  }
}

function messageOf(err: unknown): string {
  if (err instanceof OrchestratorError) return err.secretSafeMessage;
  if (err instanceof Error) return err.message;
  return 'non-error throw';
}

function errorRow(err: unknown, where: string) {
  return {
    type: 'error' as const,
    message: messageOf(err),
    code: errorCodeFor(err),
    retryable: err instanceof OrchestratorError ? err.retryable : null,
    where,
  };
}

// ── The session ──────────────────────────────────────────────────────────────

export interface DriverSessionDeps {
  readonly transcript: Transcript;
  readonly brain: HeadlessBrain;
  readonly client: ServeClient;
  readonly activeSessionId: () => SessionId | undefined;
  readonly input: DriverInput;
  /** `0` disables the ceiling. Bounds how long the DRIVER waits, not the chain. */
  readonly turnTimeoutMs: number;
  /** How long the tool read may poll. `0` reads once. */
  readonly toolWaitMs: number;
  readonly now: () => number;
  readonly promptPrefix: string;
}

export interface DriverSummary {
  readonly turns: number;
  readonly inputs: number;
  readonly commands: number;
  readonly refused: number;
  readonly errors: number;
  /** Results the product reports as `ok: false` for a reason that is not a refusal. */
  readonly failedTurns: number;
  readonly tools: number;
  readonly failedTools: number;
  readonly dispatches: number;
  readonly delivered: number;
  readonly prompted: number;
  readonly approved: number;
  readonly denied: number;
  readonly ms: number;
  readonly ok: boolean;
}

/**
 * `detail` values that make an `ok: false` result a PRODUCT VERDICT rather than a
 * failure, and so are not counted.
 *
 * Closed on purpose. The gate asking and the gate refusing are the permission
 * system WORKING — the coordinator returns `ok: false` for both precisely so a
 * caller cannot mistake them for success — and counting them would make every
 * permission-protected session red. Everything else with `ok: false` (`intake-
 * failed`, `not-addressed`, `turn-threw`, `dispatch-failed`, `plan-invalid`) is
 * something that did not happen, and an acceptance harness that passes on it is
 * worse than no harness.
 */
const PRODUCT_VERDICTS: ReadonlySet<string> = new Set(['permission-required', 'permission-denied']);

/**
 * Count the transcript's OWN rows.
 *
 * Deriving rather than tallying is the load-bearing decision here: a parallel
 * counter is a second account of the same run, and the two drift the first time a
 * row is emitted from somewhere new. Counting rows means the summary is a
 * function of the file a reader is already looking at.
 *
 * `ok` is `errors === 0 && refused === 0 && failedTurns === 0 && delivered ===
 * dispatches`. A turn that threw, a command that was refused, a turn the product
 * could not complete, or a dispatch serve did not acknowledge all make the session
 * RED.
 */
export function summarise(rows: Transcript['rows'], ms: number): DriverSummary {
  let turns = 0;
  let inputs = 0;
  let commands = 0;
  let refused = 0;
  let errors = 0;
  let failedTurns = 0;
  let tools = 0;
  let failedTools = 0;
  let dispatches = 0;
  let delivered = 0;
  let prompted = 0;
  let approved = 0;
  let denied = 0;
  for (const row of rows) {
    switch (row.type) {
      case 'input':
        inputs += 1;
        break;
      case 'command':
        commands += 1;
        if (!row.ok) refused += 1;
        break;
      case 'error':
        errors += 1;
        break;
      case 'result':
        if (!row.ok && !PRODUCT_VERDICTS.has(row.detail ?? '')) failedTurns += 1;
        break;
      case 'tool':
        tools += 1;
        if (row.status === 'error' || row.error !== null) failedTools += 1;
        break;
      case 'dispatch':
        dispatches += 1;
        if (row.delivered) delivered += 1;
        break;
      case 'permission.prompt':
        prompted += 1;
        break;
      case 'permission.decision':
        if (row.approved) approved += 1;
        else denied += 1;
        break;
      case 'phase':
        if (row.phase === 'turn.begin') turns += 1;
        break;
      default:
        break;
    }
  }
  return {
    turns,
    inputs,
    commands,
    refused,
    errors,
    failedTurns,
    tools,
    failedTools,
    dispatches,
    delivered,
    prompted,
    approved,
    denied,
    ms,
    ok: errors === 0 && refused === 0 && failedTurns === 0 && delivered === dispatches,
  };
}

/**
 * Is this answer an approval?
 *
 * Empty is NOT, and neither is anything on the refusal list. The asymmetry is
 * deliberate: a mistyped `y` costs nothing (the slot survives, the operator asks
 * again), while a mistyped `n` consumed a permission the operator meant to grant.
 */
export function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return false;
  if (/^(n|no|nope|nah|stop|abort|deny|refuse|لا|لأ|kleine)/.test(t)) return false;
  return /^(y|yes|aye|yeah|yep|ok|okay|sure|go|do it|run it|approve|confirm|نعم|نعما|اي|أيوه|ايوه|تمام|بلش|امشي|هلق|اوك)/.test(t);
}

/**
 * The approval utterance, and why it names the slot.
 *
 * `PermissionSlot.consume` compares for EXACT equality against the `approves_id`
 * the gate produced (`coordinator.ts:562`), so an approval that does not carry
 * the id cannot consume the slot and the turn re-asks — the fail-closed path. The
 * operator types `y`; the gate model never sees a `y`, it sees a sentence. That
 * sentence therefore names the slot, and `askOperator` reads the id LATE
 * (`brain.pendingPermission`) rather than capturing it when the ask was raised,
 * for the reason `reason.ts:281-288` gives: an id resolved eagerly can name a slot
 * the product has already replaced.
 */
export function approvalUtterance(pending: PendingPermission, answer: string): string {
  const said = answer.trim();
  return `نعم وافق على: ${pending.taskEn} — slot ${pending.id}${said.length > 0 ? ` (${said})` : ''}`;
}

export function denialUtterance(pending: PendingPermission): string {
  return `لا، ما بدي: ${pending.taskEn} — slot ${pending.id}`;
}

/**
 * Run the REPL until EOF.
 *
 * Every exit is a `session.end` row, because a transcript that stops mid-session
 * is indistinguishable from a crash and the difference is exactly what an
 * acceptance run checks.
 */
export async function runDriverSession(deps: DriverSessionDeps): Promise<DriverSummary> {
  const startedAt = deps.now();
  // Sliced, not counted from zero: `session.start` and `serve.probe` are already
  // in the file and are not part of the session's own accounting. Counting them
  // would make every run report one turn it never ran.
  const baseRows = deps.transcript.count;
  try {
    // SERIAL, one line at a time, each fully finished before the next is read.
    // That is the whole reason the loop awaits rather than firing: a second line
    // overtaking a turn in flight would let `session.end` be written before the
    // last turn's `result`, and would make the transcript's ORDER an accident of
    // scheduling rather than of the run.
    for (;;) {
      const line = await deps.input.read(deps.promptPrefix);
      if (line === null) break;
      if ((await handleLine(line, deps)) === 'stop') break;
    }
  } catch (err) {
    // A throw out of the LOOP (a read that blew up, not a turn). Recorded rather
    // than propagated: the transcript is the deliverable, and a process that died
    // before writing its own failure hands back a file that reads like a clean
    // run.
    deps.transcript.emit(errorRow(err, 'session-loop'));
  }
  return summarise(deps.transcript.rows.slice(baseRows), deps.now() - startedAt);
}

interface LineContext {
  readonly deps: DriverSessionDeps;
  /** Slot ids already decided during THIS input line. */
  readonly decided: Set<string>;
  /** How many approval conversations are already open above this one. */
  readonly depth: number;
  /**
   * Set when the depth cap fired.
   *
   * Mutable and shared by every level of one input line's approval conversation,
   * and it has to be: the cap fires in the DEEPEST frame, and without a flag the
   * enclosing frames simply loop and ask again — which is the unbounded behaviour
   * the cap exists to stop, one frame closer to the surface.
   */
  aborted: boolean;
}

/** Whether the operator asked the REPL to stop. Deliberately NOT one of the six. */
function isStop(line: string): boolean {
  const t = line.trim().toLowerCase();
  return t === '/quit' || t === '/exit' || t === ':q';
}

async function handleLine(line: string, deps: DriverSessionDeps): Promise<'continue' | 'stop'> {
  const t = deps.transcript;
  t.emit({
    type: 'input',
    // VERBATIM. Not trimmed, not normalised, not truncated. The red-team inputs
    // (control characters, bidi overrides, a very long line) ARE the payload of
    // those tests, and an `input` row that quietly cleaned them would make them
    // vacuous.
    text: line,
    chars: line.length,
    bytes: Buffer.byteLength(line, 'utf8'),
  });

  if (isStop(line)) return 'stop';

  const trimmed = line.trim();
  if (trimmed.length === 0) {
    // An explicit termination for an empty line, rather than a turn that spends a
    // model call to learn the same thing.
    t.emit({
      type: 'result',
      ok: false,
      detail: 'empty-input',
      replyAr: null,
      taskEn: null,
      receipt: null,
      ms: 0,
      intakeModel: null,
      gateDecision: null,
      steps: null,
      needsPermission: false,
      failure: null,
    });
    return 'continue';
  }

  if (trimmed.startsWith('/')) {
    const body = trimmed.slice(1);
    const space = body.indexOf(' ');
    const name = space < 0 ? body : body.slice(0, space);
    const argument = space < 0 ? '' : body.slice(space + 1).trim();
    // Awaited, not fired: a transcript whose rows arrive in scheduling order
    // cannot be read as a record of what happened, which is the one property this
    // file exists to have.
    const outcome = await routeInternalCommand({
      client: deps.client,
      sessionId: deps.activeSessionId(),
      name,
      argument,
      now: deps.now,
    });
    t.emit({
      type: 'command',
      name: outcome.name,
      argument: outcome.argument,
      routed: outcome.routed,
      ok: outcome.ok,
      ms: outcome.ms,
      detail: outcome.detail,
      code: outcome.code,
    });
    if (!outcome.ok) {
      // Built from the OUTCOME'S OWN fields, not from `errorRow(outcome.detail)`:
      // that helper takes a THROWN value, and handing it a string classifies it as
      // `'internal'` with the message `non-error throw` — the code the taxonomy
      // reserves for a throw nothing recognised. A refused command has a real code
      // and it belongs in the transcript verbatim.
      t.emit({
        type: 'error',
        message: outcome.detail,
        code: outcome.code ?? 'internal',
        retryable: outcome.retryable,
        where: `command:${outcome.name}`,
      });
    }
    return 'continue';
  }

  await runTurn(trimmed, { deps, decided: new Set<string>(), depth: 0, aborted: false });
  return 'continue';
}

/** One turn, then whatever it asked for. */
async function runTurn(text: string, ctx: LineContext): Promise<void> {
  const { deps } = ctx;
  const t = deps.transcript;
  const now = deps.now;
  // Counted BEFORE this turn's own `turn.begin` is written, so the first turn is
  // `driver-turn-1`. The id reaches `buildHandoff`'s envelope (`coordinator.ts:418`),
  // which makes the handoff a reproducible string rather than one that carries
  // `Date.now()`.
  const taskId = `driver-turn-${countTurns(t) + 1}`;
  const startedAt = now();
  t.emit({ type: 'phase', phase: 'turn.begin', detail: `${taskId} — ${text.length} chars`, ms: null });

  let trace: TurnTrace;
  try {
    const turn = deps.brain.turn(text, { taskId });
    trace = deps.turnTimeoutMs > 0 ? await withTimeout(turn, deps.turnTimeoutMs, taskId) : await turn;
  } catch (err) {
    t.emit(errorRow(err, 'turn'));
    t.emit({
      type: 'result',
      ok: false,
      detail: 'turn-threw',
      replyAr: null,
      taskEn: null,
      receipt: null,
      ms: now() - startedAt,
      intakeModel: null,
      gateDecision: null,
      steps: null,
      needsPermission: false,
      failure: `${errorCodeFor(err)}: ${messageOf(err)}`,
    });
    return;
  }

  emitTurnPhases(t, trace);
  // The delivered `dispatch` rows were written from inside the dispatch dep; an
  // ATTEMPT that threw has none, so it is recorded here as an undelivered row.
  // Without it `dispatched === delivered` would be true by construction and the
  // summary's transport check would be measuring nothing.
  for (const d of trace.dispatches) {
    if (d.delivered) continue;
    const at = new Date(now() - d.ms).toISOString();
    t.emit({
      type: 'dispatch',
      receipt: null,
      state: d.state,
      delivered: false,
      ms: d.ms,
      at,
      bytes: Buffer.byteLength(d.text, 'utf8'),
      text: d.text,
      failure: d.failure,
    });
    t.emit(errorRow(d.failure ?? 'the dispatch call threw with no message', 'dispatch'));
  }

  const result = trace.result;
  t.emit({
    type: 'result',
    ok: result.ok,
    detail: result.detail ?? null,
    replyAr: result.replyAr ?? null,
    taskEn: result.taskEn ?? null,
    receipt: result.receipt,
    ms: trace.ms,
    intakeModel: trace.ack.intakeModel ?? null,
    gateDecision: trace.gateVerdict?.decision ?? null,
    steps: trace.plan === null ? null : trace.plan.steps.length,
    needsPermission: result.needsPermission === true,
    failure: trace.dispatchError,
  });

  await emitTools(t, deps, trace);

  if (result.needsPermission === true) await askOperator(ctx);
}

function countTurns(t: Transcript): number {
  return t.rows.filter((r) => r.type === 'phase' && r.phase === 'turn.begin').length;
}

function emitTurnPhases(t: Transcript, trace: TurnTrace): void {
  const intakeCalls = trace.chatCalls.filter(
    (c) => c.stage === 'intake' || c.stage === 'intake-reask' || c.stage === 'intake-failover',
  );
  t.emit({
    type: 'phase',
    phase: 'intake',
    detail: trace.ack.ok ? (trace.ack.taskEn ?? trace.ack.replyAr ?? 'ok') : (trace.ack.detail ?? 'failed'),
    ms: intakeCalls.reduce((sum, c) => sum + c.ms, 0),
  });
  const gateCall = trace.chatCalls.find((c) => c.stage === 'gate');
  t.emit({
    type: 'phase',
    // `no-gate-call` is the honest name for a turn that never reached the gate. A
    // turn that ended inside intake cannot have been refused by the gate, and
    // reporting that as a refusal would blame the guard for the transport's fault.
    phase: 'gate',
    detail: gateCall === undefined ? 'no-gate-call' : (trace.gateVerdict?.decision ?? 'unparsable-verdict'),
    ms: gateCall?.ms ?? null,
  });
  t.emit({
    type: 'phase',
    phase: 'plan',
    detail: trace.plan === null ? (trace.result.detail ?? 'no plan') : `${trace.plan.steps.length} step(s)`,
    ms: trace.chatCalls.filter((c) => c.stage === 'plan').reduce((sum, c) => sum + c.ms, 0),
  });
  t.emit({
    type: 'phase',
    phase: 'dispatch',
    detail:
      trace.dispatches.length === 0
        ? 'NOTHING'
        : `${trace.dispatches.filter((d) => d.delivered).length} of ${trace.dispatches.length} delivered`,
    ms: trace.dispatches.reduce((sum, d) => sum + d.ms, 0),
  });
}

async function emitTools(t: Transcript, deps: DriverSessionDeps, trace: TurnTrace): Promise<void> {
  const session = deps.activeSessionId();
  if (session === undefined) return;
  const receipt = trace.dispatches.find((d) => d.delivered)?.receipt ?? null;
  if (receipt === null) {
    t.emit({ type: 'phase', phase: 'tools', detail: 'not read — no delivered dispatch to scope them to', ms: null });
    return;
  }
  const read = await readToolInvocations(deps.client, session, {
    afterRowId: receipt,
    deadlineMs: deps.toolWaitMs,
    now: deps.now,
  });
  t.emit({
    type: 'phase',
    phase: 'tools',
    detail: read.ok
      ? `${read.invocations.length} tool call(s) across ${read.matched} row(s) in ${read.polls} read(s)`
      : `unreadable: ${read.error ?? 'unknown'}`,
    ms: read.waitedMs,
  });
  if (!read.ok) {
    t.emit({
      type: 'error',
      message: read.error ?? 'session.messages: unreadable',
      code: 'CONTRACT_DRIFT',
      retryable: false,
      where: 'tools',
    });
    return;
  }
  for (const inv of read.invocations) {
    t.emit({
      type: 'tool',
      callId: inv.callId,
      name: inv.name,
      status: inv.status,
      args: inv.args,
      result: inv.output,
      error: inv.error,
      title: inv.title,
      ms: inv.ms,
      readWaitMs: read.waitedMs,
      rowId: inv.rowId,
    });
    // A FAILED TOOL IS THE LOUD CASE THIS HARNESS EXISTS FOR. The row alone would
    // leave `status: "error"` sitting in a transcript whose summary counted no
    // errors, so the failure is also counted: a broken tool cannot pass a run.
    if (inv.status === 'error' || inv.error !== null) {
      t.emit({
        type: 'error',
        message: `tool ${inv.name} reported ${inv.status}: ${inv.error ?? 'no error text on the part'}`,
        code: 'CONTRACT_DRIFT',
        retryable: false,
        where: `tool:${inv.name}`,
      });
    }
  }
}

/**
 * How deep the approval conversation may nest before the driver stops it.
 *
 * WHY DEPTH AND NOT A COUNT, MEASURED RATHER THAN ASSUMED. The approval turn is
 * itself a turn: if the gate asks again — which it does after an `approval-unbound`
 * or an `ask_permission` — `runTurn` calls back into `askOperator`, and the
 * transcript shows the ask count climbing one per answer rather than staying flat.
 * So a "how many answers has this input line given" counter never reaches its own
 * limit while answers remain, and the loop is bounded only by however many lines
 * the operator pasted: a script of ten thousand `y` lines would recurse ten thousand
 * frames deep. The cap is therefore on NESTING DEPTH, which is the quantity that
 * actually grows, and it is checked before each `runTurn` rather than after it.
 */
const MAX_PERMISSION_DEPTH = 5;

/**
 * BLOCK on the operator, then carry the answer through the product's own gate.
 *
 * The block is a real `read()` on the same line source as the REPL, which is why
 * this works with piped stdin and a TTY without two code paths.
 *
 * TWO GUARDS, AND THE SECOND ONE IS THE ONE THAT ACTUALLY FIRES. `PermissionSlot.open`
 * mints a FRESH id on every ask, so a gate that re-asks after each answer presents a
 * slot id the driver has never seen — a "have I decided this id?" set therefore never
 * fires against the worst case, which is the model that asks forever. The id set is
 * kept because it catches a genuine same-slot retry; `PERMISSION_ROUNDS` is kept
 * because it catches the rest. Both write an explicit `result` row: a silent return
 * here would be an unbounded conversation whose transcript simply stops, and a
 * transcript that stops is indistinguishable from a hang.
 */
async function askOperator(ctx: LineContext): Promise<void> {
  const { deps } = ctx;
  const t = deps.transcript;

  const guardRow = (pending: PendingPermission, detail: string): void => {
    t.emit({
      type: 'permission.decision',
      slotId: pending.id,
      answer: '',
      approved: false,
      utterance: '',
      consumed: false,
      dispatches: 0,
      detail,
    });
    t.emit({
      type: 'result',
      ok: false,
      detail: 'permission-loop-guard',
      replyAr: pending.askAr,
      taskEn: pending.taskEn,
      receipt: null,
      ms: 0,
      intakeModel: null,
      gateDecision: 'ask_permission',
      steps: null,
      needsPermission: true,
      failure: null,
    });
  };

  // Checked BEFORE the first read, on entry. Past this depth the driver stops
  // answering on the operator's behalf, tells the enclosing frames so, and the ask
  // stands with the transcript saying why.
  if (ctx.depth >= MAX_PERMISSION_DEPTH) {
    ctx.aborted = true;
    const pending = deps.brain.pendingPermission;
    if (pending !== null) {
      guardRow(
        pending,
        `refused: the gate re-asked ${ctx.depth} times on this one input line, each time opening a FRESH slot — the driver stopped answering at depth ${MAX_PERMISSION_DEPTH} and the ask stands`,
      );
    }
    return;
  }

  for (;;) {
    // LATE-BOUND: read after every await, never captured before one. The id
    // `consume` compares against is the one the product holds RIGHT NOW.
    const pending = deps.brain.pendingPermission;
    if (pending === null) return;

    if (ctx.decided.has(pending.id)) {
      guardRow(
        pending,
        'refused: this slot id was already decided on this input line — the gate re-asked with the SAME id, and answering it again would authorise nothing',
      );
      return;
    }

    const answer = await deps.input.read(`approve ${pending.id}? [y/n] `);
    if (answer === null) {
      t.emit({
        type: 'permission.decision',
        slotId: pending.id,
        answer: '',
        approved: false,
        utterance: '',
        consumed: false,
        dispatches: 0,
        detail: 'no operator available (stdin closed) — the ask stands and nothing was approved',
      });
      return;
    }

    ctx.decided.add(pending.id);
    // The operator's answer is INPUT and is echoed like any other input line,
    // verbatim. It was missing at first, and that is a real defect in a transcript
    // whose job is to record what the operator did: a file showing a permission
    // prompt and a decision with an unrecorded answer in between is a file that
    // cannot answer "what did the operator actually say".
    t.emit({ type: 'input', text: answer, chars: answer.length, bytes: Buffer.byteLength(answer, 'utf8') });
    const approved = isAffirmative(answer);
    const utterance = approved ? approvalUtterance(pending, answer) : denialUtterance(pending);
    const dispatchBefore = t.count;
    await runTurn(utterance, { deps, decided: ctx.decided, depth: ctx.depth + 1, aborted: ctx.aborted });
    const consumed = deps.brain.pendingPermission === null;
    t.emit({
      type: 'permission.decision',
      slotId: pending.id,
      answer,
      approved,
      utterance,
      consumed,
      dispatches: t.rows.slice(dispatchBefore).filter((r) => r.type === 'dispatch').length,
      detail: consumed
        ? 'the gate consumed the slot and the turn continued'
        : 'the slot is STILL open — the gate did not accept this decision',
    });
    // A deeper frame already hit the cap. Stopping HERE is what makes the cap a
    // bound rather than a marker: without this line every enclosing frame loops and
    // asks again.
    if (ctx.aborted) return;
  }
}

/**
 * A bounded ceiling on one turn.
 *
 * The abandoned promise is NOT cancelled — the coordinator has no cancellation
 * hook on this path — so the turn may still finish and its dispatch may still
 * land. Stated rather than hidden: the timeout bounds how long the DRIVER waits,
 * not what the chain does afterwards.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new OrchestratorError('TASK_TIMEOUT', true, `${label} exceeded the ${ms} ms driver timeout`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────────

export interface DaemonStartOutcome {
  readonly started: boolean;
  readonly ipcPort: number | null;
  readonly detail: string;
}

export interface DaemonStopOutcome {
  readonly stopped: boolean;
  readonly detail: string;
}

export interface DriverDaemon {
  readonly requested: boolean;
  start(): Promise<DaemonStartOutcome>;
  stop(): Promise<DaemonStopOutcome>;
}

/** A daemon that does nothing, for the tests and for runs that need no control plane. */
export function inertDaemon(detail = 'no daemon in this run — the driver requires none'): DriverDaemon {
  return {
    requested: false,
    start: async () => ({ started: false, ipcPort: null, detail }),
    stop: async () => ({ stopped: false, detail }),
  };
}

/**
 * The REAL daemon, behind `--daemon`.
 *
 * Opt-in because `startDaemon` BINDS 4097 (`daemon.ts:301`, via `ipcPort`), and
 * the installed app already owns that port. A driver that took it by default would
 * be unusable on the machine most likely to want to run it. Opt-in also keeps the
 * `daemon.start` row honest about which of the two things happened.
 *
 * THE TOKEN IS THE SUPERVISOR'S. `startDaemon` fails closed without one
 * (`daemon.ts:305`) and the Node side may not mint one: `main.rs` provisions
 * `ipc.token` with an owner-only protected DACL precisely because a token this
 * process invented would be a token anyone could have. So it is read from the
 * runtime directory, and an absent one is recorded as a refusal.
 */
export function realDaemon(requested: boolean, target: ServeTarget, directory: string): DriverDaemon {
  const runtimeDir = runtimeDirOf(process.env);
  let handle: { stop(): Promise<void>; ipcPort: number } | null = null;
  return {
    requested,
    start: async () => {
      if (!requested) {
        return {
          started: false,
          ipcPort: null,
          detail: 'not requested — pass --daemon to start the WS-4097 control plane; the driver needs no control plane',
        };
      }
      let token = '';
      try {
        token = readFileSync(join(runtimeDir, 'ipc.token'), 'utf8').trim();
      } catch {
        return {
          started: false,
          ipcPort: null,
          detail: 'no ipc.token in the runtime directory — the Rust supervisor provisions it, and the driver will not mint one',
        };
      }
      if (token.length === 0) {
        return {
          started: false,
          ipcPort: null,
          detail: 'ipc.token is empty — refusing to start a daemon that would fail closed anyway',
        };
      }
      const created = await startDaemon({
        servePort: target.port,
        servePassword: process.env['OPENCODE_SERVER_PASSWORD'] ?? '',
        ipcToken: token,
        ipcPort: UI_WS_PORT,
        vaultPath: vaultPathFromEnv(),
        directory,
      });
      handle = created;
      return { started: true, ipcPort: created.ipcPort, detail: `startDaemon bound the WS-4097 control plane on ${created.ipcPort}` };
    },
    stop: async () => {
      const live = handle;
      if (live === null) return { stopped: false, detail: 'nothing to stop — the daemon was never started' };
      handle = null;
      await live.stop();
      return { stopped: true, detail: 'daemon.stop() completed' };
    },
  };
}

export function runtimeDirOf(env: NodeJS.ProcessEnv): string {
  const override = env['VOICE_RUNTIME_DIR'];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.opencode-voice-runtime');
}

// ── The live chat, through the product's own keyring ─────────────────────────

/**
 * The brain's chat function, from the vault pool.
 *
 * The same acquisition `reason.ts:39-64` uses, for the same reasons: per-call
 * copies released with the REAL status, so a 429 or a 401 advances the pool rather
 * than retrying a dead key, and the pool is zeroed on the way out so key bytes do
 * not outlive the session. The pattern is restated rather than imported because
 * `reason.ts` exports nothing from it, and moving it would touch a file this
 * change is not responsible for.
 */
export function brainChat(): ChatFn {
  const ring = Keyring.load(new FileVault(vaultPathFromEnv()));
  return async (model, system, user, options) => {
    const reply = await withKey(ring, 'openrouter', async (key) => {
      const material = Buffer.from(key.material).toString('utf8');
      return openRouterChat(material, model, system, user, fetch, {
        ...(options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
      });
    });
    try {
      ring.destroy();
    } catch {
      // Best-effort. A throw here must not mask a turn's result.
    }
    return reply;
  };
}

/** The newest session serve reports, or a refusal naming what is missing. */
async function resolveSession(explicit: string | null, client: ServeClient): Promise<SessionId> {
  if (explicit !== null) return explicit as SessionId;
  const rows = await client.listSessions();
  if (rows.length === 0) {
    throw new OrchestratorError(
      'SESSION_NOT_FOUND',
      false,
      'serve reports no sessions — create one with `opencode-voice create-session`, or name one with --session',
    );
  }
  // `updatedAt` is serve's own field; ties fall back to serve's list order, which
  // is serve's.
  const sorted = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const newest = sorted[0];
  if (newest === undefined) {
    throw new OrchestratorError('SESSION_NOT_FOUND', false, 'serve returned sessions but none had a usable row');
  }
  return newest.sessionId as SessionId;
}

// ── The production entry point ───────────────────────────────────────────────

export interface DriverOptions {
  /** A first utterance, run through the SAME line handler before stdin. */
  readonly seed: string | null;
  readonly sessionId: string | null;
  readonly directory: string | null;
  readonly transcriptFile: string | null;
  readonly turnTimeoutMs: number;
  readonly toolWaitMs: number;
  readonly startDaemon: boolean;
  /**
   * The line source. Defaults to `node:readline` over stdin; injected by the
   * tests, which is the only reason this is an option rather than a constant.
   *
   * It exists because `readline` takes over `process.stdin` for the life of the
   * interface: a test that called the real one would take the runner's own stdin
   * hostage, and a suite that hangs under `vitest run` is a suite nobody runs.
   */
  readonly input?: DriverInput;
  /**
   * Where each transcript row goes besides the file. `null` or absent means
   * stdout, which is what a real run wants; the tests inject a collector so a
   * suite does not spray JSONL over the reporter's own output.
   */
  readonly echo?: ((line: string) => void) | null;
}

const EMPTY_SUMMARY: DriverSummary = {
  turns: 0,
  inputs: 0,
  commands: 0,
  refused: 0,
  errors: 0,
  failedTurns: 0,
  tools: 0,
  failedTools: 0,
  dispatches: 0,
  delivered: 0,
  prompted: 0,
  approved: 0,
  denied: 0,
  ms: 0,
  ok: false,
};

/**
 * `opencode-voice driver` — probe, wire, REPL, teardown.
 *
 * EXIT CODES:
 *   0  every input terminated explicitly, nothing refused, nothing failed
 *   1  serve answered and the session still went red — a turn threw, a command was
 *      refused, or a dispatch was not acknowledged; the transcript says which
 *   2  serve could not be used at all (no credential, no session, unusable
 *      config) — an environment problem, not an agent verdict
 *   1  serve is not healthy: `SERVE_UNREACHABLE`, recorded, and the process EXITS
 *      rather than opening a REPL it cannot use
 *
 * THE UNHEALTHY PATH IS THE ONE THAT MUST NOT HANG. Acceptance #5 is a killed
 * serve, and a REPL that waits for input after reporting an unreachable server is
 * indistinguishable from a hang in CI. So the probe gates the loop, not the other
 * way round.
 */
export async function driverCommand(options: DriverOptions): Promise<number> {
  const directory = options.directory ?? process.cwd();
  const file =
    options.transcriptFile ??
    defaultTranscriptPath({ runtimeDir: runtimeDirOf(process.env), session: options.sessionId, now: new Date() });
  const transcript = new Transcript({
    file,
    // `exactOptionalPropertyTypes` forbids handing an `undefined` where the option
    // is typed `(fn) | null`, so the absence case is spelled `null`.
    write: options.echo ?? null,
    now: () => Date.now(),
  });

  const finish = (summary: DriverSummary, exitCode: number, reason: string): number => {
    transcript.emit({
      type: 'session.end',
      turns: summary.turns,
      inputs: summary.inputs,
      commands: summary.commands,
      refused: summary.refused,
      errors: summary.errors,
      tools: summary.tools,
      dispatches: summary.dispatches,
      delivered: summary.delivered,
      prompted: summary.prompted,
      approved: summary.approved,
      denied: summary.denied,
      ms: summary.ms,
      ok: summary.ok,
      exitCode,
      reason,
    });
    if (transcript.writeFailures > 0) {
      process.stderr.write(
        `transcript file write failed ${transcript.writeFailures} time(s): ${transcript.lastWriteFailure ?? 'unknown'} — stdout still carries every row\n`,
      );
    }
    return exitCode;
  };

  let target: ServeTarget | null = null;
  let openFailure: unknown = null;
  try {
    target = await openServeTarget({ directory });
  } catch (err) {
    openFailure = err;
  }

  transcript.emit({
    type: 'session.start',
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    serveBaseUrl: target?.baseUrl ?? '(unresolved)',
    servePort: target?.port ?? 0,
    passwordSource: target?.passwordSource ?? 'none',
    session: options.sessionId,
    transcriptFile: file,
    supervisor: SERVE_SUPERVISOR_NOTE,
  });

  if (target === null) {
    transcript.emit(errorRow(openFailure, 'serve-target'));
    return finish(EMPTY_SUMMARY, 2, 'the serve target could not be opened');
  }

  const probeAt = Date.now();
  transcript.emit({
    type: 'serve.probe',
    baseUrl: target.baseUrl,
    port: target.port,
    passwordSource: target.passwordSource,
    healthy: target.healthy,
    // The elapsed time of `openServeTarget`, which CONTAINS the `probeHealth`
    // probe. Named for that rather than for a bare HTTP round trip it never
    // measured on its own.
    ms: Date.now() - probeAt,
  });

  if (!target.healthy) {
    // The same message `startDaemon` throws (`daemon.ts:310-314`), so an operator
    // sees ONE wording for "there is no serve" rather than two.
    transcript.emit({
      type: 'error',
      message: `no healthy opencode serve on 127.0.0.1:${target.port}`,
      code: 'SERVE_UNREACHABLE',
      retryable: true,
      where: 'serve.probe',
    });
    return finish(
      { ...EMPTY_SUMMARY, errors: 1 },
      1,
      'serve is not healthy — the driver does not open a REPL it cannot use',
    );
  }

  try {
    requirePassword(target);
  } catch (err) {
    transcript.emit(errorRow(err, 'serve-credential'));
    return finish({ ...EMPTY_SUMMARY, errors: 1 }, 2, 'no serve credential');
  }

  let session: SessionId;
  try {
    session = await resolveSession(options.sessionId, target.client);
  } catch (err) {
    transcript.emit(errorRow(err, 'session-resolve'));
    return finish({ ...EMPTY_SUMMARY, errors: 1 }, 2, 'no session to drive');
  }

  const daemon = realDaemon(options.startDaemon, target, directory);
  const daemonStartAt = Date.now();
  try {
    const outcome = await daemon.start();
    transcript.emit({
      type: 'daemon.start',
      started: outcome.started,
      requested: daemon.requested,
      ipcPort: outcome.ipcPort,
      ms: Date.now() - daemonStartAt,
      detail: outcome.detail,
    });
  } catch (err) {
    transcript.emit(errorRow(err, 'daemon.start'));
  }

  let chat: ChatFn;
  try {
    chat = brainChat();
  } catch (err) {
    transcript.emit(errorRow(err, 'brain-key'));
    await stopDaemon(transcript, daemon);
    return finish({ ...EMPTY_SUMMARY, errors: 1 }, 2, 'no brain key in the vault');
  }

  const input = seededInput(options.seed, options.input ?? stdinInput());
  const summary = await runDriverSession({
    transcript,
    brain: createDriverBrain({ chat, client: target.client, sessionId: () => session, transcript }),
    client: target.client,
    activeSessionId: () => session,
    input,
    turnTimeoutMs: options.turnTimeoutMs,
    toolWaitMs: options.toolWaitMs,
    now: () => Date.now(),
    promptPrefix: '> ',
  });
  input.close();
  await stopDaemon(transcript, daemon);

  const exitCode = summary.ok ? 0 : 1;
  return finish(summary, exitCode, summary.ok ? 'the session ended with no refused input and no failure' : 'the session went red — see the rows above');
}

/** Append the `daemon.stop` row, whatever the daemon's `stop()` did. */
async function stopDaemon(transcript: Transcript, daemon: DriverDaemon): Promise<void> {
  const at = Date.now();
  try {
    const outcome = await daemon.stop();
    transcript.emit({ type: 'daemon.stop', stopped: outcome.stopped, ms: Date.now() - at, detail: outcome.detail });
  } catch (err) {
    transcript.emit(errorRow(err, 'daemon.stop'));
    transcript.emit({ type: 'daemon.stop', stopped: false, ms: Date.now() - at, detail: `stop threw: ${messageOf(err)}` });
  }
}