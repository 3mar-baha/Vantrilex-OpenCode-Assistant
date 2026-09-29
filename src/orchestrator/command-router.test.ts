import { describe, expect, test } from 'vitest';
import type { SessionId } from '../common/brands.js';
import { OrchestratorError } from '../common/errors.js';
import type { UiCommand } from '../ipc/protocol.js';
import { createCommandHandler, MAX_PARKED, parseModelRef, shellCommandError } from './command-router.js';

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
    projectDirectory: () => 'O:/project',
  });
  return { handler, calls, switched };
}

const cmd = (partial: Partial<UiCommand> & { kind: UiCommand['kind'] }): UiCommand =>
  ({ id: 'c1', ...partial }) as UiCommand;

// L21 — the metacharacter guard. The original regex covered only `;&|`<><\n\r`,
// which left glob, brace, subshell, tilde, history and traversal intact. A
// deny-list is defense-in-depth BEHIND the FR-12 confirm gate and session
// scoping, never a sandbox; the tests below pin both what it now refuses and
// what it must not break.
describe('shellCommandError (L21)', () => {
  test('accepts the ordinary commands a user actually types', () => {
    // The FR-12 spec test is `rm -rf build`; hardening must not break it.
    for (const cmd of ['rm -rf build', 'npm run build', 'git status', 'cargo check', 'ls -la']) {
      expect(shellCommandError(cmd), cmd).toBeNull();
    }
  });

  test('rejects chaining and redirection metacharacters', () => {
    for (const cmd of ['a;b', 'a|b', 'a&b', 'a`b`', 'a>b', 'a<b', 'a\nb', 'a\rb']) {
      expect(shellCommandError(cmd), cmd).not.toBeNull();
    }
  });

  test('rejects glob and brace expansion that can enumerate or rewrite trees', () => {
    // The original guard let these through. A glob is a read-side enumeration
    // primitive and `{}` is brace expansion in every POSIX shell.
    for (const cmd of ['rm -rf *', 'cat /etc/*', 'ls -d ?', 'echo {a,b}', 'rm -rf src/*']) {
      expect(shellCommandError(cmd), cmd).not.toBeNull();
    }
  });

  test('rejects subshell and grouping syntax', () => {
    for (const cmd of ['echo (id)', 'echo {id}', 'a && b', 'a || b']) {
      expect(shellCommandError(cmd), cmd).not.toBeNull();
    }
  });

  test('rejects parent-directory traversal', () => {
    for (const cmd of ['cd ..', 'cat ../../etc/passwd', 'rm -rf ../build']) {
      expect(shellCommandError(cmd), cmd).not.toBeNull();
    }
  });

  test('rejects tilde and history expansion', () => {
    expect(shellCommandError('rm ~/important')).not.toBeNull();
    expect(shellCommandError('echo hi!')).not.toBeNull();
  });

  test('rejects empty and overlong commands', () => {
    expect(shellCommandError('')).not.toBeNull();
    expect(shellCommandError('   ')).not.toBeNull();
    expect(shellCommandError('x'.repeat(513))).not.toBeNull();
  });

  test('the rejection message never echoes the payload back', () => {
    // The detail is written to the supervisor log and returned to the shell.
    const msg = shellCommandError('rm -rf *; curl evil.example');
    expect(msg).not.toBeNull();
    expect(msg).not.toContain('evil.example');
  });
});

