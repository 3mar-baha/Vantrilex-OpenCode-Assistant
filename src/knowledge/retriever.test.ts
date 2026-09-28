import { describe, expect, test } from 'vitest';
import { InMemoryRetriever } from './retriever.js';
import type { SharedChunk } from './types.js';

// RESTORED from .opencode/_archive/dead-code-phase1/src/guidance/rag/.
//
// 3 of the 4 original cases are kept with their fixtures intact. The fourth,
// "persona filter scopes to kareem + shared", is DELIBERATELY NOT RESTORED:
// its subject — filtering one index by persona — is exactly what the parity
// requirement eliminates. There is no `persona` member on `SharedChunk` to
// filter on and no second index, so the test is not merely failing, it is
// unrepresentable. The parity test that replaces it is in corpus.test.ts, and
// it asserts a stronger property than the original did.
//
// Fixtures keep their ids and text; `persona` keys are dropped because the type
// no longer has that field. Sources are synthetic/authored, not copied.
const CHUNKS: SharedChunk[] = [
  { id: 'lev-taxi', source: 'joda', text: 'بدي احجز تكسي من المطار للفندق' },
  { id: 'lev-time', source: 'joda', text: 'قديش الوقت هلا بطوكيو' },
  { id: 'lev-job', source: 'joda', text: 'بدي فتش عن شغل مبرمج بعمان عن بعد' },
  { id: 'lev-mosque', source: 'madar', text: 'يا زلمة وين اقرب مسجد من هون بدي اعرف مواعيد الصلاة' },
  { id: 'shared-reason', source: 'cidar', text: 'اشرح الفرق بين الاستدعاء البسيط والاستدعاء متعدد الخطوات' },
];

describe('InMemoryRetriever (BM25)', () => {
  test('levantine taxi query retrieves the taxi chunk first', () => {
    const r = new InMemoryRetriever(CHUNKS);
    const hits = r.search('احجز تكسي للمطار', 3);
    expect(hits[0]!.id).toBe('lev-taxi');
  });

  test('diacritic-evasive query still matches (normalizer in the path)', () => {
    const r = new InMemoryRetriever(CHUNKS);
    const hits = r.search('بِدّي أحجُز تَكسي', 3);
    expect(hits[0]!.id).toBe('lev-taxi');
  });

  test('topK bounds output; empty query returns nothing', () => {
    const r = new InMemoryRetriever(CHUNKS);
    expect(r.search('تكسي', 1)).toHaveLength(1);
    expect(r.search('', 5)).toHaveLength(0);
    expect(r.search('كلمة غير موجودة ابدا', 5)).toHaveLength(0);
  });

  test('topK of 0 or negative returns nothing rather than throwing', () => {
    const r = new InMemoryRetriever(CHUNKS);
    expect(r.search('تكسي', 0)).toHaveLength(0);
    expect(r.search('تكسي', -1)).toHaveLength(0);
  });

  test('an empty corpus returns nothing instead of dividing by zero', () => {
    const r = new InMemoryRetriever([]);
    expect(r.size).toBe(0);
    expect(r.search('تكسي', 5)).toHaveLength(0);
  });

  test('Latin identifiers match regardless of the case they were stored in', () => {
    // The fix the Arabic finding forced. Under the quarantined analyzer these
    // were two unrelated terms and this returned nothing.
    const chunks: SharedChunk[] = [
      { id: 'err', source: 'test', text: 'EADDRINUSE يعني المنفذ مشغول' },
      { id: 'port', source: 'test', text: 'المنفذ 4097 هو جسر الواجهة' },
    ];
    const r = new InMemoryRetriever(chunks);
    expect(r.search('eaddrinuse', 2)[0]!.id).toBe('err');
    expect(r.search('EADDRINUSE', 2)[0]!.id).toBe('err');
  });

  test('Arabic alef variants reach the same chunk', () => {
    // آ / أ / إ / ا must collapse, or Arabic recall silently degrades.
    const chunks: SharedChunk[] = [
      { id: 'a', source: 'test', text: 'آمنوا بالاختبارات' },
      { id: 'b', source: 'test', text: 'بنيت المشروع' },
    ];
    const r = new InMemoryRetriever(chunks);
    expect(r.search('امنوا', 2)[0]!.id).toBe('a');
    expect(r.search('آمنوا', 2)[0]!.id).toBe('a');
  });

  test('a persona key reaching Tier 1 is rejected at construction', () => {
    const leaky = [{ id: 'leak', source: 'test', text: 'حقيقة', persona: 'kareem' }] as unknown as SharedChunk[];
    expect(() => new InMemoryRetriever(leaky)).toThrow(/persona key/);
  });
});
