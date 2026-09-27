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

/**
 * L16: what `doctor` reports about key availability, and whether voice can run.
 *
 * This lives here rather than in cli.ts because that module dispatches on argv
 * and calls `process.exit` at import time, so nothing can import it from a test.
 * It belongs with `readKeyPools` anyway — both are pure functions over the pool
 * model, and this one is the presentation of what that model says.
 *
 * It exists because `doctor` used to read environment variables only. The vault
 * is the single credential source, so a normal installed run — three pools saved
 * through the API-keys window, every env var unset — reported `miss` for all
 * three and exited non-zero, describing a healthy app as broken.
 *
 * An empty pool has two very different causes — never saved, or saved on
 * another machine and undecryptable here (the blob is bound to machine.key) —
 * and both leave voice silently dead, so the pools are named individually rather
 * than collapsed into one aggregate miss.
 */
export function vaultKeyStatus(pools: KeyPools): { ok: boolean; lines: string[] } {
  const emptyPools = KEY_POOLS.filter((p) => pools[p].length === 0);
  if (emptyPools.length === 0) {
    const total = KEY_POOLS.reduce((n, p) => n + pools[p].length, 0);
    return {
      ok: true,
      lines: [`ok   vault: ${total} keys across ${KEY_POOLS.length} pools (counts only, zero material)`],
    };
  }
  return {
    ok: false,
    lines: [
      `miss vault: no usable key for ${emptyPools.join(', ')} — voice stays down until saved`,
      '     (absent pool, or one written on another machine: the vault is bound to machine.key)',
    ],
  };
}