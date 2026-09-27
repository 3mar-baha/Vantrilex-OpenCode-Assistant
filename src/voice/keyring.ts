import { nowIso } from '../common/brands.js';
import { httpStatusOf } from '../common/errors.js';
import { decryptPool, type FileVault, KEY_POOLS, type KeyPool } from './vault.js';

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
    for (const pool of KEY_POOLS) {
      const secrets = decryptPool(blob.pools[pool]);
      if (secrets.keys.length === 0) throw new Error(`pool ${pool} has no keys`);
      ring.keys.set(pool, [...secrets.keys]);
      const buffer = new SharedArrayBuffer(4);
      ring.counters.set(pool, { buffer, view: new Int32Array(buffer) });
      ring.lastKeyIndex.set(pool, 0);
    }
    return ring;
  }

  /** For tests: build directly from key lists without disk. */
  static fromKeys(pools: Record<KeyPool, string[]>): Keyring {
    const ring = new Keyring();
    for (const pool of KEY_POOLS) {
      if (pools[pool].length === 0) throw new Error(`pool ${pool} has no keys`);
      ring.keys.set(pool, [...pools[pool]]);
      const buffer = new SharedArrayBuffer(4);
      ring.counters.set(pool, { buffer, view: new Int32Array(buffer) });
      ring.lastKeyIndex.set(pool, 0);
    }
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

/**
 * L17: acquire a key, run one provider call with it, and release it with the
 * truth about how that call went.
 *
 * Every call site used to release with an unconditional true in a finally
 * block, which reported success no matter how the call went. release() only
 * advances the pool on 429/401/403, so an unconditional true meant a rejected
 * key was never rotated: the daemon kept paying for the same dead credential
 * and the user saw voice simply stop, with no signal that the key was the
 * cause. A key that is present but invalid is indistinguishable from a healthy
 * one until the first utterance - this function is what ends that.
 *
 * Status recovery is httpStatusOf, which returns undefined for anything it does
 * not recognise. That is deliberate: an unrecognised failure must not advance
 * the pool, or a transient 5xx would burn a valid key. Rotation is driven only
 * by an explicit auth rejection or a rate limit.
 */
export async function withKey<T>(
  ring: Keyring,
  pool: KeyPool,
  use: (key: AcquiredKey) => Promise<T>,
): Promise<T> {
  const key = ring.acquire(pool);
  try {
    const out = await use(key);
    ring.release(key, true);
    return out;
  } catch (err) {
    const before = ring.rolloverLog.length;
    ring.release(key, false, httpStatusOf(err));
    // L16: mark the error when the release actually moved to a DIFFERENT key, so
    // the caller can tag its telemetry row `remediationAttempted: 'KeyAdvanced'`.
    // `KeyAdvanced` was in the schema with no producer, so a rotation was
    // invisible: the key changed and nothing recorded that it had.
    //
    // `from !== to` rather than "the log grew": forceAdvance also fires for a
    // single-key pool, where it burns the remaining slots and logs K1 -> K1.
    // That is a real event but it is not remediation, and claiming otherwise
    // would put `KeyAdvanced` on a row for a failure that changed nothing.
    const entry = ring.rolloverLog[before];
    if (entry !== undefined && entry.from !== entry.to && typeof err === 'object' && err !== null) {
      Object.defineProperty(err, ADVANCED, { value: true, enumerable: false, configurable: true });
    }
    throw err;
  }
}

/** Non-enumerable so the marker never reaches a JSON log line or a diff. */
const ADVANCED = Symbol('voxaura.keyAdvanced');

/**
 * Did this failure rotate the key pool? True only when `withKey` released the
 * key with a 429/401/403 — a timeout or a 5xx leaves the pool alone and reports
 * false, which is the honest answer: nothing was remediated.
 */
export function keyAdvanced(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[ADVANCED] === true;
}