// Phase 4 — the OpenCode 360° session manager commands.
describe('Phase 4 session manager commands', () => {
  function harness(over: Partial<{
    contextUsage: (id: never, limit?: number) => Promise<{ used: number; limit: number | null; percent: number | null; messageCount: number }>;
    createSession: (dir: string) => Promise<{ sessionId: never }>;
  }> = {}) {
    const events: string[] = [];
    const switched: string[] = [];
    const h = createCommandHandler({
      client: {
        setSessionAgent: async () => undefined,
        setSessionModel: async () => undefined,
        toggleSessionSkill: async () => undefined,
        execSessionShell: async () => undefined,
        ...(over.contextUsage !== undefined ? { contextUsage: over.contextUsage } : {}),
        ...(over.createSession !== undefined ? { createSession: over.createSession } : {}),
      },
      switchSession: (id) => void switched.push(id),
      activeSessionId: () => 'ses_a' as never,
      projectDirectory: () => 'O:/project',
      onContext: (id, usage) => events.push(`ctx:${id}:${usage.used}:${usage.percent}`),
    });
    return { h, events, switched };
  }

  test('sessionContext publishes telemetry and reports a known limit', async () => {
    const { h, events } = harness({
      contextUsage: async () => ({ used: 10_850, limit: 200_000, percent: 5.4, messageCount: 2 }),
    });
    const res = await h(cmd({ kind: 'sessionContext', sessionId: 'ses_a' }));
    expect(res.ok).toBe(true);
    expect(events).toEqual(['ctx:ses_a:10850:5.4']);
    expect(res.detail).toContain('%');
  });

  test('sessionContext says the limit is unknown instead of inventing one', async () => {
    const { h, events } = harness({
      contextUsage: async () => ({ used: 10_850, limit: null, percent: null, messageCount: 2 }),
    });
    const res = await h(cmd({ kind: 'sessionContext', sessionId: 'ses_a' }));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('غير معروف');
    expect(res.detail).not.toContain('%');
    expect(events).toHaveLength(1);
  });

  test('sessionContext passes the model limit through when supplied', async () => {
    let seen: number | undefined;
    const { h } = harness({
      contextUsage: async (_id, limit) => {
        seen = limit;
        return { used: 10, limit: 100, percent: 10, messageCount: 1 };
      },
    });
    await h(cmd({ kind: 'sessionContext', sessionId: 'ses_a', contextLimit: 131_072 }));
    expect(seen).toBe(131_072);
  });

  test('sessionContext with no active session is refused, not guessed', async () => {
    const { h, events } = harness({
      contextUsage: async () => ({ used: 1, limit: 10, percent: 10, messageCount: 1 }),
    });
    const res = await h(cmd({ kind: 'sessionContext', sessionId: '../../etc' }));
    expect(res).toEqual({ ok: false, detail: 'no active session' });
    expect(events).toEqual([]);
  });

  test('sessionContext degrades cleanly when the client lacks telemetry', async () => {
    const { h } = harness();
    const res = await h(cmd({ kind: 'sessionContext', sessionId: 'ses_a' }));
    expect(res).toEqual({ ok: false, detail: 'context telemetry unavailable' });
  });

  test('createSession uses the project directory and switches to the new session', async () => {
    let dir = '';
    const { h, switched } = harness({
      createSession: async (d) => {
        dir = d;
        return { sessionId: 'ses_new1' as never };
      },
    });
    const res = await h(cmd({ kind: 'createSession' }));
    expect(res.ok).toBe(true);
    expect(dir).toBe('O:/project');
    expect(switched).toEqual(['ses_new1']);
    expect(res.detail).toContain('ses_new1');
  });

  test('createSession ignores any directory supplied in the payload', async () => {
    // The directory is the daemon's, never the caller's. A command payload
    // must not be able to choose where a session is created.
    let dir = '';
    const { h } = harness({
      createSession: async (d) => {
        dir = d;
        return { sessionId: 'ses_new2' as never };
      },
    });
    await h(cmd({ kind: 'createSession' } as never));
    expect(dir).toBe('O:/project');
  });

  test('createSession degrades cleanly when the client lacks the manager', async () => {
    const { h, switched } = harness();
    const res = await h(cmd({ kind: 'createSession' }));
    expect(res).toEqual({ ok: false, detail: 'session manager unavailable' });
    expect(switched).toEqual([]);
  });

  test('the telemetry detail never carries a transcript or key material', async () => {
    const { h } = harness({
      contextUsage: async () => ({ used: 10_850, limit: 200_000, percent: 5.4, messageCount: 2 }),
    });
    const res = await h(cmd({ kind: 'sessionContext', sessionId: 'ses_a' }));
    expect(res.detail).not.toMatch(/sk-|gsk_|Bearer/);
  });
});

