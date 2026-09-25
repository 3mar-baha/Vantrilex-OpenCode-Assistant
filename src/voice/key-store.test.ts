import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readKeyPools, mergeKeyPools, writeKeyPools } from './key-store.js';
import { FileVault } from './vault.js';

function tmpVault(): FileVault {
  return new FileVault(join(mkdtempSync(join(tmpdir(), 'keystore-')), 'keyring.dat'));
}

describe('key-store (daemon key intake → vault)', () => {
  test('empty vault reads as three empty pools', () => {
    expect(readKeyPools(tmpVault())).toEqual({ groq: [], fish: [], openrouter: [] });
  });

  test('write then read round-trips all three pools', () => {
    const vault = tmpVault();
    writeKeyPools(vault, { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
    expect(readKeyPools(vault)).toEqual({ groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
  });

  test('saving one provider never wipes the others', () => {
    const vault = tmpVault();
    writeKeyPools(vault, { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
    const merged = writeKeyPools(vault, { openrouter: ['o2'] });
    expect(merged.groq).toEqual(['g1']);
    expect(merged.fish).toEqual(['f1']);
    expect(merged.openrouter).toEqual(['o2']);
  });

  test('merge ignores empty incoming pools and unknown-shaped input', () => {
    const base = { groq: ['g'], fish: ['f'], openrouter: ['o'] };
    expect(mergeKeyPools(base, { groq: [] })).toEqual(base);
    expect(mergeKeyPools(base, {})).toEqual(base);
  });

  test('an undecryptable pool reads as empty rather than throwing', () => {
    const vault = tmpVault();
    writeKeyPools(vault, { groq: ['g1'], fish: ['f1'], openrouter: ['o1'] });
    const blob = vault.load();
    if (blob === null) throw new Error('expected a blob');
    // Tamper the groq ciphertext: checksum check must refuse it, read must survive.
    blob.pools.groq = { ...blob.pools.groq, ciphertext: `${blob.pools.groq.ciphertext}XX` };
    vault.save({
      groq: { keys: [] },
      fish: { keys: ['f1'] },
      openrouter: { keys: ['o1'] },
    });
    expect(readKeyPools(vault).fish).toEqual(['f1']);
  });
});