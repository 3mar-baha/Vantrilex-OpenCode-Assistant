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



const NUMERIC_CLAIMS = [
  'root vitest tests',
  'root vitest files',
  'root vitest skipped',
  // Whether the DECLARED guards are still locatable, reported apart from the
  // ceiling so the message leads with the cause. Added because break-testing a
  // deleted guard produced three red claims whose first two were about counts —
  // a real failure whose message points at the wrong cause.
  'skip guards declared',
  // The ceiling run-check. It is a SEPARATE claim from `root vitest skipped` and
  // both are registered, because they answer different questions and one used to
  // stand in for the other: `root vitest skipped` compares the document's stated
  // cardinality against the number of named entries derived from the tree, and
  // `root vitest skip ceiling` compares the run against that cardinality. A
  // guard that pinned only the first would stay green while the second was
  // deleted, and the deleted one is the check that actually bites — it is what
  // turns "13 skips, all within the ceiling" into a failure when none of the 13
  // matches a declared guard.
  //
  // It matches `hasClaimIn` through the `ceilingLabel: 'root vitest skip
  // ceiling',` property, which is a quoted literal followed by a comma. The
  // call sites themselves are `fail(ceilingLabel, …)` / `pass(ceilingLabel, …)`
  // and are NOT literals, so a matcher that only understood call arguments would
  // report this claim as missing. The pinned assertion further down covers the
  // entry surviving in THIS list, which is the other direction.
  'root vitest skip ceiling',
  'desktop vitest tests',
  'desktop vitest files',
  'desktop vitest skipped',
  'cargo tests',
  'e2e tests (static count)',
  'e2e specs',
  'live modules',
  'dead modules',
  'live source lines',
  'gate stage count',
];

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
    //
    // The `skipped` labels are here because they were split OUT of the test
    // count when the per-suite reports were unified: a run with hidden skips
    // prints the same passed total as a complete one, so `tests` alone cannot
    // detect them and a separate claim had to be registered for each suite.
    for (const label of NUMERIC_CLAIMS) {
      expect(hasClaim(label), `docs-verify no longer checks "${label}"`).toBe(true);
    }
  });

  test('the pinned list itself still carries both skip-count claims', () => {
    // Direction 2, and it is the one that was missing.
    //
    // The loop above iterates the pinned list, so it can only prove a label
    // that IS in the list is registered in docs-verify.mjs. Deleting an ENTRY
    // FROM THE LIST makes the suite quieter rather than red - the assertion
    // disappears along with the thing it was asserting, and every gate stays
    // green. Measured: removing 'desktop vitest skipped' from this file left
    // all 5 tests passing. That is a guard whose only failure mode is silence,
    // which is the exact defect shape this file was written to prevent.
    //
    // So the list is pinned as data, not just as an iteration source. Adding a
    // new claim means adding it to NUMERIC_CLAIMS and seeing it fail here
    // first; that is the intended friction, not an accident of the guard.
    expect(NUMERIC_CLAIMS, 'the root skip-count claim left the pinned list').toContain(
      'root vitest skipped',
    );
    expect(NUMERIC_CLAIMS, 'the desktop skip-count claim left the pinned list').toContain(
      'desktop vitest skipped',
    );
    // The ceiling's run-check, for the same reason. Removing it from the list
    // would delete the only assertion that it is registered, and the two halves
    // are not interchangeable: the cardinality claim can pass while the run
    // silently exceeds the ceiling it just restated correctly.
    expect(NUMERIC_CLAIMS, 'the ceiling run-check claim left the pinned list').toContain(
      'root vitest skip ceiling',
    );
    expect(NUMERIC_CLAIMS, 'the declared-guard liveness claim left the pinned list').toContain(
      'skip guards declared',
    );
    // Deliberately NOT a length/count assertion on the list. Adding a suite is
    // the codebase growing, and claim-matcher.ts's own doctrine is that a guard
    // which punishes growth is the wrong guard: at the call site "you added a
    // check" and "you deleted a check" are indistinguishable. Two named claims
    // is the whole obligation; a third suite brings its own label with it.
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
