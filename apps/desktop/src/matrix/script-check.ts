// C.7 dialect check, Phase 1 — renderer-pure, zero I/O, zero daemon surface.
//
// WHAT IT CATCHES: Latin echo. Something downstream of the voice loop came
// back in Latin script — a model reply, a UI string, an identifier, a path.
// That is the one dialect failure a renderer can see with certainty, because
// the transcript is right there in a frame.
//
// WHAT IT DELIBERATELY DOES NOT CATCH, and this is the important half: STT
// pins `language:'ar'` (`stt.ts:93`), so English audio comes back as
// ARABIC-SCRIPT GIBBERISH. That is the COMMON failure, and it is invisible
// here — Arabic script looks exactly like a correct Arabic reply, and no frame
// carries the language Whisper actually heard. Any copy implying this function
// "detects the wrong dialect" would be claiming a measurement nobody took. The
// SPECULATIVE phase-2 path (capture `res.language` from Groq `verbose_json`,
// which needs one recorded live call in `10-CHECKPOINT.md` before it is real)
// is deliberately NOT built here: it is a daemon change and this item is
// renderer-pure.
//
// The rule is the roadmap's: Latin >= 60% AND Arabic presence ~0.
//
// THE DIGIT DECISION, stated rather than left implicit: digits are excluded
// from BOTH the numerator and the denominator, for every numeral form.
// Measured: `4` is `\p{Nd}` but NOT `\p{sc=Latin}`; `٤` is `\p{Nd}` AND
// `\p{sc=Arabic}`. So "Latin digits" is not a real category — ASCII digits are
// not Latin script, and Arabic-Indic digits are not Arabic *letters*. The naive
// `\p{sc=Latin}` test misfiles the first; the naive `\p{sc=Arabic}` test
// misfiles the second. Neither is a dialect signal: an Arabic speaker writes
// `4096` inside an Arabic sentence all day, which is precisely why the roadmap
// names `افتح المنفذ 4096` as a must-not-trip. The `\p{Nd}` test therefore runs
// FIRST, before either script test, and a digit is neutral in both directions.
//
// Which is also why the script tests are anchored per code point instead of
// using an intersection. V8 has no set intersection in a character class:
// `/[\p{Nd}&&\p{sc=Latin}]/u` parses as the UNION `{Nd} ∪ {&} ∪ {Latin}` and
// says nothing. Measured, it matches `4`, `٤` and `&` — every one of which the
// intended intersection rejects. A class that silently answers a different
// question than it reads like is worse than a slow loop, so `^…$` it is.
//
// Everything else non-whitespace counts in the denominator, including symbols
// and scripts that are neither Latin nor Arabic (Cyrillic, Hebrew, CJK).
// Excluding them would let `abcЖДЕ` read as 100% Latin and defeat the point.
//
// Comparisons are INTEGER, not floating point: `latin / total >= 0.6` is
// `0.6`, a value with no exact binary representation, so the exactly-60% case
// is decided by the nearest double rather than by the rule. `latin * 10 >= 6 *
// total` is exact and has no off-by-one. A boundary that rounds is a boundary
// that rots.

/** Latin share at or above which the text counts as a Latin echo. 60%, per the roadmap. */
export const LATIN_ECHO_PERCENT = 60;
/**
 * Arabic share at or above which the text is treated as Arabic and the check
 * stops. "Arabic ~0" in the roadmap is approximate, and this is the number:
 * strict `arabic === 0` would false-positive on `ا npm install`, which is an
 * Arabic utterance, not a Latin echo.
 */
export const ARABIC_PRESENCE_PERCENT = 10;
/**
 * Minimum letters (any script) before the check can fire. Below this the ratio
 * is noise: `ok` is 100% Latin and means nothing, and a 1-2 character
 * fragment cannot support a warning the user would know what to do about.
 */
export const MIN_LETTERS = 4;

const LATIN_LETTER = /^\p{sc=Latin}$/u;
const ARABIC_LETTER = /^\p{sc=Arabic}$/u;
// Must be tested BEFORE either script test: `٤` matches both \p{Nd} and
// \p{sc=Arabic}, and `4` matches \p{Nd} while being neither Latin nor Arabic.
const DIGIT = /^\p{Nd}$/u;
const WHITESPACE = /\s/u;

/**
 * Does this text look like a Latin-script echo rather than an Arabic utterance?
 *
 * Never throws and never returns true for empty, whitespace-only,
 * punctuation-only or digit-only input.
 *
 * @param text transcript or UI string; a non-string is treated as absent.
 */
export function looksNonArabic(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;

  let latin = 0;
  let arabic = 0;
  let total = 0;

  for (const ch of text) {
    if (WHITESPACE.test(ch)) continue;
    if (DIGIT.test(ch)) continue; // neutral — see the digit decision above
    total += 1;
    if (LATIN_LETTER.test(ch)) latin += 1;
    else if (ARABIC_LETTER.test(ch)) arabic += 1;
  }

  if (total < MIN_LETTERS) return false;
  // Latin share at or above 60%, in exact integer arithmetic (see the note
  // above on why this is not a `/` comparison).
  if (latin * 100 < LATIN_ECHO_PERCENT * total) return false;
  // Any real Arabic share disqualifies it.
  if (arabic * 100 >= ARABIC_PRESENCE_PERCENT * total) return false;
  return true;
}
