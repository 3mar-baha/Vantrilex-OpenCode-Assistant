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

/**
 * A claim label is only pinned when it appears in a CLAIM POSITION — an entry of
 * the tuple array the harness iterates — not merely anywhere in the file.
 *
 * Found by break-testing. The first version of this guard used a bare
 * `toContain(label)`, and deleting the `['dead modules', ...]` check still left
 * the string "dead modules" in the header comment that explains the tool's
 * history, so the guard passed while the check was gone. A substring search over
 * a file that also contains prose about itself counts the prose.
 */
function hasClaim(label: string): boolean {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // docs:verify registers a claim in one of FOUR shapes, and pinning a subset
  // produced a guard that failed on its own baseline:
  //   1. a single-line tuple entry — ['dead modules', /x/, reach.dead],
  //   2. a MULTI-LINE tuple entry — prettier wraps the long regex ones, so the
  //      opening bracket is on one line and the label on the next. Two separate
  //      failures came from assuming a table entry is always one line.
  //   3. a string literal call     — pass('cargo tests', a, b)
  //   4. a TEMPLATE literal call   — pass(`persona refs: ${label}`, a, b)
  return (
    new RegExp(`^\\s*\\['${esc}'\\s*,`, 'm').test(SRC) ||
    new RegExp(`\\[\\s*\\n\\s*'${esc}'\\s*,`, 'm').test(SRC) ||
    new RegExp(`\\b(?:pass|fail|unverified)\\('${esc}'`, 'm').test(SRC) ||
    new RegExp('\\b(?:pass|fail|unverified)\\(`' + esc, 'm').test(SRC)
  );
}

describe('hasClaim recognises every claim-registration shape', () => {
  // The guard's own matcher, tested against synthetic sources. Both regressions
  // above were in THIS function, not in the claims it checks, and neither was
  // visible from a passing run: a substring version counted a prose mention in
  // the header comment as coverage, and versions covering only some shapes
  // reported claims the script plainly makes as absent.
  const match = (src: string, label: string): boolean => {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      new RegExp(`^\\s*\\['${esc}'\\s*,`, 'm').test(src) ||
      new RegExp(`\\[\\s*\\n\\s*'${esc}'\\s*,`, 'm').test(src) ||
      new RegExp(`\\b(?:pass|fail|unverified)\\('${esc}'`, 'm').test(src) ||
      new RegExp('\\b(?:pass|fail|unverified)\\(`' + esc, 'm').test(src)
    );
  };

  test('a single-line table entry counts as a claim', () => {
    expect(match("  ['dead modules', /x/, reach.dead],", 'dead modules')).toBe(true);
  });

  test('a wrapped multi-line table entry counts as a claim', () => {
    // Prettier wraps the entries whose regex is long, so the label lands on the
    // line after the bracket. The matcher previously required the two to be
    // adjacent on one line and reported these claims as absent.
    expect(match("  [\n    'earcon pitch constants',\n    /x/,\n    der,\n  ],", 'earcon pitch constants')).toBe(true);
  });

  test('a string-literal call counts as a claim', () => {
    expect(match("  pass('cited line anchors', a, b);", 'cited line anchors')).toBe(true);
    expect(match("  unverified('cargo tests', 'x', 1);", 'cargo tests')).toBe(true);
  });

  test('a template-literal call counts as a claim', () => {
    // The shape that broke the previous two versions: the per-file persona
    // checks are named `persona refs: ${label}` inside a backtick, so a matcher
    // that only accepted a quote character reported them as missing.
    expect(match('  pass(`persona refs: ${label}`, doc, der);', 'persona refs:')).toBe(true);
  });

  test('a prose mention does NOT count as a claim', () => {
    // The exact false positive that let the first version pass: the header
    // comment explains the tool's history and names the thing it once checked.
    expect(match('// AGENTS.md claimed "0 dead modules" when 7 were dead', 'dead modules')).toBe(false);
  });

  test('an unrelated label does not match', () => {
    expect(match("  ['live modules', /x/, 1],", 'dead modules')).toBe(false);
  });

  test('a deleted claim leaves no trace to match', () => {
    // Simulates the real break: the tuple entry is gone, and only prose remains.
    const stripped = '// historically it reported 0 dead modules\n  [\'live modules\', /x/, 1],';
    expect(match(stripped, 'dead modules')).toBe(false);
  });
});

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
