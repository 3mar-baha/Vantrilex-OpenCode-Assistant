import type { SessionId } from '../common/brands.js';
import { errorCodeFor } from '../common/errors.js';
import type { UiCommand } from '../ipc/protocol.js';
import { spokenAsk, type PendingConfirmation } from './permission.js';

// Daemon-side WS-4097 command execution. Maps renderer intents to ServeClient
// mutations; every failure becomes a structured outcome (never an exception
// escaping to the socket). The UiServer turns the outcome into an ack.
//
// PHASE 5 — GOVERNANCE TIERS. FR-12 parks any command with real-world blast
// radius until the operator confirms it. The tier model below is the definition
// of which commands those are, and it is a TIER MODEL rather than a longer
// denylist for a reason that is a correction, not a preference: the previous
// reading was "anything not explicitly known to be safe is gated", which put an
// approval prompt in front of every conversational turn. The owner's decision is
// the other way round and is recorded here verbatim in behaviour — see
// `COMMAND_TIERS` for the classification and its reasoning.

/**
 * WHAT `ok` MEANS. One sentence, because it is the sentence every reader of an
 * ack needs and the old code had two incompatible ones:
 *
 * **`ok` is DISPATCH, not OUTCOME — it says the verb was reached and the
 * contract held, and it deliberately says NOTHING about whether the work
 * succeeded.**
 *
 * WHY NOT THE OTHER DEFINITION. "The command succeeded" is unrepresentable in
 * this layer. Serve reports no exit code on a shell call (measured: `exit 3`
 * comes back `status: 'completed'`, empty output, no exit field anywhere), so
 * the two available readings of a completed tool call are "it worked" and "we
 * cannot tell", and the honest one is the second. Claiming `ok: true` under the
 * success reading is the fabrication the `output` frame and the task notice
 * were built to remove — it was the same lie wearing a boolean. Claiming
 * `ok: false` would be the mirror fabrication, and inferring it from an empty
 * output string was explicitly forbidden: a command that legitimately printed
 * nothing is indistinguishable from `exit 3` and both are `unknown`.
 *
 * SO THE OUTCOME IS NOT DROPPED — it is moved to `detail`, which is where a
 * machine code belongs. Every surface then reports the same fact: the ack says
 * `shell-outcome-unknown`, the `output` frame says `outcome: 'unknown'`, and
 * the notice says `warn` with the Arabic "the server returned no exit code, so
 * the result is not confirmed". Three surfaces, one judgement, derived by the
 * one exported function (`deriveShellOutcome`) rather than three.
 */
export interface CommandOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * The three verdicts serve's shell route can support. Structurally identical to
 * `ShellOutcome` in `runtime/client.ts` and declared here so this module stays
 * client-free — the router has no business importing the HTTP layer.
 */
export type ShellOutcomeLike = 'ok' | 'failed' | 'unknown';

/**
 * The slice of a shell result the ack needs.
 *
 * `outcome` is OPTIONAL on purpose, and the default it forces is the honest
 * one: a client that answers without a contract-shaped verdict yields
 * `unknown`, not `ok`. A required field would be a better type and would also
 * be a lie about the fakes in this tree's own tests — a stub returning `{}` is
 * exactly the "answered nothing, concluded nothing" case, and forcing it to
 * invent a verdict is the defect, not the fix.
 */
export interface ShellResultLike {
  readonly outcome?: ShellOutcomeLike;
}

/** The `ack.detail` a derived shell outcome is reported as. */
export const SHELL_OUTCOME_DETAIL: Readonly<Record<ShellOutcomeLike, string>> = {
  ok: 'shell-outcome-ok',
  failed: 'shell-outcome-failed',
  unknown: 'shell-outcome-unknown',
};

/**
 * Read a client's verdict, and refuse to guess one.
 *
 * Anything that is not one of the three literals — including a result with no
 * `outcome` at all — is `unknown`. `'ok'` is the one value that must never be
 * produced by a default, and it is the only one a default would produce wrongly.
 */
export function outcomeOf(result: ShellResultLike | void): ShellOutcomeLike {
  const outcome = result?.outcome;
  return outcome === 'ok' || outcome === 'failed' || outcome === 'unknown' ? outcome : 'unknown';
}

