// A.2 — re-apply the owner-only Windows DACL to `vault/keyring.dat` after a
// save. The supervisor locks the file down at startup, but `FileVault.save`
// rewrites it (temp file + rename), and a fresh temp file is created with the
// directory's inheritable ACL, not the owner-only one. The Rust command
// `restrict_vault_file` exists for exactly this; nothing called it.
//
// Shape mirrors `services.ts:34-64` on purpose: a no-op outside a Tauri host
// (a browser has no ACL to re-apply), a dynamic import of the invoke module so
// the web/E2E bundle never hard-depends on it, and a result object that never
// throws — a rejected invoke is a verdict, not a crash in the keys window.
//
// The contract is `raw === true`, nothing softer. The command returns `Ok(false)`
// on non-Windows and on a non-owner account, and a "probably fine" truthy
// payload must never render as a confirmed lock.
//
// C.1 — the two non-ok outcomes are NOT the same event, and collapsing them is
// the defect this module used to have. `restrict_vault_file` (main.rs:907) is
// fail-CLOSED: when `restrict_to_owner` fails it removes `keyring.dat`
// (main.rs:917-919) and returns `Err`, which Tauri delivers as a REJECTED
// invoke. So:
//   - `unconfirmed`  — the command ran and did not confirm. Nothing was
//     deleted; the keys are on disk with an ACL we cannot vouch for.
//   - `keyring-lost` — the host FAILED, and on that path the keyring file is
//     deleted. The keys are no longer at rest, and the operator must enter
//     them again. Rendering this as an amber footnote under a green "keys
//     saved" receipt would understate a deleted credential store.
//
// The renderer is told which happened; it is not left to guess from `ok`.
/** `unconfirmed` ≠ `keyring-lost`: only the latter means the file was deleted. */
export type VaultDaclState = 'ok' | 'unconfirmed' | 'keyring-lost';

export interface VaultDaclResult {
  readonly ok: boolean;
  /** Discriminant; `ok` is exactly `state === 'ok'`. */
  readonly state: VaultDaclState;
  readonly detail: string;
}

/**
 * Ask the Rust host to re-apply the owner-only ACL to the keyring.
 *
 * @returns `null` when there is no Tauri host (nothing to do, not a failure);
 *          `{state:'ok'}` only on a literal `true` from the host.
 */
export async function restrictVaultFile(): Promise<VaultDaclResult | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  let invoke: <T>(cmd: string) => Promise<T>;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch (err) {
    // The command was never issued, so the host deleted nothing: unconfirmed.
    return { ok: false, state: 'unconfirmed', detail: err instanceof Error ? err.message : String(err) };
  }
  try {
    const raw: unknown = await invoke<unknown>('restrict_vault_file');
    if (raw !== true) {
      // Fail closed: an unconfirmed answer is not evidence of a lock.
      return { ok: false, state: 'unconfirmed', detail: 'host did not confirm the owner-only ACL' };
    }
    return { ok: true, state: 'ok', detail: 'keyring.dat restricted to the owner' };
  } catch (err) {
    // A Rust `Err` reaches us as a rejection, and that path deletes the
    // keyring. Do not soften it into the same verdict as an unconfirmed lock.
    return {
      ok: false,
      state: 'keyring-lost',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
