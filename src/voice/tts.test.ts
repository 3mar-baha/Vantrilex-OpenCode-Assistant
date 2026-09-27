import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  fetchWithTimeout,
  fishRequestBody,
  FishHttpTransport,
  FISH_TIMEOUT_MS,
  isSpeakable,
  PLAYBACK_RETENTION_MS,
  SpeechGate,
  SPEECH_CACHE_MAX_ENTRY_BYTES,
  SPEECH_FILLERS,
  splitSentences,
  stripSpeechText,
  sweepOldPlaybackFiles,
  TtsEngine,
  TtsTimeoutError,
} from './tts.js';
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

// D2 TDD — nothing may reach the speech engine that has no spoken form.
// Fish vocalises asterisks, hash marks, emoji and URLs, which is how a calm
// reply turns into garbled, shouted nonsense.

// The core contract, inherited from pipecat's strip_markdown docstring: the
// sanitiser must never eat a word. Both sides are diacritic-stripped BEFORE
// tokenising — otherwise combining marks act as separators on one side only
// and a single word reads as several.
function spokenTokens(text: string): string[] {
  return text.replace(/[ً-ٰٟـ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

describe('stripSpeechText', () => {
  // Expectations carry the tashkil-stripped and terminal-punctuation forms:
  // `حسناً` (tanween) normalises to `حسنا`, and every output ends in a
  // terminator because Fish needs it for final intonation.
  test('the pipecat markdown chain: fences, code, emphasis, headers, quotes', () => {
    expect(stripSpeechText('**تمام** و _حسناً_')).toBe('تمام و حسنا.');
    expect(stripSpeechText('`npm run build` يعمل')).toBe('npm run build يعمل.');
    expect(stripSpeechText('```ts\nconst x = 1;\n```\nتمت')).toBe('تمت.');
    expect(stripSpeechText('## النتيجة\nنعم')).toBe('النتيجة\nنعم.');
    expect(stripSpeechText('> اقتباس\nرد')).toBe('اقتباس\nرد.');
    expect(stripSpeechText('***مهم***')).toBe('مهم.');
    expect(stripSpeechText('__قوي__')).toBe('قوي.');
  });

  test('preserves link labels but drops the URL itself', () => {
    expect(stripSpeechText('اقرأ [التوثيق](https://example.com/x) الآن')).toBe('اقرأ التوثيق الآن.');
    expect(stripSpeechText('افتح https://example.com/very/long?a=1&b=2 اليوم')).toBe('افتح اليوم.');
  });

  test('strips list bullets but keeps the words', () => {
    expect(stripSpeechText('- الخطوة\n- الثانية')).toBe('الخطوة\nالثانية.');
    expect(stripSpeechText('1. أول\n2) ثاني')).toBe('أول\nثاني.');
  });

  test('strips emoji, pictographs, ZWJ and variation selectors', () => {
    expect(stripSpeechText('تم 🎉✅ 👍🏽 الآن')).toBe('تم الآن.');
    // ZWJ family sequence: each pictograph is stripped and the joiner vanishes
    // with them, so no gap is left behind.
    expect(stripSpeechText('عائلة 👨‍👩‍👧‍👦 هنية')).toBe('عائلة هنية.');
    // Flag: two regional indicators.
    expect(stripSpeechText('مؤجل 🇸🇦 الآن')).toBe('مؤجل الآن.');
  });

  test('does not mangle snake_case identifiers', () => {
    // A lone underscore is not emphasis. Mangling identifiers would corrupt
    // every file name the assistant says out loud.
    expect(stripSpeechText('الوسيط family_time يعمل')).toBe('الوسيط family_time يعمل.');
  });

  test('strips Arabic tashkil and tatweel (orthography, not phonemes)', () => {
    expect(stripSpeechText('مُحَمَّد')).toBe('محمد.');
    expect(stripSpeechText('كتـــاب')).toBe('كتاب.');
  });

  test('does NOT fold Arabic letter variants — folding mispronounces MSA', () => {
    // ى is alef maksura: correct in "على" MSA, and folding it to ي yields
    // "علي" (Egyptian). آ carries a real madda in "آمن". أ is a distinct
    // phoneme in "أرد". Under-normalising is safe; over-normalising invents a
    // dialect. Deliberately not implemented.
    expect(stripSpeechText('على')).toContain('ى');
    expect(stripSpeechText('آمن')).toContain('آ');
    expect(stripSpeechText('أرد')).toContain('أ');
  });

  test('strips bidi control characters', () => {
    expect(stripSpeechText('سلام‏عليكم‎')).toBe('سلامعليكم.');
  });

  test('guarantees terminal punctuation for final intonation', () => {
    expect(stripSpeechText('تمام')).toBe('تمام.');
    expect(stripSpeechText('هل انتهى؟')).toBe('هل انتهى؟');
    expect(stripSpeechText('نعم!')).toBe('نعم!');
  });

  test('leaves no floating space before a terminator after a removal', () => {
    // The regression this pins: removing a trailing emoji or a diacritic used
    // to leave "تمام ." — a pause the engine reads as hesitation.
    expect(stripSpeechText('تمام 🎉.')).toBe('تمام.');
    expect(stripSpeechText('تم ICC ✅؟')).toBe('تم ICC؟');
  });

  test('trims leading conversational fillers from each sentence', () => {
    expect(stripSpeechText('يعني السؤال واضح')).toBe('السؤال واضح.');
    expect(stripSpeechText('طيب، نفتحها')).toBe('نفتحها.');
    // A bare "تمام" is a legitimate answer, not a filler — it must survive.
    expect(stripSpeechText('تمام')).toBe('تمام.');
  });

  test('collapses runaway whitespace', () => {
    // `أهلاً` carries a tanween, so it normalises to `أهلا`.
    expect(stripSpeechText('  \n\n  أهلاً   بك  \n ')).toBe('أهلا بك.');
  });

  test('is a no-op on clean prose', () => {
    const clean = 'سأفتح لوحة الجلسات الآن، وأعرض آخر عشر.';
    expect(stripSpeechText(clean)).toBe(clean);
  });

  test('THE CONTRACT: no spoken word is ever lost', () => {
    // Decoration only — code blocks and URLs/paths drop their content by
    // design (see the exception test below), so they are not in this set.
    const inputs = [
      '**مرحبا** بك في _المشروع_ 🎉',
      'ثم `-flag` و `value`',
      '### عنوان\n- عنصر\nنص',
      'علي ّ ـــه مُدَرس',
      '> اقتباس\n**رد**',
    ];
    for (const input of inputs) {
      expect(spokenTokens(stripSpeechText(input))).toEqual(spokenTokens(input));
    }
  });

  test('DOCUMENTED EXCEPTION: code, URLs and paths are dropped, not spoken', () => {
    // None of these have a spoken form — code and URLs are exactly the
    // garbling we are removing. Asserted so nobody "fixes" them back.
    expect(stripSpeechText('```\nconst secret = 1;\n```\nتمت')).toBe('تمت.');
    expect(stripSpeechText('اقرأ https://example.com/a/b')).toBe('اقرأ.');
    expect(stripSpeechText('افتح src/voice/tts.ts')).toBe('افتح.');
  });

  test('is idempotent', () => {
    const once = stripSpeechText('**تمام** 🎉 إذاً `x`');
    expect(stripSpeechText(once)).toBe(once);
  });

  test('punctuation-only or symbol-only input yields empty (never synthesized)', () => {
    expect(stripSpeechText('--- *** ``` 🎉 👋')).toBe('');
    expect(stripSpeechText('   \n\n ')).toBe('');
    expect(isSpeakable('--- *** 🎉')).toBe(false);
    expect(isSpeakable('تمام')).toBe(true);
  });

  test('exposes its filler list for review', () => {
    expect(SPEECH_FILLERS.length).toBeGreaterThan(0);
  });
});

// L9 — the Fish fetch had no timeout, so a hung socket wedged the utterance
// and the speech phase forever. brain.ts already uses this exact idiom
// (`fetchImpl` + AbortController); the transport now matches it.
describe('fetchWithTimeout (L9)', () => {
  test('aborts a hung request and throws a typed, distinguishable error', async () => {
    const hung = new Promise<Response>(() => undefined);
    const started = Date.now();
    await expect(fetchWithTimeout('https://x', {}, 120, () => hung)).rejects.toBeInstanceOf(TtsTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('passes an abort signal to the underlying fetch', async () => {
    let seen: AbortSignal | undefined;
    const spy = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen = init?.signal ?? undefined;
      return Promise.reject(new Error('stop here'));
    };
    await expect(fetchWithTimeout('https://x', {}, 5000, spy)).rejects.toThrow('stop here');
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  test('returns the response when it resolves inside the budget', async () => {
    const ok = new Response('body', { status: 200 });
    const res = await fetchWithTimeout('https://x', {}, 5000, () => Promise.resolve(ok));
    expect(res.status).toBe(200);
  });

  test('clears its timer on success so the process is not held open', async () => {
    // A leaked timer keeps the event loop alive; assert it is disarmed.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await fetchWithTimeout('https://x', {}, 60_000, () => Promise.resolve(new Response('')));
    await new Promise((r) => setTimeout(r, 10));
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(after).toBeLessThanOrEqual(before);
  });

  test('the transport passes a signal, so a hung synthesis cannot wedge a turn', async () => {
    const captured: Array<AbortSignal | null | undefined> = [];
    const ring = {
      acquire: () => ({ material: new Uint8Array([1]) }),
      release: () => undefined,
    } as unknown as Parameters<typeof FishHttpTransport>[0];
    const transport = new FishHttpTransport(ring, 'https://fish.invalid', {
      fetchImpl: (_u, init) => {
        captured.push(init?.signal);
        return Promise.reject(new Error('network down'));
      },
      timeoutMs: 1234,
    });
    await expect(transport.synthesize('مرحبا', 'ref')).rejects.toThrow('network down');
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toBeInstanceOf(AbortSignal);
  });

  test('FishHttpTransport default timeout is bounded', () => {
    expect(FISH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FISH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('Fish request policy (D3)', () => {
  test('speaks calmly: quality latency, slower pace, negative dB volume', () => {
    const body = fishRequestBody('مرحبا', 'ref-1');
    // latency 'balanced' trades quality for latency (docs: "normal: best
    // quality, balanced: reduced latency") — the wrong trade for a dignified
    // voice that was reported as shouting.
    expect(body.latency).toBe('normal');
    expect(body.chunk_length).toBe(300);
    expect(body.prosody).toEqual({ speed: 0.95, volume: -2, normalize_loudness: true });
    expect((body.prosody as { volume: number }).volume).toBeLessThan(0);
  });

  test('penalises repetition at the source', () => {
    // Docs: "Penalty for repeating audio patterns. Values above 1.0 reduce
    // repetition." The reported symptom was repeated words.
    expect(fishRequestBody('مرحبا', 'ref-1').repetition_penalty).toBeGreaterThan(1);
  });

  test('lowers expressiveness for a consistent, calm delivery', () => {
    // Docs: temperature "Controls expressiveness"; lower is more consistent.
    expect(fishRequestBody('مرحبا', 'ref-1').temperature).toBeLessThan(0.7);
  });

  test('KEEPS normalize:true — it normalises TEXT, not audio', () => {
    // Correcting the audit: the schema defines this as text normalisation for
    // number stability. It was never the loudness control that was blamed.
    expect(fishRequestBody('مرحبا', 'ref-1').normalize).toBe(true);
  });

  test('keeps voice consistency across chunks', () => {
    expect(fishRequestBody('مرحبا', 'ref-1').condition_on_previous_chunks).toBe(true);
  });

  test('carries the sanitised text and the reference voice', () => {
    const body = fishRequestBody('  **مرحبا**  ', 'ref-1');
    expect(body.text).toBe('مرحبا.');
    expect(body.reference_id).toBe('ref-1');
    expect(body.format).toBe('mp3');
  });
});

// L2 — speakSentences accumulated every sentence's audio into one blob to build
// a single cache entry, so peak memory equalled the whole reply with no ceiling.
describe('TtsEngine cache ceiling (L2)', () => {
  const cfg = {
    dir: 'C:/Users/omarb/AppData/Local/Temp/opencode/tts-l2-cache',
    maxEntries: 50,
    maxBytes: 1_000_000,
    maxEntryBytes: 500_000,
  };

  test('an over-long reply is not cached whole, and says so', async () => {
    const transport: FishTransport = {
      synthesize: async () => new TextEncoder().encode('x'.repeat(4096)),
    };
    const engine = new TtsEngine(cfg, transport, { play: async () => ({ startedMs: 0 }) });
    // Four 4 KB sentences = 16 KB of audio, under a 4 KB ceiling.
    const res = await engine.speakSentences('أ. ب. ج. د.', 'male-default' as VoiceId);
    expect(res.sentences).toBe(4);
    // No exception, no unbounded blob: the oversized entry is simply skipped.
    expect(res.cacheHit).toBe(false);
  });

  test('a normal reply is still cached, so the fast path is not lost', async () => {
    const transport: FishTransport = {
      synthesize: async (text: string) => new TextEncoder().encode(text),
    };
    const engine = new TtsEngine(cfg, transport, { play: async () => ({ startedMs: 0 }) });
    await engine.speakSentences('تمام.', 'male-default' as VoiceId);
    const second = await engine.speakSentences('تمام.', 'male-default' as VoiceId);
    expect(second.cacheHit).toBe(true);
  });

  test('SPEECH_CACHE_MAX_ENTRY_BYTES is a sane, explicit ceiling', () => {
    expect(SPEECH_CACHE_MAX_ENTRY_BYTES).toBeGreaterThan(0);
    expect(SPEECH_CACHE_MAX_ENTRY_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

// L3 — FileAudioOut wrote an MP3 to %TEMP% per reply and nothing ever pruned it.
describe('FileAudioOut pruning (L3)', () => {
  test('prunes old files and leaves recent ones', () => {
    const dir = 'C:/Users/omarb/AppData/Local/Temp/opencode/tts-l3-sweep';
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.mp3');
    const fresh = path.join(dir, 'fresh.mp3');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));

    const removed = sweepOldPlaybackFiles(dir, 5 * 60_000, now);

    expect(removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing directory is not an error', () => {
    expect(sweepOldPlaybackFiles('C:/Users/omarb/AppData/Local/Temp/opencode/tts-l3-absent', 60_000, Date.now())).toBe(0);
  });

  test('the default retention is bounded', () => {
    expect(PLAYBACK_RETENTION_MS).toBeGreaterThan(0);
    expect(PLAYBACK_RETENTION_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe('TtsEngine sanitisation (D2 integration)', () => {
  const cfg = {
    dir: 'C:/Users/omarb/AppData/Local/Temp/opencode/tts-d2-cache',
    maxEntries: 10,
    maxBytes: 1_000_000,
    maxEntryBytes: 500_000,
  };

  test('speakSentences never sends markdown to the transport', async () => {
    const requested: string[] = [];
    const transport: FishTransport = {
      synthesize: async (text: string) => {
        requested.push(text);
        return new TextEncoder().encode(text);
      },
    };
    const engine = new TtsEngine(cfg, transport, { play: async () => ({ startedMs: 0 }) });
    await engine.speakSentences('**تمام** 🎉. `git status` نظيف.', 'male-default' as VoiceId);
    expect(requested).toEqual(['تمام.', 'git status نظيف.']);
  });

  test('speak returns without synthesizing when nothing is speakable', async () => {
    let called = 0;
    const transport: FishTransport = {
      synthesize: async (text: string) => {
        called += 1;
        return new TextEncoder().encode(text);
      },
    };
    const engine = new TtsEngine(cfg, transport, { play: async () => ({ startedMs: 0 }) });
    const res = await engine.speakSentences('--- *** 🎉', 'male-default' as VoiceId);
    expect(called).toBe(0);
    expect(res.sentences).toBe(0);
  });
});
