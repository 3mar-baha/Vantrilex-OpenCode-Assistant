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
