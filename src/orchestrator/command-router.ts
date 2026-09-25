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
}

/** Kinds that may destroy work or touch the host — these require FR-12. */
export const DESTRUCTIVE_KINDS: ReadonlySet<UiCommand['kind']> = new Set(['execSessionShell']);
export const CONFIRMATION_TTL_MS = 60_000;

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
    return id === undefined || id === '' ? null : (id as SessionId);
  };

  const execute = async (cmd: UiCommand): Promise<CommandOutcome> => {
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