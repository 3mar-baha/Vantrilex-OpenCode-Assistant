import { describe, expect, test } from 'vitest';
import { guardText, REFUSAL_AR, screenText } from './guard.js';
import { KAREEM, NOUR, PERSONAS, shieldHolds } from './personas.js';

// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/, verbatim.
// These 6 cases were dormant — vitest.config.ts includes only src/**/*.test.ts,
// so nothing under .opencode/_archive/ had run since v0.7.0. They are live again
// and, as of this commit, actually executed. The dialect is locked Ammani, and
// `REFUSAL_AR` was already Jordanian, so no string changed.
const LIST = ['BLOCKED_ALPHA', 'محظور_بيتا'];

describe('personas (Kareem/Nour)', () => {
  test('profiles are distinct in voice routing and tone', () => {
    expect(PERSONAS.kareem.id).toBe('kareem');
    expect(PERSONAS.nour.id).toBe('nour');
    expect(KAREEM.toneMarkers).toContain('يا غالي');
    expect(NOUR.toneMarkers).toContain('من عيوني');
    expect(KAREEM.shieldLexicon).not.toEqual(NOUR.shieldLexicon);
  });

  test('v1 shield: nour feminine self-reference holds, masculine drift fails', () => {
    expect(shieldHolds(NOUR, 'أنا جاهزة، شفت الملف')).toBe(true);
    expect(shieldHolds(NOUR, 'أنا جاهز، خلصت الشغل')).toBe(false);
    expect(shieldHolds(KAREEM, 'أنا جاهز، رتبت الأمور')).toBe(true);
    expect(shieldHolds(NOUR, 'كل التيستات خضرا')).toBe(true); // no self-claim
  });
});

describe('Tier-D guard', () => {
  test('blocklist hit blocks with reason; refusal string is Jordanian', () => {
    expect(screenText('هذا يحتوي BLOCKED_ALPHA هنا', LIST)).toEqual({ blocked: true, reason: 'blocklist' });
    expect(screenText('نص نظيف تماما', LIST)).toEqual({ blocked: false });
    expect(REFUSAL_AR).toContain('خلينا مركزين بشغلنا المفيد');
  });

  test('diacritic-evasive blocklist term still matches after normalization', () => {
    expect(screenText('كلمة محظُور_بيتَا هنا', LIST).blocked).toBe(true);
  });

  test('neural backstop blocks when the screen passes but intent is destructive', async () => {
    const verdict = await guardText('clean words', LIST, async () => true);
    expect(verdict).toEqual({ blocked: true, reason: 'neural' });
  });

  test('neural failure never blocks by itself (fail-open speech, FR-12 owns risk)', async () => {
    const verdict = await guardText('clean words', LIST, async () => {
      throw new Error('model down');
    });
    expect(verdict).toEqual({ blocked: false });
  });
});

describe('locked dialect: Ammani / White Jordanian', () => {
  test('both personas carry the locked constructions', () => {
    // Kareem: direct, confident. Nour: calm, precise inquiry.
    expect(KAREEM.toneMarkers).toContain('يا غالي');
    expect(KAREEM.toneMarkers).toContain('هسا بنرتبها');
    expect(NOUR.toneMarkers).toContain('تمام، بس للتأكيد');
  });

  test('no stiff newsreader MSA and no Beirusi in the tone markers', () => {
    // MSA newsreader tells ("حاضر، سأقوم بتنفيذ") and Beirusi markers are both
    // excluded by the live brain prompt (brain.ts:108).
    const all = [...KAREEM.toneMarkers, ...NOUR.toneMarkers];
    for (const marker of all) {
      expect(marker).not.toMatch(/سأقوم|حاضر،|سأقوم بتنفيذ/);
      expect(marker).not.toMatch(/هلق|شو|كيفك/); // Beirut: now / what / how-are-you
    }
  });
});
