import { describe, expect, test } from 'vitest';
import { ownerOnlyAclAvailable } from './win-acl.js';

describe('owner-only ACL capability, as measured on this platform', () => {
  test('POSIX reports the capability available, and it is not a stub', () => {
    // On POSIX, `{ mode: 0o600 }` IS the protection, so the answer is
    // available. A test that silently passed on every platform would be a false
    // guarantee for a Windows-only claim, so the branch is asserted directly.
    if (process.platform === 'win32') return;
    expect(ownerOnlyAclAvailable().supported).toBe(true);
  });

  test('Windows reports it UNAVAILABLE, with a reason, not a silent true', () => {
    // This is the whole point of the module. `icacls` reports success and
    // produces a file its own named grantee cannot read, so claiming a fix here
    // would strand every saved provider key. The honest answer is false, with
    // the reason attached, and the daemon warns once.
    if (process.platform !== 'win32') return;
    const r = ownerOnlyAclAvailable();
    expect(r.supported).toBe(false);
    if (!r.supported) {
      expect(r.reason).toMatch(/icacls|owner SID/i);
      // A reason is part of the contract: "unsupported" with no explanation is
      // a bug report waiting to happen.
      expect(r.reason.length).toBeGreaterThan(40);
    }
  });
});
