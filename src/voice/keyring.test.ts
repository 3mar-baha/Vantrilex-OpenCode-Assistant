import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Keyring } from './keyring.js';
import { decryptPool, FileVault } from './vault.js';

const pools = { groq: ['K1-g', 'K2-g', 'K3-g'], fish: ['K1-f'] };

describe('lock-free rotation distribution (ADR-005 proof)', () => {
  test('25 concurrent acquisitions resolve slots 0-9/10-19/20-24', async () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const used = await Promise.all(
        Array.from({ length: 25 }, () =>
          (async () => {
            const k = ring.acquire('groq');
            const id = k.keyId;
            ring.release(k, true);
            return id;
          })(),
        ),
      );
      // Slot order under concurrency is nondeterministic; counts are structural.
      const count = (id: string): number => used.filter((u) => u === id).length;
      expect(count('K1')).toBe(10);
      expect(count('K2')).toBe(10);
      expect(count('K3')).toBe(5);
      expect(ring.rolloverLog.filter((r) => r.reason === 'count-exhausted')).toHaveLength(2);
    } finally {
      ring.destroy();
    }
  });

  test('429 forces advance past current key remainder', () => {
    const ring = Keyring.fromKeys(pools);
    try {
      for (let i = 0; i < 5; i += 1) {
        const k = ring.acquire('groq');
        ring.release(k, true);
      }
      const bad = ring.acquire('groq');
      expect(bad.keyId).toBe('K1');
      ring.release(bad, false, 429);
      const next = ring.acquire('groq');
      expect(next.keyId).toBe('K2');
      ring.release(next, true);
      expect(ring.rolloverLog.at(-1)?.reason).toBe('rate-limited');
    } finally {
      ring.destroy();
    }
  });

  test('release zeroes caller-visible material', () => {
    const ring = Keyring.fromKeys(pools);
    try {
      const k = ring.acquire('fish');
      expect(k.material.length).toBeGreaterThan(0);
      ring.release(k, true);
      expect(k.material.every((b) => b === 0)).toBe(true);
    } finally {
      ring.destroy();
    }
  });
});

describe('file vault', () => {
  test('encrypt round-trip; corrupt checksum refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const vault = new FileVault(join(dir, 'keyring.dat'));
    const blob = vault.save({ groq: { keys: ['g1', 'g2'] }, fish: { keys: ['f1'] } });
    expect(vault.load()).not.toBeNull();
    expect(decryptPool(blob.pools.groq).keys).toEqual(['g1', 'g2']);
    const tampered = { ...blob.pools.groq, ciphertext: `${blob.pools.groq.ciphertext}X` };
    expect(() => decryptPool(tampered)).toThrowError(/checksum mismatch/);
  });

  test('bootstrap reads comma pools from env-shaped input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const vault = new FileVault(join(dir, 'keyring.dat'));
    const blob = vault.bootstrapFromEnv({ GROQ_API_KEYS: 'a,b', FISH_AUDIO_KEYS: 'c' } as NodeJS.ProcessEnv);
    expect(blob).not.toBeNull();
    expect(decryptPool((blob as NonNullable<typeof blob>).pools.groq).keys).toEqual(['a', 'b']);
    expect(vault.bootstrapFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