export interface CommandClient {
  setSessionAgent(sessionId: SessionId, agent: string): Promise<unknown>;
  setSessionModel(sessionId: SessionId, model: { id: string; providerID: string }): Promise<unknown>;
  toggleSessionSkill(sessionId: SessionId, skill: string, action: 'attach' | 'detach'): Promise<unknown>;
  /**
   * Run a shell command, and ANSWER WITH WHAT SERVE SAID.
   *
   * `commandId` is the WS command id, threaded in so the `output` frame can be
   * correlated to the command the shell is still showing a spinner for, rather
   * than to a daemon-internal task id. It is a REQUIRED parameter and not an
   * optional one: an `execSessionShell` that cannot be correlated to its command
   * produces a frame the shell has to guess about, and making the id optional
   * would let a future caller quietly drop back to that.
   *
   * THE OTHER FOUR VERBS DELIBERATELY DO NOT TAKE ONE, and that is a checked
   * decision rather than an oversight. Of the five, only `execSessionShell`
   * produces a frame keyed by a command (`output`); `setSessionAgent` /
   * `setSessionModel` publish nothing per-command, `toggleSessionSkill`
   * publishes an ack only, and `createSession` returns its id in the ack's own
   * detail. Adding a parameter nothing consumes is how an interface grows a
   * false affordance.
   */
  execSessionShell(sessionId: SessionId, command: string, commandId: string): Promise<ShellResultLike | void>;
  /** Phase 4 — session manager. */
  createSession?(directory: string): Promise<{ sessionId: SessionId }>;
  contextUsage?(sessionId: SessionId, limit?: number): Promise<ContextUsageLike>;
}

/** The slice of `ContextUsage` the router needs; keeps this module client-free. */
export interface ContextUsageLike {
  readonly used: number;
  readonly limit: number | null;
  readonly percent: number | null;
  readonly messageCount: number;
}

export interface KeySaver {
  saveKeys(keys: { groq: string; fish: string; openrouter: string }): Promise<unknown>;
}

export interface CommandRouterDeps {
  readonly client: CommandClient;
  readonly switchSession: (id: SessionId) => void;
  readonly activeSessionId: () => SessionId | undefined;
  readonly saveKeys?: KeySaver;
  /** Persist the active voice persona server-side (real state, not cosmetic). */
  readonly setPersona?: (persona: 'kareem' | 'nour') => void;
  /**
   * Barge-in hook: an `abort` command trips the TTS speech gate so stale
   * reply sentences never synthesize or broadcast afterwards. Absent by
   * default (keyless daemons have no speech to stop).
   *
   * This is the EXPLICIT stop: the HUD button, and it cancels the whole turn.
   */
  readonly onAbort?: () => void;
  /**
   * M2 Pattern 2 — speech-only barge-in, the command a voice burst sends.
   *
   * Deliberately NOT the same hook as `onAbort`. A barge used to send `abort`,
   * so talking over the assistant discarded the plan already paid for (free-tier
   * p50 1,950 ms) and the user heard nothing. This stops the audio and leaves
   * the turn running; the button remains the full cancel.
   */
  readonly onStopSpeech?: () => void;
  /**
   * M2 Pattern 3 — the shell's player started audio, once per utterance.
   *
   * This is the delivery channel's liveness signal, nothing more: it does not
   * carry the audio (that is the binary downlink) and it is not a barge. The
   * daemon uses it to mark the channel playable so a held FR-12 confirmation is
   * delivered when the user can hear it, rather than into an utterance.
   */
  readonly onPlaybackStarted?: (playbackId?: string) => void;
  /** Phase 4: the directory a new session is created in (the project root). */
  readonly projectDirectory: () => string;
  /** Phase 4: publish context-window telemetry to the shell. */
  readonly onContext?: (sessionId: SessionId, usage: ContextUsageLike) => void;
  /**
   * Phase 5: fired after a command actually executed (not when it was parked
   * for FR-12 confirmation). The daemon uses this to have the MODEL narrate
   * the outcome — the reason confirmations stopped sounding like templates.
   */
  readonly onExecuted?: (cmd: UiCommand, outcome: CommandOutcome) => void;
  /**
   * Phase 5: the state-mutating actions this router gates but cannot yet reach.
   *
   * ABSENT IS THE NORMAL STATE and the refusal is structured, not a throw: a
   * keyless or not-yet-integrated daemon answers `file operations unavailable`.
   * The gate is the reason these are optional — a mutating verb that cannot be
   * reached cannot be approved into doing anything either, and the router does
   * not pretend otherwise by faking a success.
   */
  readonly mutateFile?: (
    sessionId: SessionId,
    op: { readonly kind: 'writeFile' | 'deleteFile'; readonly path: string; readonly contents?: string },
  ) => Promise<unknown>;
  /** Phase 5: the sensitive-configuration toggle, gated like the file verbs. */
  readonly setSensitiveConfig?: (
    sessionId: SessionId,
    op: { readonly key: string; readonly value?: string },
  ) => Promise<unknown>;
  /**
   * Phase 5: fired when a state-mutating command is PARKED, with the ask the
   * user has to answer. Never fired for a read-only kind — `PendingConfirmation`'s
   * `tier` is the literal `'state-mutating'`, so this cannot be called on the
   * conversational path at all.
   */
  readonly onConfirmationRequired?: (pending: PendingConfirmation) => void;
  /**
   * Phase 5: write the ask line for a parked command, in the active persona's
   * voice. Returns `null`/empty when it cannot, and the ask is then withheld —
   * a template is not an acceptable substitute, so the caller renders the
   * machine-facing `taskEn` alone.
   *
   * The daemon wires this to the model; the router NEVER calls a model itself
   * (`deps.chat` does not exist here on purpose — the router is the execution
   * boundary and a synthesis call inside it is the double-quota defect D4).
   */
  readonly askLine?: (pending: PendingConfirmation) => string | null;
}

