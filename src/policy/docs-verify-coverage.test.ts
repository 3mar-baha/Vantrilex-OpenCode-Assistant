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

  /**
   * `src` with every comment removed — line comments and block comments.
   *
   * THIS EXISTS BECAUSE A BREAK-PROBE CAME BACK GREEN, and the reason is
   * instructive enough to be worth its own function. MEASURED: deleting the
   * `ceilingLabel: 'root vitest skip ceiling',` registration from
   * `docs-verify.mjs` left every test in this file PASSING. The reason is that
   * `hasClaimIn` accepts a label that is QUOTED and BOUND, and the JSDoc above
   * `reportSkipCeiling` names the same label in backticks:
   *
   *     2. `root vitest skip ceiling` — the RUN against the arm ...
   *
   * which satisfies the matcher exactly as a registration does. So the guard
   * was satisfied by a COMMENT ABOUT a claim while the claim was gone — the
   * "coverage that reads as present while being absent" shape this file exists
   * to prevent, reproduced by the guard that exists to prevent it.
   *
   * WHY THE MATCHER ITSELF IS NOT CHANGED. `claim-matcher.ts` is deliberately
   * property-based rather than shape-based, its header argues explicitly against
   * a list of spellings, and it is outside this wave's write set. Making it
   * prose-aware would have to know what prose is, which is the shape-list by
   * another name. Stripping comments here instead is a STATEMENT about this one
   * relationship: a claim is registered in CODE, and a file that only talks about
   * a claim has not registered it.
   *
   * The string-literal case is handled rather than ignored: a `'//'` or `'/*'`
   * INSIDE a string must not start a comment, so a claim label containing either
   * would otherwise swallow the rest of the file and make every later check
   * vacuously true — the exact failure mode of a naive strip, and the reason this
   * walks the source character by character.
   */
  function stripComments(src: string): string {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      const next = src[i + 1];
      if (ch === '/' && next === '/') {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        // Keep a newline so line numbers stay meaningful in failure messages.
        out += '\n';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        // Copy the literal verbatim, so a `//` inside it is not a comment start.
        out += ch;
        i += 1;
        while (i < n) {
          if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
          out += src[i];
          if (src[i] === ch) { i += 1; break; }
          i += 1;
        }
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  test('each numeric label is REGISTERED IN CODE, not merely mentioned in prose', () => {
    // Direction 2 for `hasClaim`: the label must survive comment-stripping, and
    // it must reach a claim CALL. Both are required, because each alone is
    // satisfiable by the wrong thing:
    //
    //   - label present in prose only  → survives the matcher, fails this test
    //   - label bound, call site deleted → survives the matcher, fails this test
    //   - label passed to a call, but never bound
    //                                    → survives `REGISTRATIONS`, fails this test
    //
    // And the stripper is itself exercised, because a stripper that removes
    // everything would make the whole assertion vacuously true. MEASURED below.
    // The stripper's own anti-vacuity bounds, and they are stated as BOUNDS on a
    // measurement rather than as magic numbers. MEASURED on this file: the
    // comments are ~22% of `docs-verify.mjs`, so the stripper removes about a
    // fifth of it. The bounds are deliberately wide — "some comments went, most
    // of the file stayed" — because the point is only to catch the two degenerate
    // strippers (one that removes nothing, one that removes everything); the
    // assertions below are what actually establish correctness.
    const CODE = stripComments(SRC);
    const removed = SRC.length - CODE.length;
    expect(removed, 'the stripper removed nothing — this file has comments').toBeGreaterThan(SRC.length * 0.01);
    expect(CODE.length, 'the stripper removed the entire file').toBeGreaterThan(SRC.length * 0.25);
    // Prose that must be GONE, and code that must SURVIVE.
    expect(CODE, 'a line comment survived stripping').not.toMatch(/^\s*\/\/ /m);
    expect(CODE, 'a JSDoc line survived stripping').not.toMatch(/^\s*\* /m);
    expect(CODE, 'the comment-stripping removed real code').toContain('function reportSkipCeiling');

    const CALL_SITES: Record<string, string> = {
      // Each label must still reach a claim call. The four that arrive through a
      // destructured parameter are named by that parameter's use, and the
      // registration binding for those is checked below.
      'root vitest tests': 'pass(testsLabel',
      'root vitest files': 'pass(filesLabel',
      'root vitest skipped': 'fail(skippedLabel',
      'root vitest skip ceiling': 'fail(ceilingLabel',
      'skip guards declared': "'skip guards declared',",
      // The desktop suite reaches its claims through the SAME destructured
      // parameters as the root one, so these three pin the same call sites. They
      // are listed separately rather than collapsed into the root entries
      // because the labels are distinct claims, and a collapsed table would let a
      // desktop label lose its call site unnoticed.
      'desktop vitest tests': 'pass(testsLabel',
      'desktop vitest files': 'pass(filesLabel',
      'desktop vitest skipped': 'pass(skippedLabel',
      'cargo tests': "pass('cargo tests'",
      'e2e tests (static count)': "pass('e2e tests (static count)'",
      'e2e specs': "pass('e2e specs'",
      'live modules': 'pass(label, doc, String(der))',
      'dead modules': 'pass(label, doc, String(der))',
      'live source lines': 'pass(label, doc, String(der))',
      'gate stage count': "pass('gate stage count'",
    };
    // STANDING RULE: a loop over an empty map asserts nothing. Asserted as a
    // COUNT, and cross-checked against the pinned list so the two cannot drift
    // into covering different sets.
    const callLabels = Object.keys(CALL_SITES);
    expect(callLabels.length, 'the call-site table emptied itself').toBeGreaterThan(0);
    expect(callLabels.length, 'the call-site table lost a label the pinned list still claims').toBe(
      NUMERIC_CLAIMS.length,
    );

    for (const label of NUMERIC_CLAIMS) {
      // (a) bound as a label in CODE — not in a comment.
      expect(
        hasClaimIn(CODE, label),
        `"${label}" survives only in prose: the claim it names is no longer registered in code`,
      ).toBe(true);
      // (b) reaches a claim call.
      const site = CALL_SITES[label];
      expect(site, `no call site is pinned for the numeric claim "${label}"`).toBeDefined();
      expect(CODE, `"${label}" no longer reaches a claim call`).toContain(site as string);
      // (c) and against the RAW source too, so the original guard still holds.
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
