import { describe, expect, test } from 'vitest';
import { guardText, REFUSAL_AR, screenText } from './guard.js';
import { KAREEM, NOUR, PERSONAS, shieldHolds } from './personas.js';

// Synthetic blocklist tokens only — real Tier-D lists stay out of the repo.
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
