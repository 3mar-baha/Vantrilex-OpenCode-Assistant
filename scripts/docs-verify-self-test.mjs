// docs-verify self-test — the BEHAVIOURAL guard on citedAnchors.
//
// Why this is a separate module and why it is not in the vitest suite:
//
//   1. Behaviour, not source shape. The previous guard asserted that certain
//      identifiers appear in `docs-verify.mjs`'s SOURCE, and a code review proved
//      that form is satisfiable by a no-op: deleting the entire not-code check,
//      removing the ambiguous-basename rejection, and stubbing the classifiers to
//      `false` all left it green. Asserting a script contains text only proves the
//      script contains text. This module RUNS the checker.
//   2. Speed. A vitest test that shells out to `docs-verify.mjs` spawns the whole
//      vitest suite twice. This runs in ~1s and is invoked from the same place the
//      checker runs, so it can be wired into a gate without a timeout blowout.
//
// It drives the real checker with synthetic documents. `AGENTS.md` is never
// modified: the checker reads `globalThis.__agentsOverride` when set, which is
// installed by `docs-verify.mjs` purely so this file can supply a document.
//
// SCOPE, stated because it is the limit of what this file can cover: this runs
// under `npm run docs:verify --self-test`, not under `npm run test`. A vitest
// case cannot reach it without spawning this script, which spawns the vitest
// suite - the cost the header above is about. Anything that must fail in the
// default test gate has to live in `src/policy/`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// WHY THESE ARE SYNTHETIC DOCUMENTS RATHER THAN COPIES OF AGENTS.md. The same
// reason the anchor cases are: appending the real document to a scenario quietly
// turns every case into a claim about every figure the document states today, so
// a scenario whose own injection behaves correctly fails on unrelated drift. The
// ceiling cases are worse in a specific way, because `docFor` builds a
// two-sentence document and a full copy would drag in every claim in the file —
// so a self-test for "an understated ceiling is rejected" would also be a
// self-test for the earcon count, the reachability figures and 270 line anchors.
// The real document is checked by `docs:verify` itself, which names the figure and
// the line; what is checked here is whether the CHECKER compares.