// ─── PHASE 5 · GOVERNANCE TIERS ──────────────────────────────────────────────

/**
 * Two tiers, and the question each asks is "what happens if this is wrong?".
 *
 *  - `read-only`        — nothing outside this process's transient state
 *                        changes. Wrong answer: one wasted turn, a wrong agent
 *                        name, a stale persona. UNGATED, because a gate here
 *                        costs the user a round trip to ask "yes" about a
 *                        question.
 *  - `state-mutating`   — something on disk, in the session's authority, or in
 *                        the host's configuration changes. Wrong answer: work is
 *                        destroyed, or the agent's permissions move. GATED, and
 *                        fail-closed: unconfirmed means never executed.
 *
 * WHY THIS IS A MAPPED TYPE AND NOT A `Set`. `satisfies Record<GovernedKind,
 * CommandTier>` is TOTAL over the union, and totality here is the fail-closed
 * property rather than a style choice. When the integration wave adds a kind to
 * `UiCommand['kind']` in `protocol.ts`, this table fails to COMPILE until someone
 * writes down what that kind does to the machine. A `Set` cannot do that: a new
 * kind is simply absent, and absent-from-a-denylist has to mean "safe" or the
 * Set is not a gate. There is no default branch, no fall-through and no
 * `unknown` tier — the compiler is what refuses an unclassified verb.
 */
export type CommandTier = 'read-only' | 'state-mutating';

/**
 * The `confirm` verb is the approval itself, not work, so it is not classified.
 * It is handled before the tier lookup and can only release a slot a
 * `state-mutating` kind created. Typing it out of the table is more honest than
 * filing it under a tier: there is no sense in which confirming is safe.
 */
export type WorkCommandKind = Exclude<UiCommand['kind'], 'confirm'>;

/**
 * Kinds the owner named in the Phase-5 decision that `UiCommand['kind']` does not
 * carry yet. They live HERE, in a typed extension, because the union they would
 * join is `protocol.ts` — owned by the integration wave, not by this change.
 *
 * They are real, classified and gated today, not placeholders: the classification
 * below already puts all three in `state-mutating`, and the park path already
 * handles them. What is missing is only the wire, so each of them currently
 * resolves to a structured `… unavailable` refusal instead of executing anything.
 * Nothing here is simulated or stubbed to look like it works.
 *
 * EXACTLY WHAT `protocol.ts` MUST ADD (integration wave, see report):
 *   1. these three strings in the `kind:` z.enum([…]) at `protocol.ts:471`;
 *   2. a `.strict()`-compatible field for each:
 *        writeFile          → `path: string.min(1).max(1024)`, `contents: string.max(1_048_576)`
 *        deleteFile         → `path: string.min(1).max(1024)`
 *        setSensitiveConfig → `configKey: string` (IDENT_RE charset),
 *                             `configValue: string.max(4096)`
 *      each with the same `.refine((v) => !CONTROL_CHARS_RE.test(v))` the other
 *      free-text fields carry, so none of them can forge a supervisor log line;
 *   3. the three kinds in the renderer's `CommandKind` union
 *      (`apps/desktop/src/bridge/ws.ts:117`) so the shell can actually send them.
 * Nothing else in the protocol changes, and no existing frame is altered.
 */
export const PENDING_PROTOCOL_KINDS = ['writeFile', 'deleteFile', 'setSensitiveConfig'] as const;
export type PendingProtocolKind = (typeof PENDING_PROTOCOL_KINDS)[number];

/** Every verb the router governs, protocol-adopted or pending adoption. */
export type GovernedKind = WorkCommandKind | PendingProtocolKind;

/**
 * THE CLASSIFICATION. Every entry carries its reason inline, because the reason
 * is the thing a future editor actually needs and the thing a bare `Set` throws
 * away. Read this table before changing a tier.
 */
