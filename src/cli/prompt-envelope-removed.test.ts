import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { promptBody } from './serve.js';
import { openServeTarget } from './serve.js';

// ─────────────────────────────────────────────────────────────────────────────
// W26 — `promptEnvelope` was plumbed from the CLI, printed as a field, and read
// ZERO times in the request path.
//
// The guard is DERIVED from the sources on disk: it reads them and asserts a
// SHAPE (the option is absent, the flag is gone, the printed field is gone,
// nothing accepts an envelope argument), so it cannot be satisfied by a file that
// merely looks right. Nothing here types an expected line number or an expected
// count of occurrences of a string that might not exist.
//
// WHY DELETION RATHER THAN WIRING, restated because "just make it real" is the
// obvious objection: both shapes are measurably invalid. `/doc` declares
// `PromptInput = {text, files?, agents?}` with `additionalProperties: false`, so
// `metadata` — which BOTH old shapes carried — has no home, and `prompt` is a
// required key the flat shape omitted. Measured: flat → 400 "Missing key
// [\"prompt\"]", nested → 500. Reinstating the flag would ship a body the server
// rejects. The real egress is a ROUTE choice by status code, not a shape choice,
// so there is nothing for the flag to select.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = (rel: string): string => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

/**
 * Strip comments, keeping string and template literals intact.
 *
 * THE GUARD HAS TO SCAN CODE, NOT PROSE. The removal left explanatory comments
 * that necessarily NAME what was removed ("this used to take `promptEnvelope`"),
 * and a guard that greps the raw file fails on its own documentation. Deleting
 * the rationale to satisfy a grep is exactly backwards. So comments go, and the
 * literals stay — which matters, because a false strip could otherwise hide a
 * real occurrence and make the guard vacuous in the other direction.
 *
 * This is a scanner rather than a regex because `/` appears inside regex
 * literals and URLs, and `//` inside a string is not a comment.
 */
function code(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && src.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const ch = src[i] ?? '';
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i] ?? '';
        if (c === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === ch) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const FILES = [
  'runtime/client.ts',
  'cli/serve.ts',
  'cli/bridge.ts',
  'cli/headless.ts',
  'cli/reason.ts',
  'cli/agent.ts',
] as const;

const CODE = new Map<string, string>(FILES.map((f) => [f, code(SRC(f))]));
// `cli/agent.ts` is reached through the `CODE` map rather than a named alias:
// the chain guards iterate the map, so an alias for it would be unused.
const CLIENT = CODE.get('runtime/client.ts') as string;
const SERVE = CODE.get('cli/serve.ts') as string;
const BRIDGE = CODE.get('cli/bridge.ts') as string;
const HEADLESS = CODE.get('cli/headless.ts') as string;
const REASON = CODE.get('cli/reason.ts') as string;

describe('W26: the dead option is gone from the class, not just from the print', () => {
  test('BREAK: `promptEnvelope` occurs nowhere in the client, the target, or the CLI', () => {
    // The whole chain in one assertion: the getter, the constructor option, the
    // `ServeTarget` field, the `--envelope` flag, its parser, its usage lines and
    // every print site. Re-adding it anywhere makes this red.
    for (const [name, src] of CODE) {
      expect(src, `${name} still references promptEnvelope in code`).not.toMatch(/promptEnvelope/);
    }
  });

  test('BREAK: `ServeClient` takes no third argument, so nothing can pass one', () => {
    // The constructor is where the capability used to be admitted. A guard that
    // only checked the prints would pass while the option was still accepted —
    // which is the "false affordance the print hides" case, and the reason this
    // asserts the SHAPE rather than the symptom.
    const ctor = CLIENT.match(/constructor\([\s\S]*?\)\s*\{\}/);
    expect(ctor, 'the ServeClient constructor must be findable').not.toBeNull();
    expect(ctor?.[0], 'a third parameter is a prompt-shape slot again').not.toMatch(/options/);
    // And the two-parameter call sites are what the tree now uses.
    expect(CLIENT).toMatch(/constructor\(\s*private readonly baseUrl: string,\s*private readonly password: string,?\s*\)/);
  });

  test('BREAK: `openServeTarget` takes no envelope option', () => {
    expect(SERVE).not.toMatch(/PromptEnvelope/);
    const sig = SERVE.match(/export async function openServeTarget\([^)]*\)/);
    expect(sig?.[0]).not.toMatch(/envelope/i);
  });

  test('BREAK: no exported `promptCommand` arity takes a third argument', () => {
    // Three parameters meant `(sessionId, text, envelope)`. Two is the real one.
    expect(BRIDGE).toMatch(/export async function promptCommand\(sessionId: string, text: string\): Promise<number>/);
  });

  test('BREAK: the `prompt envelope` field is printed by nobody', () => {
    // The literal the user saw. Checked as a printed LABEL, so renaming the
    // variable while keeping the line fails here.
    for (const [name, src] of [
      ['cli/bridge.ts', BRIDGE],
      ['cli/reason.ts', REASON],
    ] as const) {
      expect(src, `${name} still prints an envelope field`).not.toMatch(/out\.field\(\s*['"]prompt envelope['"]/);
    }
    // And the string that told the reader which shape was in play.
    expect(BRIDGE).not.toMatch(/ServeClient default is flat/);
  });

  test('BREAK: `--envelope` is not accepted, parsed, or advertised', () => {
    expect(HEADLESS).not.toMatch(/envelopeOption/);
    // As a value-option: leaving it in `VALUE_OPTIONS` would make `--envelope x`
    // swallow the next positional, which is the exact bug the set's comment warns
    // about — so its absence is checked in the set itself, not just in usage text.
    const valueOpts = HEADLESS.match(/const VALUE_OPTIONS[\s\S]*?\]\);/);
    expect(valueOpts?.[0], '`envelope` must leave VALUE_OPTIONS').not.toMatch(/'envelope'/);
    expect(HEADLESS).not.toMatch(/--envelope/);
  });
});

