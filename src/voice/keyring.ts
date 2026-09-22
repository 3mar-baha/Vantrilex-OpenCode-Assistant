import { nowIso } from '../common/brands.js';
import { decryptPool, type FileVault, type KeyPool } from './vault.js';

// Lock-free keyring — docs/20, ADR-005. Slot assignment is a wait-free atomic
// fetch-and-add on a SharedArrayBuffer counter; keyIndex = floor(slot/10) % n,
// so request #11 deterministically rolls over. Only the counter is lock-free —
// secret buffers are still zeroed on release/rollover (security boundary).
export const ROTATION_LIMIT = 10;

export interface AcquiredKey {
  readonly pool: KeyPool;
  readonly keyId: string;
  readonly material: Buffer;
}

export interface RolloverInfo {
  readonly at: string;
  readonly reason: 'count-exhausted' | 'rate-limited' | 'auth-failed' | 'manual';
  readonly from: string;
  readonly to: string;
}

export class Keyring {
  private readonly counters = new Map<KeyPool, { buffer: SharedArrayBuffer; view: Int32Array }>();
  private readonly keys = new Map<KeyPool, string[]>();
  private readonly cached = new Map<KeyPool, Buffer>();
  private readonly rollovers: RolloverInfo[] = [];
  private lastKeyIndex = new Map<KeyPool, number>();

  private constructor() {}

  static load(vault: FileVault): Keyring {
    const ring = new Keyring();
    const blob = vault.load();
    if (blob === null) throw new Error('vault empty — run vault bootstrap first');
    (['groq', 'fish'] as const).forEach((pool) => {
      const secrets = decryptPool(blob.pools[pool]);
      if (secrets.keys.length === 0) throw new Error(`pool ${pool} has no keys`);
      ring.keys.set(pool, [...secrets.keys]);
      const buffer = new SharedArrayBuffer(4);
      ring.counters.set(pool, { buffer, view: new Int32Array(buffer) });
      ring.lastKeyIndex.set(pool, 0);
    });
    return ring;
  }

  /** For tests: build directly from key lists without disk. */
  static fromKeys(pools: Record<KeyPool, string[]>): Keyring {
    const ring = new Keyring();
    (['groq', 'fish'] as const).forEach((pool) => {
      if (pools[pool].length === 0) throw new Error(`pool ${pool} has no keys`);
      ring.keys.set(pool, [...pools[pool]]);
      const buffer = new SharedArrayBuffer(4);
      ring.counters.set(pool, { buffer, view: new Int32Array(buffer) });
      ring.lastKeyIndex.set(pool, 0);
    });
    return ring;
  }

  private poolMaterial(pool: KeyPool, index: number): Buffer {
    const list = this.keys.get(pool) as string[];
    let buf = this.cached.get(pool);
    if (buf === undefined) {
      buf = Buffer.from(list[index] as string, 'utf8');
      this.cached.set(pool, buf);
    } else if ((this.lastKeyIndex.get(pool) as number) !== index) {
      buf.fill(0);
      buf = Buffer.from(list[index] as string, 'utf8');
      this.cached.set(pool, buf);
    }
    return Buffer.from(buf);
  }

  acquire(pool: KeyPool): AcquiredKey {
    const counter = this.counters.get(pool) as { view: Int32Array };
    const list = this.keys.get(pool) as string[];
    const slot = Atomics.add(counter.view, 0, 1);
    const keyIndex = Math.floor(slot / ROTATION_LIMIT) % list.length;
    const prev = this.lastKeyIndex.get(pool) as number;
    if (keyIndex !== prev) {
      this.cached.get(pool)?.fill(0);
      this.rollovers.push({ at: nowIso(), reason: 'count-exhausted', from: `K${prev + 1}`, to: `K${keyIndex + 1}` });
      this.lastKeyIndex.set(pool, keyIndex);
    }
    return { pool, keyId: `K${keyIndex + 1}`, material: this.poolMaterial(pool, keyIndex) };
  }

  release(key: AcquiredKey, ok: boolean, status?: number): void {
    key.material.fill(0);
    if (!ok && (status === 429 || status === 401 || status === 403)) {
      this.forceAdvance(key.pool, status === 429 ? 'rate-limited' : 'auth-failed');
    }
  }

  /** Skip past the current key's remaining slots; next acquire lands on the next key. */
  forceAdvance(pool: KeyPool, reason: 'rate-limited' | 'auth-failed' | 'manual'): void {
    const counter = this.counters.get(pool) as { view: Int32Array };
    const list = this.keys.get(pool) as string[];
    const current = Atomics.load(counter.view, 0);
    const currentKey = Math.floor(current / ROTATION_LIMIT) % list.length;
    const nextBoundary = (Math.floor(current / ROTATION_LIMIT) + 1) * ROTATION_LIMIT;
    Atomics.store(counter.view, 0, nextBoundary);
    const nextKey = nextBoundary === current ? currentKey : (currentKey + 1) % list.length;
    this.cached.get(pool)?.fill(0);
    this.lastKeyIndex.set(pool, nextKey);
    this.rollovers.push({ at: nowIso(), reason, from: `K${currentKey + 1}`, to: `K${nextKey + 1}` });
  }

  get rolloverLog(): readonly RolloverInfo[] {
    return this.rollovers;
  }

  /** Zero all cached material (shutdown path). */
  destroy(): void {
    for (const buf of this.cached.values()) buf.fill(0);
    this.cached.clear();
  }
}