export const COMMAND_TIERS = {
  // ── Read-only: the conversational and observational tier. NO GATE. ────────
  // The owner's explicit correction. Gating any of these re-gates conversation,
  // which is the failure this table exists to prevent.
  switchSession: 'read-only', // owner tier 1. Moves a pointer; mutates nothing.
  sessionContext: 'read-only', // owner tier 1. A telemetry read.

  // ── Read-only: this app's own transient state. Nothing persisted, so there
  //    is nothing to confirm and nothing to undo. ─────────────────────────────
  abort: 'read-only', // cancels the current turn. M2: the explicit stop.
  stopSpeech: 'read-only', // audio only. A barge must never cost a round trip.
  playbackStarted: 'read-only', // liveness telemetry of the renderer player.
  mute: 'read-only',
  deafen: 'read-only',
  arm: 'read-only',

  // ── Read-only: session SELECTION. One click back, no machine authority
  //    moves, nothing is destroyed. ───────────────────────────────────────────
  // These three are the ones an over-broad tier-2 would have caught, and
  // "switch to opus" behind an approval prompt is the regression the owner
  // called out. They change which tool answers, not what the tool may do.
  setSessionAgent: 'read-only',
  setSessionModel: 'read-only',
  setPersona: 'read-only', // a voice-tone preference, not a capability.

  // ── Read-only, WITH A STATED CARVE-OUT. Read this one. ────────────────────
  // `saveApiKeys` writes AES-encrypted key material to disk. By the plainest
  // reading of "sensitive configuration" it belongs above this line, and that
  // reading is why it is called out instead of quietly filed. It is here
  // because the actor is the LOCAL USER in their own first-party key window,
  // not the agent, and there is no approval affordance anywhere in the
  // renderer to satisfy a `confirm` — gating it makes first-run key
  // provisioning impossible, which is the v0.6.0 class exactly: every gate
  // green and an installed build that cannot start.
  // THIS IS THE ONE DEVIATION FROM THE OWNER'S TIER-2 LIST, and it is a
  // property of the current renderer, not a judgement that keys are
  // unimportant. If the agent ever gains a path to this command it MUST move
  // to `state-mutating`; the integration wave's job is to re-derive this line.
  saveApiKeys: 'read-only',

  // ── State-mutating: the owner's tier-2 list, verbatim. ────────────────────
  execSessionShell: 'state-mutating', // arbitrary process execution on the host.
  writeFile: 'state-mutating', // owner list: file writes.
  deleteFile: 'state-mutating', // owner list: file deletes.
  setSensitiveConfig: 'state-mutating', // owner list: sensitive config toggles.

  // ── State-mutating, and these two are my call rather than the owner's list. ──
  // Flagged in the report for overrule. Both are classified strictly, both are
  // free to gate today, and the reason for taking the strict reading NOW is that
  // the HUD sends neither (measured: implemented daemon-side, never sent), so
  // there is no flow to break. The stricter reading is cheap today and
  // expensive after Phase 2/7 give either of them a button.
  //
  // `toggleSessionSkill` changes the INSTRUCTIONS the agent will run, which is
  // an authority change in the same family as a config toggle.
  toggleSessionSkill: 'state-mutating',
  // `createSession` PERSISTS a new session in OpenCode's store. It destroys
  // nothing and is trivially abandoned, but "read-only" would be a false
  // description of something that writes, and the tier name is the contract.
  createSession: 'state-mutating',
} satisfies { readonly [K in GovernedKind]: CommandTier };

/** The tier of a verb. Total by construction — see `COMMAND_TIERS`. */
export function tierOf(kind: GovernedKind): CommandTier {
  return COMMAND_TIERS[kind];
}

const PENDING_KIND_SET: ReadonlySet<string> = new Set<string>(PENDING_PROTOCOL_KINDS);

/** True for a kind the shipped wire contract cannot yet carry. */
export function isPendingProtocolKind(kind: string): kind is PendingProtocolKind {
  return PENDING_KIND_SET.has(kind);
}

/**
 * Compatibility view: the gated kinds the CURRENT wire contract can carry.
 *
 * Retained because it is a published export, and DERIVED from the table so there
 * is exactly one place a kind is classified. It is a view, not the definition —
 * a reader who treats this `Set` as the gate will miss the three pending kinds
 * and the reasoning behind every other one. Typed over `WorkCommandKind`, so
 * `confirm` cannot appear in it even by accident.
 */
export const DESTRUCTIVE_KINDS: ReadonlySet<WorkCommandKind> = new Set(
  (Object.keys(COMMAND_TIERS) as GovernedKind[]).filter(
    (k): k is WorkCommandKind => COMMAND_TIERS[k] === 'state-mutating' && !PENDING_KIND_SET.has(k),
  ),
);

/**
 * A command as the router governs it: the shipped `UiCommand` union, plus the
 * three kinds the integration wave has yet to add to it. Widening the handler's
 * PARAMETER is backwards compatible — `(GovernedCommand) => Outcome` is
 * assignable to the `(UiCommand) => Outcome` slot `UiServer.onCommand` declares.
 */
export type GovernedCommand = UiCommand | PendingProtocolCommand;

/** The additive, typed shape of a kind `protocol.ts` does not carry yet. */
export interface PendingProtocolCommand {
  readonly id: string;
  readonly kind: PendingProtocolKind;
  readonly sessionId?: string;
  /** `writeFile` / `deleteFile`. Session-relative; the client owns the root. */
  readonly path?: string;
  /** `writeFile` only. */
  readonly contents?: string;
  /** `setSensitiveConfig` only. */
  readonly configKey?: string;
  /** `setSensitiveConfig` only. */
  readonly configValue?: string;
}

/** Narrows away the pending kinds, for the one dep that must not see them. */
function isProtocolCommand(cmd: GovernedCommand): cmd is UiCommand {
  return !PENDING_KIND_SET.has(cmd.kind);
}