describe('W26: what the report says instead', () => {
  test('the diagnostic re-read sends the body the client actually sends', () => {
    // This is the half that makes the removal a REPAIR rather than a deletion.
    // `promptBody` used to take an envelope and produce a body `ServeClient`
    // never sends, so the "what serve said" diagnostic described a request that
    // could not have happened — under either flag value.
    expect(promptBody('t')).toEqual({ prompt: { text: 't' }, delivery: 'steer' });
  });

  test('BREAK: the serialiser in the client is byte-identical to the diagnostic body', () => {
    // Reads the production serialiser out of the client rather than restating
    // it, so the two cannot drift apart silently.
    const bodies = CLIENT.match(/body: JSON\.stringify\((\{[^\n]*\})\)/g) ?? [];
    expect(bodies.some((b) => b.includes("{ prompt: { text }, delivery: 'steer' }"))).toBe(true);
  });

  test('BREAK: `metadata` is in no prompt body, because `PromptInput` forbids it', () => {
    // `PromptInput` is `{text, files?, agents?}` with `additionalProperties:false`.
    // Carrying `metadata` inside it measured 400/500, so its absence is the
    // contract rather than an omission — and the one place it used to appear
    // (`promptBody`'s signature) is gone with the flag.
    for (const [name, src] of [
      ['runtime/client.ts', CLIENT],
      ['cli/serve.ts', SERVE],
    ] as const) {
      expect(src, `${name} puts metadata in a prompt body`).not.toMatch(/prompt:\s*\{\s*text,[^}]*metadata/);
    }
    expect(promptBody('t')).not.toHaveProperty('metadata');
  });
});

describe('W26: the shape guard is not satisfied by a vacuous read', () => {
  test('the sources this guard reads are all non-empty', () => {
    // A file-read guard that silently read an empty string would satisfy every
    // `not.toMatch` above. This is the anti-vacuity anchor, and it is the
    // mistake this repo has already made once: a break-the-guard passed only
    // because the anchor string was not in the file.
    for (const [name, src] of CODE) {
      expect(src.length, `${name} read as empty — the guard would be vacuous`).toBeGreaterThan(200);
      // The stripper must not eat the file: real code survives it.
      expect(src, `${name} lost its code to the comment stripper`).toMatch(/\bexport\b/);
    }
  });

  test('the stripper removes comments and keeps literals', () => {
    // Otherwise "scan code only" could be a stripper that blanks everything, and
    // every `not.toMatch` above would pass for the wrong reason.
    expect(code('const a = 1; // promptEnvelope\n')).not.toMatch(/promptEnvelope/);
    expect(code('const a = 1;')).toMatch(/const a = 1;/);
    // A literal is NOT a comment, so a mention inside one survives — which is the
    // case that would let a real occurrence hide.
    expect(code("const s = 'promptEnvelope';")).toMatch(/promptEnvelope/);
    expect(code('/* promptEnvelope */ const b = 2;')).not.toMatch(/promptEnvelope/);
    expect(code('const u = `x // y`;')).toMatch(/x \/\/ y/);
  });

  test('and the client still has the egress the whole removal is premised on', () => {
    // If the route fallback were ever deleted, "remove the flag" would stop being
    // the right answer and become a regression. This asserts the premise is still
    // true rather than assuming it.
    expect(CLIENT).toContain('prompt_async');
    expect(CLIENT).toMatch(/promptWithKey/);
  });

  test('`openServeTarget` is still callable with no arguments', () => {
    // The call sites stopped passing options; this proves the default parameter
    // survived the edit, so `openServeTarget()` is a real call rather than a
    // compile error waiting to happen.
    expect(SERVE).toMatch(/export async function openServeTarget\(options: \{ readonly directory\?: string \} = \{\}\)/);
    expect(typeof openServeTarget).toBe('function');
  });
});