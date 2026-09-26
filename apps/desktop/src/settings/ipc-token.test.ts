import { describe, expect, test, vi } from 'vitest';
import { resolveIpcTokenWithRetry } from './ipc-token.js';

// Cold-start resilience: the shell may mount before the daemon has written the
// per-install token. Resolving once and giving up left the HUD permanently
// "غير متصل"; the resolver must keep trying a bounded number of times.
describe('resolveIpcTokenWithRetry', () => {
  test('returns the token as soon as the resolver succeeds', async () => {
    const attempts: number[] = [];
    const resolve = vi.fn(async () => {
      attempts.push(1);
      return 'tok-abc';
    });
    const token = await resolveIpcTokenWithRetry({ resolve, attempts: 5, delayMs: 0, sleep: async () => undefined });
    expect(token).toBe('tok-abc');
    expect(attempts).toHaveLength(1);
  });

  test('retries past undefined then returns the token', async () => {
    let calls = 0;
    const resolve = async (): Promise<string | undefined> => {
      calls += 1;
      return calls < 3 ? undefined : 'tok-late';
    };
    const token = await resolveIpcTokenWithRetry({ resolve, attempts: 5, delayMs: 0, sleep: async () => undefined });
    expect(token).toBe('tok-late');
    expect(calls).toBe(3);
  });

  test('gives up after the attempt budget, returning undefined', async () => {
    let calls = 0;
    const resolve = async (): Promise<string | undefined> => {
      calls += 1;
      return undefined;
    };
    const token = await resolveIpcTokenWithRetry({ resolve, attempts: 3, delayMs: 0, sleep: async () => undefined });
    expect(token).toBeUndefined();
    expect(calls).toBe(3);
  });
});
