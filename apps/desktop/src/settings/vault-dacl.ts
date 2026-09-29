// A.2 — re-apply the owner-only Windows DACL to `vault/keyring.dat` after a
// save. The supervisor locks the file down at startup, but `FileVault.save`
// rewrites it (temp file + rename), and a fresh temp file is created with the
// directory's inheritable ACL, not the owner-only one. The Rust command
// `restrict_vault_file` exists for exactly this; nothing called it.
//
// Shape mirrors `services.ts:34-64` on purpose: a no-op outside a Tauri host
// (a browser has no ACL to re-apply), a dynamic import of the invoke module so
// the web/E2E bundle never hard-depends on it, and a result object that never
// throws — a rejected invoke is a warn, not a crash in the keys window.
//
// The contract is `raw === true`, nothing softer. The command returns `Ok(false)`
// on non-Windows and on a non-owner account, and a "probably fine" truthy
// payload must never render as a confirmed lock.
export interface VaultDaclResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Ask the Rust host to re-apply the owner-only ACL to the keyring.
 *
 * @returns `null` when there is no Tauri host (nothing to do, not a failure);
 *          `{ok:true}` only on a literal `true` from the host.
 */
export async function restrictVaultFile(): Promise<VaultDaclResult | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  let invoke: <T>(cmd: string) => Promise<T>;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  try {
    const raw: unknown = await invoke<unknown>('restrict_vault_file');
    if (raw !== true) {
      // Fail closed: an unconfirmed answer is not evidence of a lock.
      return { ok: false, detail: 'host did not confirm the owner-only ACL' };
    }
    return { ok: true, detail: 'keyring.dat restricted to the owner' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
