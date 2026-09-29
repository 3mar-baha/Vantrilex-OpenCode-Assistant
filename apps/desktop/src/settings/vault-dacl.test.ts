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

  // ── C.1 — the rejection is NOT the same event as an unconfirmed answer ────
  // `restrict_vault_file` (main.rs:907) fails CLOSED: on Err it removes
  // `keyring.dat` (main.rs:917-919), and Tauri turns Err into a rejected
  // promise. So the rejection arm carries strictly more information than the
  // `Ok(false)` arm and must be distinguishable by the caller.
  test('C.1 — a rejected invoke is `keyring-lost`, not merely unconfirmed', async () => {
    enterTauri();
    invoke.mockRejectedValue(new Error('keyring.dat: acl: SetNamedSecurityInfoW failed (5)'));
    const res = await restrictVaultFile();
    expect(res?.state).toBe('keyring-lost');
    expect(res?.ok).toBe(false);
    // The host's own message is preserved — it is the only evidence of what
    // the supervisor actually did.
    expect(res?.detail).toContain('SetNamedSecurityInfoW');
  });

  test('C.1 — an unconfirmed answer is `unconfirmed`, never `keyring-lost`', async () => {
    enterTauri();
    invoke.mockResolvedValue(false);
    expect((await restrictVaultFile())?.state).toBe('unconfirmed');
    invoke.mockResolvedValue('true');
    expect((await restrictVaultFile())?.state).toBe('unconfirmed');
  });

  test('C.1 — a confirmed `true` is the only `ok` state', async () => {
    enterTauri();
    invoke.mockResolvedValue(true);
    const res = await restrictVaultFile();
    expect(res?.state).toBe('ok');
    expect(res?.ok).toBe(true);
  });

  // `ok` and `state` are both public. If they could disagree, every caller
  // reading the wrong one silently ships a wrong receipt.
  test('C.1 — `ok` and `state` never disagree', async () => {
    enterTauri();
    for (const [answer, state] of [
      [true, 'ok'],
      [false, 'unconfirmed'],
      ['true', 'unconfirmed'],
      [null, 'unconfirmed'],
    ] as const) {
      invoke.mockResolvedValue(answer);
      const res = await restrictVaultFile();
      expect(res?.state).toBe(state);
      expect(res?.ok).toBe(state === 'ok');
    }
    invoke.mockRejectedValue(new Error('keyring.dat: acl failed'));
    const rejected = await restrictVaultFile();
    expect(rejected?.state).toBe('keyring-lost');
    expect(rejected?.ok).toBe(false);
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
