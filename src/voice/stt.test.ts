import { describe, expect, test } from 'vitest';
import { AudioIngest } from './ingest.js';
import { AudioPipeline } from '../orchestrator/audio-pipeline.js';
import { chunkPcm, meanNoSpeechProb, STT_TIMEOUT_MS, SttTimeoutError, transcribeStream } from './stt.js';

/** 5 s of a 440 Hz tone at a speech-like level (-12 dBFS). */
function speechWindow(): Uint8Array {
  const samples = new Int16Array(80_000);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(32768 * 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return new Uint8Array(samples.buffer);
}

// D1 TDD — `response_format: 'verbose_json'` already returns per-segment
// no_speech_prob; it was discarded, so hallucinated text was indistinguishable
// from speech. The pipeline gate now depends on this being surfaced.
describe('meanNoSpeechProb', () => {
  test('returns undefined when no segments carry the field', () => {
    expect(meanNoSpeechProb(undefined)).toBeUndefined();
    expect(meanNoSpeechProb([])).toBeUndefined();
    expect(meanNoSpeechProb([{ text: 'a' }])).toBeUndefined();
  });

  test('averages across segments', () => {
    expect(meanNoSpeechProb([{ no_speech_prob: 0.1 }, { no_speech_prob: 0.3 }])).toBeCloseTo(0.2, 6);
  });

  test('ignores malformed and non-finite values', () => {
    const got = meanNoSpeechProb([
      { no_speech_prob: 0.4 },
      { no_speech_prob: Number.NaN },
      { no_speech_prob: 'high' as unknown as number },
      undefined,
    ]);
    expect(got).toBeCloseTo(0.4, 6);
  });

  test('a single silent segment inside speech dilutes the mean (documented)', () => {
    // Mean is the within-chunk aggregate on purpose: one leading silence
    // segment must not kill a window that is otherwise real speech.
    expect(meanNoSpeechProb([{ no_speech_prob: 0.01 }, { no_speech_prob: 0.95 }])).toBeCloseTo(0.48, 6);
  });

  test('a uniformly non-speech chunk does exceed the 0.6 drop threshold', () => {
    // The property the gate actually relies on.
    const v = meanNoSpeechProb([{ no_speech_prob: 0.9 }, { no_speech_prob: 0.85 }, { no_speech_prob: 0.7 }]);
    expect(v).toBeGreaterThan(0.6);
  });
});

// D5 — the STT call had no timeout. `AudioPipeline.pushChunk` awaits windows
// serially, so one hung Whisper request wedged the whole capture loop and the
// speech phase with it.
describe('STT timeout (D5)', () => {
  test('a hung client rejects with a typed error inside the budget', async () => {
    const started = Date.now();
    await expect(
      transcribeStream(new Uint8Array(64_000), { transcribe: () => new Promise<string>(() => undefined) }, undefined, {
        timeoutMs: 120,
      }),
    ).rejects.toBeInstanceOf(SttTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('the timeout names its own budget and is distinguishable from a provider error', async () => {
    const err = await transcribeStream(
      new Uint8Array(64_000),
      { transcribe: () => new Promise<string>(() => undefined) },
      undefined,
      { timeoutMs: 80 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttTimeoutError);
    expect((err as SttTimeoutError).name).toBe('SttTimeoutError');
    expect((err as Error).message).toContain('80ms');
  });

  test('a provider error passes through unchanged', async () => {
    await expect(
      transcribeStream(
        new Uint8Array(64_000),
        {
          transcribe: async () => {
            throw new Error('Groq 401');
          },
        },
        undefined,
        { timeoutMs: 5000 },
      ),
    ).rejects.toThrow('Groq 401');
  });

  test('a slow-but-in-budget client still succeeds', async () => {
    const res = await transcribeStream(
      new Uint8Array(64_000),
      {
        transcribe: async () => {
          await new Promise((r) => setTimeout(r, 40));
          return 'تم';
        },
      },
      undefined,
      { timeoutMs: 5000 },
    );
    expect(res.text).toBe('تم');
  });

  test('the pipeline abandons a timed-out window and keeps flowing', async () => {
    // The real consequence of D5: one hung window used to stop every later
    // window from being processed. `transcribeStream` owns the timeout and
    // throws this; the pipeline's contract is to drop the window and continue.
    let call = 0;
    const timeouts: number[] = [];
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        call += 1;
        if (call === 1) throw new SttTimeoutError(STT_TIMEOUT_MS);
        return 'بعد التعافي';
      },
      think: async () => ({ reply: 'حاضر' }),
      activeSessionId: () => undefined,
      onSttTimeout: (ms) => void timeouts.push(ms),
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(timeouts).toEqual([STT_TIMEOUT_MS]);
    expect(pipeline.sttTimeoutDrops).toBe(1);
    expect(utterances).toHaveLength(0);

    // The next window is processed normally: the wedge is gone.
    await pipeline.pushChunk(speechWindow());
    expect(utterances).toEqual([{ transcript: 'بعد التعافي', reply: 'حاضر', receipt: null }]);
  });

  test('a non-timeout transcription error still propagates', async () => {
    // Only timeouts are swallowed. A real provider failure must not be hidden.
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        throw new Error('Groq 401');
      },
      think: async () => ({ reply: 'x' }),
      activeSessionId: () => undefined,
    });
    await expect(pipeline.pushChunk(speechWindow())).rejects.toThrow('Groq 401');
  });

  test('STT_TIMEOUT_MS is bounded', () => {
    expect(STT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('transcribeStream', () => {
  test('surfaces the client no_speech_prob on the transcript', async () => {
    const res = await transcribeStream(
      new Uint8Array(64_000),
      { transcribe: async () => ({ text: 'مرحبا', noSpeechProb: 0.11 }) },
    );
    expect(res.text).toBe('مرحبا');
    expect(res.noSpeechProb).toBeCloseTo(0.11, 6);
  });

  test('a bare-string client yields undefined rather than a fabricated 0', async () => {
    const res = await transcribeStream(new Uint8Array(64_000), { transcribe: async () => 'نص' });
    expect(res.text).toBe('نص');
    // Fabricating 0 would make a hallucinated window look maximally confident.
    expect(res.noSpeechProb).toBeUndefined();
  });

  test('multiple chunks take the max, so one silent chunk taints the window', async () => {
    let i = 0;
    const probs = [0.05, 0.95];
    const res = await transcribeStream(
      new Uint8Array(400_000),
      {
        transcribe: async () => {
          const noSpeechProb = probs[i++] as number;
          return { text: 'x', noSpeechProb };
        },
      },
    );
    expect(chunkPcm(new Uint8Array(400_000)).length).toBeGreaterThan(1);
    expect(res.noSpeechProb).toBeCloseTo(0.95, 6);
  });
});
