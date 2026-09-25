import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { UiCommand } from '../ipc/protocol.js';

// Daemon-side WS-4097 command execution (final wiring). Maps renderer intents to
// ServeClient mutations; every failure becomes a structured outcome (never an
// exception escaping to the socket). The UiServer turns the outcome into an ack.
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
}

/** `provider/id` → ModelRef; a bare id defaults to the `opencode` provider. */
export function parseModelRef(model: string): { id: string; providerID: string } {
  const slash = model.indexOf('/');
  if (slash > 0) return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
  return { providerID: 'opencode', id: model };
}

export function createCommandHandler(deps: CommandRouterDeps): (cmd: UiCommand) => Promise<CommandOutcome> {
  const resolveSession = (cmd: UiCommand): SessionId | null => {
    const id = cmd.sessionId ?? deps.activeSessionId();
    return id === undefined || id === '' ? null : (id as SessionId);
  };

  return async (cmd: UiCommand): Promise<CommandOutcome> => {
    try {
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
          // 3-key mandate: all pools required, never partial. Values travel
          // localhost-only and land directly in the encrypted vault.
          if (deps.saveKeys === undefined) return { ok: false, detail: 'key intake unavailable' };
          if (cmd.groqKey === undefined || cmd.fishKey === undefined || cmd.openrouterKey === undefined) {
            return { ok: false, detail: 'all 3 keys required' };
          }
          await deps.saveKeys.saveKeys({ groq: cmd.groqKey, fish: cmd.fishKey, openrouter: cmd.openrouterKey });
          return { ok: true };
        }
        case 'abort':
        case 'mute':
        case 'deafen':
        case 'arm':
        case 'setPersona':
          return { ok: true };
        default:
          return { ok: false, detail: 'unsupported command' };
      }
    } catch (err) {
      if (err instanceof OrchestratorError) return { ok: false, detail: err.code };
      return { ok: false, detail: 'internal' };
    }
  };
}
