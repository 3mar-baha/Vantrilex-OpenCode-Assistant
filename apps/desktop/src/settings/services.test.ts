import { afterEach, describe, expect, test, vi } from 'vitest';
import { ensureServices } from './services.js';

// L11 TDD — the host returns a typed status. The shell must treat `in-flight`
// as "not ready yet, try again" rather than as success, and must not loop
// forever on a genuine failure.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

function enterTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

afterEach(() => {
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('ensureServices', () => {
  test('is a no-op outside Tauri (a browser must not spawn host processes)', async () => {
    expect(await ensureServices()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('reports ready with the step list', async () => {
    enterTauri();
    invoke.mockResolvedValue({
      state: 'ready',
      detail: 'opencode serve started on 4096; daemon started on 4097',
      retriable: false,
      steps: ['opencode serve started on 4096', 'daemon started on 4097'],
    });
    const res = await ensureServices();
    expect(res?.ok).toBe(true);
    expect(res?.detail).toContain('4096');
  });

  test('a failure is surfaced as not-ok and is not retried', async () => {
    enterTauri();
    invoke.mockResolvedValue({
      state: 'failed',
      detail: 'daemon (pid 1234) did not open 4097 in time; it was killed',
      retriable: false,
      steps: [],
    });
    const res = await ensureServices();
    expect(res?.ok).toBe(false);
    expect(res?.detail).toContain('4097');
    // One attempt only: a genuine failure retried forever is a hang, not a fix.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('in-flight is retried and then succeeds', async () => {
    enterTauri();
    invoke
      .mockResolvedValueOnce({ state: 'in-flight', detail: 'bring-up already in flight', retriable: true, steps: [] })
      .mockResolvedValueOnce({
        state: 'ready',
        detail: 'daemon started on 4097',
        retriable: false,
        steps: ['daemon started on 4097'],
      });
    const res = await ensureServices();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(res?.ok).toBe(true);
  });

  test('in-flight that never resolves stops after the retry budget', async () => {
    enterTauri();
    invoke.mockResolvedValue({ state: 'in-flight', detail: 'bring-up already in flight', retriable: true, steps: [] });
    const res = await ensureServices();
    // Bounded: one initial call plus a small fixed number of retries.
    expect(invoke.mock.calls.length).toBeGreaterThan(1);
    expect(invoke.mock.calls.length).toBeLessThanOrEqual(6);
    expect(res?.ok).toBe(false);
  });

  test('an invoke rejection becomes a not-ok result, never a throw', async () => {
    enterTauri();
    invoke.mockRejectedValue(new Error('command not found'));
    const res = await ensureServices();
    expect(res?.ok).toBe(false);
    expect(res?.detail).toContain('command not found');
  });

  test('an unknown/malformed payload fails closed rather than claiming success', async () => {
    enterTauri();
    invoke.mockResolvedValue('not-an-object');
    const res = await ensureServices();
    expect(res?.ok).toBe(false);
  });
});