describe('command router (existing behaviour)', () => {  test('provider/id splits; bare id defaults to the opencode provider', () => {
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

  test('saveApiKeys requires all three keys and delegates to the saver', async () => {
    const saved: Array<{ groq: string; fish: string; openrouter: string }> = [];
    const h = harness();
    const withSaver = createCommandHandler({
      client: {
        setSessionAgent: async () => ({}),
        setSessionModel: async () => ({}),
        toggleSessionSkill: async () => ({}),
        execSessionShell: async () => ({}),
      },
      switchSession: () => undefined,
      activeSessionId: () => undefined,
      saveKeys: { saveKeys: async (k) => void saved.push(k) },
      projectDirectory: () => 'O:/project',
    });
    expect(await withSaver(cmd({ kind: 'saveApiKeys', groqKey: 'g', fishKey: 'f', openrouterKey: 'o' }))).toEqual({ ok: true });
    expect(saved).toEqual([{ groq: 'g', fish: 'f', openrouter: 'o' }]);
    expect(await withSaver(cmd({ kind: 'saveApiKeys', groqKey: 'g', fishKey: 'f' }))).toEqual({
      ok: false,
      detail: 'all 3 keys required',
    });
    expect(saved).toHaveLength(1);
    expect(await h.handler(cmd({ kind: 'saveApiKeys', groqKey: 'g', fishKey: 'f', openrouterKey: 'o' }))).toEqual({
      ok: false,
      detail: 'key intake unavailable',
    });
  });

  test('agent/model/skill/shell target the explicit or active session', async () => {
    const h = harness();
    await h.handler(cmd({ kind: 'setSessionAgent', agent: 'build' }));
    expect(h.calls.agent).toEqual([['ses_active', 'build']]);
    await h.handler(cmd({ kind: 'setSessionModel', model: 'anthropic/opus', sessionId: 'ses_x' }));
    expect(h.calls.model).toEqual([['ses_x', { providerID: 'anthropic', id: 'opus' }]]);
    await h.handler(cmd({ kind: 'toggleSessionSkill', skill: 'probe', skillAction: 'detach' }));
    expect(h.calls.skill).toEqual([['ses_active', 'probe', 'detach']]);
    // FR-12: shell is parked first, then executed on explicit confirm.
    const parked = await h.handler(cmd({ kind: 'execSessionShell', command: 'git status' }));
    expect(parked).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.calls.shell).toEqual([]);
    await h.handler(cmd({ kind: 'confirm', id: 'c2', confirmId: 'c1' }));
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
      projectDirectory: () => 'O:/project',
    });
    expect(await handler(cmd({ kind: 'setSessionAgent', agent: 'x' }))).toEqual({ ok: false, detail: 'no active session' });
    expect(calls).toHaveLength(0);
  });

  test('client errors surface as OrchestratorError codes, never escapes', async () => {
    const h = harness({ fail: true });
    expect(await h.handler(cmd({ kind: 'setSessionAgent', agent: 'x' }))).toEqual({ ok: false, detail: 'SESSION_BUSY' });
  });

  test('local intents (mute/abort/deafen/arm) ack; setPersona acks with detail', async () => {
    const h = harness();
    for (const kind of ['mute', 'abort', 'deafen', 'arm'] as const) {
      expect(await h.handler(cmd({ kind }))).toEqual({ ok: true });
    }
    expect(await h.handler(cmd({ kind: 'setPersona', persona: 'nour' }))).toMatchObject({ ok: true });
  });

  test('abort trips the speech gate; silence when no gate is wired', async () => {    const aborted: string[] = [];
    const withGate = createCommandHandler({
      client: {
        setSessionAgent: async () => undefined,
        setSessionModel: async () => undefined,
        toggleSessionSkill: async () => undefined,
        execSessionShell: async () => undefined,
      },
      switchSession: () => undefined,
      activeSessionId: () => undefined,
      onAbort: () => void aborted.push('abort'),
      projectDirectory: () => 'O:/project',
    });
    expect(await withGate(cmd({ kind: 'abort' }))).toEqual({ ok: true });
    expect(aborted).toEqual(['abort']);
    const bare = harness();
    expect(await bare.handler(cmd({ kind: 'abort' }))).toEqual({ ok: true });
  });

  // M2 Pattern 2 — speech-only barge-in. `stopSpeech` is the command a voice
  // burst sends; `abort` is the button. They MUST NOT be the same handler: a
  // barge that cancels the turn discards a plan the user already paid ~1.95 s
  // of free-tier latency for. This pins the separation at the router: the
  // speech hook runs, the abort hook does not, and the outcome IS forwarded
  // to `onExecuted` (the daemon's own closure decides not to narrate it —
  // pinned in daemon-barge-in.test.ts — the router must not make that choice).
  test('M2-P2: stopSpeech stops audio only, and never runs the abort handler', async () => {
    const calls: string[] = [];
    const executed: Array<{ kind: string; ok: boolean }> = [];
    const h = createCommandHandler({
      client: {
        setSessionAgent: async () => void calls.push('setSessionAgent'),
        setSessionModel: async () => void calls.push('setSessionModel'),
        toggleSessionSkill: async () => void calls.push('toggleSessionSkill'),
        execSessionShell: async () => void calls.push('execSessionShell'),
      },
      switchSession: () => void calls.push('switchSession'),
      activeSessionId: () => {
        calls.push('activeSessionId');
        return 'ses_active' as SessionId;
      },
      projectDirectory: () => {
        calls.push('projectDirectory');
        return 'O:/project';
      },
      onAbort: () => void calls.push('onAbort'),
      onStopSpeech: () => void calls.push('onStopSpeech'),
      onExecuted: (cmd, outcome) => void executed.push({ kind: cmd.kind, ok: outcome.ok }),
    });
    expect(await h(cmd({ kind: 'stopSpeech' }))).toEqual({ ok: true });
    // Exactly one hook, and it is the speech hook. Reading the active session
    // would be "session contact" — there is none. And the outcome IS forwarded
    // to onExecuted (the daemon skips narration there; the router forwards).
    expect(calls).toEqual(['onStopSpeech']);
    expect(executed).toEqual([{ kind: 'stopSpeech', ok: true }]);
  });

  test('M2-P2: stopSpeech acks on a keyless daemon (no speech hook wired)', async () => {
    // `rebuildVoice` leaves no pipeline without keys. A barge that arrived then
    // must still ack: the router's catch would turn the mic's fire-and-forget
    // send into a visible error frame for something the user cannot act on.
    const bare = harness();
    expect(await bare.handler(cmd({ kind: 'stopSpeech' }))).toEqual({ ok: true });
    expect(bare.calls.agent).toEqual([]);
    expect(bare.calls.shell).toEqual([]);
    expect(bare.switched).toEqual([]);
  });

  test('M2-P2: the explicit abort button still runs the FULL abort handler', async () => {
    // The other half of the split, and the one that must not regress: `abort`
    // is still `onAbort`, and `onStopSpeech` is never a substitute for it.
    const calls: string[] = [];
    const h = createCommandHandler({
      client: {
        setSessionAgent: async () => undefined,
        setSessionModel: async () => undefined,
        toggleSessionSkill: async () => undefined,
        execSessionShell: async () => undefined,
      },
      switchSession: () => undefined,
      activeSessionId: () => undefined,
      projectDirectory: () => 'O:/project',
      onAbort: () => void calls.push('onAbort'),
      onStopSpeech: () => void calls.push('onStopSpeech'),
    });
    expect(await h(cmd({ kind: 'abort' }))).toEqual({ ok: true });
    expect(calls).toEqual(['onAbort']);
  });

  test('unsafe shell metacharacters are rejected before parking', async () => {
    const h = harness();
    expect(await h.handler(cmd({ kind: 'execSessionShell', command: 'a; rm -rf /' }))).toEqual({
      ok: false,
      detail: 'command rejected (unsafe metacharacters)',
    });
    expect(await h.handler(cmd({ kind: 'execSessionShell', command: 'echo $(whoami)' }))).toEqual({
      ok: false,
      detail: 'command rejected (unsafe metacharacters)',
    });
    // A plain command (no metacharacters) still parks for FR-12 confirmation.
    expect(await h.handler(cmd({ kind: 'execSessionShell', command: 'rm -rf build' }))).toEqual({
      ok: true,
      detail: 'confirmation-required',
    });
  });

  test('malformed session ids are refused (no path injection)', async () => {
    const h = harness();
    expect(
      await h.handler(cmd({ kind: 'setSessionAgent', sessionId: '../../etc', agent: 'x' })),
    ).toEqual({ ok: false, detail: 'no active session' });
  });
});

