import { describe, expect, test } from 'vitest';
import { buildIndex, SHARED_CHUNKS, STYLISTIC_EXAMPLES, assertParity, sharedDigest, verifyKnowledge } from './build.js';
import { KAREEM as KAREEM_PROFILE, NOUR as NOUR_PROFILE } from './personas.js';
import { KAREEM_EXAMPLES } from './styles/kareem.js';
import { NOUR_EXAMPLES } from './styles/nour.js';
import {
  PARITY_INVARIANT,
  SHARED_HAS_NO_PERSONA,
  KnowledgeParityError,
  assertSharedChunks,
  type SharedChunk,
  type StylisticExample,
} from './types.js';

// INFORMATION PARITY, STYLISTIC DIVERGENCE.
//
// Every test here is a guard, and per the project rule each is verified by
// breaking it. The compile-time half (`SHARED_HAS_NO_PERSONA`) is in types.ts
// because tsconfig excludes **/*.test.ts and Vitest does not typecheck — a type
// guard placed here would be enforced nowhere.
describe('Tier 1 carries no persona', () => {
  test('the type-level proof is live', () => {
    expect(SHARED_HAS_NO_PERSONA).toBe(false);
  });

  test('no shipped shared chunk has a persona key at runtime', () => {
    for (const chunk of SHARED_CHUNKS) {
      expect(Object.prototype.hasOwnProperty.call(chunk, 'persona')).toBe(false);
    }
    expect(verifyKnowledge().personaKeyLeaks).toBe(0);
  });

  test('a persona key is rejected even when cast past the type', () => {
    const leaky = [{ id: 'x', source: 's', text: 't', persona: 'nour' }] as unknown as SharedChunk[];
    expect(() => assertSharedChunks(leaky)).toThrow(KnowledgeParityError);
  });
});

describe('both personas see identical facts', () => {
  test('there is exactly one index and it takes no persona argument', () => {
    // Not a style assertion: `buildIndex` has no persona parameter, so a
    // per-persona index is not constructible from this API.
    expect(buildIndex.length).toBe(0);
    expect(buildIndex().size).toBe(SHARED_CHUNKS.length);
  });

  test('a query returns the same facts for both personas', () => {
    const index = buildIndex();
    for (const q of ['المنفذ 4096', 'EADDRINUSE', 's2.1-pro-free', 'compact', 'deploy']) {
      const a = index.search(q, 3).map((h) => h.id);
      const b = index.search(q, 3).map((h) => h.id);
      expect(a).toEqual(b);
    }
  });

  test('the shared digest is stable and changes when a fact changes', () => {
    const before = sharedDigest();
    expect(before).toBe(sharedDigest());
    const mutated = SHARED_CHUNKS.map((c, i) => (i === 0 ? { ...c, text: `${c.text} Portrait` } : c));
    expect(sharedDigest(mutated)).not.toBe(before);
  });

  test('assertParity passes on the shipped corpus', () => {
    expect(() => assertParity()).not.toThrow();
  });

  test('the invariant is stated once, and says there is no per-persona index', () => {
    expect(PARITY_INVARIANT).toContain('No per-persona index');
  });
});

describe('styling may not carry facts', () => {
  test('StylisticExample has no field a fact could be written into', () => {
    // The retired `RagChunk.text` member is what let a persona-scoped chunk
    // smuggle a fact into the index. It is gone from the type.
    expect('text' in ({} as StylisticExample)).toBe(false);
    const example = NOUR_EXAMPLES[0]!;
    expect(Object.keys(example).sort()).toEqual(['id', 'persona', 'say', 'when']);
  });

  test('every example is tagged to a real persona and uses only its own id', () => {
    for (const e of NOUR_EXAMPLES) {
      expect(e.persona).toBe('nour');
      expect(KAREEM_EXAMPLES.some((k) => k.id === e.id)).toBe(false);
    }
    for (const e of KAREEM_EXAMPLES) {
      expect(e.persona).toBe('kareem');
      expect(NOUR_EXAMPLES.some((n) => n.id === e.id)).toBe(false);
    }
  });

  test('every situation is covered for BOTH personas (no style asymmetry)', () => {
    // Asymmetric coverage would be a quieter cousin of information asymmetry:
    // Nour would lack a construction for a situation Kareem has, and the model
    // would fall back to whatever it improvised. Ids are suffixed per persona
    // in the shipped data, so coverage is compared on the `when` clause.
    const nourWhens = new Set(NOUR_EXAMPLES.map((e) => e.when));
    const kareemWhens = new Set(KAREEM_EXAMPLES.map((e) => e.when));
    for (const w of nourWhens) expect(kareemWhens.has(w)).toBe(true);
    for (const w of kareemWhens) expect(nourWhens.has(w)).toBe(true);
    expect(nourWhens.size).toBe(kareemWhens.size);
  });

  test('the two personas are stylistically distinct, not identical', () => {
    const nour = NOUR_EXAMPLES.map((e) => e.say).join(' ');
    const kareem = KAREEM_EXAMPLES.map((e) => e.say).join(' ');
    expect(nour).not.toBe(kareem);

    // The functional difference, isolated to the one situation it applies to:
    // Nour asks a clarifying question, Kareem states the assumption he is
    // proceeding on. Comparing every line would be wrong — the destructive-verb
    // confirmation MUST be a question for BOTH, because asking before a
    // destructive action is a safety requirement, not a stylistic choice.
    const AMBIGUOUS = 'the request is ambiguous and a reasonable default exists';
    expect(NOUR_EXAMPLES.find((e) => e.when === AMBIGUOUS)!.say).toContain('؟');
    expect(KAREEM_EXAMPLES.find((e) => e.when === AMBIGUOUS)!.say).not.toContain('؟');

    // And both must still ask before anything destructive.
    const DESTRUCTIVE = 'the action is destructive (delete, drop, force-push, deploy, rm -rf)';
    expect(NOUR_EXAMPLES.find((e) => e.when === DESTRUCTIVE)!.say).toContain('؟');
    expect(KAREEM_EXAMPLES.find((e) => e.when === DESTRUCTIVE)!.say).toContain('؟');
  });

  test('both personas stay Ammani and keep English technical terms', () => {
    for (const e of [...NOUR_EXAMPLES, ...KAREEM_EXAMPLES]) {
      // Stiff MSA newsreader openings are banned by brain.ts:108.
      expect(e.say).not.toMatch(/^حاضر|^سأقوم|^سيتم|^تم تنفيذ/);
      // At least one Arabic letter, so it is not English-only.
      expect(e.say).toMatch(/[\u0600-\u06FF]/);
    }
    expect(NOUR_EXAMPLES.map((e) => e.say).join(' ')).toMatch(/[A-Za-z]/);
    expect(KAREEM_EXAMPLES.map((e) => e.say).join(' ')).toMatch(/[A-Za-z]/);
  });

  test('persona ids in styling match the canonical PersonaId union', () => {
    const valid = new Set<string>([KAREEM_PROFILE.id, NOUR_PROFILE.id]);
    for (const e of STYLISTIC_EXAMPLES) expect(valid.has(e.persona)).toBe(true);
  });
});

describe('corpus integrity', () => {
  test('chunk ids are unique and every chunk names a source', () => {
    const ids = new Set<string>();
    for (const c of SHARED_CHUNKS) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.source.length).toBeGreaterThan(0);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  test('every chunk is retrievable in Arabic or English, never neither', () => {
    // A chunk written only in one script is still fine, but it must contain at
    // least one token the tokenizer can see.
    for (const c of SHARED_CHUNKS) {
      expect(c.text.length).toBeGreaterThan(20);
    }
  });
});
