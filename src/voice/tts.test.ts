import { describe, expect, test } from 'vitest';
import { SpeechGate, splitSentences, TtsEngine } from './tts.js';
import type { FishTransport } from './tts.js';
import type { VoiceId } from '../common/brands.js';

// Directive 5 TDD: sentence-level streaming. The first sentence must be
// dispatched to Fish Audio immediately — never buffered behind the full
// paragraph — so first-chunk TTFB tracks one short clause, not the reply.
describe('splitSentences', () => {
  test('splits Arabic and Latin terminators, keeps text, drops empties', () => {
    expect(splitSentences('أهلاً بك. كيف أساعدك؟ تمام! Ready? Yes.')).toEqual([
      'أهلاً بك.',
      'كيف أساعدك؟',
      'تمام!',
      'Ready?',
      'Yes.',
    ]);
  });

  test('newlines bound sentences; empty input yields none', () => {
    expect(splitSentences('سطر أول\nسطر ثان')).toEqual(['سطر أول', 'سطر ثان']);
    expect(splitSentences('   ')).toEqual([]);
  });

  test('a run-on sentence without punctuation hard-splits on word boundary', () => {
    const words = Array.from({ length: 100 }, (_, i) => `كلمة${i}`).join(' ');
    const parts = splitSentences(words);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
    expect(parts.join(' ')).toBe(words);
  });
});

describe('SpeechGate', () => {
  test('abort invalidates the in-flight generation', () => {
    const gate = new SpeechGate();
    const gen = gate.capture();
    expect(gate.isCurrent(gen)).toBe(true);
    gate.abort();
    expect(gate.isCurrent(gen)).toBe(false);
    expect(gate.isCurrent(gate.capture())).toBe(true);
  });
});

describe('TtsEngine.speakSentences', () => {
  test('first sentence synthesizes and plays before later ones start', async () => {
    const requested: string[] = [];
    const played: string[] = [];
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    const transport: FishTransport = {
      synthesize: async (text: string) => {
        requested.push(text);
        if (requested.length === 2) await secondGate;
        return new TextEncoder().encode(`audio:${text}`);
      },
    };
    const engine = new TtsEngine(
      {
        dir: 'C:/Users/omarb/AppData/Local/Temp/opencode/tts-sent-cache',
        maxEntries: 50,
        maxBytes: 1_000_000,
        maxEntryBytes: 500_000,
      },
      transport,
      {
        play: async (audio: Uint8Array) => {
          played.push(new TextDecoder().decode(audio));
          if (played.length === 1) releaseSecond();
          return { startedMs: 0 };
        },
      },
    );
    const result = await engine.speakSentences('أهلاً. كيف أساعدك؟', 'male-default' as VoiceId);
    expect(requested).toEqual(['أهلاً.', 'كيف أساعدك؟']);
    expect(played).toEqual(['audio:أهلاً.', 'audio:كيف أساعدك؟']);
    expect(result.sentences).toBe(2);
    expect(result.firstChunkMs).toBeGreaterThanOrEqual(0);
  });
});
