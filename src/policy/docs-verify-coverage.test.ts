import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

// WHY THIS FILE EXISTS.
//
// `docs:verify` is the instrument that found five falsities in AGENTS.md by
// re-deriving them. It is also a script, and a script can be edited. If someone
// deletes a claim from it, nothing fails: the harness reports success, the claim
// simply stops being checked, and the drift it was introduced to catch comes
// back. That is the same shape as the defect it exists to prevent - coverage that
// reads as present while being absent.
//
// The precedent is `sidecar-safety.test.ts`, which pins a property of a script
// the same way: assert on the source, because the thing being guarded IS source.
//
// This is deliberately a structural guard, and honestly labelled as one. It
// cannot tell whether a check derives correctly, only whether it is still there.
// That is the gap break-testing covers and this does not.

const SRC = readFileSync('scripts/docs-verify.mjs', 'utf8');

// The matcher lives in its own module so this guard and its own tests use ONE
// implementation, and so the regex can be written as ordinary source instead of
// being assembled through two layers of escaping. It is a SHAPE test: it proves
// a label is registered, not that it derives correctly.
import { hasClaimIn } from './claim-matcher.js';

/** Whether docs-verify registers this label. See `claim-matcher.ts`. */
function hasClaim(label: string): boolean {
  return hasClaimIn(SRC, label);
}



describe('docs:verify keeps its claim set', () => {
  test('every narrative claim label is still present', () => {
    // The claims added when the narrative drift was found. Deleting any one of
    // these entries means the corresponding check is gone.
    for (const label of [
      'persona refs:',
      'earcon modules',
      'earcon pitch constants',
      'knowledge importers',
      'knowledge barrel importers',
      'cited line anchors',
      'test-reachable modules',
      'test-blind modules',
    ]) {
      expect(hasClaim(label), `docs-verify no longer checks "${label}"`).toBe(true);
    }
  });

  test('the numeric claims survive alongside the narrative ones', () => {
    // A guard that only defended the NEW checks would let the original 18 be
    // deleted silently. That is why docs:verify exists.
    for (const label of [
      'root vitest tests',
      'root vitest files',
      'desktop vitest tests',
      'desktop vitest files',
      'cargo tests',
      'e2e tests (static count)',
      'e2e specs',
      'live modules',
      'dead modules',
      'live source lines',
      'gate stage count',
    ]) {
      expect(hasClaim(label), `docs-verify no longer checks "${label}"`).toBe(true);
    }
  });

  test('the script still derives from the document and the tree', () => {
    // The design rule that makes the harness trustworthy: documented figures are
    // PARSED out of the markdown, derived figures computed from the tree. A
    // hardcoded expectation here would make "docs:verify passed" meaningless,
    // because the script would be agreeing with itself instead of with the code.
    //
    // This checks the SHAPE, not each literal: it proves claims are wired to the
    // markdown, not that no constant could ever be added. That is the honest
    // scope of a structural guard, and claiming more would repeat the mistake
    // this repository keeps making.
    expect(SRC, 'claims are no longer parsed out of AGENTS.md').toMatch(/agents\.match\(/);
    expect(SRC, 'derived figures no longer read the tree').toMatch(/readFileSync\(join\(ROOT, p\), 'utf8'\)/);
  });

  test('the reported total cannot shrink when a claim is removed', () => {
    // `results.length - skipped.length` was the old form: remove a claim and the
    // number falls, so the output still reads as a pass. The current form counts
    // verified claims only and pairs it with UNVERIFIED being fatal, so a removed
    // claim turns into an error instead of a quieter success.
    expect(SRC).toMatch(/docs:verify passed — \$\{results\.length\} claim\(s\)/);
    expect(SRC, 'the old shrinkable total is back').not.toMatch(/results\.length - skipped\.length/);
  });

  test('UNVERIFIED is fatal, not a warning', () => {
    // Removing a documented figure silently disables its check. Observed by
    // break-testing: deleting the earcon count left every other claim green and
    // exited 0, so the harness reported success while covering one claim less.
    const idx = SRC.indexOf('if (skipped.length)');
    expect(idx, 'the UNVERIFIED block is gone from the script').toBeGreaterThan(-1);
    const tail = SRC.slice(idx);
    // The failure path must be reachable: an UNVERIFIED item prints a warning and
    // then errors out. A block that only warns is the shape that was wrong.
    expect(tail, 'the UNVERIFIED block no longer exits non-zero').toMatch(
      /console\.warn[\s\S]*?console\.error[\s\S]*?process\.exit\(1\)/,
    );
  });
});