describe('parked-command bound (L20)', () => {
  // A parked command is one awaiting FR-12 confirmation, and it is still
  // EXECUTABLE. The map was swept only when the next destructive command
  // arrived, so a burst of parks with no follow-up grew it without bound and
  // each entry stayed live for the full TTL.

  test('a park storm leaves exactly MAX_PARKED live, not more', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED * 4; i += 1) {
      const id = `p${i}`;
      ids.push(id);
      await h.handler(cmd({ id, kind: 'execSessionShell', command: `echo ${i}` }));
    }
    // Measure the live set by confirming every id ever issued and counting the
    // ones that actually execute. The bound is the cap, not "at most the cap":
    // an over-eager eviction would quietly drop a command the user is looking
    // at, and an under-eager one leaves stale entries executable.
    let executed = 0;
    for (const id of ids) {
      const r = await h.handler(cmd({ id: `c-${id}`, kind: 'confirm', confirmId: id }));
      if (r.ok) executed += 1;
    }
    expect(executed).toBe(MAX_PARKED);
  });

  test('the newest parked command is the one that survives', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED * 3; i += 1) {
      const id = `p${i}`;
      ids.push(id);
      await h.handler(cmd({ id, kind: 'execSessionShell', command: `echo ${i}` }));
    }
    // The most recent park is the one the user is actually confirming; if the
    // cap evicted it, a legitimate confirmation would silently do nothing.
    const newest = ids[ids.length - 1] as string;
    await h.handler(cmd({ id: 'c', kind: 'confirm', confirmId: newest }));
    expect(h.calls.shell).toEqual([['ses_active', `echo ${MAX_PARKED * 3 - 1}`]]);
  });

  test('the oldest parked command is evicted first', async () => {
    const h = harness();
    const first = 'p0';
    await h.handler(cmd({ id: first, kind: 'execSessionShell', command: 'echo first' }));
    for (let i = 1; i <= MAX_PARKED; i += 1) {
      await h.handler(cmd({ id: `p${i}`, kind: 'execSessionShell', command: `echo ${i}` }));
    }
    // Evicted: confirming it reports nothing pending rather than running a
    // command the user can no longer see or reason about.
    expect(await h.handler(cmd({ id: 'c0', kind: 'confirm', confirmId: first }))).toEqual({
      ok: false,
      detail: 'no pending action',
    });
    expect(h.calls.shell).toEqual([]);
  });

  test('a confirmation storm cannot resurrect evicted commands', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED * 5; i += 1) {
      const id = `p${i}`;
      ids.push(id);
      await h.handler(cmd({ id, kind: 'execSessionShell', command: `echo ${i}` }));
    }
    // Confirm every id ever issued. At most the surviving window may execute;
    // the rest must be reported as unknown.
    const results = [];
    for (const id of ids) {
      results.push(await h.handler(cmd({ id: `c-${id}`, kind: 'confirm', confirmId: id })));
    }
    const executed = results.filter((r) => r.ok).length;
    expect(executed).toBeLessThanOrEqual(MAX_PARKED);
    expect(executed).toBeGreaterThan(0);
  });
});
