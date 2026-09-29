import { describe, expect, test } from 'vitest';
import { looksNonArabic } from './script-check.js';

// C.7 — dialect check, Phase 1 (renderer-pure). The roadmap scopes the copy to
// exactly one failure: LATIN ECHO. STT pins `language:'ar'`, so English audio
// comes back as Arabic-script gibberish — that is the *common* failure, and it
// is deliberately NOT what this detects, because nothing in the frame says
// which language Whisper actually heard. What survives as Latin is an
// identifier, a path or an error the model/UI echoed. Test 5 pins that
// exclusion so the claim cannot rot into "detects wrong dialect" by silence.
//
// The rule, straight from the roadmap: Latin >= 60% AND Arabic presence ~0.
// `افتح المنفذ 4096` must NOT trip — "any Latin -> bad" is wrong, because
// Arabic sentences carry ASCII numbers and English technical terms.
describe('looksNonArabic (C.7 — Latin echo only)', () => {
  test('a pure English echo trips', () => {
    // The canonical case: a model or UI message that came back in English.
    expect(looksNonArabic('Deployment failed on the remote host')).toBe(true);
    expect(looksNonArabic('EADDRINUSE')).toBe(true);
    // A pasted path is the other Latin echo this exists to catch.
    expect(looksNonArabic('C:\\Users\\omar\\AppData\\Voxaura\\vault')).toBe(true);
  });

  test('an Arabic sentence carrying an ASCII number does NOT trip', () => {
    // The roadmap's own example. `4096` is Latin-adjacent, the sentence is not.
    expect(looksNonArabic('افتح المنفذ 4096')).toBe(false);
    // Digits are not diluted away either: a number-heavy Arabic sentence is
    // still Arabic, and a digits-in-the-numerator rule would wrongly trip it.
    expect(looksNonArabic('افتح المنافذ 4096 4097 4098 4099 4095')).toBe(false);
  });

  test('a long Arabic sentence with a couple of English technical words does NOT trip', () => {
    expect(
      looksNonArabic(
        'هلق بفتح المنفذ 4097 وأشغّل npm run dev من مجلد src، بعدين أرسل prompt للـ opencode serve',
      ),
    ).toBe(false);
    // Short, and only ~50% Latin — must not trip even with a Latin plurality.
    expect(looksNonArabic('هلا npm')).toBe(false);
  });

  test('empty, whitespace and punctuation-only text does not trip and never throws', () => {
    expect(looksNonArabic('')).toBe(false);
    expect(looksNonArabic('   ')).toBe(false);
    expect(looksNonArabic('\t\n  \r\n')).toBe(false);
    expect(looksNonArabic('...!!!---???')).toBe(false);
    expect(looksNonArabic('4096 4097 4098')).toBe(false); // digits only
    expect(looksNonArabic('،؟؛')).toBe(false); // Arabic punctuation only
    // Defensive: the frame carries a runtime value, not a compile-time guarantee.
    for (const bad of [null, undefined, 0, 1, {}, [], true]) {
      expect(looksNonArabic(bad as unknown as string)).toBe(false);
    }
  });

  test('an Arabic-script gibberish string does NOT trip — the exclusion is pinned', () => {
    // Whisper with `language:'ar'` fed English audio: the COMMON failure, and
    // the one this function deliberately does not detect.
    expect(looksNonArabic('كسسرر فيبي ىلل ضصمم')).toBe(false);
    expect(looksNonArabic('تمام')).toBe(false);
  });

  test('boundary: exactly 60% Latin trips, just under does not', () => {
    // Cyrillic, not Arabic, is the filler on purpose: it occupies denominator
    // positions while leaving Arabic presence at 0, so these two isolate the
    // LATIN ratio from the second (Arabic-~0) condition. An Arabic filler
    // would be blocked by that condition and the boundary would pass
    // vacuously — the vacuous-boundary trap this repo keeps hitting.
    expect(looksNonArabic('abcЖД')).toBe(true); // 3 of 5 = 60.0%
    expect(looksNonArabic('abcЖДЕ')).toBe(false); // 3 of 6 = 50.0%
  });

  test('boundary: Arabic presence of exactly 10% blocks, just under does not', () => {
    // "Arabic ~0" is a floor, not an exact zero: one Arabic interjection
    // (`ا npm install`) is still an Arabic utterance, so a strict
    // `arabic === 0` would false-positive on the most common mixed shape.
    expect(looksNonArabic('abcdefghiم')).toBe(false); // 1/10 = 10.0% -> blocks
    expect(looksNonArabic('abcdefghijم')).toBe(true); // 1/11 = 9.1%  -> trips
  });

  test('a mostly-Latin string with one Arabic interjection still trips', () => {
    // The deliberate reading of the gap: ~92% English is a Latin echo even
    // though it is not a pure one. Pinned so the choice is visible, not implied.
    expect(looksNonArabic('ا npm install')).toBe(true);
  });

  test('digits are neutral in BOTH directions — adding one changes nothing', () => {
    // ASCII digits (`4`) and Arabic-Indic digits (`٤`) are `\p{Nd}`, and
    // `٤` is ALSO `\p{sc=Arabic}`. Counting them either way would move the
    // ratio, so they are excluded from numerator and denominator alike and
    // `abcЖД٤` must score exactly like `abcЖД`.
    expect(looksNonArabic('abcЖД٤')).toBe(looksNonArabic('abcЖД'));
    expect(looksNonArabic('abcЖД٤')).toBe(true);
    expect(looksNonArabic('abc٤ЖД')).toBe(true);
  });

  test('a Latin fragment below the letter floor does not trip', () => {
    // `ok` / `hi` are noise, not a dialect signal. The floor stops a 1-2 char
    // fragment from raising a warning the user cannot act on.
    expect(looksNonArabic('ok')).toBe(false);
    expect(looksNonArabic('a')).toBe(false);
    expect(looksNonArabic('okay')).toBe(true);
  });
});
