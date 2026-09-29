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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The four behaviours a code review found missing or vacuous. */
export function selfTestCitedAnchors(ROOT, citedAnchors) {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const daemonLines = readFileSync(join(ROOT, 'src/daemon.ts'), 'utf8').split('\n');

  // A line that is real code, and a line that is only a comment.
  const codeLine = daemonLines.findIndex((l) => l.trimStart().startsWith('import ')) + 1;
  const commentLine = daemonLines.findIndex((l) => /^\s*\/\//.test(l)) + 1;
  const pastEnd = daemonLines.length + 500;

  const cite = (n) => '\n\nSee `daemon.ts:' + n + '` here.\n';

  return [
    [
      'a citation to a real code line passes',
      anchorsAllOk(citedAnchors, agents + cite(codeLine)),
    ],
    [
      // The drift class the whole check exists for: `daemon.ts:509` pointed at a
      // comment for a full cycle while the gate stayed green.
      'a citation to a COMMENT line is rejected',
      anchorsRejectWith(citedAnchors, agents + cite(commentLine), /line is a line comment/),
    ],
    [
      'a citation past the end of the file is rejected',
      anchorsRejectWith(citedAnchors, agents + cite(pastEnd), /has \d+ lines/),
    ],
    [
      // `vault.ts` exists twice in this tree. First-match-wins resolved it to
      // `src/memory/vault.ts` (the Obsidian scaffolder) and validated a citation
      // about the keyring against an unrelated line.
      'an ambiguous basename is rejected, not guessed',
      anchorsRejectWith(citedAnchors, agents + '\n\nSee `vault.ts:1` here.\n', /ambiguous basename/),
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

function anchorsAllOk(citedAnchors, doc) {
  return withDoc(citedAnchors, doc, () => citedAnchors().every((a) => a.ok));
}

function anchorsRejectWith(citedAnchors, doc, re) {
  return withDoc(citedAnchors, doc, () => {
    const bad = citedAnchors().filter((a) => !a.ok);
    return bad.length > 0 && bad.some((b) => re.test(b.why));
  });
}
