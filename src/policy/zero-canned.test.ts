import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { UiCommandSchema } from '../ipc/protocol.js';

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
 * Blank comments — replace them with spaces of the SAME LENGTH, so every index
 * and every line number in the result still refers to the original file.
 *
 * Newline-preserving on purpose. The previous version deleted comment bodies
 * outright, which silently renumbered everything after a multi-line block
 * comment: the offender reports in the first test were `file:line` and could
 * point at the wrong line, and a line-numbered guard that reports the wrong
 * line is worse than one that reports none.
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/.*$/gm, blank);
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

/**
 * The renderer, for the send-path guard. Deliberately the WHOLE renderer and
 * not just `App.tsx`: the property being guarded is a property of the send path,
 * and `SettingsView.tsx` and `KeysView.tsx` call `sendCommand` too. Scanning one
 * file would have left two of the six call sites unchecked while the report read
 * as though the renderer were covered.
 */
const RENDERER_DIRS = ['apps/desktop/src'];

function rendererProductionFiles(): string[] {
  return RENDERER_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => !isTestFile(f));
}

/** Index of the character after the string literal that starts at `i`. */
function endOfString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    // A template literal's `${…}` can contain braces, so it is skipped as a
    // balanced region rather than scanned for the closing backtick. Without this
    // a `${` would let the brace counter see a `}` that closes nothing.
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        const inner = src[j];
        if (inner === '"' || inner === "'" || inner === '`') {
          j = endOfString(src, j);
          continue;
        }
        if (inner === '{') depth += 1;
        else if (inner === '}') depth -= 1;
        j += 1;
      }
      continue;
    }
    if (c === quote) return j + 1;
    j += 1;
  }
  return j;
}

/** Index just past the `}` matching the `{` at `open`. String-aware. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(src, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * Top-level keys of an object literal, INCLUDING the outer braces.
 *
 * Two filters, and both are needed — the first version of this had only the
 * first and reported `groq`, `fish` and `openrouter` as keys of the
 * `saveApiKeys` command, because `keys.groq,` ends with an identifier followed
 * by a comma. They are PROPERTY NAMES of a local variable, not wire fields.
 *
 *   1. DEPTH. A nested object contributes nothing:
 *      `{ id, kind: 'playbackStarted', ...(p !== undefined ? { playbackId } : {}) }`
 *      yields exactly `id` and `kind`. That nested `{ playbackId }` is a real
 *      call site in the tree today, and it is not a field the caller sends
 *      unconditionally.
 *   2. POSITION. An identifier is a key only when the previous significant
 *      character is `{`, `,`, or nothing — i.e. it starts a property. `keys`
 *      in `groqKey: keys.groq` is preceded by `:`, and `groq` by `.`; neither
 *      is a key.
 */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  /** Last significant (non-whitespace) character consumed. */
  let prev: string | undefined;
  let i = 0;
  while (i < literal.length) {
    const c = literal[i];
    if (c === undefined) break;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = endOfString(literal, i);
      prev = '"';
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth += 1;
      prev = c;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      prev = c;
      i += 1;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < literal.length && /[A-Za-z0-9_$]/.test(literal[j] ?? '')) j += 1;
      const word = literal.slice(i, j);
      let k = j;
      while (k < literal.length && /\s/.test(literal[k] ?? '')) k += 1;
      const atKeyPosition = prev === undefined || prev === '{' || prev === ',';
      // `key: v`, shorthand `{ key }` and a trailing `{ key }` are all keys;
      // `key(` is a method and `key` after `=` is a reference.
      if (atKeyPosition && (literal[k] === ':' || literal[k] === ',' || literal[k] === '}')) {
        keys.push(word);
      }
      prev = 'x';
      i = j;
      continue;
    }
    prev = c;
    i += 1;
  }
  return keys;
}

interface SendCallSite {
  readonly line: number;
  /** The object literal passed as the argument, or null if it is not inline. */
  readonly literal: string | null;
  readonly keys: readonly string[];
}

