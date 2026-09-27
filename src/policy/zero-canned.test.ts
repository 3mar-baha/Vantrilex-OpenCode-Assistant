import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Phase 5 — ZERO CANNED REPLIES, enforced at the source level.
//
// A unit test on `narrate` proves the narrator does not template. This proves
// the CALL SITES do not either, which is where the actual defect lived: nine
// literals like 'تم تبديل النموذج' passed into `send()`.
//
// Deliberately a source scan rather than a runtime test: the failure mode is a
// hardcoded string in a file, and no runtime assertion can see a literal that
// only executes on a click nobody performs in CI.

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'apps/desktop/src'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'sidecar' || entry === 'target') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Canned confirmations the user called out, plus their close relatives. */
const BANNED = [
  'تم تنفيذ الأمر بنجاح',
  'تم تغيير النموذج',
  'تم تبديل النموذج',
  'تم تبديل الجلسة',
  'تم تعيين الوكيل',
  'تم تبديل الشخصية',
  'تم إيقاف التوليد',
  'تمت إعادة التوليد',
  'تم صمّ الميكروفون',
  'تم تشغيل الميكروفون',
  'تم كتم صوت المساعد',
  'تم تشغيل صوت المساعد',
];

/** Files where a match is a test assertion, not shipped behaviour. */
function isTestFile(f: string): boolean {
  return /\.test\.tsx?$/.test(f);
}

/**
 * Remove comments so a phrase quoted in a "this used to be here" note is not
 * mistaken for live behaviour. Block comments first (they can span lines),
 * then line comments.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * A banned phrase may legitimately appear inside a model prompt, where it is
 * named in order to be FORBIDDEN. That is the opposite of the defect. Such a
 * line must carry an explicit prohibition marker, so the allowance is narrow
 * and self-documenting rather than a blanket exemption.
 */
const PROHIBITION_MARKER = /forbid|forbidden|robotic|template|قالب|آلي|ممنوع|لا تستخدم|no "/i;

function productionFiles(): string[] {
  return SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => !isTestFile(f));
}

describe('zero canned replies (Phase 5)', () => {
  test('no production source contains a canned confirmation', () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      for (const [i, line] of lines.entries()) {
        for (const phrase of BANNED) {
          if (!line.includes(phrase)) continue;
          if (PROHIBITION_MARKER.test(line)) continue;
          offenders.push(`${file.replace(ROOT, '.')}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `canned confirmation(s) in production source:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('every remaining mention of a banned phrase is a prohibition, not an output', () => {
    // A guard on the guard: the allowance above must not become a hiding place.
    let mentions = 0;
    for (const file of productionFiles()) {
      for (const line of stripComments(readFileSync(file, 'utf8')).split('\n')) {
        if (BANNED.some((p) => line.includes(p))) {
          mentions += 1;
          expect(line, `non-prohibition mention: ${line.trim()}`).toMatch(PROHIBITION_MARKER);
        }
      }
    }
    // The prompts must actually say it, or the model is never told.
    expect(mentions).toBeGreaterThan(0);
  });

  test('the HUD send() takes no success message at all', () => {
    // The signature itself is the guarantee: there is no slot to put a template.
    const app = readFileSync(join(ROOT, 'apps/desktop/src/App.tsx'), 'utf8');
    const sig = app.match(/const send = \([^)]*\)/)?.[0] ?? '';
    expect(sig).toBeDefined();
    // Two parameters: the command and the failure text. No `ok` string.
    expect(sig.split(',').length).toBe(2);
    expect(sig).not.toMatch(/ok\s*:\s*string/);
  });

  test('the narrator module contains no template table', () => {
    const narrator = readFileSync(join(ROOT, 'src/orchestrator/narrator.ts'), 'utf8');
    // A canned line would live in a string array or a template literal map.
    expect(narrator).not.toMatch(/const\s+\w*(?:TEMPLATES|PHRASES|REPLIES|CANNED)\w*\s*=/i);
    // And the module must offer no fallback sentence for a failed call.
    expect(narrator).not.toMatch(/catch\s*\{[^}]*return\s+['"`]/);
  });

  test('every verbal line reaches the voice path only via the model', () => {
    // `setVoicePhase('speaking', ...)` is the only way text becomes speech.
    // Its transcript argument must come from a model result, not a literal.
    const daemon = readFileSync(join(ROOT, 'src/daemon.ts'), 'utf8');
    const calls = [...daemon.matchAll(/setVoicePhase\('speaking',\s*([^)]*)\)/g)].map((m) => m[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const arg of calls) {
      const isModelOutput = /line|text|utterance\.reply|transcript/.test(arg);
      const isLiteral = /^['"`]/.test(arg.trim());
      expect(isLiteral, `literal spoken line: ${arg}`).toBe(false);
      expect(isModelOutput, `unexpected spoken source: ${arg}`).toBe(true);
    }
  });

  test('no text input box was added to the HUD (voice-only invariant)', () => {
    // The mandate is explicit: zero text boxes. A regression here would be a
    // user-visible architectural violation, not a styling preference.
    const app = readFileSync(join(ROOT, 'apps/desktop/src/App.tsx'), 'utf8');
    expect(app).not.toMatch(/<input[^>]*type=["']text["']/i);
    expect(app).not.toMatch(/<textarea/i);
  });
});
