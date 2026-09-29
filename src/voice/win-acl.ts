import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Why this file exists, and why it is nearly empty.
//
// The security audit found a real split: `ipc.token`, `serve.pass` and
// `owner.key` get a proper owner-only protected DACL from the Rust supervisor,
// and the two vault files - `machine.key` and `keyring.dat`, which hold the
// machine key and the encrypted provider keys - did not. The obvious fix from
// Node is `icacls`, and it was implemented, tested, and then removed.
//
// MEASURED, NOT ASSUMED. On this Windows host:
//
//   icacls <file> /inheritance:r /grant:r OMAR:(F)
//   -> returns success ("Successfully processed 1 files")
//   -> the file then cannot be READ, by the very account named in the grant.
//      `readFileSync` throws EPERM.
//
// The failure is silent in the worst way: the command reports success and the
// only symptom is a file nobody can use. The cause is that `icacls` writes an
// explicit DACL that replaces the implicit owner access, and `icacls` has no way
// to name the OWNER SID - it resolves a name to a SID, and resolving "OMAR" does
// not produce the owner SID that `SetNamedSecurityInfoW` would preserve.
//
// The Rust `restrict_to_owner` works precisely because it calls
// `SetNamedSecurityInfoW` with a NULL `oldacl` and the OWNER SID taken from the
// file, so ownership is preserved by construction. That API is not reachable
// from Node without a native addon, and adding one for a single file is a worse
// trade than the gap it closes.
//
// So the honest options are, in order of preference:
//   1. move machine.key and keyring.dat creation into the Rust supervisor, which
//      already has the correct helper - the real fix, and a small one, because
//      `write_protected_secret` already exists and fails closed;
//   2. ship a tiny native helper;
//   3. accept the inherited ACL, which on a stock profile is
//      owner/SYSTEM/Administrators and is not an escalation.
//
// Until (1) is done, `vault.ts` keeps the Unix `mode: 0o600` and this module
// reports the situation instead of pretending to fix it. A helper that locks the
// owner out of the key file would strand every saved provider key, and that is
// strictly worse than the exposure it claims to remove.

export type AclCapability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/**
 * Whether a real owner-only DACL can be applied from here.
 *
 * Always `false` on Windows until the supervisor owns the file, and always
 * `true` on POSIX, where `mode: 0o600` is already correct and `icacls` is not
 * involved at all. This exists so a caller can REPORT the gap rather than
 * silently shipping a no-op that reads as a fix.
 */
export function ownerOnlyAclAvailable(): AclCapability {
  if (process.platform !== 'win32') return { supported: true };
  return {
    supported: false,
    reason:
      'icacls cannot express an owner-only DACL from Node: it grants a name, and the ' +
      'resulting file is unreadable even by that account. The Rust supervisor can, ' +
      'because SetNamedSecurityInfoW preserves the owner SID by construction.',
  };
}

/** Exposed for the diagnostic below; not part of the product path. */
export function icaclsAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('icacls', ['/?'], { stdio: 'ignore', windowsHide: true });
    return existsSync('C:/Windows/System32/icacls.exe') || true;
  } catch {
    return false;
  }
}
