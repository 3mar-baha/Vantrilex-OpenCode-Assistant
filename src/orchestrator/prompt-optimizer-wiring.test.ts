import { describe, expect, test } from 'vitest';
import { isActionableInstruction, optimizePrompt } from './prompt-optimizer.js';

// `prompt-optimizer.ts` was written in "Phase 5" and documented as a shipped
// "prompt optimization seam". It was not: no module imported it.
//
// The wiring in daemon.ts adds one provider call per ACTIONABLE turn, so the
// cost control is `isActionableInstruction`. These tests pin the two properties
// that make that safe:
//
//   1. an acknowledgement must never become a task, or the assistant acts on
//      the user's politeness;
//   2. any failure must fall back to the USER'S OWN WORDS, never a template.
//
// Property 2 is what keeps this from reintroducing the canned-reply class of
// defect the project banned in Phase 5.

describe('acknowledgements are never turned into tasks', () => {
  const acknowledgements = [
    'تمام',
    'طيب',
    'اوك',
    'ماشي',
    'يسلمو',
    'يلا',
    'تماما',
    'حسنا',
    'جيد',
    'شكرا جزيلا',
  ];

  test('every pure acknowledgement is non-actionable', () => {
    for (const a of acknowledgements) expect(isActionableInstruction(a), a).toBe(false);
  });

  test('punctuation and whitespace do not smuggle one through', () => {
    for (const a of acknowledgements) {
      expect(isActionableInstruction(`  ${a}!  `), a).toBe(false);
      expect(isActionableInstruction(`${a}؟`), a).toBe(false);
    }
  });

  test('empty and punctuation-only input is non-actionable', () => {
    for (const empty of ['', '   ', '؟؟', '...', '!']) {
      expect(isActionableInstruction(empty), JSON.stringify(empty)).toBe(false);
    }
  });

  test('a real request IS actionable - the gate must not be a black hole', () => {
    for (const task of ['شوف ليش الـ build فشل', 'اقرا @README.md', 'run the tests', 'git status']) {
      expect(isActionableInstruction(task), task).toBe(true);
    }
  });
});

describe('failure falls back to the user\'s own words, never a template', () => {
  const original = 'شوف ليش الـ build فشل';

  test('a provider error returns the utterance unchanged', async () => {
    const out = await optimizePrompt(original, async () => {
      throw new Error('no keys');
    }, 'm/slug');
    // Identical, not a canned rewrite. This is the invariant that stops the
    // optimizer from becoming a second source of canned phrasing.
    expect(out).toBe(original);
  });

  test('an empty completion returns the utterance unchanged', async () => {
    expect(await optimizePrompt(original, async () => '   ', 'm/slug')).toBe(original);
  });

  test('a successful rewrite is returned', async () => {
    const brief = 'ROLE: Fix the build\nCONTEXT: CI red\nGOAL: identify the error\nCONSTRAINTS: none';
    expect(await optimizePrompt(original, async () => brief, 'm/slug')).toBe(brief);
  });

  test('a runaway rewrite is capped rather than dispatched whole', async () => {
    const out = await optimizePrompt(original, async () => 'x'.repeat(9000), 'm/slug');
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.length).toBeGreaterThan(0);
  });

  test('the fallback never contains a canned confirmation', async () => {
    for (const attempt of [async () => { throw new Error('x'); }, async () => '']) {
      const out = await optimizePrompt(original, attempt, 'm/slug');
      for (const banned of ['تم تنفيذ', 'تم تغيير', 'بنجاح']) expect(out).not.toContain(banned);
    }
  });
});
