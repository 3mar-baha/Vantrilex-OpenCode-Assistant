import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nowIso, VOICE_IDS } from '../common/brands.js';
import type { VoiceId } from '../common/brands.js';
import { AudioCache, cacheKey, type AudioCacheConfig } from './cache.js';
import type { Keyring } from './keyring.js';

// TTS engine — docs/18 §18.4, docs/06 §6.6. Cache-first; Fish Audio `s2.1-pro-free`
// streaming synthesis; voice from VOICE_IDS; keyring-supplied key per call.
// AudioOut is a sink interface: FileAudioOut persists + hands off to the OS
// (no focus APIs); device streaming binds later without changing this path.
export const TTS_MODEL = 's2.1-pro-free';
export const TTS_FIRST_CHUNK_BUDGET_MS = 800;

export interface AudioOut {
  play(audio: Uint8Array, voice: VoiceId): Promise<{ startedMs: number }>;
  /** Progressive sink: receives chunks as they synthesize; default callers may omit. */
  playStream?(chunks: AsyncIterable<Uint8Array>, voice: VoiceId): Promise<{ startedMs: number }>;
}

export class FileAudioOut implements AudioOut {
  constructor(private readonly dir: string = join(tmpdir(), 'opencode-voice-playback')) {}

  async play(audio: Uint8Array, voice: VoiceId): Promise<{ startedMs: number }> {
    return this.playStream(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield audio;
      })(),
      voice,
    );
  }

  async playStream(chunks: AsyncIterable<Uint8Array>, voice: VoiceId): Promise<{ startedMs: number }> {
    const started = Date.now();
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${cacheKey(nowIso(), voice)}.mp3`);
    const { openSync, writeSync, closeSync } = await import('node:fs');
    const fd = openSync(path, 'w');
    try {
      for await (const chunk of chunks) {
        writeSync(fd, chunk);
      }
    } finally {
      closeSync(fd);
    }
    return { startedMs: Date.now() - started };
  }
}

export interface FishTransport {
  synthesize(text: string, fishVoiceId: string): Promise<Uint8Array>;
  /** Progressive synthesis; engine times first yield as first-chunk TTFB. */
  synthesizeStream?(text: string, fishVoiceId: string): AsyncGenerator<Uint8Array>;
}

export class FishHttpTransport implements FishTransport {
  constructor(
    private readonly keyring: Keyring,
    private readonly endpoint = 'https://api.fish.audio/v1/tts',
  ) {}

  async synthesize(text: string, fishVoiceId: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const chunk of this.synthesizeStream(text, fishVoiceId)) {
      parts.push(chunk);
    }
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  async *synthesizeStream(text: string, fishVoiceId: string): AsyncGenerator<Uint8Array> {
    const key = this.keyring.acquire('fish');
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Buffer.from(key.material).toString('utf8')}`,
          'Content-Type': 'application/json',
          model: TTS_MODEL,
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          reference_id: fishVoiceId,
          format: 'mp3',
          latency: 'balanced',
          chunk_length: 200,
          normalize: true,
        }),
      });
      if (res.status === 429) {
        this.keyring.release(key, false, 429);
        throw new Error('TTS rate-limited (429)');
      }
      if (!res.ok || res.body === null) {
        this.keyring.release(key, false, res.status);
        throw new Error(`TTS failed: HTTP ${res.status}`);
      }
      this.keyring.release(key, true);
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch (err) {
      try {
        key.material.fill(0);
      } catch {
        // Zeroing is best-effort after transport failure.
      }
      throw err;
    }
  }
}

export class TtsEngine {
  private readonly cache: AudioCache;

  constructor(
    cfg: AudioCacheConfig,
    private readonly transport: FishTransport,
    private readonly out: AudioOut,
  ) {
    this.cache = new AudioCache(cfg);
  }

  async speak(text: string, voice: VoiceId): Promise<{ cacheHit: boolean; startedMs: number; firstChunkMs?: number }> {
    const cached = await this.cache.get(text, voice);
    if (cached !== null) {
      const { startedMs } = await this.out.play(new Uint8Array(cached), voice);
      return { cacheHit: true, startedMs, firstChunkMs: 0 };
    }
    if (this.transport.synthesizeStream !== undefined && this.out.playStream !== undefined) {
      // Progressive path: first chunk flows to the sink before synthesis completes.
      const stream = this.transport.synthesizeStream(text, VOICE_IDS[voice]);
      const started = Date.now();
      let firstChunkMs = -1;
      const collected: Uint8Array[] = [];
      const tee = async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of stream) {
          if (firstChunkMs < 0) firstChunkMs = Date.now() - started;
          collected.push(chunk);
          yield chunk;
        }
      };
      const { startedMs } = await this.out.playStream(tee(), voice);
      const total = collected.reduce((n, p) => n + p.byteLength, 0);
      const audio = new Uint8Array(total);
      let offset = 0;
      for (const part of collected) {
        audio.set(part, offset);
        offset += part.byteLength;
      }
      await this.cache.set(text, voice, audio);
      return { cacheHit: false, startedMs, firstChunkMs };
    }
    const audio = await this.transport.synthesize(text, VOICE_IDS[voice]);
    await this.cache.set(text, voice, audio);
    const { startedMs } = await this.out.play(audio, voice);
    return { cacheHit: false, startedMs };
  }

  cacheStats(): { size: number; hits: number; misses: number } {
    const stats = this.cache.stats();
    return { size: stats.size, hits: stats.hits, misses: stats.misses };
  }
}
