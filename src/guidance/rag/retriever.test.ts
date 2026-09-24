import { describe, expect, test } from 'vitest';
import { InMemoryRetriever } from './retriever.js';
import type { RagChunk } from './retriever.js';

// G4D — BM25 retrieval over Levantine fixtures. Chunk texts mirror the shapes
// inspected in arabic-agent-eval (data/levantine.jsonl); ids and fixtures are
// authored here, not copied.
const CHUNKS: RagChunk[] = [
  { id: 'lev-taxi', persona: 'kareem', source: 'joda', text: 'بدي احجز تكسي من المطار للفندق' },
  { id: 'lev-time', persona: 'kareem', source: 'joda', text: 'قديش الوقت هلا بطوكيو' },
  { id: 'lev-job', persona: 'kareem', source: 'joda', text: 'بدي فتش عن شغل مبرمج بعمان عن بعد' },
  { id: 'lev-mosque', persona: 'nour', source: 'madar', text: 'يا زلمة وين اقرب مسجد من هون بدي اعرف مواعيد الصلاة' },
  { id: 'shared-reason', persona: 'shared', source: 'cidar', text: 'اشرح الفرق بين الاستدعاء البسيط والاستدعاء متعدد الخطوات' },
];

describe('InMemoryRetriever (BM25)', () => {
  test('levantine taxi query retrieves the taxi chunk first', () => {
    const r = new InMemoryRetriever(CHUNKS);
    const hits = r.search('احجز تكسي للمطار', 3);
    expect(hits[0]!.id).toBe('lev-taxi');
  });

  test('persona filter scopes to kareem + shared', () => {
    const r = new InMemoryRetriever(CHUNKS);
    const hits = r.search('مواعيد الصلاة', 5, ['kareem']);
    expect(hits.every((h) => h.persona === 'kareem' || h.persona === 'shared')).toBe(true);
    expect(hits.some((h) => h.persona === 'nour')).toBe(false);
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
});
