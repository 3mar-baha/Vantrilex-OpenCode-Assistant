import { describe, expect, test } from 'vitest';
import { chunkPcm, meanNoSpeechProb, transcribeStream } from './stt.js';

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