export const CONFIRMATION_TTL_MS = 60_000;
/**
 * L20: upper bound on parked (awaiting-confirmation) commands. A companion is
 * single-user, so anything above a handful is a stuck client or a loop, not a
 * legitimate burst. Oldest is evicted first so the in-flight confirmation is
 * never the one dropped.
 */
export const MAX_PARKED = 8;

/**
 * Session ids are opaque `ses_…` tokens — never paths or free text.
 *
 * L23: this now requires the `ses_` prefix rather than merely tolerating
 * arbitrary alphanumerics. A value that merely *looks* like a token (`..`,
 * `ses_a/../ses_b`) must not be able to reach a path-shaped consumer.
 */
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{1,120}$/;

/**
 * Shell metacharacters that enable injection, chaining, enumeration or
 * traversal — refused outright.
 *
 * L21: the original list was `;&|`<><\n\r`, which left glob (`*?`), brace and
 * group expansion (`{}()`), subshells, tilde expansion, history expansion and
 * `..` traversal completely open. A glob is a read-side enumeration primitive;
 * `{}` and `()` are expansion/substitution in every POSIX shell.
 *
 * This is defense-in-depth BEHIND the FR-12 confirm gate and session scoping.
 * It is a deny-list and therefore not a sandbox: it raises the cost of an
 * accidental or naive payload, and it is tested both for what it refuses and
 * for what it must not break (`rm -rf build` is the FR-12 spec case).
 */
