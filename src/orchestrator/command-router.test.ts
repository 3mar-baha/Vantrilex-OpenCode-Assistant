import { describe, expect, test } from 'vitest';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { UiCommand } from '../ipc/protocol.js';
import { createCommandHandler, parseModelRef } from './command-router.js';

// Final wiring TDD — renderer intents → ServeClient mutations with structured
// outcomes; the active session is used when the command omits sessionId.
function harness(overrides: Partial<{ fail: boolean }> = {}): {
  handler: (cmd: UiCommand) => Promise<{ ok: boolean; detail?: string }>;
  calls: Record<string, unknown[]>;
  switched: SessionId[];
} {
  const calls: Record<string, unknown[]> = { agent: [], model: [], skill: [], shell: [] };
  const switched: SessionId[] = [];
  const client = {
    setSessionAgent: async (s: SessionId, a: string) => {
      if (overrides.fail === true) throw new OrchestratorError('SESSION_BUSY', true, 'busy');
      calls.agent!.push([s, a]);
      return { ok: true };
    },
    setSessionModel: async (s: SessionId, m: { id: string; providerID: string }) => {
      calls.model!.push([s, m]);
      return { ok: true };
    },
    toggleSessionSkill: async (s: SessionId, k: string, a: string) => {
      calls.skill!.push([s, k, a]);
      return { ok: true };
    },
    execSessionShell: async (s: SessionId, c: string) => {
      calls.shell!.push([s, c]);
      return { ok: true };
    },
  };
  const handler = createCommandHandler({
    client,
    switchSession: (id) => void switched.push(id),
    activeSessionId: () => 'ses_active' as SessionId,
  });
  return { handler, calls, switched };
}

const cmd = (partial: Partial<UiCommand> & { kind: UiCommand['kind'] }): UiCommand =>
  ({ id: 'c1', ...partial }) as UiCommand;

describe('parseModelRef', () => {
  test('provider/id splits; bare id defaults to the opencode provider', () => {
    expect(parseModelRef('anthropic/opus')).toEqual({ providerID: 'anthropic', id: 'opus' });
    expect(parseModelRef('muse-spark')).toEqual({ providerID: 'opencode', id: 'muse-spark' });
  });
});

describe('createCommandHandler', () => {
  test('switchSession updates the active context', async () => {
    const h = harness();
    expect(await h.handler(cmd({ kind: 'switchSession', sessionId: 'ses_b' }))).toEqual({ ok: true });
    expect(h.switched).toEqual(['ses_b']);
    expect(await h.handler(cmd({ kind: 'switchSession' }))).toEqual({ ok: false, detail: 'sessionId required' });
  });

  test('agent/model/skill/shell target the explicit or active session', async () => {
    const h = harness();
    await h.handler(cmd({ kind: 'setSessionAgent', agent: 'build' }));
    expect(h.calls.agent).toEqual([['ses_active', 'build']]);
    await h.handler(cmd({ kind: 'setSessionModel', model: 'anthropic/opus', sessionId: 'ses_x' }));
    expect(h.calls.model).toEqual([['ses_x', { providerID: 'anthropic', id: 'opus' }]]);
    await h.handler(cmd({ kind: 'toggleSessionSkill', skill: 'probe', skillAction: 'detach' }));
    expect(h.calls.skill).toEqual([['ses_active', 'probe', 'detach']]);
    await h.handler(cmd({ kind: 'execSessionShell', command: 'git status' }));
    expect(h.calls.shell).toEqual([['ses_active', 'git status']]);
  });

  test('missing required fields fail fast with structured detail', async () => {
    const h = harness();
    expect(await h.handler(cmd({ kind: 'setSessionAgent' }))).toEqual({ ok: false, detail: 'agent required' });
    expect(await h.handler(cmd({ kind: 'setSessionModel' }))).toEqual({ ok: false, detail: 'model required' });
    expect(await h.handler(cmd({ kind: 'execSessionShell' }))).toEqual({ ok: false, detail: 'command required' });
  });

  test('no active session is a structured failure, not a throw', async () => {
    const calls: unknown[] = [];
    const handler = createCommandHandler({
      client: {
        setSessionAgent: async () => calls.push(1),
        setSessionModel: async () => calls.push(1),
        toggleSessionSkill: async () => calls.push(1),
        execSessionShell: async () => calls.push(1),
      },
      switchSession: () => undefined,
      activeSessionId: () => undefined,
    });
    expect(await handler(cmd({ kind: 'setSessionAgent', agent: 'x' }))).toEqual({ ok: false, detail: 'no active session' });
    expect(calls).toHaveLength(0);
  });

  test('client errors surface as OrchestratorError codes, never escapes', async () => {
    const h = harness({ fail: true });
    expect(await h.handler(cmd({ kind: 'setSessionAgent', agent: 'x' }))).toEqual({ ok: false, detail: 'SESSION_BUSY' });
  });

  test('local intents (mute/abort/deafen/arm/setPersona) are no-ops that ack', async () => {
    const h = harness();
    for (const kind of ['mute', 'abort', 'deafen', 'arm', 'setPersona'] as const) {
      expect(await h.handler(cmd({ kind }))).toEqual({ ok: true });
    }
  });
});
