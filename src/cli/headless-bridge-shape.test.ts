import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF `cli.ts`, PINNED.
//
// The comment inside the headless-bridge fallback used to justify its own
// placement with a list of LINE ANCHORS (`cli.ts:24`, `:182`, `:270`, `:285`) and
// the claim that "nothing above this point moves by a single line". All four
// anchors were wrong by the time the next reader arrived — `:285` was never the
// argv ladder, the ladder moved under a later edit, and the fallback itself then
// moved BELOW the ladder, which voided the stability argument for the very
// anchors it was protecting. The comment now rests on a claim about SHAPE, which
// is the only kind that survives a daemon edit.
//
// A comment that cites line numbers is checked by nothing: `npm run docs:verify`
// resolves the anchors `AGENTS.md` cites, not the ones a source comment cites. So
// this file exists to make the shape claim enforced rather than merely asserted.
//
// Everything here is DERIVED from `src/cli.ts` on disk — the ladder's line, the
// fallback's line, the static/dynamic import forms. No expected value is typed
// in, so editing `cli.ts` cannot make this file agree with itself by accident.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const source = readFileSync(join(ROOT, 'src/cli.ts'), 'utf8');
const lines = source.split(/\r?\n/);

/** First line whose trimmed text is `needle`, 1-based; throws if absent. */
function lineOf(needle: string): number {
  const idx = lines.findIndex((l) => l.trim() === needle);
  if (idx < 0) throw new Error(`src/cli.ts has no line whose trimmed text is ${JSON.stringify(needle)}`);
  return idx + 1;
}

/**
 * The index of the brace that closes the whole `if`/`else if` chain opened at
 * `openLine` (0-based).
 *
 * Chain-aware, and that detail is the whole reason this helper exists: a naive
 * depth counter returns at the FIRST `}`, which for a five-branch ladder is the
 * `}` that opens the second branch — not the end of the ladder. A guard written
 * against a wrong helper is worse than no guard, because it looks load-bearing.
 */
function closingBrace(openLine: number): number {
  let depth = 0;
  for (let i = openLine - 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth > 0) continue;
        // Back at column 0 of the ladder: keep walking while the next branch
        // continues the chain, otherwise this is the chain's closing brace.
        const rest = line.slice(c + 1).trim();
        if (rest.startsWith('else')) continue;
        return i;
      }
    }
  }
  throw new Error(`src/cli.ts: no closing brace for the chain opened at line ${openLine}`);
}

const LADDER_OPEN = lineOf("if (command === 'doctor') {");
const FALLBACK_OPEN = lineOf('} else {');
const LADDER_CLOSE = closingBrace(LADDER_OPEN);

describe('the headless fallback is the last statement in the module', () => {
  test('the fallback opens inside the argv ladder, not above it', () => {
    expect(FALLBACK_OPEN, 'the fallback is the ladder`s own else branch').toBeGreaterThan(LADDER_OPEN);
    expect(FALLBACK_OPEN, 'the fallback is the ladder`s final else').toBeLessThan(LADDER_CLOSE + 1);
  });

  test('and nothing follows the ladder in cli.ts', () => {
    // This is the load-bearing half of the shape claim, and the one that makes
    // it true rather than aspirational: a top-level statement after the ladder
    // would be an edit that could move the anchors the old comment cited.
    const after = lines.slice(LADDER_CLOSE + 1).filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//');
    });
    expect(after, 'cli.ts must end with the argv ladder').toEqual([]);
  });
});

describe('the headless bridge is reached dynamically, and only dynamically', () => {
  test('no static import of cli/headless.js', () => {
    const staticImport = lines.find((l) => /^import\s.*from\s+'\.\/cli\/headless\.js'/.test(l));
    expect(staticImport, 'a static import would drag the coordinator into `doctor` and `knowledge`').toBeUndefined();
  });

  test('the dynamic import exists, and sits INSIDE the fallback', () => {
    const dynamic = lines.findIndex((l) => l.includes("await import('./cli/headless.js')"));
    expect(dynamic, 'the bridge must be loaded with await import()').toBeGreaterThanOrEqual(0);
    expect(dynamic + 1, 'the import must be inside the fallback branch').toBeGreaterThan(FALLBACK_OPEN);
    expect(dynamic + 1, 'the import must be inside the fallback branch').toBeLessThanOrEqual(closingBrace(FALLBACK_OPEN) + 1);
  });

  test('and it is the ONLY dynamic import that names the bridge', () => {
    expect(source.match(/await import\('\.\/cli\/headless\.js'\)/g) ?? []).toHaveLength(1);
  });
});

describe('the comment in that branch cites no line number it cannot keep', () => {
  test('the headless comment block names no `cli.ts:NNN` anchor', () => {
    // The rule the rewrite follows, asserted so a future editor re-introducing
    // an anchor list trips here rather than shipping another rot.
    const commentLines = lines.slice(FALLBACK_OPEN - 1, closingBrace(FALLBACK_OPEN)).filter((l) => l.trim().startsWith('//'));
    const anchors = commentLines.filter((l) => /cli\.ts:\d+/.test(l));
    expect(anchors, 'a shape claim needs no line anchors; the ones that were there were all wrong').toEqual([]);
  });
});