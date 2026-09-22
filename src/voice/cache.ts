import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LRUCache } from 'lru-cache';
import { nowIso, VOICE_IDS } from '../common/brands.js';
import type { VoiceId } from '../common/brands.js';

// Audio cache entries + 50-clip LRU — docs/05 §5.4, docs/18 §18.5.
export interface AudioCacheEntry {
  readonly key: string;
  readonly text: string;
  readonly voice: VoiceId;
  readonly fishVoiceId: string;
  readonly blobPath: string;
  readonly bytes: number;
  readonly createdAt: string;
  lastHitAt: string;
  hits: number;
}

export interface AudioCacheStats {
  size: number;
  readonly maxSize: 50;
  bytesTotal: number;
  readonly bytesCap: number;
  hits: number;
  misses: number;
}

export interface AudioCacheConfig {
  readonly dir: string;
  readonly maxEntries: 50;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}

export function normalizeForCache(text: string): string {
  return text.trim().replace(/\s+/g, ' ').normalize('NFKC');
}

export function cacheKey(text: string, voice: VoiceId): string {
  return createHash('sha256')
    .update(`${normalizeForCache(text)}|${VOICE_IDS[voice]}`)
    .digest('hex');
}

export class AudioCache {
  private readonly lru: LRUCache<string, AudioCacheEntry>;
  private bytesTotal = 0;
  private hits = 0;
  private misses = 0;

  constructor(private readonly cfg: AudioCacheConfig) {
    this.lru = new LRUCache<string, AudioCacheEntry>({
      max: 50,
      maxSize: cfg.maxBytes,
      sizeCalculation: (entry) => entry.bytes,
      dispose: (entry) => {
        this.bytesTotal -= entry.bytes;
        void unlink(entry.blobPath).catch(() => undefined);
      },
      updateAgeOnGet: true,
    });
  }

  async get(text: string, voice: VoiceId): Promise<Buffer | null> {
    const key = cacheKey(text, voice);
    const hit = this.lru.get(key);
    if (hit === undefined) {
      this.misses += 1;
      return null;
    }
    hit.hits += 1;
    hit.lastHitAt = nowIso();
    this.hits += 1;
    return readFile(hit.blobPath);
  }

  async set(text: string, voice: VoiceId, audio: Uint8Array): Promise<void> {
    if (audio.byteLength > this.cfg.maxEntryBytes) return;
    await mkdir(this.cfg.dir, { recursive: true });
    const key = cacheKey(text, voice);
    const blobPath = join(this.cfg.dir, `${key}.mp3`);
    await writeFile(blobPath, audio);
    const now = nowIso();
    this.lru.set(key, {
      key,
      text: normalizeForCache(text),
      voice,
      fishVoiceId: VOICE_IDS[voice],
      blobPath,
      bytes: audio.byteLength,
      createdAt: now,
      lastHitAt: now,
      hits: 0,
    });
    this.bytesTotal += audio.byteLength;
  }

  stats(): AudioCacheStats {
    return {
      size: this.lru.size,
      maxSize: 50,
      bytesTotal: this.bytesTotal,
      bytesCap: this.cfg.maxBytes,
      hits: this.hits,
      misses: this.misses,
    };
  }
}
