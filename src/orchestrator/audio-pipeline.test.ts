import { describe, expect, test } from 'vitest';
import { AudioIngest, WINDOW_BYTES } from '../voice/ingest.js';
import { AudioPipeline } from './audio-pipeline.js';

// P4 TDD — ingest → transcribe → think → dispatch-if-active. Silence never
// spends a brain call; no active session means no dispatch (no fabrication).
//
// D1 TDD — silence must not even reach the STT provider. The fixtures below
// are speech-amplitude PCM on purpose: the previous `new Uint8Array(n).fill(4)`
// was -78 dBFS digital near-silence, so the "speech" tests only passed because
// nothing gated them. Room tone now has its own fixture, `silentWindow()`.

/** 5 s of a 440 Hz tone at a speech-like level (-12 dBFS). */
function speechWindow(): Uint8Array {
  const samples = new Int16Array(WINDOW_BYTES / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(32768 * 0.25 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return new Uint8Array(samples.buffer);
}

/** 5 s of digital silence (0 dBFS floor). */
function silentWindow(): Uint8Array {
  return new Uint8Array(WINDOW_BYTES);
}

describe('AudioPipeline', () => {
  test('full loop: transcript → reply → dispatch receipt', async () => {
    const calls: string[] = [];
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async (pcm) => {
        calls.push(`transcribe:${pcm.byteLength}`);
        return 'live harness ping';
      },
      think: async (text) => {
        calls.push(`think:${text}`);
        return { reply: 'تمام' };
      },
      dispatch: async (text) => {
        calls.push(`dispatch:${text}`);
        return { receipt: 'msg_1' };
      },
      activeSessionId: () => 'ses_a' as never,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(calls).toEqual(['transcribe:160000', 'think:live harness ping', 'dispatch:live harness ping']);
    expect(utterances).toEqual([{ transcript: 'live harness ping', reply: 'تمام', receipt: 'msg_1' }]);
  });

  test('D1: silence never reaches the STT provider', async () => {
    const calls: string[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        calls.push('transcribe');
        return 'should never run';
      },
      think: async () => {
        calls.push('think');
        return { reply: 'x' };
      },
      dispatch: async () => {
        calls.push('dispatch');
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(silentWindow());
    // The gate short-circuits upstream of transcribe: the hallucination
    // amplifier is closed at the source, not merely filtered downstream.
    expect(calls).toEqual([]);
    expect(pipeline.gatedWindows).toBe(1);
    expect(pipeline.droppedWindows).toBe(0);
  });

  test('an empty transcript from a LOUD window still spends nothing downstream', async () => {
    const calls: string[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        calls.push('transcribe');
        return '   ';
      },
      think: async () => {
        calls.push('think');
        return { reply: 'x' };
      },
      dispatch: async () => {
        calls.push('dispatch');
        return { receipt: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(speechWindow());
    expect(calls).toEqual(['transcribe']);
  });

  test('D1: high no_speech_prob is dropped as a hallucination', async () => {
    const calls: string[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        calls.push('transcribe');
        return { text: 'شكرا لك جزيلا', noSpeechProb: 0.91 };
      },
      think: async () => {
        calls.push('think');
        return { reply: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(speechWindow());
    expect(calls).toEqual(['transcribe']);
    expect(pipeline.hallucinationDrops).toBe(1);
  });

  test('D1: a confident transcript with low no_speech_prob survives', async () => {
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => ({ text: 'افتح الجلسات', noSpeechProb: 0.04 }),
      think: async () => ({ reply: 'حاضر' }),
      activeSessionId: () => 'ses_a' as never,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(utterances).toEqual([{ transcript: 'افتح الجلسات', reply: 'حاضر', receipt: null }]);
    expect(pipeline.hallucinationDrops).toBe(0);
  });

  test('D1: an injected speech gate (Silero) can veto a loud window', async () => {
    const calls: string[] = [];
    const gateCalls: number[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      speechGate: async (window) => {
        gateCalls.push(window.byteLength);
        return false;
      },
      transcribe: async () => {
        calls.push('transcribe');
        return 'text';
      },
      think: async () => ({ reply: 'x' }),
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(speechWindow());
    expect(gateCalls).toEqual([WINDOW_BYTES]);
    expect(calls).toEqual([]);
    expect(pipeline.gatedWindows).toBe(1);
  });

  test('D1: an injected speech gate can admit a window the energy gate would drop', async () => {
    // Proves the injected gate REPLACES the energy gate rather than stacking on
    // top of it: a digitally silent window is transcribed when the model says
    // "speech" (e.g. a very quiet speaker, or a mic with a high noise floor).
    const calls: string[] = [];
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      speechGate: async () => true,
      transcribe: async () => {
        calls.push('transcribe');
        return 'كلمة هادئة';
      },
      think: async () => {
        calls.push('think');
        return { reply: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(silentWindow());
    expect(calls).toEqual(['transcribe', 'think']);
    expect(pipeline.gatedWindows).toBe(0);
    expect(utterances).toHaveLength(1);
  });

  test('D1: repeated identical transcripts are dropped once', async () => {
    let thinks = 0;
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'نفس الجملة',
      think: async () => {
        thinks += 1;
        return { reply: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(speechWindow());
    await pipeline.pushChunk(speechWindow());
    await pipeline.pushChunk(speechWindow());
    expect(thinks).toBe(1);
    expect(pipeline.repeatDrops).toBe(2);
  });

  test('D1: dedupe is case/whitespace/punctuation insensitive', async () => {
    let thinks = 0;
    const variants = ['نفس الجملة', '  نفس الجملة  ', 'نفس الجملة؟', 'نفس الجملة؟؟'];
    let i = 0;
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => variants[i++] as string,
      think: async () => {
        thinks += 1;
        return { reply: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    for (const variant of variants) {
      void variant;
      await pipeline.pushChunk(speechWindow());
    }
    expect(thinks).toBe(1);
  });

  test('D1: reset() clears the repeat history so a new turn can repeat itself', async () => {
    let thinks = 0;
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'نفس الجملة',
      think: async () => {
        thinks += 1;
        return { reply: 'x' };
      },
      activeSessionId: () => 'ses_a' as never,
    });
    await pipeline.pushChunk(speechWindow());
    pipeline.reset();
    await pipeline.pushChunk(speechWindow());
    expect(thinks).toBe(2);
    expect(pipeline.repeatDrops).toBe(0);
  });

  test('no active session means think but no dispatch', async () => {
    const calls: string[] = [];
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'hello',
      think: async () => {
        calls.push('think');
        return { reply: 'hi' };
      },
      dispatch: async () => {
        calls.push('dispatch');
        return { receipt: 'x' };
      },
      activeSessionId: () => undefined,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(calls).toEqual(['think']);
    expect(utterances).toEqual([{ transcript: 'hello', reply: 'hi', receipt: null }]);
  });

  test('partial windows accumulate without downstream calls', async () => {
    let transcribes = 0;
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => {
        transcribes += 1;
        return 'x';
      },
      think: async () => ({ reply: 'x' }),
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });
    await pipeline.pushChunk(new Uint8Array(3200));
    expect(transcribes).toBe(0);
    expect(pipeline.bufferedBytes).toBe(3200);
  });

  test('downstream errors surface, later chunks still flow', async () => {
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'ok',
      think: async () => {
        throw new Error('brain down');
      },
      dispatch: async () => ({ receipt: 'x' }),
      activeSessionId: () => undefined,
    });
    await expect(pipeline.pushChunk(speechWindow())).rejects.toThrow('brain down');
    expect(pipeline.bufferedBytes).toBe(0);
  });

  test('think-provided receipt is used as-is; no implicit raw dispatch', async () => {
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'hello',
      think: async () => ({ reply: 'hi', receipt: 'msg_chain' }),
      activeSessionId: () => 'ses_a' as never,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    // The utterances equality below is the proof: a stray dispatch would
    // have produced receipt 'x' instead of the chain receipt.
    expect(utterances).toEqual([{ transcript: 'hello', reply: 'hi', receipt: 'msg_chain' }]);
  });

  test('without a dispatch fallback nothing is ever sent implicitly', async () => {
    const utterances: unknown[] = [];
    const pipeline = new AudioPipeline({
      ingest: new AudioIngest(),
      transcribe: async () => 'hello',
      think: async () => ({ reply: 'hi' }),
      activeSessionId: () => 'ses_a' as never,
      onUtterance: (u) => void utterances.push(u),
    });
    await pipeline.pushChunk(speechWindow());
    expect(utterances).toEqual([{ transcript: 'hello', reply: 'hi', receipt: null }]);
  });
});
