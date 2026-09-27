import { describe, expect, test } from 'vitest';
import { vaultKeyStatus } from './voice/key-store.js';
import { KEY_POOLS } from './voice/vault.js';

// L16: `doctor` reported key availability from environment variables only. The
// vault is the single credential source, so a normal installed run — three pools
// saved through the API-keys window, every env var unset — printed `miss` for
// all three and exited non-zero. The tool described a healthy app as broken.
//
// These pin the replacement: the vault is the verdict, and an empty pool is
// named individually because "never saved" and "written on another machine"
// look identical from here and both leave voice dead.

const P = (o: Partial<Record<(typeof KEY_POOLS)[number], string[]>>) => ({
  groq: o.groq ?? [],
  fish: o.fish ?? [],
  openrouter: o.openrouter ?? [],
});

describe('doctor reports the vault, not the environment', () => {
  test('three saved pools are ok, and the count is a count', () => {
    const v = vaultKeyStatus(P({ groq: ['a', 'b'], fish: ['c'], openrouter: ['d'] }));
    expect(v.ok).toBe(true);
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toContain('ok');
    expect(v.lines[0]).toContain('4 keys');
  });

  test('no key material ever reaches the report', () => {
    // The real risk in printing key counts is printing a key while doing it.
    const secret = 'sk-or-v1-abcdef0123456789';
    const v = vaultKeyStatus(P({ groq: [secret], fish: ['f'], openrouter: ['o'] }));
    for (const line of v.lines) expect(line).not.toContain(secret);
  });

  test('a fully keyless vault is a miss naming every pool', () => {
    const v = vaultKeyStatus(P({}));
    expect(v.ok).toBe(false);
    for (const pool of KEY_POOLS) expect(v.lines[0]).toContain(pool);
  });

  test('one empty pool is named, not averaged away by the healthy ones', () => {
    // A single missing pool is enough to kill STT or the brain, so the report
    // must not read "ok" because the other two are populated.
    const v = vaultKeyStatus(P({ groq: ['a'], fish: ['b'], openrouter: [] }));
    expect(v.ok).toBe(false);
    expect(v.lines[0]).toContain('openrouter');
    expect(v.lines[0]).not.toContain('groq');
    expect(v.lines[0]).not.toContain('fish');
  });

  test('the hint names the cross-machine cause, which looks like absence', () => {
    // keyring.dat copied from another machine decrypts to nothing. Reporting
    // only "no key" sends the user to re-enter keys they already entered.
    const v = vaultKeyStatus(P({ groq: ['a'] }));
    expect(v.lines[1]).toContain('machine.key');
  });

  test('an empty-string key still counts as a key entry being present', () => {
    // readKeyPools filters upstream; if a blank ever survived, reporting a
    // miss is the safer answer than reporting health.
    const v = vaultKeyStatus(P({ groq: [''], fish: ['f'], openrouter: ['o'] }));
    expect(v.ok).toBe(true);
  });
});
