import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Keyring } from './keyring.js';
import { decryptPool, FileVault } from './vault.js';

const pools = { groq: ['K1-g', 'K2-g', 'K3-g'], fish: ['K1-f'], openrouter: ['K1-o'] };

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

  test('A.6 primitive: destroy zeroes the live cache buffer and the ring recovers', () => {
    // The mechanism every A.6 assertion rests on. `cached` is private, so this
    // reads the ring the way a debugger would — and it is the only place in the
    // suite that can see whether a destroy had anything to zero. The daemon-side
    // tests then assert on the same object.
    const ring = Keyring.fromKeys(pools);
    const first = ring.acquire('groq');
    expect(first.keyId).toBe('K1');
    ring.release(first, true);
    const cache = (ring as unknown as { cached: Map<string, Buffer> }).cached;
    const held = cache.get('groq') as Buffer;
    expect(held.toString('utf8'), 'the ring caches one Buffer per pool, not per call').toBe(pools.groq[0]);
    expect(cache.size).toBe(1);

    ring.destroy();

    // Zeroed IN PLACE, not swapped out: a replaced buffer would leave the old
    // one alive in the heap, which is the residency A.6 exists to remove.
    expect([...held].every((b) => b === 0), 'the very buffer that held the key must be zeroed').toBe(true);
    expect(cache.size, 'and the ring must forget it').toBe(0);
    // Zeroing must not corrupt the ring into handing out empty credentials.
    const after = ring.acquire('groq');
    expect(after.material.toString('utf8'), 'a post-destroy acquire rebuilds real material').toBe(pools.groq[0]);
  });

  test('fromKeys refuses an empty third pool (fail-closed activation)', () => {
    expect(() => Keyring.fromKeys({ groq: ['a'], fish: ['b'], openrouter: [] })).toThrowError(/no keys/);
    const ring = Keyring.fromKeys({ groq: ['a'], fish: ['b'], openrouter: ['c'] });
    try {
      const k = ring.acquire('openrouter');
      expect(k.material.length).toBeGreaterThan(0);
      ring.release(k, true);
    } finally {
      ring.destroy();
    }
  });
});

describe('file vault', () => {
  test('encrypt round-trip; corrupt checksum refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const vault = new FileVault(join(dir, 'keyring.dat'));
    const blob = vault.save({ groq: { keys: ['g1', 'g2'] }, fish: { keys: ['f1'] }, openrouter: { keys: ['o1'] } });
    expect(vault.load()).not.toBeNull();
    expect(decryptPool(blob.pools.groq).keys).toEqual(['g1', 'g2']);
    const tampered = { ...blob.pools.groq, ciphertext: `${blob.pools.groq.ciphertext}X` };
    expect(() => decryptPool(tampered)).toThrowError(/checksum mismatch/);
  });

  test('bootstrap reads comma pools from env-shaped input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const vault = new FileVault(join(dir, 'keyring.dat'));
    const blob = vault.bootstrapFromEnv({ GROQ_API_KEYS: 'a,b', FISH_AUDIO_KEYS: 'c', OPENROUTER_API_KEYS: 'd' } as NodeJS.ProcessEnv);
    expect(blob).not.toBeNull();
    expect(decryptPool((blob as NonNullable<typeof blob>).pools.groq).keys).toEqual(['a', 'b']);
    expect(decryptPool((blob as NonNullable<typeof blob>).pools.openrouter).keys).toEqual(['d']);
    expect(vault.bootstrapFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test('bootstrap is fail-closed: any missing pool refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const vault = new FileVault(join(dir, 'keyring.dat'));
    expect(
      vault.bootstrapFromEnv({ GROQ_API_KEYS: 'a', FISH_AUDIO_KEYS: 'b' } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      vault.bootstrapFromEnv({ GROQ_API_KEYS: 'a', OPENROUTER_API_KEYS: 'c' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
