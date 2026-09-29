import { describe, expect, test } from 'vitest';
import { NARRATOR_SYSTEM, narrate, type NarratorChat, type NarratorPersona } from './narrator.js';
import { KAREEM, NOUR, PERSONA_DIRECTIVES } from '../knowledge/personas.js';
import type { PersonaId } from '../common/brands.js';

// Persona wiring (docs/personas/WIRING.md §4). Each guard below was verified by
// BREAKING it before being accepted — a guard never observed failing is a
// comment, not a guard. The break transcripts are recorded in the commit.

const CTX = { action: 'switch-model', outcome: 'ok' as const, target: 'inkling' };

/** Captures the system string the narrator hands to the model. */
function spyChat(reply = '{"reply_ar":"تمام"}'): { chat: NarratorChat; seen: string[] } {
  const seen: string[] = [];
  const chat: NarratorChat = (_m, system) => {
    seen.push(system);
    return Promise.resolve(reply);
  };
  return { chat, seen };
}

const p = (id: PersonaId): NarratorPersona => ({ id, directive: PERSONA_DIRECTIVES[id] });

describe('persona directives (narrator seam)', () => {
  test('omitting the persona is byte-identical to pre-wiring behaviour', () => {
    // Proves the change is ADDITIVE. If this ever needs updating, the seam has
    // quietly changed what an unconfigured narrator does.
    const { chat, seen } = spyChat();
    return narrate(CTX, chat, 'm', 20).then(() => {
      expect(seen[0]).toBe(NARRATOR_SYSTEM.replace('{max}', '20'));
    });
  });

  test('NARRATOR_SYSTEM is PREPENDED, never substituted', () => {
    // A directive must not be able to delete a safety constraint. If the system
    // prompt with a persona did not CONTAIN NARRATOR_SYSTEM verbatim, the seam
    // would be allowing style to overrule the contract.
    const { chat, seen } = spyChat();
    return narrate(CTX, chat, 'm', 20, p('nour')).then(() => {
      expect(seen[0]).toContain(NARRATOR_SYSTEM.replace('{max}', '20'));
      expect(seen[0]!.startsWith(NOUR.directive)).toBe(true);
    });
  });

  test('the two personas produce DIFFERENT system strings', () => {
    // The whole point. Before wiring, both produced the identical string, which
    // is why selecting Nour or Kareem changed only the voice.
    const a = spyChat();
    const b = spyChat();
    return Promise.all([
      narrate(CTX, a.chat, 'm', 20, p('kareem')),
      narrate(CTX, b.chat, 'm', 20, p('nour')),
    ]).then(() => {
      expect(a.seen[0]).not.toBe(b.seen[0]);
      expect(a.seen[0]).toContain(KAREEM.directive);
      expect(b.seen[0]).toContain(NOUR.directive);
    });
  });

  test('a persona cannot raise the word cap or the char ceiling', () => {
    const { chat, seen } = spyChat();
    // The cap lives in the prompt text; the hard ceiling in MAX_CHARS. Neither is
    // reachable from a directive, and this asserts the prompt still states it.
    return narrate(CTX, chat, 'm', 20, p('kareem')).then(() => {
      expect(seen[0]).toContain('20');
      expect(seen[0]).toMatch(/20\s*كلمة/);
    });
  });

  test('a persona cannot reintroduce the canned-confirmation ban', () => {
    const { chat, seen } = spyChat();
    return narrate(CTX, chat, 'm', 20, p('nour')).then(() => {
      // The ban is an explicit prohibition in NARRATOR_SYSTEM. It must survive.
      expect(seen[0]).toMatch(/تم تنفيذ الأمر بنجاح/);
    });
  });

  test('every PersonaId has a non-empty directive', () => {
    const ids: PersonaId[] = ['kareem', 'nour'];
    for (const id of ids) {
      expect(PERSONA_DIRECTIVES[id]).toBeTruthy();
      expect(PERSONA_DIRECTIVES[id].length).toBeGreaterThan(20);
    }
    // No persona may be registered without one, or the narrator would silently
    // fall back to no style.
    expect(Object.keys(PERSONA_DIRECTIVES).sort()).toEqual(['kareem', 'nour']);
  });

  test('directives are Arabic-only, with English technical terms preserved', () => {
    // The narrator's whole output is {"reply_ar": "..."}. An English directive
    // would be token cost and a consistency risk for no audible benefit.
    for (const id of ['kareem', 'nour'] as const) {
      const d = PERSONA_DIRECTIVES[id];
      expect(d).toMatch(/[\u0600-\u06FF]/);
      // It must not drift into being a paragraph of English instructions.
      const letters = d.replace(/[^\p{L}]/gu, '');
      const arabic = (letters.match(/[\u0600-\u06FF]/g) ?? []).length;
      expect(arabic / letters.length).toBeGreaterThan(0.9);
    }
  });

  test('neither directive violates the destructive-action rule', () => {
    // Both personas must still be told to confirm first. A persona that could
    // talk its way past confirmation would be a safety regression, not a style
    // one, so it is asserted here rather than trusted to the prompt text.
    for (const id of ['kareem', 'nour'] as const) {
      expect(PERSONA_DIRECTIVES[id]).toMatch(/اسأل قبل أي عملية خطرة/);
    }
  });

  test('the narrator does not import the persona registry', async () => {
    // Structural, and asserted against the actual source rather than a comment:
    // the narrator must receive a directive STRING, not look one up. If it
    // imported the registry, rewording a dossier for a human reader would
    // silently change what the assistant says.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/orchestrator/narrator.ts', 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    expect(imports.some((i) => i.includes('knowledge/'))).toBe(false);
    // It may still take the PersonaId TYPE from common/brands - a type-only
    // import erases at runtime, so this is not a registry dependency.
    expect(imports.some((i) => i.includes('common/brands'))).toBe(true);
  });
});
