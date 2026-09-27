import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { UiCommand } from '../ipc/protocol.js';

// Daemon-side WS-4097 command execution. Maps renderer intents to ServeClient
// mutations; every failure becomes a structured outcome (never an exception
// escaping to the socket). The UiServer turns the outcome into an ack.
//
// FR-12: commands with real-world blast radius (currently the session shell)
// are PARKED until the operator explicitly confirms. An unconfirmed command is
// never executed, and confirmation expires.
export interface CommandOutcome {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface CommandClient {
  setSessionAgent(sessionId: SessionId, agent: string): Promise<unknown>;
  setSessionModel(sessionId: SessionId, model: { id: string; providerID: string }): Promise<unknown>;
  toggleSessionSkill(sessionId: SessionId, skill: string, action: 'attach' | 'detach'): Promise<unknown>;
  execSessionShell(sessionId: SessionId, command: string): Promise<unknown>;
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
   */
  readonly onAbort?: () => void;
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
}

/** Kinds that may destroy work or touch the host — these require FR-12. */
export const DESTRUCTIVE_KINDS: ReadonlySet<UiCommand['kind']> = new Set(['execSessionShell']);
export const CONFIRMATION_TTL_MS = 60_000;

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

/** `provider/id` → ModelRef; a bare id defaults to the `opencode` provider. */
export function parseModelRef(model: string): { id: string; providerID: string } {
  const slash = model.indexOf('/');
  if (slash > 0) return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  return { providerID: 'opencode', id: model };
}

export interface CommandHandlerOptions {
  readonly now?: () => number;
}

export function createCommandHandler(
  deps: CommandRouterDeps,
  options: CommandHandlerOptions = {},
): (cmd: UiCommand) => Promise<CommandOutcome> {
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, { readonly at: number; readonly cmd: UiCommand }>();

  const resolveSession = (cmd: UiCommand): SessionId | null => {
    const id = cmd.sessionId ?? deps.activeSessionId();
    if (id === undefined || id === '' || !SESSION_ID_RE.test(id)) return null;
    return id as SessionId;
  };

  const execute = async (cmd: UiCommand): Promise<CommandOutcome> => {
    const outcome = await dispatch(cmd);
    // Phase 5 — ZERO CANNED REPLIES. Every executed command reports back so
    // the daemon can have the MODEL write the line the user hears. The router
    // itself never produces a sentence.
    deps.onExecuted?.(cmd, outcome);
    return outcome;
  };

  const dispatch = async (cmd: UiCommand): Promise<CommandOutcome> => {
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
        await deps.client.execSessionShell(session, cmd.command);
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

  return async (cmd: UiCommand): Promise<CommandOutcome> => {
    try {
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
      if (DESTRUCTIVE_KINDS.has(cmd.kind)) {
        // Validate before parking so malformed destructive commands fail fast.
        if (cmd.kind === 'execSessionShell') {
          if (resolveSession(cmd) === null) return { ok: false, detail: 'no active session' };
          if (cmd.command === undefined) return { ok: false, detail: 'command required' };
          const unsafe = shellCommandError(cmd.command);
          if (unsafe !== null) return { ok: false, detail: unsafe };
        }
        // FR-12: park the payload; nothing happens until an explicit confirm.
        pending.set(cmd.id, { at: now(), cmd });
        for (const [key, entry] of pending) {
          if (now() - entry.at > CONFIRMATION_TTL_MS) pending.delete(key);
        }
        return { ok: true, detail: 'confirmation-required' };
      }
      return await execute(cmd);
    } catch (err) {
      if (err instanceof OrchestratorError) return { ok: false, detail: err.code };
      return { ok: false, detail: 'internal' };
    }
  };
}