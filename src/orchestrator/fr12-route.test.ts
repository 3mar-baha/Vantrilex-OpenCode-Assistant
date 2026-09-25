import { describe, expect, test } from 'vitest';
import type { SessionId } from '../common/brands.js';
import type { UiCommand } from '../ipc/protocol.js';
import { createCommandHandler, CONFIRMATION_TTL_MS } from './command-router.js';

// FR-12 at the execution boundary: a destructive command is parked and NEVER
// executed until an explicit confirm arrives; confirmation expires.
function harness(nowRef: { value: number }): {
  handler: (cmd: UiCommand) => Promise<{ ok: boolean; detail?: string }>;
  shells: string[];
} {
  const shells: string[] = [];
  const handler = createCommandHandler(
    {
      client: {
        setSessionAgent: async () => ({}),
        setSessionModel: async () => ({}),
        toggleSessionSkill: async () => ({}),
        execSessionShell: async (_s: SessionId, c: string) => {
          shells.push(c);
          return {};
        },
      },
      switchSession: () => undefined,
      activeSessionId: () => 'ses_active' as SessionId,
    },
    { now: () => nowRef.value },
  );
  return { handler, shells };
}

const shellCmd = (id: string, command: string): UiCommand =>
  ({ id, kind: 'execSessionShell', command }) as UiCommand;

describe('FR-12 execution gate', () => {
  test('an unconfirmed shell command is parked, never executed', async () => {
    const now = { value: 1_000 };
    const h = harness(now);
    const outcome = await h.handler(shellCmd('c1', 'rm -rf build'));
    expect(outcome).toEqual({ ok: true, detail: 'confirmation-required' });
    expect(h.shells).toEqual([]);
  });

  test('an explicit confirm executes the parked command exactly once', async () => {
    const now = { value: 1_000 };
    const h = harness(now);
    await h.handler(shellCmd('c1', 'git status'));
    const confirmed = await h.handler({ id: 'c2', kind: 'confirm', confirmId: 'c1' } as UiCommand);
    expect(confirmed).toEqual({ ok: true });
    expect(h.shells).toEqual(['git status']);
    // Replaying the confirm finds nothing pending.
    expect(await h.handler({ id: 'c3', kind: 'confirm', confirmId: 'c1' } as UiCommand)).toEqual({
      ok: false,
      detail: 'no pending action',
    });
  });

  test('an explicit reject cancels without executing', async () => {
    const now = { value: 1_000 };
    const h = harness(now);
    await h.handler(shellCmd('c1', 'deploy now'));
    const cancelled = await h.handler({ id: 'c2', kind: 'confirm', confirmId: 'c1', approve: false } as UiCommand);
    expect(cancelled).toEqual({ ok: true, detail: 'cancelled' });
    expect(h.shells).toEqual([]);
  });

  test('confirmation expires after the TTL', async () => {
    const now = { value: 1_000 };
    const h = harness(now);
    await h.handler(shellCmd('c1', 'drop table'));
    now.value += CONFIRMATION_TTL_MS + 1;
    const late = await h.handler({ id: 'c2', kind: 'confirm', confirmId: 'c1' } as UiCommand);
    expect(late).toEqual({ ok: false, detail: 'confirmation expired' });
    expect(h.shells).toEqual([]);
  });

  test('non-destructive commands are unaffected by the gate', async () => {
    const now = { value: 1_000 };
    const h = harness(now);
    expect(await h.handler({ id: 'x', kind: 'switchSession', sessionId: 'ses_a' } as UiCommand)).toEqual({ ok: true });
    expect(await h.handler({ id: 'y', kind: 'mute' } as UiCommand)).toEqual({ ok: true });
  });
});