const UNSAFE_SHELL_RE = /[;&|`$<>\n\r*?(){}!~]/;
/** Path traversal as its own rule, so the message says why. */
const TRAVERSAL_RE = /\.\./;
/** A value that lands in `daemon.log` must never be able to forge a log line. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

/**
 * Defense-in-depth for `execSessionShell`. The FR-12 confirm gate is the real
 * control (reachable from the HUD); this rejects payloads that could chain,
 * redirect, enumerate or escape before they are ever parked.
 *
 * The returned message never echoes the payload: it goes to the supervisor log
 * and back to the shell.
 */
export function shellCommandError(command: string): string | null {
  if (command.trim().length === 0) return 'command required';
  if (command.length > 512) return 'command too long';
  if (TRAVERSAL_RE.test(command)) return 'command rejected (path traversal)';
  if (UNSAFE_SHELL_RE.test(command)) return 'command rejected (unsafe metacharacters)';
  return null;
}

/**
 * Defense-in-depth for the file verbs, and the same class of check as
 * `shellCommandError`: a shape the payload must have before it is even parked.
 *
 * SCOPE, STATED PLAINLY. This is a SHAPE check, not a sandbox. It does not know
 * the project root, and the real root scoping belongs to `ServeClient` in
 * `runtime/client.ts` — a file this change must not edit. What it does buy is
 * that a `writeFile` carrying a traversal or a control character is refused
 * BEFORE the user is asked to approve it, so the ask is never about something
 * that was never going to be sent.
 *
 * The returned message never echoes the path: it goes to the supervisor log and
 * back to the shell, and a path is exactly the kind of value a log line should
 * not be echoing verbatim.
 */
export function filePathError(path: string): string | null {
  if (path.trim().length === 0) return 'path required';
  if (path.length > 1024) return 'path too long';
  if (CONTROL_CHARS_RE.test(path)) return 'path rejected (control characters)';
  if (TRAVERSAL_RE.test(path)) return 'path rejected (path traversal)';
  return null;
}

/** `provider/id` → ModelRef; a bare id defaults to the `opencode` provider. */
export function parseModelRef(model: string): { id: string; providerID: string } {
  const slash = model.indexOf('/');
  if (slash > 0) return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  return { providerID: 'opencode', id: model };
}

export interface CommandHandlerOptions {
  readonly now?: () => number;
}

/**
 * The machine-facing English description of a parked action.
 *
 * Derived from the payload's OWN arguments, never from a template keyed on the
 * kind — so the ask cannot describe something other than what is parked, and a
 * shell command is named by its actual text rather than by the word "command".
 * Bounded: the command is already capped at 512 by `shellCommandError` and the
 * path at 1024 by `filePathError`, and this caps the composed string.
 *
 * For `execSessionShell` it deliberately omits the VERB. What the model wrote in
 * the ask is the proposal; what happened is that this exact string was handed to
 * the shell. Labelling it "run" would claim a second, unplanned act.
 */
export function describeAction(cmd: GovernedCommand): string {
  const line = (() => {
    switch (cmd.kind) {
      case 'execSessionShell':
        return `shell: ${cmd.command ?? ''}`;
      case 'writeFile':
        return `write file: ${cmd.path ?? ''}`;
      case 'deleteFile':
        return `delete file: ${cmd.path ?? ''}`;
      case 'setSensitiveConfig':
        return `set config: ${cmd.configKey ?? ''}`;
      default:
        return cmd.kind;
    }
  })();
  return line.length <= 240 ? line : `${line.slice(0, 239).trimEnd()}…`;
}

export function createCommandHandler(
  deps: CommandRouterDeps,
  options: CommandHandlerOptions = {},
): (cmd: GovernedCommand) => Promise<CommandOutcome> {
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, { readonly at: number; readonly cmd: GovernedCommand }>();

  // `sessionId?: string | undefined` rather than `?: string`, because every
  // caller passes a `UiCommand` whose zod-derived field is `string | undefined`
  // and `exactOptionalPropertyTypes` forbids the narrower shape. The `?? ''`
  // below is what actually rejects a missing one; the type only has to admit it.
  const resolveSession = (cmd: { readonly sessionId?: string | undefined }): SessionId | null => {
    const id = cmd.sessionId ?? deps.activeSessionId();
    if (id === undefined || id === '' || !SESSION_ID_RE.test(id)) return null;
    return id as SessionId;
  };

  const execute = async (cmd: GovernedCommand): Promise<CommandOutcome> => {
    const outcome = await dispatch(cmd);
    // Phase 5 — ZERO CANNED REPLIES. Every executed command reports back so
    // the daemon can have the MODEL write the line the user hears. The router
    // itself never produces a sentence.
    //
    // Narrowed to the wire contract: `onExecuted` is the narration seam and the
    // three pending kinds have no narration until Phase 1 gives them an output
    // summary, so they are not reported rather than being reported as something
    // the narrator cannot describe.
    if (isProtocolCommand(cmd)) deps.onExecuted?.(cmd, outcome);
    return outcome;
  };

  const dispatch = async (cmd: GovernedCommand): Promise<CommandOutcome> => {
    switch (cmd.kind) {
      case 'switchSession': {
        if (cmd.sessionId === undefined) return { ok: false, detail: 'sessionId required' };
        deps.switchSession(cmd.sessionId as SessionId);
        return { ok: true };
      }
      case 'setSessionAgent': {
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (cmd.agent === undefined) return { ok: false, detail: 'agent required' };
        await deps.client.setSessionAgent(session, cmd.agent);
        return { ok: true };
      }
      case 'setSessionModel': {
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (cmd.model === undefined) return { ok: false, detail: 'model required' };
        await deps.client.setSessionModel(session, parseModelRef(cmd.model));
        return { ok: true };
      }
      case 'toggleSessionSkill': {
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (cmd.skill === undefined) return { ok: false, detail: 'skill required' };
        await deps.client.toggleSessionSkill(session, cmd.skill, cmd.skillAction ?? 'attach');
        return { ok: true };
      }
      case 'execSessionShell': {
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (cmd.command === undefined) return { ok: false, detail: 'command required' };
        const unsafe = shellCommandError(cmd.command);
        if (unsafe !== null) return { ok: false, detail: unsafe };
        // `cmd.id` is the WS command id, and it is what the `output` frame
        // carries so the shell can match a result to the spinner it is still
        // showing. It used to be dropped here and the frame carried the task
        // queue's id instead; see `CommandClient.execSessionShell`.
        const result = await deps.client.execSessionShell(session, cmd.command, cmd.id);
        // `ok: true` because the verb was reached and the contract held — NOT
        // because the command worked. See the `CommandOutcome` doc for why the
        // success reading is unrepresentable here, and `SHELL_OUTCOME_DETAIL`
        // for where the real verdict goes.
        return { ok: true, detail: SHELL_OUTCOME_DETAIL[outcomeOf(result)] };
      }
      // Phase 5 — file writes and deletes. Gated, and reached only through the
      // park path, so this `case` is the execution half of a two-step.
      case 'writeFile':
      case 'deleteFile': {
        if (deps.mutateFile === undefined) return { ok: false, detail: 'file operations unavailable' };
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (cmd.path === undefined) return { ok: false, detail: 'path required' };
        const badPath = filePathError(cmd.path);
        if (badPath !== null) return { ok: false, detail: badPath };
        // `writeFile` with no contents is an empty-file write, which is a
        // legitimate `touch` — so it is NOT rejected here. The dep owns the
        // meaning of an absent `contents`.
        await deps.mutateFile(session, {
          kind: cmd.kind,
          path: cmd.path,
          ...(cmd.contents !== undefined ? { contents: cmd.contents } : {}),
        });
        return { ok: true };
      }
      // Phase 5 — the sensitive-configuration toggle. Same two-step.
      case 'setSensitiveConfig': {
        if (deps.setSensitiveConfig === undefined) return { ok: false, detail: 'configuration writes unavailable' };
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (cmd.configKey === undefined || cmd.configKey.length === 0) {
          return { ok: false, detail: 'config key required' };
        }
        if (CONTROL_CHARS_RE.test(cmd.configKey)) return { ok: false, detail: 'config key rejected (control characters)' };
        await deps.setSensitiveConfig(session, {
          key: cmd.configKey,
          ...(cmd.configValue !== undefined ? { value: cmd.configValue } : {}),
        });
        return { ok: true };
      }
      case 'saveApiKeys': {
        if (deps.saveKeys === undefined) return { ok: false, detail: 'key intake unavailable' };
        if (cmd.groqKey === undefined || cmd.fishKey === undefined || cmd.openrouterKey === undefined) {
          return { ok: false, detail: 'all 3 keys required' };
        }
        await deps.saveKeys.saveKeys({ groq: cmd.groqKey, fish: cmd.fishKey, openrouter: cmd.openrouterKey });
        return { ok: true };
      }
      case 'setPersona': {
        if (cmd.persona === undefined) return { ok: false, detail: 'persona required' };
        deps.setPersona?.(cmd.persona);
        return { ok: true, detail: 'persona-set' };
      }
      case 'abort':
        deps.onAbort?.();
        return { ok: true };
      // M2 Pattern 2: one line, no session contact, no FR-12 park. The barge is
      // not a destructive act and must never cost a confirmation round-trip.
      case 'stopSpeech':
        deps.onStopSpeech?.();
        return { ok: true };
      // M2 Pattern 3: one line, no session contact, no FR-12 park. Telemetry of
      // the audio path, and it must never be narrated — see the `onExecuted`
      // skip in daemon.ts, which is where that decision is enforced.
      case 'playbackStarted':
        deps.onPlaybackStarted?.(cmd.playbackId);
        return { ok: true };
      // Phase 4 — OpenCode 360° session manager. Both are additive commands;
      // a client that predates them never sends them.
      case 'sessionContext': {
        const session = resolveSession(cmd);
        if (session === null) return { ok: false, detail: 'no active session' };
        if (deps.client.contextUsage === undefined) return { ok: false, detail: 'context telemetry unavailable' };
        const usage = await deps.client.contextUsage(session, cmd.contextLimit);
        deps.onContext?.(session, usage);
        // The detail is a number, never a transcript or key material.
        return {
          ok: true,
          detail: usage.percent === null
            ? `${usage.used} رمز (الحد غير معروف)`
            : `${usage.percent}% من ${usage.limit ?? 0} رمز`,
        };
      }
      case 'createSession': {
        if (deps.client.createSession === undefined) return { ok: false, detail: 'session manager unavailable' };
        const directory = deps.projectDirectory();
        const created = await deps.client.createSession(directory);
        deps.switchSession(created.sessionId);
        return { ok: true, detail: `جلسة جديدة: ${created.sessionId}` };
      }
      case 'mute':
      case 'deafen':
      case 'arm':
        return { ok: true };
      default:
        return { ok: false, detail: 'unsupported command' };
    }
  };

  /**
   * Everything a state-mutating command must satisfy BEFORE it is parked.
   *
   * Returns a failure outcome, or `null` when the command is parkable. Ordering
   * matters in one place: the availability check comes FIRST, so an unreachable
   * verb never spends the user's attention on an ask it cannot honour.
   *
   * The shape checks are duplicated from `dispatch` on purpose. They are cheap
   * and total, and the alternative — parking first and validating on execution —
   * is the behaviour the original code explicitly avoided ("validate before
   * parking so malformed destructive commands fail fast").
   */
  const prevalidate = (cmd: GovernedCommand): CommandOutcome | null => {
    switch (cmd.kind) {
      case 'execSessionShell': {
        if (resolveSession(cmd) === null) return { ok: false, detail: 'no active session' };
        if (cmd.command === undefined) return { ok: false, detail: 'command required' };
        const unsafe = shellCommandError(cmd.command);
        if (unsafe !== null) return { ok: false, detail: unsafe };
        return null;
      }
      case 'writeFile':
      case 'deleteFile': {
        if (deps.mutateFile === undefined) return { ok: false, detail: 'file operations unavailable' };
        if (resolveSession(cmd) === null) return { ok: false, detail: 'no active session' };
        if (cmd.path === undefined) return { ok: false, detail: 'path required' };
        const badPath = filePathError(cmd.path);
        return badPath === null ? null : { ok: false, detail: badPath };
      }
      case 'setSensitiveConfig': {
        if (deps.setSensitiveConfig === undefined) return { ok: false, detail: 'configuration writes unavailable' };
        if (resolveSession(cmd) === null) return { ok: false, detail: 'no active session' };
        if (cmd.configKey === undefined || cmd.configKey.length === 0) {
          return { ok: false, detail: 'config key required' };
        }
        if (CONTROL_CHARS_RE.test(cmd.configKey)) {
          return { ok: false, detail: 'config key rejected (control characters)' };
        }
        return null;
      }
      // `createSession` is state-mutating, so its availability is checked here
      // too — otherwise a daemon without the session manager would park a
      // command, ask the user to confirm it, and only then refuse. The ask has
      // to be worth answering.
      case 'createSession':
        return deps.client.createSession === undefined
          ? { ok: false, detail: 'session manager unavailable' }
          : null;
      default:
        return null;
    }
  };

  /**
   * The ask for a parked command. The English `taskEn` is the ACTION, derived
   * from the payload's own arguments so it cannot describe something other than
   * what is parked.
   *
   * The Arabic line comes from `deps.askLine` and passes `spokenAsk`, which is
   * the single cap both gates share. A writer that returns nothing usable, or
   * more than twenty words, yields `''` — and the ask is then withheld rather
   * than replaced, because a template is the thing the Phase-5 tone work exists
   * to remove. A withheld ask costs the user a rendered line, not the gate.
   */
  const askFor = (cmd: GovernedCommand): PendingConfirmation => {
    const session = resolveSession(cmd);
    const taskEn = describeAction(cmd);
    const openedAt = now();
    const base = {
      id: cmd.id,
      taskEn,
      sessionId: session ?? '',
      tier: 'state-mutating' as const,
      openedAt,
    };
    let line = '';
    try {
      line = spokenAsk(deps.askLine?.({ ...base, askAr: '' }) ?? '') ?? '';
    } catch {
      // A throwing ask-writer must not change the gate's verdict. The command
      // is parked either way; only the sentence is lost.
      line = '';
    }
    return { ...base, askAr: line };
  };

  return async (cmd: GovernedCommand): Promise<CommandOutcome> => {
    try {
      // ── THE APPROVAL PATH. The ONLY route a state-mutating command takes to
      //    `execute`, and the structural mirror of `Coordinator.gate()`'s
      //    `kind: 'proceed'`: the slot is deleted BEFORE the action is read out
      //    of it, so a crash in `execute` leaves nothing replayable. Do not
      //    move this delete below the `execute` call.
      if (cmd.kind === 'confirm') {
        const id = cmd.confirmId;
        if (id === undefined) return { ok: false, detail: 'confirmId required' };
        const parked = pending.get(id);
        if (parked === undefined) return { ok: false, detail: 'no pending action' };
        pending.delete(id);
        if (now() - parked.at > CONFIRMATION_TTL_MS) return { ok: false, detail: 'confirmation expired' };
        if (cmd.approve === false) return { ok: true, detail: 'cancelled' };
        return await execute(parked.cmd);
      }
      // ── THE TIER LOOKUP. One call, total over every governed kind, and the
      //    only thing that decides whether this command is gated. It is a
      //    classification, not a deny-list: a read-only kind takes the return
      //    below and flows straight to `execute` on the same turn.
      if (tierOf(cmd.kind) === 'state-mutating') {
        // Validate before parking so a malformed state-mutating command fails
        // fast instead of spending the user's attention on an ask.
        const invalid = prevalidate(cmd);
        if (invalid !== null) return invalid;
        // FR-12: park the payload; nothing happens until an explicit confirm.
        // L20: the map was swept ONLY when the next destructive command
        // arrived, so a burst of parks with no follow-up grew it without bound
        // and a parked command stayed executable for the full TTL. Cap it, and
        // drop the OLDEST — the newest is the one being confirmed.
        pending.set(cmd.id, { at: now(), cmd });
        for (const [key, entry] of pending) {
          if (now() - entry.at > CONFIRMATION_TTL_MS) pending.delete(key);
        }
        while (pending.size > MAX_PARKED) {
          const oldest = pending.keys().next();
          if (oldest.done === true) break;
          pending.delete(oldest.value);
        }
        // The ask, ON THIS TURN, and nothing is executed on it. The router
        // calls no model and synthesises nothing: the line is written by
        // `deps.askLine` (the daemon's model) and only RENDERED, exactly as
        // `onPermissionRequired` does in `daemon.ts`. A second synthesis site
        // is the double-Fish-quota defect D4 exists to prevent, and the
        // cost is the same one already recorded there — the user sees the
        // question and answers it by voice on the next turn.
        deps.onConfirmationRequired?.(askFor(cmd));
        return { ok: true, detail: 'confirmation-required' };
      }
      // ── READ-ONLY, and the owner's explicit correction: this is the FREE
      //    path. `promptSession` (the 4096 conversational egress), every
      //    listing, `sessionContext`, `switchSession` and the session-selection
      //    verbs land here and run on this turn, with no park and no ask. A
      //    gate on this line is the regression the tier model exists to stop.
      return await execute(cmd);
    } catch (err) {
      // `errorCodeFor`, not `err.code`: a daemon-side deadline, a cancellation
      // and the daemon stopping all arrive as `OrchestratorError('SESSION_BUSY',
      // …)` carrying a typed `stopReason`, and reporting all three as "busy"
      // told a user to wait for a cancellation. The three are re-coded here, at
      // the sink where a code becomes user-visible, from the FIELD and not from
      // the message — `errorCodeFor` reads `stopReason` only. That is the same
      // discipline `UiServer.notice()` uses for redaction: one place, so the
      // next throw site cannot forget.
      return { ok: false, detail: errorCodeFor(err) };
    }
  };
}