/**
 * Every `sendCommand(` CALL in `src`, distinguished from the method DECLARATION
 * of the same name in `bridge/ws.ts` by what precedes it: a call is reached
 * through `.` (or `?.`), a declaration stands alone at class-member indent.
 */
function sendCommandCallSites(src: string): SendCallSite[] {
  const out: SendCallSite[] = [];
  for (const m of src.matchAll(/\bsendCommand\(/g)) {
    const at = m.index ?? 0;
    let before = at - 1;
    while (before >= 0 && /\s/.test(src[before] ?? '')) before -= 1;
    if (src[before] !== '.') continue; // the bridge's own `sendCommand(cmd: …)`
    const open = src.indexOf('(', at);
    let arg = open + 1;
    while (arg < src.length && /\s/.test(src[arg] ?? '')) arg += 1;
    const line = src.slice(0, at).split('\n').length;
    if (src[arg] !== '{') {
      out.push({ line, literal: null, keys: [] });
      continue;
    }
    const end = matchBrace(src, arg);
    const literal = end === -1 ? src.slice(arg) : src.slice(arg, end);
    out.push({ line, literal, keys: topLevelKeys(literal) });
  }
  return out;
}

interface SendPathDeclaration {
  readonly name: string;
  readonly line: number;
  readonly params: readonly string[];
}

/**
 * Send-path function/method DECLARATIONS and their parameter lists. Same
 * preceded-by-`.` discrimination as above, so `sendCommand({ … })` call sites
 * are not mistaken for declarations with an object literal for a parameter.
 *
 * The `[:=]?` between the name and the parameter list is load-bearing, and its
 * absence was a vacuous guard found by break-testing: `const send = (cmd, fail:
 * string, ok: string) => …` does not match `send\s*\(`, because a `=` sits
 * between the name and the paren. So the pattern missed the EXACT shape the
 * original test was written for — reintroducing the deleted wrapper with a
 * third `ok: string` parameter passed the repaired guard cleanly. A `:` is
 * allowed for the same reason (a class method or a typed field).
 */
function sendPathDeclarations(src: string): SendPathDeclaration[] {
  const out: SendPathDeclaration[] = [];
  const re = /\b(send|sendCommand|sendCommandDetailed)\b\s*(?:[:=]\s*)?(?:<[^()<>]*>\s*)?\(/g;
  for (const m of src.matchAll(re)) {
    const name = m[1] ?? '';
    const at = m.index ?? 0;
    let before = at - 1;
    while (before >= 0 && /\s/.test(src[before] ?? '')) before -= 1;
    if (src[before] === '.') continue; // a call site, not a declaration
    const open = src.indexOf('(', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i += 1) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        i = endOfString(src, i) - 1;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const params = src
      .slice(open + 1, end)
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    out.push({ name, line: src.slice(0, at).split('\n').length, params });
  }
  return out;
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

  test('the renderer command send path has no success-message slot', () => {
    // THE INVARIANT. The HUD's command sender has no success-message parameter,
    // so the renderer cannot emit a canned confirmation at all — whatever the
    // user hears about a successful command was narrated by the daemon's own
    // model. The regression this exists to catch is a future edit that adds an
    // `ok`/`success` string to a renderer send path.
    //
    // WHY IT IS NOT A REGEX ON ONE SIGNATURE. It used to be:
    //
    //     const sig = app.match(/const send = \([^)]*\)/)?.[0] ?? '';
    //     expect(sig).toBeDefined();
    //     expect(sig.split(',').length).toBe(2);
    //     expect(sig).not.toMatch(/ok\s*:\s*string/);
    //
    // The UI rewrite deleted the `const send = (cmd, fail: string)` wrapper, so
    // the regex matched nothing, `sig` was `''`, and `toBeDefined()` failed. A
    // guard that binds to one line's exact text is a guard that reports "the
    // wrapper is gone" instead of "the property holds", and it did: it went red
    // on a file that was still correct. The fix is not to delete it and not to
    // loosen it until it passes — it is to bind to the PROPERTY, which is a
    // property of the send path and not of any one declaration.
    //
    // The property, stated so it can be checked without a style guide:
    //
    //   1. `UiCommandSchema` is `.strict()`, so the wire shape is closed. Every
    //      top-level key the renderer sends must be a field of that schema. A
    //      success string has no field, therefore there is nowhere to put one —
    //      this is enforced by the daemon, not merely by convention.
    //   2. Therefore EVERY `sendCommand(` call site is inspected, its object
    //      literal is parsed, and its keys are checked against the schema.
    //      Sites are counted, and a count of zero is a FAILURE: a guard that
    //      inspects nothing must never be able to pass.
    //   3. A call site whose argument is not an inline object literal is a site
    //      this guard cannot read, and it is reported as a failure rather than
    //      skipped. A send path hidden behind a variable is exactly where a
    //      success string would go to hide.
    //   4. Independently, no send-path DECLARATION in the renderer may name a
    //      success-message parameter. This is the old `not.toMatch(/ok\s*:\s*string/)`
    //      widened from one signature to every one of them, so re-introducing a
    //      `const send = (cmd, fail: string, ok: string)` wrapper is caught even
    //      though its object literal would be clean.
    //
    // The allowlist is derived from the real schema rather than transcribed, so
    // adding a legitimate command field cannot turn this into a false failure —
    // the failure it is built to report can no longer happen by accident.

    const protocolFields = new Set(Object.keys(UiCommandSchema.shape));
    expect(protocolFields.size, 'the protocol schema exposes no fields to check against').toBeGreaterThan(0);

    const inspected: string[] = [];
    const failures: string[] = [];

    for (const file of rendererProductionFiles()) {
      // Comments blanked in place, so the offsets below are real line numbers.
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const site of sendCommandCallSites(src)) {
        const rel = file.replace(ROOT, '.').replace(/\\/g, '/');
        const at = `${rel}:${site.line}`;
        inspected.push(at);
        if (site.literal === null) {
          failures.push(
            `${at}: sendCommand() argument is not an inline object literal, so this ` +
              `guard cannot read it. A send path hidden behind a variable is where a ` +
              `canned success string would go — inline the command object.`,
          );
          continue;
        }
        for (const key of site.keys) {
          if (protocolFields.has(key)) continue;
          failures.push(
            `${at}: sendCommand() sends \`${key}\`, which is not a field of ` +
              `UiCommandSchema. The wire shape is .strict(), so the daemon rejects it — ` +
              `and a field the protocol does not define is the only place a canned ` +
              `confirmation could ride to the user.`,
          );
        }
      }
    }

    // A guard that inspects zero sites is not a guard. This is the assertion
    // whose absence let the original regex fail as a vacuous `''` match.
    // The count is printed on every run on purpose: a green line with no
    // evidence of WHAT it covered is exactly the failure mode being repaired,
    // and this repository has been bitten by it more than once.
    console.info(
      `  zero-canned: send-path guard inspected ${inspected.length} sendCommand call site(s)\n` +
        inspected.map((s) => `    ${s}`).join('\n'),
    );
    expect(
      inspected.length,
      `no sendCommand() call sites found in ${RENDERER_DIRS.join(', ')} — the guard ` +
        `inspected nothing, so it would pass no matter what the renderer sent`,
    ).toBeGreaterThan(0);
    expect(failures, `${failures.length} failure(s) across ${inspected.length} sendCommand call site(s):\n${failures.join('\n')}`).toEqual([]);

    // Part 4: no send-path declaration may name a success-message parameter.
    const successParam = /^(?:ok|success|successMessage|successText|doneText|confirmMessage|message|text)$/i;
    for (const file of rendererProductionFiles()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const decl of sendPathDeclarations(src)) {
        for (const param of decl.params) {
          const name = param.split(/[:?=]/)[0]?.trim() ?? '';
          expect(
            successParam.test(name),
            `${file.replace(ROOT, '.').replace(/\\/g, '/')}:${decl.line}: send-path ` +
              `\`${decl.name}\` declares a success-message parameter \`${param}\`. The ` +
              `sender takes the command and nothing else; success text is the daemon's.`,
          ).toBe(false);
        }
      }
    }
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