/** The behaviours a code review found missing or vacuous, plus the Rust one. */
export function selfTestCitedAnchors(ROOT, citedAnchors) {
  const daemonLines = readFileSync(join(ROOT, 'src/daemon.ts'), 'utf8').split('\n');
  const mainRsLines = readFileSync(join(ROOT, 'apps/desktop/src-tauri/src/main.rs'), 'utf8').split('\n');

  // A line that is real code, and a line that is only a comment.
  const codeLine = daemonLines.findIndex((l) => l.trimStart().startsWith('import ')) + 1;
  const commentLine = daemonLines.findIndex((l) => /^\s*\/\//.test(l)) + 1;
  const pastEnd = daemonLines.length + 500;
  // A Rust line that is real code by construction: a `fn` signature is not a
  // comment, a blank, a bare delimiter or a JSDoc continuation, so the
  // "not code" classifiers cannot be what rejects it. Any failure below is
  // therefore about `.rs` being DROPPED rather than about the content check.
  const rustCodeLine = mainRsLines.findIndex((l) => /^\s*(pub(\(\w+\))?\s+)?fn\s/.test(l)) + 1;

  const cite = (n) => '\n\nSee `daemon.ts:' + n + '` here.\n';

  // Every document below is SYNTHETIC, and that is load-bearing rather than
  // cosmetic. Each case used to append the REAL AGENTS.md to its scenario, which
  // quietly made every case also a claim about every anchor the document cites
  // today: a scenario whose own injection behaved correctly still failed because
  // of unrelated drift elsewhere in the prose. That is why "a citation to a real
  // code line passes" was red while the checker was working — MEASURED: dozens of
  // the document's own anchors were dangling (comments, blank lines and bare
  // delimiters left by the parallel UI rewrite), and none of them was the
  // scenario under test.
  //
  // A self-test asserts about the CHECKER. Drift in the document belongs to the
  // `cited line anchors` claim in `docs:verify` itself, which reports it per
  // anchor and names the line - which is where it is actionable.
  //
  // The scenarios stay synthetic in the other direction too: they read real lines
  // out of the real tree (`src/daemon.ts`, `main.rs`) rather than hardcoding line
  // numbers, so they cannot rot into false passes when a file shifts.
  return [
    [
      'a citation to a real code line passes',
      oneAnchorResolves(citedAnchors, 'daemon.ts', codeLine),
    ],
    // The skip-ceiling cases are NOT in this array: they need `reportSuite` and
    // the results reader, which are wired in `docs-verify.mjs --self-test` where
    // the checker is actually running. Keeping them in a separate export is what
    // makes the split honest — this function's return value is only about
    // anchors, and a case that silently stopped being collected would be
    // invisible here.
    [
      // The drift class the whole check exists for: `daemon.ts:509` pointed at a
      // comment for a full cycle while the gate stayed green.
      'a citation to a COMMENT line is rejected',
      anchorsRejectWith(citedAnchors, cite(commentLine), /line is a line comment/),
    ],
    [
      'a citation past the end of the file is rejected',
      anchorsRejectWith(citedAnchors, cite(pastEnd), /has \d+ lines/),
    ],
    [
      // `vault.ts` exists twice in this tree. First-match-wins resolved it to
      // `src/memory/vault.ts` (the Obsidian scaffolder) and validated a citation
      // about the keyring against an unrelated line.
      'an ambiguous basename is rejected, not guessed',
      anchorsRejectWith(citedAnchors, '\n\nSee `vault.ts:1` here.\n', /ambiguous basename/),
    ],
    [
      // Rust reachability. `.rs` was added to the citation pattern, the index
      // filter and the index roots as one change, because one part without the
      // other two reports the wrong cause (a resolvable file that reads "not
      // found"). AGENTS.md cites `main.rs` throughout the supervisor's anchors.
      //
      // WHY A CASE HERE AND NOT A LABEL PIN. `src/policy/docs-verify-coverage.test.ts`
      // asserts that docs-verify registers certain claim LABELS; it never sees
      // this regex, so a label pin could not tell a widened pattern from a
      // reverted one. And the failure it guards is BLIND, not red: reverting
      // `.rs` from the pattern does not make a check fail, it makes every
      // `main.rs` citation stop being a citation at all, so the cited total
      // drops and every remaining anchor still resolves. A check that stops
      // checking and reports nothing is the worst available failure mode, which
      // is exactly why this asserts on the PARSED SET - the thing that would
      // silently shrink.
      //
      // Asserted on a synthetic document, so it keeps working if the document
      // ever stops citing Rust. It would otherwise be a claim about the prose
      // rather than about the capability.
      'a `.rs` citation is parsed as a citation at all',
      rustAnchorIsParsed(citedAnchors, rustCodeLine),
    ],
  ];
}

/**
 * `main.rs:NNN` must produce a resolvable anchor.
 *
 * The load-bearing half is `anchors.length === 1` with `name === 'main.rs'`:
 * a reverted pattern yields ZERO anchors for a document that contains one, so
 * the case fails on the missing citation rather than on anything the checker
 * reported about it. The `ok` half then covers the index filter and the roots,
 * because an anchor that is parsed but unresolvable fails there.
 */
function rustAnchorIsParsed(citedAnchors, line) {
  return withDoc(citedAnchors, 'See `main.rs:' + line + '` here.\n', () => {
    const anchors = citedAnchors();
    return anchors.length === 1 && anchors[0].name === 'main.rs' && anchors[0].ok;
  });
}

/**
 * Exactly one citation in, exactly one resolved anchor out.
 *
 * The count is load-bearing. `every((a) => a.ok)` over an EMPTY parsed set is
 * vacuously true, so a pattern that stopped matching anything at all would
 * report PASS for the "a real citation passes" case — the check stops checking
 * and says so. Asserting `length === 1` on a document that contains exactly one
 * citation closes that hole.
 */
function oneAnchorResolves(citedAnchors, name, line) {
  return withDoc(citedAnchors, 'See `' + name + ':' + line + '` here.\n', () => {
    const anchors = citedAnchors();
    return anchors.length === 1 && anchors[0].ok;
  });
}

// ── the skip ceiling ─────────────────────────────────────────────────────────
//
// WHY THESE ARE BEHAVIOURAL AND NOT IN `src/policy/`. The coverage guard pins
// claim LABELS, which is a shape test: it cannot tell whether the ceiling
// compares anything, and the three ways this could be broken all leave a
// label-pinning guard green.
//
//   1. the comparison inverted (`observed >= permitted` instead of `<=`);
//   2. the accounting reduced to a summary count, so an unnamed skip inside the
//      ceiling passes;
//   3. the empty-set case left vacuous, so a broken derivation that finds zero
//      entries reports "0 observed <= 0 permitted" and passes.
//
// The first is the one the requirement names: a ceiling that does not bite is
// worse than the equality it replaced. These cases drive the REAL
// `reportSuite` with synthetic counts and a synthetic document, so they exercise
// the claim path rather than a helper the claim path happens to call — which is
// why `reportSuite` takes `doc` as a parameter instead of closing over the real
// AGENTS.md.

/**
 * A `root **N total** (F files)` sentence plus a ceiling sentence.
 *
 * `win32Ceiling`/`otherCeiling` are the document's TWO arms and are separate
 * parameters rather than one `ceiling`, because a single number could not express
 * the cases that matter: a document stating only the win32 arm, or stating an arm
 * the current platform does not select. Deriving them from `runIf` by default
 * keeps every existing case writing what it means ("the tree, restated") instead
 * of repeating `runIf + 1` at two dozen call sites.
 */
function docFor({ total, files, runIf, win32Guards = 1, win32Ceiling, otherCeiling }) {
  const w32 = win32Ceiling ?? runIf + win32Guards;
  const other = otherCeiling ?? runIf;
  return [
    `root **${total} total** (${files} files)`,
    `The skip is a NAMED CEILING, skip ceiling **${w32} on win32 / ${other} on non-win32** (${win32Guards} win32 platform skip + ${runIf} test.runIf prerequisites)`,
  ].join('\n');
}

const COUNT_RE = /root \*\*(\d+) total(?: [^**]*)?\*\*/;
const FILES_RE = /root \*\*\d+ total(?: [^**]*)?\*\* \((\d+) files\)/;
const CEILING_RE =
  /skip ceiling \*\*(\d+) on win32 \/ (\d+) on non-win32\*\* \((\d+) win32 platform skip \+ (\d+) test\.runIf prerequisites\)/;

// THE FOREIGN PLATFORM. Every per-platform case is driven against a platform
// that is NOT `process.platform`, so the case is meaningful on every machine. A
// self-test that used the running platform would pass on Windows and assert
// nothing on Linux — which is the exact asymmetry this whole item exists to
// remove. `…pth` keeps it off any real `process.platform` value, and
// `FOREIGN_PLATFORM !== process.platform` is asserted below as a count.
const FOREIGN_PLATFORM = 'not-win32';

/**
 * A synthetic run: the four counts, a file count, the COLLECTED file list, and
 * per-assertion skips.
 *
 * `filesList` is a parameter rather than a fixed `[]` because it is what
 * `declaredSkipEntries` reads to size the ceiling, and hardcoding it to empty
 * made every case derive the platform guard alone — so the document's
 * `runIf` half was compared against 0 and the cardinality claim was red for a
 * reason that had nothing to do with the case under test. MEASURED: that is
 * exactly what happened, and the failure read as "the document is wrong" when
 * the fixture was. A synthetic input that silently does not reach the code under
 * test is the fixture's bug, and it is indistinguishable from a real failure
 * unless the input is checked.
 */
function countsFor({ tests, passed, failed = 0, skipped = 0, files = 1, filesList = [], skips = [], exit = 0 }) {
  return {
    ok: true,
    collectError: false,
    exit,
    tests,
    passed,
    failed,
    skipped,
    todos: 0,
    files,
    filesList,
    problem: null,
    skipDetail: skips.map((s) => ({ file: s.file, title: s.title })),
  };
}

/**
 * Drive one root-suite claim against a synthetic document and run.
 *
 * `platform` defaults to the RUNNING platform, because most cases are about
 * cardinalities that are the same on either. The per-platform cases pass it
 * explicitly and are the only ones that do.
 */
function ceilingRun({ deps, doc, counts, platform }) {
  const { reportSuite, resetResults, readResults } = deps;
  resetResults();
  reportSuite({
    doc,
    counts,
    countRe: COUNT_RE,
    filesRe: FILES_RE,
    runLabel: 'root vitest (no failures)',
    testsLabel: 'root vitest tests',
    skippedLabel: 'root vitest skipped',
    filesLabel: 'root vitest files',
    testsMetric: 'total',
    skipCheck: 'ceiling',
    ceilingRe: CEILING_RE,
    ceilingLabel: 'root vitest skip ceiling',
    platform,
  });
  const rows = readResults();
  return {
    rows,
    byName: new Map(rows.map((r) => [r.name, r])),
  };
}

/** The status of one claim, or `'ABSENT'` — never `'ok'` for a missing row. */
function statusOf(run, name) {
  return run.byName.get(name)?.status ?? 'ABSENT';
}

export function selfTestSkipCeiling({ ROOT, declaredSkipEntries, ceilingEntries, skipCeilingVerdict, ...deps }) {
  // `declaredSkipEntries` is handed a file list, so these cases control the
  // ceiling's size exactly by choosing which files to scan. The real
  // `test/release-verify-boot.test.ts` carries two `test.runIf` sites and no
  // `skipIf`, so scanning it ALONE plus the declared platform guard is a
  // three-entry ceiling with no fixture file.
  //
  // THE PLATFORM ENTRY IS NOT OPTIONAL, and getting this wrong is the trap: it is
  // located by a literal condition in `src/daemon.test.ts`, NOT by the file list,
  // so it is derived in EVERY case below. A self-test that assumed the ceiling was
  // exactly the `runIf` count would document a number the script never produces.
  const twoEntryFile = join(ROOT, 'test/release-verify-boot.test.ts');
  const { entries: realTwo, problems: realTwoProblems } = declaredSkipEntries([twoEntryFile]);
  // Both halves asserted as COUNTS, not truthiness, and both asserted NON-ZERO:
  // a case written against a scan that silently found nothing would pass on
  // `0 <= 0` and prove nothing. This is the standing rule about predicates over
  // an empty set, applied to a count. The split is the document's own split —
  // 1 declared guard plus N `runIf` sites — because the claim checks the halves
  // separately, so a self-test that used one number for both would be testing a
  // weaker claim than the checker makes.
  const ceilingCount = realTwo.length;
  const runIfCount = realTwo.filter((e) => e.kind === 'runIf').length;
  const platformCount = ceilingCount - runIfCount;
  const shapeOk = realTwoProblems.length === 0 && ceilingCount > 0 && runIfCount > 0 && platformCount === 1;

  // A synthetic run whose skips are the REAL derived entries, so the
  // "all observed skips are named" case uses titles the derivation actually
  // produced rather than invented ones that could not match. One of the three
  // entries is the platform guard, whose title comes from the real
  // `src/daemon.test.ts` — so an entry whose title stopped being read from the
  // file breaks this case too, which is the coupling that makes it worth having.
  const named = realTwo.map((e) => ({ file: e.file, title: e.title }));
  // The file list is what makes the derivation return `ceilingCount` entries, so
  // it is part of every synthetic run. Omitting it would derive 1 (the platform
  // guard alone) while the document claimed 3, and the cardinality claim would be
  // red for a reason that has nothing to do with the case under test.
  const namedCounts = (skipped, skips) =>
    countsFor({ tests: 100, passed: 100 - skipped, skipped, files: 1, filesList: [twoEntryFile], skips });

  // ── the per-platform cases ────────────────────────────────────────────────
  //
  // WHY THESE EXIST AND WHY THEY CANNOT BE WRITTEN ANY OTHER WAY. The ceiling's
  // one declared guard is `test.skipIf(process.platform === 'win32')`, so it
  // contributes to the ceiling on Windows and on nothing else. A document that
  // stated one number would therefore be red on every non-Windows machine —
  // including, on the evidence of the previous revision, every machine the
  // author never ran. These cases assert the property that fixes it, and they
  // assert it on BOTH sides of the predicate rather than only the side the test
  // host happens to be on.
  //
  // WHAT IS DERIVED HERE RATHER THAN ASSUMED. `win32Arm` and `otherArm` come from
  // `ceilingEntries` over the REAL derived entries, so a case cannot pass by
  // restating a number this file made up. `otherArm` is asserted to be exactly
  // `runIfCount`, which is what makes the difference falsifiable: if the declared
  // guard were no longer the only platform entry, or if `firesOn` were dropped,
  // the two arms would coincide and every case below would stop discriminating.
  const realEntries = realTwo;
  const win32Arm = ceilingEntries(realEntries, 'win32').length;
  const otherArm = ceilingEntries(realEntries, FOREIGN_PLATFORM).length;
  // STANDING RULE, applied to the fixture rather than to the tree: a predicate
  // that is trivially true on the host is a case that asserts nothing. Asserted
  // as a count/fact, and `otherArm < win32Arm` is the non-vacuity condition —
  // without it the two arms could be equal and the "wrong arm rejected" cases
  // would be rejecting a document that states the right number.
  const armsDiscriminate =
    FOREIGN_PLATFORM !== process.platform &&
    win32Arm > 0 &&
    otherArm > 0 &&
    otherArm < win32Arm &&
    win32Arm === runIfCount + platformCount &&
    otherArm === runIfCount;

  return [
    // 1. The document's cardinality matching the tree passes, and that is the
    //    ONLY way the cardinality claim passes.
    [
      'the ceiling cardinality claim passes when the document restates the tree',
      // `shapeOk` is conjoined rather than assumed, so this case cannot pass on a
      // derivation that found nothing: a scan returning 0 entries would make
      // `ceilingCount - 1` negative and the "understated" case below meaningless.
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: namedCounts(0, []),
        }),
        'root vitest skipped',
      ) === 'ok' && shapeOk,
    ],
    [
      // The direction the requirement exists for: a document that understates
      // the ceiling is red, which is what makes adding a `runIf` without
      // raising the ceiling a visible failure.
      'a document that understates the ceiling is rejected',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount - 1 }),
          counts: namedCounts(0, []),
        }),
        'root vitest skipped',
      ) === 'FAIL',
    ],
    [
      // The compensating-error guard: the arms are right and the `runIf` half is
      // wrong. A bare-sum check would pass this.
      'correct ceiling arms with a wrong runIf half are rejected',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount + 1 }),
          counts: namedCounts(0, []),
        }),
        'root vitest skipped',
      ) === 'FAIL',
    ],

    // 2. THE CEILING BITES.
    [
      // EVERY declared entry is active and one more skip arrives on top, so
      // `observed = ceilingCount + 1 > permitted = ceilingCount` and the extra
      // one matches nothing. Both ceiling conditions hold at once, which is the
      // real shape of "the suite gained a skip" — the case asserts only that the
      // claim is red, because which of the two conditions fires is a
      // message-quality question and red is the requirement.
      'observed skips above the ceiling are rejected',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: namedCounts(ceilingCount + 1, [
            ...named,
            { file: named[0].file, title: 'an extra skip nobody declared' },
          ]),
        }),
        'root vitest skip ceiling',
      ) === 'FAIL' && shapeOk,
    ],
    [
      // THE COUNT CHECK, IN ISOLATION — and this case exists because the two
      // above do not pin it. MEASURED while break-testing: with
      // `overCeiling` forced to `false`, BOTH cases above still passed, because a
      // suite that genuinely gains skips gains UNDECLARED ones, so the naming
      // check fired and carried the verdict. The count comparison was untested.
      //
      // The shape that reaches it alone is a skip whose title REPEATS: a
      // `test.runIf` guard over a `test.each` produces one skipped assertion PER
      // ROW, all carrying the same title, so the run observes more skips than
      // there are entries while every one of them IS attributable. That is a real
      // vitest behaviour, not a contrived one, and it is the only shape where the
      // two conditions can disagree.
      //
      // `repeated` is a count, not a boolean, for the standing reason: `every()`
      // over an empty is true.
      'observed skips beyond the ceiling are rejected when all of them are named',
      (() => {
        const repeated = [named[0], named[0], named[1], named[2]].filter(Boolean);
        return (
          repeated.length > ceilingCount &&
          new Set(repeated.map((s) => `${s.file}\u0000${s.title}`)).size === named.length &&
          statusOf(
            ceilingRun({
              deps,
              doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
              counts: namedCounts(repeated.length, repeated),
            }),
            'root vitest skip ceiling',
          ) === 'FAIL'
        );
      })(),
    ],
    [
      // The case a bare count CANNOT catch, and the reason the accounting exists:
      // `2 <= ceilingCount` is comfortably true, and one of the two skips matches
      // no declared entry. A ceiling that only compared integers would pass this,
      // which is precisely the "13, none of which I can account for" reading the
      // requirement names. The invented title is deliberately unlike any real one.
      'a skip within the ceiling that matches no declared entry is rejected',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: namedCounts(2, [
            named[0],
            { file: named[0].file, title: 'a skip nobody declared' },
          ]),
        }),
        'root vitest skip ceiling',
      ) === 'FAIL' && shapeOk,
    ],
    [
      // The positive case for the same code path, so the two above cannot be
      // satisfied by a check that rejects everything. A claim pinned only on its
      // failure modes is a claim that cannot pass.
      //
      // Every declared entry active, none invented: the ceiling holds and every
      // skip is named. This is the "all 13 of 13 permitted" case the
      // requirement asks a reader to be able to distinguish from the other one.
      'observed skips within the ceiling and all named are accepted',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: namedCounts(ceilingCount, named),
        }),
        'root vitest skip ceiling',
      ) === 'ok' && shapeOk,
    ],

    // 3. The vacuous-true guards.
    [
      // The smallest derivation the checker can produce. `declaredSkipEntries([])`
      // scans no file, so the ONLY entry is the declared platform guard — and
      // asserting that count is 1 is what makes the next case meaningful, because
      // "an unnamed skip is caught" is only a claim if the ceiling was not empty.
      //
      // A count assertion rather than a truthiness one, per the standing rule
      // about predicates over an empty set. If the declared platform guard ever
      // stopped resolving, this reads 0 and the case goes red, which is correct:
      // the ceiling would then be empty and every check over it vacuous.
      'an empty file list still derives exactly the one declared platform guard',
      declaredSkipEntries([]).entries.length === 1 &&
        declaredSkipEntries([]).entries[0].kind === 'platform' &&
        declaredSkipEntries([]).problems.length === 0,
    ],
    [
      // Against that minimal one-entry ceiling: a run observing two skips, neither
      // of which is the platform guard. `unaccounted` is 2, so the claim is red
      // even though `2 <= 1` is... false, which is the other half. The point of
      // the pair is that BOTH the bound and the naming are load-bearing, and a
      // check that enforced only one of them would pass a case the other rejects.
      'a run observing more skips than the ceiling permits is rejected',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          // `filesList: []` → the derived ceiling is 1 (the platform guard only),
          // while the document claims ceilingCount, so the CARDINALITY claim is
          // red too. The run-check is what this case is about, and it is red for
          // its own reason: 2 observed, 1 permitted.
          counts: countsFor({
            tests: 100,
            passed: 98,
            skipped: 2,
            files: 1,
            filesList: [],
            skips: [
              { file: 'a.test.ts', title: 'nobody declared this' },
              { file: 'b.test.ts', title: 'nor this' },
            ],
          }),
        }),
        'root vitest skip ceiling',
      ) === 'FAIL',
    ],
    [
      // The other vacuous shape, asserted on the verdict function directly: a run
      // with skips and no entry able to match any of them. `active.length === 0`
      // alongside `unaccounted.length > 0` is the broken-accounting signature, and
      // it must not read as a pass.
      'a run with skips and zero active entries is rejected',
      (() => {
        const v = skipCeilingVerdict([], countsFor({ tests: 4, passed: 2, skipped: 2, skips: [
          { file: 'a.ts', title: 'x' },
          { file: 'b.ts', title: 'y' },
        ] }));
        return v.unaccounted.length === 2 && v.active.length === 0 && v.permitted === 0;
      })(),
    ],

    // 4. The real run, end to end through the derivation.
    [
      // The real tree, the real guard sites, every one of them NAMED. This is the
      // case that would fail if `guardedTestSites` stopped finding sites (the set
      // would empty and nothing would be accounted for) or if the titles drifted
      // out of sync with the reporter's.
      //
      // Non-emptiness is asserted as a count, per the standing rule: "every entry
      // has a title" over an empty set is true and worthless.
      'every declared skip guard in the real tree has a non-empty title',
      realTwoProblems.length === 0 &&
        realTwo.length > 0 &&
        realTwo.every((e) => typeof e.title === 'string' && e.title.length > 0),
    ],
    [
      // Both entries are distinguishable by (file, title), which is the key the
      // accounting matches on. If two guards in one file shared a title the set
      // would collapse and one entry could be double-counted as two skips.
      'declared skip guards in one file are distinguishable by title',
      new Set(realTwo.map((e) => `${e.file}\u0000${e.title}`)).size === realTwo.length,
    ],
    [
      // The real platform guard is located, and the runIf sites are not counted
      // as platform entries. One entry of `kind === 'platform'`, located in
      // `src/daemon.test.ts` by its literal condition.
      'the declared win32 platform guard resolves to exactly one entry',
      (() => {
        const { entries, problems } = declaredSkipEntries([
          join(ROOT, 'src/daemon.test.ts'),
          twoEntryFile,
        ]);
        const platform = entries.filter((e) => e.kind === 'platform');
        const runIf = entries.filter((e) => e.kind === 'runIf');
        return (
          problems.length === 0 &&
          platform.length === 1 &&
          platform[0].file === 'src/daemon.test.ts' &&
          platform[0].condition === "process.platform === 'win32'" &&
          // The TOTAL is checked as a sum of the two named halves, and
          // `runIf.length` is asserted as a COUNT rather than inferred. This is
          // the case that would go red if a `runIf` inside `src/daemon.test.ts`
          // were counted once as a platform guard and once as a `runIf` entry —
          // that file declares 2 `skipIf` sites and 0 `runIf` sites, and the
          // `skipIf(process.platform !== 'win32')` sibling must contribute
          // nothing, because it RUNS on this platform and skips nothing.
          runIf.length === runIfCount &&
          entries.length === platform.length + runIf.length
        );
      })(),
    ],

    // 5. The strictness the ruling adds, in the OTHER direction: the total.
    [
      // The claim moved from `numPassedTests` to `numTotalTests`, and this is the
      // case that pins the move. A document stating the PASS count and a run
      // whose passes differ from its total must be rejected — which is the state
      // this repository was in, and it is the reason the change was needed.
      'a document stating the pass count is rejected when passes differ from the total',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount })
            .replace('root **100 total**', 'root **99 total**'),
          counts: namedCounts(0, []),
        }),
        'root vitest tests',
      ) === 'FAIL',
    ],
    [
      // And the positive half: the total as stated is accepted. A claim pinned
      // only on its failure modes cannot pass, so this is not optional.
      'a document stating the total is accepted',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: countsFor({ tests: 100, passed: 87, files: 1 }),
        }),
        'root vitest tests',
      ) === 'ok',
    ],
    [
      // A SHORTER suite is a failure, which is the "a suite that loses a test so
      // the total drops goes red" requirement. 99 tests observed against 100
      // documented.
      'a suite that loses a test is rejected against the documented total',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: countsFor({ tests: 99, passed: 87, files: 1 }),
        }),
        'root vitest tests',
      ) === 'FAIL',
    ],
    [
      // The EQUALITY branch, which is the one the ceiling path never reaches —
      // and which is therefore the one a self-test made only of ceiling cases
      // would never run. `reportSuite` read its second group from a hoisted `m`
      // that only the ceiling path had removed, and every ceiling case passed
      // while `npm run docs:verify` died with `ReferenceError: m is not
      // defined` on the DESKTOP call. MEASURED. Two things follow and both are
      // asserted here: the equality branch must still compare the skip count, and
      // it must do so by reading the document itself.
      'the equality skip branch still compares the documented skip count',
      (() => {
        const { reportSuite, resetResults, readResults } = deps;
        resetResults();
        reportSuite({
          doc: 'desktop **100 passed + 0 skipped** (1 files)',
          counts: countsFor({ tests: 100, passed: 100, skipped: 0, files: 1 }),
          countRe: /desktop \*\*(\d+) passed \+ (\d+) skipped(?: [^**]*)?\*\*/,
          filesRe: /desktop \*\*\d+ passed \+ \d+ skipped(?: [^**]*)?\*\* \((\d+) files\)/,
          runLabel: 'desktop vitest (no failures)',
          testsLabel: 'desktop vitest tests',
          skippedLabel: 'desktop vitest skipped',
          filesLabel: 'desktop vitest files',
        });
        const rows = readResults();
        const row = rows.find((r) => r.name === 'desktop vitest skipped');
        return rows.length === 4 && row !== undefined && row.status === 'ok';
      })(),
    ],
    [
      // And the same branch rejects a WRONG skip count, so the case above cannot
      // pass by finding the row and accepting whatever it says.
      'the equality skip branch rejects a wrong documented skip count',
      (() => {
        const { reportSuite, resetResults, readResults } = deps;
        resetResults();
        reportSuite({
          doc: 'desktop **100 passed + 3 skipped** (1 files)',
          counts: countsFor({ tests: 100, passed: 100, skipped: 0, files: 1 }),
          countRe: /desktop \*\*(\d+) passed \+ (\d+) skipped(?: [^**]*)?\*\*/,
          filesRe: /desktop \*\*\d+ passed \+ \d+ skipped(?: [^**]*)?\*\* \((\d+) files\)/,
          runLabel: 'desktop vitest (no failures)',
          testsLabel: 'desktop vitest tests',
          skippedLabel: 'desktop vitest skipped',
          filesLabel: 'desktop vitest files',
        });
        const row = readResults().find((r) => r.name === 'desktop vitest skipped');
        return row !== undefined && row.status === 'FAIL';
      })(),
    ],
    [
      // A REAL FAILURE still goes red, and separately: the run claim is not the
      // count claim, so a failing suite with the documented total present is
      // still red. This is the third strictness requirement.
      'a real test failure is rejected even when the documented total matches',
      statusOf(
        ceilingRun({
          deps,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: countsFor({ tests: 100, passed: 86, failed: 1, files: 1 }),
        }),
        'root vitest (no failures)',
      ) === 'FAIL',
    ],

    // 6. THE PER-PLATFORM CASES. This is what the ruling asked for, and it is
    //    the section that cannot be written as a single-arm case.
    //
    //    Each case is driven at an EXPLICIT platform, and `FOREIGN_PLATFORM` is
    //    chosen so it differs from the running one, which is asserted by
    //    `armsDiscriminate`. Together that means these cases are the same case on
    //    Windows and on Linux: nothing here reads `process.platform` to decide
    //    what it expects.
    [
      // The non-vacuity precondition, as its own case. Every case below is
      // conjoined with it so none of them can pass on a tree where the two arms
      // coincide — which is what a deleted `firesOn` would produce, and a
      // coincidence would make "the wrong arm is rejected" reject a correct
      // document for the wrong reason. A count/fact assertion rather than a
      // truthiness one, per the standing rule.
      'the two platform arms differ, and the foreign platform is not this one',
      armsDiscriminate,
    ],
    [
      // The arm SELECTED follows the platform. On win32 the document must state
      // `runIf + 1`; on a foreign platform it must state `runIf`. Both are
      // asserted against a document whose arms are derived from the tree, so a
      // pass means "the checker compared the number for THIS platform".
      //
      // Note what is NOT claimed: this does not execute on Linux. It drives the
      // checker's platform parameter with a non-win32 value, which is proof the
      // derivation is a function of the predicate and not a property of the host.
      'the ceiling cardinality claim compares the arm the platform selects',
      statusOf(
        ceilingRun({
          deps,
          platform: 'win32',
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: namedCounts(0, []),
        }),
        'root vitest skipped',
      ) === 'ok' &&
        statusOf(
          ceilingRun({
            deps,
            platform: FOREIGN_PLATFORM,
            doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
            counts: namedCounts(0, []),
          }),
          'root vitest skipped',
        ) === 'ok' &&
        armsDiscriminate,
    ],
    [
      // THE CASE THE RULING EXISTS FOR, and the one a single-arm document could
      // not express: a document carrying only the win32 number is RED on the
      // foreign platform, because the ceiling there is one lower. This is the
      // exact failure of the previous revision — correct on Windows, wrong
      // everywhere else — driven from the wrong-platform side.
      'a document stating only the win32 ceiling is rejected on a non-win32 platform',
      statusOf(
        ceilingRun({
          deps,
          platform: FOREIGN_PLATFORM,
          // Both arms carry the win32 figure: the composition is self-consistent
          // and the `runIf` half is right, so ONLY the non-win32 arm can be what
          // rejects it. A check that simply compared the win32 arm would pass
          // this document, which is why it is built this way.
          doc: docFor({
            total: 100,
            files: 1,
            runIf: runIfCount,
            win32Ceiling: win32Arm,
            otherCeiling: win32Arm,
          }),
          counts: namedCounts(0, []),
        }),
        'root vitest skipped',
      ) === 'FAIL' && armsDiscriminate,
    ],
    [
      // And the mirror: a document carrying only the non-win32 figure is RED on
      // win32. Together the two cases are what stop the checker from having
      // quietly become "compare the non-win32 arm" — a regression that every
      // Windows run would report green.
      'a document stating only the non-win32 ceiling is rejected on win32',
      statusOf(
        ceilingRun({
          deps,
          platform: 'win32',
          doc: docFor({
            total: 100,
            files: 1,
            runIf: runIfCount,
            win32Ceiling: otherArm,
            otherCeiling: otherArm,
          }),
          counts: namedCounts(0, []),
        }),
        'root vitest skipped',
      ) === 'FAIL' && armsDiscriminate,
    ],
    [
      // The 27-arm arithmetic bug, pinned. The first per-platform version derived
      // each arm as `runIf + declared` where `declared` was itself a
      // platform-filtered count over ALL entries — so the win32 arm double-counted
      // the 13 `runIf` sites and read 27 for a 14-entry tree. MEASURED against a
      // document stating 14, which is the only thing that caught it.
      //
      // Pinned as a case because it is the shape of mistake that survives every
      // other ceiling assertion: the two arms still DIFFER, both are wrong in the
      // same direction, and the wrong-document cases still reject the right
      // documents. This asserts each arm equals `ceilingEntries` at its own
      // platform and that the full set is the win32 arm — the only formulation a
      // half-sum cannot satisfy.
      'each ceiling arm equals the platform-scoped entry count, not a sum of halves',
      win32Arm === ceilingEntries(realEntries, 'win32').length &&
        otherArm === ceilingEntries(realEntries, FOREIGN_PLATFORM).length &&
        win32Arm === realEntries.length &&
        otherArm < realEntries.length,
    ],
    [
      // The RUN claim moves with the platform too, not just the cardinality
      // claim. A suite on a foreign platform observing `runIfCount` skips, all of
      // them named, is within the foreign ceiling; the same suite observing one
      // more, every skip still attributable, is NOT. This is the per-platform twin
      // of the "beyond the ceiling but all named" case, and it is the one that
      // matters operationally — the cardinality claim describes the document
      // while this one binds the run.
      //
      // The shape is a repeated title, because that is the only shape where the
      // bound and the accounting disagree (a `test.each` under one `runIf`).
      'the run ceiling drops on a platform the declared guard cannot fire on',
      (() => {
        const dup = [named[1], named[2]].filter(Boolean).map((s) => ({ ...s }));
        const observed = win32Arm;
        const allNamed = new Set(dup.map((s) => `${s.file}\u0000${s.title}`)).size === dup.length;
        const tooManyHere =
          statusOf(
            ceilingRun({
              deps,
              platform: 'win32',
              doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
              counts: namedCounts(observed, [...named, ...dup.slice(0, observed - runIfCount)]),
            }),
            'root vitest skip ceiling',
          ) === 'ok';
        const tooManyThere =
          statusOf(
            ceilingRun({
              deps,
              platform: FOREIGN_PLATFORM,
              doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
              counts: namedCounts(observed, [...named, ...dup.slice(0, observed - runIfCount)]),
            }),
            'root vitest skip ceiling',
          ) === 'FAIL';
        return observed > otherArm && allNamed && tooManyHere && tooManyThere && armsDiscriminate;
      })(),
    ],
    [
      // The ZERO-permitted guard, and it is asserted as a case because it is
      // reachable: forcing a platform that no entry fires on derives a ceiling of
      // 0, where `0 <= 0` holds and every skip is still attributable, so without
      // the check the run claim would report green on a vacuous ceiling. The
      // fixture uses an empty file list so the ceiling is exactly the declared
      // platform guard, then drives a platform it does not fire on.
      'a ceiling with no entry firing on the platform is rejected rather than vacuous',
      statusOf(
        ceilingRun({
          deps,
          platform: FOREIGN_PLATFORM,
          doc: docFor({ total: 100, files: 1, runIf: runIfCount }),
          counts: countsFor({
            tests: 100,
            passed: 100,
            skipped: 0,
            files: 1,
            filesList: [],
            skips: [],
          }),
        }),
        'root vitest skip ceiling',
      ) === 'FAIL' && platformCount === 1 && FOREIGN_PLATFORM !== 'win32',
    ],
  ];
}

function withDoc(citedAnchors, doc, fn) {
  const saved = globalThis.__agentsOverride;
  globalThis.__agentsOverride = doc;
  try {
    return fn();
  } finally {
    globalThis.__agentsOverride = saved;
  }
}

function anchorsRejectWith(citedAnchors, doc, re) {
  return withDoc(citedAnchors, doc, () => {
    const bad = citedAnchors().filter((a) => !a.ok);
    return bad.length > 0 && bad.some((b) => re.test(b.why));
  });
}
