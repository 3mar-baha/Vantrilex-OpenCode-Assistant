import { afterEach, describe, expect, test, vi } from 'vitest';
import { restrictVaultFile } from './vault-dacl.js';

// A.2 — the save path rewrites `vault/keyring.dat`, so the owner-only DACL the
// Rust supervisor applied at startup cannot be assumed to still be in force.
// The shell has to ask the host to re-apply it, and it has to treat an
// unconfirmed answer as NOT locked: `raw !== true` is the whole contract.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

function enterTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

afterEach(() => {
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('restrictVaultFile (A.2)', () => {
  test('is a no-op outside a Tauri host (a browser has no ACL to re-apply)', async () => {
    expect(await restrictVaultFile()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('a host-confirmed `true` is ok', async () => {
    enterTauri();
    invoke.mockResolvedValue(true);
    const res = await restrictVaultFile();
    expect(res?.ok).toBe(true);
  });

  test('an explicit `false` is not ok — the lock was not confirmed', async () => {
    enterTauri();
    invoke.mockResolvedValue(false);
    const res = await restrictVaultFile();
    expect(res?.ok).toBe(false);
  });

  test.each([['true'], [1], [null], [{}], [undefined]])(
    'a non-boolean answer (%p) fails closed rather than claiming the file is locked',
    async (raw) => {
      enterTauri();
      invoke.mockResolvedValue(raw);
      const res = await restrictVaultFile();
      expect(res?.ok).toBe(false);
    },
  );

  test('an invoke rejection becomes a not-ok result, never a throw', async () => {
    enterTauri();
    invoke.mockRejectedValue(new Error('command not found'));
    const res = await restrictVaultFile();
    expect(res?.ok).toBe(false);
    expect(res?.detail).toContain('command not found');
  });

  // Break-guard: the exact registered command name is load-bearing. A typo
  // ('restrictVaultFile', 'restrict-vault-file') fails closed at runtime on a
  // real host, and would render as a permanent amber line nobody can clear.
  test('invokes the registered command name exactly', async () => {
    enterTauri();
    invoke.mockResolvedValue(true);
    await restrictVaultFile();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe('restrict_vault_file');
  });
});
