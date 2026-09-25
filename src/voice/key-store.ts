import { decryptPool, KEY_POOLS, type FileVault, type KeyPool } from './vault.js';

// Key-store adapter — the bridge between the daemon's key-intake path and the
// encrypted vault. Reads tolerate a missing or undecryptable pool (returns an
// empty list instead of throwing, so one bad pool never blocks the app); writes
// merge, so saving one provider never wipes the others.
export type KeyPools = Record<KeyPool, string[]>;

const empty = (): KeyPools => ({ groq: [], fish: [], openrouter: [] });

export function readKeyPools(vault: FileVault): KeyPools {
  const out = empty();
  const blob = vault.load();
  if (blob === null) return out;
  for (const pool of KEY_POOLS) {
    const entry = blob.pools?.[pool];
    if (entry === undefined) continue;
    try {
      out[pool] = decryptPool(entry).keys;
    } catch {
      // Corrupt or foreign-machine pool: report empty, never leak or throw.
      out[pool] = [];
    }
  }
  return out;
}

export function mergeKeyPools(existing: KeyPools, incoming: Partial<KeyPools>): KeyPools {
  const merged = { ...existing };
  for (const pool of KEY_POOLS) {
    const next = incoming[pool];
    if (next !== undefined && next.length > 0) merged[pool] = [...next];
  }
  return merged;
}

export function writeKeyPools(vault: FileVault, incoming: Partial<KeyPools>): KeyPools {
  const merged = mergeKeyPools(readKeyPools(vault), incoming);
  vault.save({
    groq: { keys: merged.groq },
    fish: { keys: merged.fish },
    openrouter: { keys: merged.openrouter },
  });
  return merged;
}