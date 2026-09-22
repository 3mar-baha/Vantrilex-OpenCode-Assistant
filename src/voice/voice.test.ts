import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BrainOutputSchema, normalizeBrainJson, requiresConfirmation } from './brain.js';
import { projectSlot, qualifyBriefing } from './disambiguation.js';
import { CHUNK_BYTES, chunkPcm, OVERLAP_BYTES } from './stt.js';
import { TtsEngine, type AudioOut, type FishTransport } from './tts.js';
import type { AudioCacheConfig } from './cache.js';
import type { VoiceId } from '../common/brands.js';

describe('STT chunking', () => {
  test('5s windows with 0.5s overlap; empty input yields none', () => {
    expect(chunkPcm(new Uint8Array(0))).toEqual([]);
    const twelve = new Uint8Array(CHUNK_BYTES * 2 + 1000);
    const chunks = chunkPcm(twelve);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[1]?.startsAtMs).toBe(
      Math.floor(((CHUNK_BYTES - OVERLAP_BYTES) / (16000 * 2)) * 1000),
    );
    expect(chunks[0]?.bytes.byteLength).toBe(CHUNK_BYTES);
  });
});

describe('brain contracts', () => {
  test('output schema accepts valid brain JSON, rejects prose', () => {
    const valid = BrainOutputSchema.safeParse({
      intent: 'followUp',
      reply: 'ok',
      sessionDirective: 'run tests',
    });
    expect(valid.success).toBe(true);
    expect(BrainOutputSchema.safeParse({ intent: 'chat', reply: 'hi' }).success).toBe(false);
  });

  test('high-stakes detection (FR-12)', () => {
    expect(requiresConfirmation('please deploy to production')).toBe(true);
    expect(requiresConfirmation('run rm -rf on the cache dir')).toBe(true);
    expect(requiresConfirmation('run the test suite')).toBe(false);
  });

  test('near-miss shapes normalize; garbage returns null', () => {
    const normalized = normalizeBrainJson({
      intent: 'followUp',
      outcome: 'All tests green',
      identity: 'Live session',
      nextAction: 'Await instructions',
    });
    expect(normalized?.intent).toBe('followUp');
    expect(normalized?.reply).toContain('All tests green');
    expect(normalizeBrainJson({ intent: 'followUp', reply: 'ok' })?.reply).toBe('ok');
    expect(normalizeBrainJson('just prose')).toBeNull();
    expect(normalizeBrainJson({})).toBeNull();
  });
});

describe('TTS cache-first pipeline', () => {
  const cfg: AudioCacheConfig = { dir: mkdtempSync(join(tmpdir(), 'cache-test-')), maxEntries: 50, maxBytes: 1 << 20, maxEntryBytes: 1 << 18 };
  const transport: FishTransport = {
    synthesize: async () => new Uint8Array([1, 2, 3, 4]),
  };
  const played: Uint8Array[] = [];
  const out: AudioOut = {
    play: async (audio: Uint8Array) => {
      played.push(audio);
      return { startedMs: 5 };
    },
  };

  test('miss synthesizes once; hit replays without transport', async () => {
    let calls = 0;
    const counting: FishTransport = {
      synthesize: async () => {
        calls += 1;
        return new Uint8Array([9, 9]);
      },
    };
    const engine = new TtsEngine(cfg, counting, out);
    const voice: VoiceId = 'male-default';
    const first = await engine.speak('hello there', voice);
    expect(first.cacheHit).toBe(false);
    const second = await engine.speak('hello there', voice);
    expect(second.cacheHit).toBe(true);
    expect(calls).toBe(1);
    expect(played).toHaveLength(2);
    expect(transport).toBeDefined();
  });
});

describe('project disambiguation', () => {
  test('silent slot on single project; embedded slot on multiple', () => {
    expect(projectSlot({ activeProjects: ['a'], currentProject: 'a' })).toBe('');
    expect(projectSlot({ activeProjects: ['a', 'b'], currentProject: 'b' })).toBe('b');
    expect(qualifyBriefing('done', { activeProjects: ['a'], currentProject: 'a' })).toBe('done');
    expect(qualifyBriefing('done', { activeProjects: ['a', 'b'], currentProject: 'b' })).toBe('[b] done');
  });
});
