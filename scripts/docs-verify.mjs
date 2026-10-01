#!/usr/bin/env node
// docs:verify — mechanically re-derive every number AGENTS.md claims, and fail
// if the code disagrees. AGENTS.md is the ONLY audit surface: README.md,
// docs/10-CHECKPOINT.md and CONTRIBUTING.md are read by no check here, and the
// exemption is stated at the UNVERIFIED gate below rather than implied here.
//
// WHY THIS EXISTS. The five highest-severity process defects in this repository
// were not code bugs; they were documents asserting things the code contradicted.
// AGENTS.md claimed "0 dead modules" when 7 were dead, listed a test stage that
// did not exist, quoted test counts a full cycle behind, described a crypto
// defect that had been fixed, and claimed 62 type errors in a script that ran at
// 0. Nothing caught any of it, because a green gate says nothing about prose.
//
// DESIGN RULE: this script contains NO expected values. Every "documented" figure
// is parsed out of the markdown and every "derived" figure is computed from the
// live tree, the live test runs, or package.json. If you add a number to a doc,
// this script compares it against reality — it does not know what the number is
// supposed to be. That is the only way the check stays honest as the repo moves.
//
// Exit code 0 = every claim matches. 1 = at least one does not. Anything that
// cannot be derived is reported UNVERIFIED, never assumed to pass.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
// An override root lets a test drive this script against a COPY of AGENTS.md
// without touching the real one. Behavioural guards need that; asserting on
// this file's source instead only proves the source contains the text.
// DOCS_VERIFY_ROOT overrides only where AGENTS.md is READ FROM, so a test can
// drive the script against a copy of the document without copying the whole tree.
// Everything else - the source, the tests, package.json - is read from the real
// repository, because copying 58 modules and running vitest per assertion would
// make the guard slower than the thing it guards.
const DOC_ROOT = process.env.DOCS_VERIFY_ROOT ?? process.cwd();
const ROOT = process.cwd();
const results = [];
// Per-suite ceiling detail for the section printed after the table. The table
// cell is CLAMPED (see CELL below), so a 14-entry list cannot fit in it and a
// clamped list is a list a reader cannot check. The full enumeration is printed
// unclamped, which is what makes "which declared reasons were active in this
// run" answerable rather than asserted.
const skipCeilingReport = [];
const add = (name, documented, derived, status) => results.push({ name, documented, derived, status });
const fail = (name, doc, der) => add(name, doc, der, 'FAIL');
const pass = (name, doc, der) => add(name, doc, der, 'ok');
const unverified = (name, doc, der) => add(name, doc, der, 'UNVERIFIED');

// ── helpers ──────────────────────────────────────────────────────────────────

function read(p) {
  return readFileSync(join(ROOT, p), 'utf8');
}

/** Walk src/ resolving BOTH static and dynamic relative specifiers. */
function reachability() {
  const SRC = join(ROOT, 'src');
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
    return out;
  };
  const all = walk(SRC);
  const live = new Set();
  const queue = [join(SRC, 'daemon.ts'), join(SRC, 'cli.ts')].filter(existsSync);
  while (queue.length > 0) {
    const file = queue.pop();
    if (live.has(file)) continue;
    live.add(file);
    const src = readFileSync(file, 'utf8');
    // Any quoted relative specifier: `from './x.js'`, `import('./x.js')`, re-exports.
    for (const m of src.matchAll(/['"](\.[^'"]+)\.js['"]/g)) {
      const target = resolve(dirname(file), `${m[1]}.ts`);
      if (existsSync(target) && !live.has(target)) queue.push(target);
    }
  }
  let lines = 0;
  for (const f of live) lines += readFileSync(f, 'utf8').split('\n').length;
  // "Dead" means: not shipped AND not exercised by any test. A module used
  // only by a test suite - claim-matcher.ts is the live example - is neither a
  // shipping cost nor dead code, and counting it as dead once inflated the
  // figure from 7 to 8 and pointed at a Laya regression that does not exist.
  // NOTE: `all` was built by a walk that EXCLUDES .test.ts, so filtering it
  // for test files can only ever yield an empty set. The first version of this
  // fix did exactly that and silently changed nothing - which is the third time
  // in this repository that a correct-looking edit was a no-op, and the reason
  // each one was caught is that a number moved that should not have.
  const testFiles = [];
  const collectTests = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) collectTests(p);
      else if (p.endsWith('.test.ts')) testFiles.push(p);
    }
  };
  collectTests(SRC);
  const byTest = new Set();
  const tq = [...testFiles];
  while (tq.length > 0) {
    const f = tq.pop();
    if (byTest.has(f)) continue;
    byTest.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/['"](\.[^'"]+)\.js['"]/g)) {
      const t = resolve(dirname(f), `${m[1]}.ts`);
      if (existsSync(t) && !byTest.has(t)) tq.push(t);
    }
  }
  // THREE categories, because collapsing any two has produced a wrong number
  // here twice: counting test-only modules as dead reported 8, and subtracting
  // the test-reachable set wholesale reported 1. Both were "true" of a different
  // question than the one the document asks.
  //
  //   live        reachable from a production entrypoint, so it ships
  //   guarded     reachable only from a test that asserts it must NOT load. The
  //               Laya set is this: dead by decision, and a test imports it to
  //               keep it that way. Reporting it inside the dead set would
  //               understate a set the owner tracks by name.
  //   dead        neither: nothing can execute it
  //   scaffolding reachable only from a test that uses it (claim-matcher.ts)
  const LAYA = /[\\/]runtime[\\/]laya[\\/]/;
  const deadFiles = all.filter((f) => !live.has(f) && !byTest.has(f));
  const guardedFiles = all.filter((f) => !live.has(f) && byTest.has(f) && LAYA.test(f));
  const scaffoldingFiles = all.filter(
    (f) => !live.has(f) && byTest.has(f) && !LAYA.test(f),
  );
  return {
    live: live.size,
    dead: deadFiles.length,
    guarded: guardedFiles.length,
    scaffolding: scaffoldingFiles.length,
    lines,
    all: all.length,
  };
}

/**
 * The reporter's own reason for a non-collecting run, or null.
 *
 * Measured on a file with a syntax error: `testResults[0].message` is
 *
 *   Transform failed with 1 error:
 *   C:/…/probe/broken.test.ts:2:38: ERROR: Expected ";" but found "is"
 *
 * Two lines, not one: the first is the headline and the SECOND carries the
 * file and the column, which is the actionable half. Truncated to one line it
 * read "Transform failed with 1 error:" and named nothing. Bounded to 240
 * chars because a full rollup can be 40 lines of noise around one fact.
 */
function collectErrorReason(json) {
  for (const t of Array.isArray(json.testResults) ? json.testResults : []) {
    if (typeof t?.message === 'string' && t.message.trim() !== '') {
      return t.message
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .slice(0, 2)
        .join(' — ')
        .slice(0, 240);
    }
  }
  return 'no testResults[].message on the document';
}

/**
 * Run a vitest suite with the JSON reporter and return its counts.
 *
 * WHY THIS NO LONGER GIVES UP ON A NON-ZERO EXIT. It used to: `if
 * (r.status !== 0) return null`. Every "all passing" claim then fell through to
 * UNVERIFIED in exactly the case it exists for — a suite with a real failure
 * could never FAIL, because the failure was what made the parse return null.
 * UNVERIFIED is fatal, so the exit code was still 1; what was lost is the
 * DIAGNOSIS, and a check whose verdict on a broken suite is "reporter
 * unavailable" is a check that cannot name a defect.
 *
 * MEASURED 2026-10-01 on vitest 4.1.11, with a probe suite of 1 passed /
 * 1 failed / 1 skipped:
 *
 *   exit code 1, STDOUT 2,159 bytes, STDERR 0 bytes, JSON intact.
 *
 * So the document is parsed regardless of the exit code, and the field names
 * are the Jest-compatible ones, quoted from that failing run:
 *
 *   "numTotalTests": 3, "numPassedTests": 1, "numFailedTests": 1,
 *   "numPendingTests": 1, "numTodoTests": 0, "numTotalTestSuites": 2,
 *   "success": false, "testResults": [ { assertionResults: [...] } ]
 *
 * `numFailedTests` is present and correct on a FAILING run. A skip is
 * `numPendingTests`, per-assertion `status: "skipped"`. A todo is
 * `numTodoTests` and appears in NEITHER passed nor pending, so
 * `numTotalTests = passed + failed + pending + todos` — verified on a probe
 * carrying all four kinds (1 + 1 + 1 + 1 = 4). This tree has zero `test.todo`
 * calls, measured across src/, test/ and bench/, which is why the documented
 * form is `passed + skipped`; the todo count is still surfaced in the verdict
 * line so the arithmetic is readable if one is ever added.
 *
 * THE ONE PATH WHERE `numFailedTests` IS 0 ON A NON-ZERO EXIT: a suite that
 * never collected. Measured on a file with a syntax error — exit 1,
 * numTotalTests 0, numPassedTests 0, numFailedTests 0, numPendingTests 0,
 * numFailedTestSuites 1, `success: false`, reason on `testResults[0].message`.
 * That is reported as a FAILURE carrying the reason. It is deliberately NOT
 * "0 failed", which would be a false green, and NOT UNVERIFIED, which would
 * discard the one message worth reading. `collectError` names the state and
 * the caller decides; nothing here infers a count that was not measured.
 */
function vitestCounts(cwd, include) {
  const args = ['vitest', 'run', '--reporter=json', ...(include ?? [])];
  const r = spawnSync('npx', args, { cwd: join(ROOT, cwd), encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  const exit = r.status;
  const body = typeof r.stdout === 'string' ? r.stdout : '';
  // Try the whole stream first, then from the first brace: a non-JSON banner
  // can precede the document, and a naive `indexOf('{')` would splice the two
  // together into something that cannot parse.
  const start = body.indexOf('{');
  let json = null;
  for (const cand of start < 0 ? [body] : [body, body.slice(start)]) {
    if (cand.trim() === '') continue;
    try { json = JSON.parse(cand); break; } catch { /* try the next shape */ }
  }
  if (json === null) {
    return {
      ok: false,
      exit,
      tests: null,
      passed: null,
      failed: null,
      skipped: null,
      todos: null,
      files: null,
      collectError: false,
      problem: `vitest exited ${exit} and wrote no parsable JSON to stdout (${body.length} bytes)`,
      filesList: [],
      skipDetail: [],
    };
  }
  // `numTotalTests` is authoritative and already accounts for `test.each`
  // expansion. A static grep of `test(` does NOT: it undercounted the desktop
  // suite by 2 here, which would have produced a false failure.
  //
  // The FILE count is `testResults.length`, NOT `numTotalTestSuites` — the
  // latter counts `describe` blocks (184 for the root suite, against 53 files).
  // Getting that wrong would have made this script "prove" a false claim true by
  // demanding the doc be corrected to match a buggy derivation.
  const tests = json.numTotalTests ?? null;
  const collectError = json.success === false && (tests ?? 0) === 0;
  return {
    ok: true,
    exit,
    tests,
    files: Array.isArray(json.testResults) ? json.testResults.length : null,
    passed: json.numPassedTests ?? null,
    failed: json.numFailedTests ?? null,
    // `numTotalTests` IS the documented figure, and it is the only stable one.
    //
    // MEASURED 2026-10-01 at 6a90518, the same commit, the same 671 tracked
    // files and a junctioned `node_modules` on both sides:
    //
    //   working tree : 1595 passed |  1 skipped  (1596 total)
    //   clean clone  : 1583 passed | 13 skipped  (1596 total)
    //
    // The TOTAL agrees and the pass/skip split does not, because which
    // `test.runIf` prerequisites are satisfied is a property of the artifacts on
    // the disk, not of the tree. A count that changes because `dist/` exists is
    // a machine property, so the claim is `numTotalTests` and the skip figure
    // became the NAMED CEILING below. Comparing the document's first number to
    // `numPassedTests` — which is what this did — cannot be satisfied by any
    // single figure: the working tree already read 1594 against a derived 1595
    // at this commit, and a clean clone reads 1583.
    //
    // What `numTotalTests` buys is closure in BOTH directions, which is why the
    // ceiling's one declared entry is safe: a test appearing or disappearing
    // moves the total, and a skip guard that stops skipping here moves the total
    // the other way. Neither can be absorbed by a ceiling.
    //
    // The figure does not move with serve liveness, STRUCTURALLY rather than
    // by measurement: `vitest.config.ts` negates `src/**/*.live.test.ts` out
    // of `include`, so the live tier is not collected by `npm run test` at all
    // and contributes zero tests to any of the four counters. (That config
    // comment records an earlier measurement — 1394+1 with the credential
    // reachable, 1392+3 without — taken BEFORE the negation, so it describes a
    // tree state that no longer exists and must not be read as the current
    // behaviour.) What a `describe.skipIf` that never runs contributes to
    // `numPendingTests` is NOT measured here and is not assumed.
    skipped: json.numPendingTests ?? null,
    todos: json.numTodoTests ?? 0,
    // The files the run ACTUALLY collected, and the per-assertion skip detail.
    //
    // WHY THE COLLECTED SET COMES FROM THE REPORTER AND NOT A SECOND COPY OF
    // `vitest.config.ts`'s GLOBS. A hand-written include list here would be a
    // claim that goes stale the moment a glob is edited, and it would go stale in
    // the dangerous direction: a `runIf` in a file this script stopped scanning
    // would leave the ceiling untouched AND unaccounted, so the run would report
    // one fewer permitted entry than the file actually contains. Reading the
    // set from the reporter cannot drift, and it is the same set the ceiling has
    // to reason about — a `runIf` in a file vitest never collects cannot produce
    // a skip, so exempting it is correct rather than lax.
    filesList: Array.isArray(json.testResults)
      ? json.testResults.map((t) => t?.name).filter((n) => typeof n === 'string')
      : [],
    // Per-assertion `status: 'skipped'` is the ONLY way to tell WHICH guard
    // produced a skip. `numPendingTests` is a bare integer: 1 in the working
    // tree and 13 in a clean clone are the same field with the same meaning, and
    // no integer can say which of the declared prerequisites was satisfied. A
    // ceiling a reader cannot resolve is the "13, none of which I can account
    // for" case, so the detail is parsed and matched by (file, title) against
    // the declared entries.
    skipDetail: Array.isArray(json.testResults)
      ? json.testResults.flatMap((t) =>
          (Array.isArray(t?.assertionResults) ? t.assertionResults : [])
            .filter((a) => a?.status === 'skipped')
            .map((a) => ({
              file: typeof t?.name === 'string' ? t.name : '',
              title: typeof a?.title === 'string' ? a.title : '',
            })),
        )
      : [],
    collectError,
    problem: collectError ? collectErrorReason(json) : null,
  };
}

/**
 * The three counts, named separately and never summed away.
 *
 * `0 failed / 1 skipped / 1395 total` — the wording matters as much as the
 * numbers. The previous verdict read `some failing` for any `tests !== passed`,
 * which mislabels a correct-by-design skip as a failure; two rounds of analysis
 * were sent down the wrong path by that word. A skip is not a failure and a
 * failure is not a skip, so both are always named.
 */
function countsLine(c) {
  const todo = c.todos > 0 ? ` / ${c.todos} todo` : '';
  return `${c.failed} failed / ${c.skipped} skipped${todo} / ${c.tests} total`;
}

// ── the declared skip ceiling ────────────────────────────────────────────────
//
// WHY A CEILING AND NOT AN EQUALITY. The measured problem, at 6a90518, same
// commit, same 671 tracked files, `node_modules` junctioned on both sides:
//
//   working tree : 1595 passed |  1 skipped  (1596 total)
//   clean clone  : 1583 passed | 13 skipped  (1596 total)
//
// `numPendingTests` was the claim and it is a function of which gitignored
// artifacts exist on the disk: 12 of the 13 `test.runIf` sites in this tree
// declare a prerequisite that a clean checkout does not have, and one of the 13
// declares a prerequisite that a clean checkout DOES have (the installed app's
// runtime dir, which lives in the user's profile and travels with the machine
// rather than the repository). An equality therefore had no satisfiable value
// that was true of both, which is why this commit was red before the change
// below and green after it.
//
// So the ceiling is a set of NAMED entries, each one a guard that can turn a
// test into a skip without deleting it:
//
//   1 declared platform guard   `test.skipIf(process.platform === 'win32')`
//   + one entry per `test.runIf` site in a file the run actually collected
//
// and the document states the CARDINALITY of that set. That is the checked
// claim: the number in AGENTS.md is compared against the number of named
// entries derived here, so adding a `runIf` without raising the ceiling is a
// visible failure, and removing one is too. Neither direction is silent.
//
// AND THAT CARDINALITY IS PER-PLATFORM, because one of the named entries is a
// guard that only fires on one platform. `test.skipIf(process.platform ===
// 'win32')` cannot skip anything on Linux, so a ceiling of 14 that counted it
// there would permit one skip nobody declared — the exact defect a ceiling
// exists to prevent, reintroduced by the ceiling itself. Nothing observed that
// on Linux; it is arithmetic, and it is the kind of arithmetic that cannot be
// seen from the machine the check was written on.
//
// So the derivation is a function of a PLATFORM PREDICATE, and the document
// states BOTH arms — `14 on win32 / 13 on non-win32` — while the run is
// compared against the arm the current platform selects. The non-win32 arm is
// REASONED, not executed: it comes out of the same declared `firesOn` data
// through the same predicate, and `docs-verify-self-test.mjs` drives both arms
// against synthetic runs, but no Linux machine has run this gate.
//
// WHAT A CEILING IS NOT. It is not a licence to skip. Two checks sit on top of
// it and both fail the run:
//
//   - the ceiling HOLDS: `observed <= permitted`. A suite that gains a skip
//     beyond the ceiling goes red.
//   - every observed skip is ACCOUNTED FOR by a named entry, matched on
//     (file, title). A `test.skip(...)` with no declared guard is an
//     unaccounted skip and goes red, even though it is inside the ceiling —
//     which is the "13, none of which I can account for" case made fatal.
//
// The report also names which declared entries were ACTIVE, so a reader can
// tell "13 of 13 permitted" from "13, none of which I can account for".

/**
 * The platform the document's two ceiling arms are keyed on.
 *
 * WHY A CONSTANT AND NOT `process.platform`. The document states two arms —
 * win32 and everything else — so the derivation has to be able to ask about a
 * platform OTHER than the one it is running on, or the second arm could not be
 * checked from any platform at all. Naming the discriminating platform as a
 * constant is what makes the non-win32 arm a derivable claim rather than an
 * assertion about the machine.
 *
 * WHY "EVERYTHING ELSE" IS A COMPLEMENT AND NOT A PLATFORM. Every declared
 * guard either fires on win32, fires on every platform, or names some third
 * platform — and the second arm has to be exhaustive or the pair would not cover
 * the space. `declaredSkipEntries` FAILS when a guard names a third platform, so
 * the complement stays exact instead of quietly absorbing a guard into an arm it
 * does not fire on.
 */
const WIN32_PLATFORM = 'win32';

/**
 * The probe for "every platform that is not win32".
 *
 * NOT A REAL PLATFORM, and that is deliberate: `guardFiresOn` compares
 * `firesOn === platform`, so any string that is not `'win32'` exercises the
 * complement branch, and a synthetic value cannot collide with a platform Node
 * might one day report. `declaredSkipEntries` requires every declared guard to
 * fire on win32 or nowhere, so this one probe is the whole non-win32 arm — there
 * is no per-platform table to fall out of step with the declaration.
 */
const NON_WIN32_PLATFORM = 'non-win32';

/**
 * Whether a derived entry can produce a skip on `platform`.
 *
 * ONE predicate, and it is deliberately total: an entry with no `firesOn` fires
 * everywhere, so `test.runIf` entries — whose condition is about the disk, not
 * the OS — need no special case. That is what keeps the filter from becoming a
 * `kind === 'platform'` test, which would have to be edited the day a
 * platform-dependent `runIf` appeared.
 */
function guardFiresOn(entry, platform) {
  return entry.firesOn == null || entry.firesOn === platform;
}

/**
 * The named entries permitted to skip on `platform`.
 *
 * THIS IS WHERE THE CEILING BECOMES A FUNCTION OF THE PLATFORM, and it is a
 * separate function from `declaredSkipEntries` on purpose. `declaredSkipEntries`
 * is a derivation OF THE TREE, and the tree does not change with the OS: the
 * win32 guard is present in a Linux checkout exactly as it is here, and the
 * self-test asserts its presence unconditionally. Filtering inside the
 * derivation would turn a tree derivation into a machine measurement and make
 * every case over it silently Windows-only. So the tree derivation keeps every
 * entry and the PLATFORM filter is its own, injectable, separately-proven step.
 */
function ceilingEntries(entries, platform) {
  return entries.filter((e) => guardFiresOn(e, platform));
}

/**
 * The declared (NOT derived) skip guards, each located by a literal condition.
 *
 * WHY ONE ENTRY IS DECLARED WHILE THE OTHER THIRTEEN ARE DERIVED. A
 * `test.runIf` site is a syntactic fact: the call is in the file or it is not.
 * A `test.skipIf` guard's condition is an arbitrary expression —
 * `process.platform === 'win32'`, `isWin32()`, `!(a && b)` — and no text scan can
 * evaluate it. Scanning for the substring `process.platform` would also match
 * the ACTIVE half of the pair, because this same file declares
 * `test.skipIf(process.platform !== 'win32')` (`src/daemon.test.ts:858`), which
 * RUNS on this platform and skips nothing. Counting it would inflate the ceiling
 * by one on every platform, which is the failure mode a ceiling exists to
 * prevent.
 *
 * So this entry is declared and NAMED, and it is located by its literal
 * condition rather than by a line number, so a line shift in the file does not
 * silently relocate it. If the declared literal cannot be found, the claim FAILS
 * and says which file and which literal — the alternative is a ceiling that
 * quietly loses an entry and permits one more unexplained skip, which is the
 * hole the "must fail when the observed skip count exceeds it" requirement is
 * about.
 *
 * `firesOn` is what makes the ceiling PER-PLATFORM, and it is deliberately
 * DECLARED DATA rather than a second scan of the condition. The condition is an
 * arbitrary expression, and the whole reason it is located by literal is that no
 * text scan can evaluate it; scanning it again for a platform would reintroduce
 * exactly the failure the next paragraph describes. So the platform is stated
 * once, as `firesOn`, and `declaredSkipEntries` then REFUSES a guard whose
 * `firesOn` is not named in its own literal condition. The declaration is
 * therefore falsifiable from both sides: rename the literal and the entry goes
 * unlocatable; rename `firesOn` alone and it stops agreeing with the literal.
 * Neither drifts silently, which a bare `firesOn` could.
 *
 * `firesOn: null` means "not platform-dependent — fires everywhere", and
 * `declaredSkipEntries` requires a guard whose condition mentions
 * `process.platform` to declare one. Deleting the field is a change, not a
 * neutral edit.
 *
 * DECLARING ONE BOUND DOES NOT WEAKEN THE CHECK, and the two-sided pinning is
 * the argument:
 *
 *   - delete the guard      → one entry and one test both disappear, so the
 *                             ceiling cardinality and the total BOTH fall and
 *                             both are compared against the document. Red twice.
 *   - change the condition so it stops skipping here
 *                           → the guard becomes an ordinary passing test, so the
 *                             total RISES by one. Red.
 *
 * The total claim is what makes the second case catchable, and it is the reason
 * the ruling moved the test-count claim off `numPassedTests` onto
 * `numTotalTests`: a total is the only figure in the reporter that moves when a
 * test appears or disappears for ANY reason.
 */
const DECLARED_SKIP_GUARDS = [
  {
    kind: 'platform',
    file: 'src/daemon.test.ts',
    guard: 'test.skipIf',
    condition: "process.platform === 'win32'",
    // BREAK-PROBE TARGET, and the probe is a DOCUMENT edit, not a source edit:
    // this is the only string in the file a reader would change to move the
    // ceiling, so it is the string worth breaking. Changing it makes the entry
    // unlocatable (nothing matches the literal) rather than silently relocating
    // it, which is the property that lets a stale `file:line` be avoided.
    //
    // The SECOND break-prove target is `firesOn`. Pointing it at a platform the
    // condition does not name is the one edit that would make the derivation
    // quietly describe the wrong tree, and it is reported as a PROBLEM rather
    // than only as a red count, because a red count alone sends the reader to go
    // count `runIf` sites instead of to this declaration.
    firesOn: WIN32_PLATFORM,
    why: 'permanent by design — ensureIpcToken refuses to generate where a 0600 mode is a Windows no-op, because the Rust supervisor provisions that path with a protected DACL instead',
  },
];

/**
 * Repo-relative, forward-slashed, lower-cased path key.
 *
 * ONE normaliser for BOTH sides of every match. The reporter emits
 * `O:/opencode-Vantrilex/src/daemon.test.ts` with forward slashes, while
 * `process.cwd()` on this platform is `O:\opencode-Vantrilex` with backslashes,
 * so a `path.replace(ROOT, '')` keyed on the raw value is a silent no-op and the
 * two sides of a (file, title) match never agree. The existing display-only uses
 * of that replace are unaffected either way; a MATCH cannot afford to be.
 */
const rootSlash = resolve(ROOT).replace(/\\/g, '/').toLowerCase();
const fileKey = (p) =>
  p
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(rootSlash + '/', '');

/**
 * Index of the `)` that closes the `(` at `openIdx`, skipping string literals
 * and `//` comments. -1 if the file ends unbalanced.
 *
 * WHY NOT A REGEX. The guard's own argument is an expression containing nested
 * calls, quoted strings and commas —
 * `existsSync(join(resolve('apps/desktop/src-tauri/sidecar'), 'dist/cli.js'))` —
 * so the only way to find where the guard call ends is to count parentheses.
 * Widening a regex until a real prerequisite fits is the alternative this file
 * has already paid for once, in the `describe.skipIf` derivation.
 */
function matchParen(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') { i += 1; continue; }
        if (source[i] === ch) break;
      }
      continue;
    }
    // A `//` comment can hold a paren. Skipping it is not defensive: a comment
    // above a guard that mentions `test.runIf(x)` is a plausible edit, and
    // counting its parens would desynchronise every site after it.
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `test.<guard>(<condition>)(<title>` site in a source file.
 *
 * The title is read as the FIRST string literal after the guard call's closing
 * paren, which is the test's own name and therefore the exact string the JSON
 * reporter echoes back in `assertionResults[].title`. Matching on the reporter's
 * own `title` rather than on `fullName` avoids re-deriving the enclosing
 * `describe` titles — a second derivation of the test tree, which would be a
 * third place for a rename to go unnoticed. MEASURED 2026-10-01 on a probe
 * carrying a `runIf`, a `skipIf` on each side of a platform test and a `test.skip`:
 * `ancestorTitles: ['W19 the real shipped payload']`, `title: 'a skipped named
 * block A'`, `status: 'skipped'`, and `numPendingTests: 1`.
 *
 * A site whose shape does not parse is DROPPED here and reported as a problem by
 * `declaredSkipEntries`, which fails the claim. Dropping it silently would
 * shrink the ceiling, which is the one direction that must never happen
 * quietly.
 */
function guardedTestSites(source, guard) {
  const needle = guard + '(';
  const out = [];
  for (let i = source.indexOf(needle); i >= 0; i = source.indexOf(needle, i + 1)) {
    const condStart = i + needle.length;
    const condEnd = matchParen(source, condStart - 1);
    if (condEnd < 0) continue;
    const condition = source.slice(condStart, condEnd).replace(/\s+/g, ' ').trim();
    let k = condEnd + 1;
    while (k < source.length && /\s/.test(source[k])) k += 1;
    if (source[k] !== '(') continue;
    let t = k + 1;
    while (t < source.length && /\s/.test(source[t])) t += 1;
    const quote = source[t];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const titleEnd = source.indexOf(quote, t + 1);
    if (titleEnd < 0) continue;
    out.push({
      line: source.slice(0, i).split('\n').length,
      condition,
      title: source.slice(t + 1, titleEnd),
    });
  }
  return out;
}

/**
 * The ceiling: every named entry a skip in this suite is allowed to be.
 *
 * `problems` is non-empty when an entry could not be established, and a problem
 * FAILS the claim rather than reducing the count. That is the deliberate
 * direction: a ceiling that shrinks on a parse failure permits skips nobody
 * declared, which is the whole defect class this file is about.
 *
 * THE ENTRIES ARE PLATFORM-INDEPENDENT, and `firesOn` is carried on each one
 * rather than filtered here. See `ceilingEntries`: the platform is the last
 * filter, not the derivation, so this function stays a property of the tree and
 * every self-test case over it holds on every OS. Every `test.runIf` entry gets
 * `firesOn: null`, which `guardFiresOn` reads as "fires everywhere" — a
 * `runIf` prerequisite is about the disk, never about the OS, and giving it a
 * null field rather than omitting the field keeps the predicate total.
 *
 * TWO PROBLEMS ARE CHECKED ON THE DECLARATION ITSELF, and both exist because
 * `firesOn` is declared data:
 *
 *   1. `firesOn` must agree with the literal condition. A guard whose condition
 *      names `process.platform` but whose `firesOn` names a different platform —
 *      or names none — is a ceiling describing a tree that does not exist, and it
 *      would otherwise show up only as a cardinality mismatch, which reads as a
 *      document error.
 *   2. No declared guard may name a third platform. The document has exactly two
 *      arms and the second is the complement of win32, so a darwin-only guard
 *      would make "non-win32" a description the tree contradicts. This is the
 *      invariant that keeps the complement exact, and it is checked on every
 *      platform rather than only on the one where it would bite.
 */
function declaredSkipEntries(filesList) {
  const entries = [];
  const problems = [];
  for (const d of DECLARED_SKIP_GUARDS) {
    const p = join(ROOT, d.file);
    if (!existsSync(p)) {
      problems.push(`declared guard: ${d.file} does not exist`);
      continue;
    }
    const sites = guardedTestSites(readFileSync(p, 'utf8'), d.guard).filter(
      (s) => s.condition === d.condition,
    );
    if (sites.length === 0) {
      problems.push(`declared guard: no ${d.guard}(${d.condition}) in ${d.file}`);
      continue;
    }
    if (sites.length > 1) {
      problems.push(
        `declared guard: ${sites.length} sites match ${d.guard}(${d.condition}) in ${d.file} ` +
          `(lines ${sites.map((s) => s.line).join(', ')}) — a ceiling entry must name ONE test`,
      );
      continue;
    }
    // The `firesOn`/condition agreement check. It is here and not in the
    // ceiling claim so that BOTH the diagnostic claim (`skip guards declared`)
    // and the ceiling claims carry it, which is the same reason an unlocatable
    // guard is reported from here rather than only from `reportSkipCeiling`.
    const condNamesPlatform = /process\.platform/.test(d.condition);
    if (condNamesPlatform && d.firesOn == null) {
      problems.push(
        `declared guard: ${d.file} ${d.guard}(${d.condition}) is platform-dependent but declares no firesOn — ` +
          'the ceiling would count it on every platform',
      );
      continue;
    }
    if (
      d.firesOn != null &&
      !d.condition.includes(`'${d.firesOn}'`) &&
      !d.condition.includes(`"${d.firesOn}"`)
    ) {
      problems.push(
        `declared guard: ${d.file} declares firesOn=${d.firesOn} but its condition ` +
          `(${d.condition}) does not name that platform`,
      );
      continue;
    }
    if (d.firesOn != null && d.firesOn !== WIN32_PLATFORM) {
      // NOT a `continue`: this is a property of the DECLARATION LIST, not of one
      // entry, so it is raised once and the entry still counts. Dropping the
      // entry would shrink the ceiling on the failure path, which is the one
      // direction that must never happen quietly.
      problems.push(
        `declared guard: firesOn=${d.firesOn} names a platform other than ${WIN32_PLATFORM}; ` +
          'the document states two arms (win32 and everything else), so a third platform makes ' +
          'the second arm a description the tree contradicts',
      );
    }
    entries.push({
      kind: d.kind,
      file: d.file,
      line: sites[0].line,
      title: sites[0].title,
      condition: d.condition,
      firesOn: d.firesOn ?? null,
      why: d.why,
    });
  }
  for (const f of filesList) {
    const src = readFileSync(f, 'utf8');
    for (const s of guardedTestSites(src, 'test.runIf')) {
      entries.push({
        kind: 'runIf',
        file: fileKey(f),
        line: s.line,
        title: s.title,
        condition: s.condition,
        // A `runIf` prerequisite is a statement about the DISK, never about the
        // OS, so it is permitted on every platform. Stated explicitly rather
        // than left off so that `guardFiresOn` has one rule and no kind test.
        firesOn: null,
        why: null,
      });
    }
  }
  // A (file, line) collision means the same call site was counted twice — only
  // reachable if a declared guard were itself `test.runIf`. Reported, not
  // deduplicated: a ceiling whose cardinality depends on an unstated
  // precedence rule is a ceiling nobody can review.
  const seen = new Map();
  for (const e of entries) {
    const k = `${e.file}:${e.line}`;
    if (seen.has(k)) problems.push(`duplicate skip-guard site counted twice — ${k}`);
    else seen.set(k, e);
  }
  return { entries, problems };
}

/**
 * Compare one run's skips against the named ceiling.
 *
 * `unaccounted` is the load-bearing output and it is a FAILURE, not a note: a
 * skip the ceiling permits but cannot name is a guard nobody declared, which is
 * the "coverage that reads as present while being absent" shape. A plain
 * `test.skip(...)` lands here — MEASURED, it reports identically to a
 * `runIf`-guarded skip (`status: 'skipped'`, counted in `numPendingTests`) and
 * differs only in that no declared entry matches its (file, title).
 *
 * `permitted` is the PLATFORM-SCOPED count, not `entries.length`. This is the
 * whole of Item 1: a guard that cannot fire on the platform it is being scored
 * on must not raise the ceiling there, or the ceiling permits one unexplained
 * skip on exactly the machines that were never measured. The matching
 * (`permitted`) map is built over EVERY entry rather than only the permitted
 * ones, so an entry that fires nowhere on this platform is still recognised as
 * a declared guard when it does show up in `assertionResults` — the accounting
 * and the bound are deliberately two different questions, and conflating them
 * would make a stray report from a `test.skipIf` on a platform it does not skip
 * on look like an undeclared skip.
 */
function skipCeilingVerdict(entries, counts, platform = process.platform) {
  const permittedEntries = ceilingEntries(entries, platform);
  const permitted = new Map(entries.map((e) => [`${e.file}\u0000${e.title}`, e]));
  const activeKeys = new Set();
  const unaccounted = [];
  for (const s of counts.skipDetail) {
    const k = `${fileKey(s.file)}\u0000${s.title}`;
    if (permitted.has(k)) activeKeys.add(k);
    else unaccounted.push({ ...s, file: fileKey(s.file) });
  }
  // STANDING RULE, the one that matters here: a set-based "all observed are
  // permitted" is vacuously true over an EMPTY declared set, and an empty
  // derived set is exactly what a broken scanner produces. `permittedEntries
  // .length` is therefore asserted by the caller and the caller fails on zero,
  // and the vacuous-true shape is additionally blocked by requiring that a run
  // with skips has at least one active entry.
  return {
    observed: counts.skipped,
    platform,
    derived: entries.length,
    permitted: permittedEntries.length,
    active: entries.filter((e) => activeKeys.has(`${e.file}\u0000${e.title}`)),
    unaccounted,
  };
}

/**
 * Report one suite's claims. Shared by the root and desktop blocks so the two
 * cannot drift apart again — they are the same check, and the copy that made
 * "some failing" appear once already cost a rewrite.
 *
 * The documented form is `root **N total** (F files)` — the TOTAL, against
 * `numTotalTests`. `numPassedTests` is the field the document's first number was
 * compared against before the ceiling change, and that is the field which is a
 * function of the machine: at 6a90518 the same commit reads 1595 passed with
 * `dist/` present and 1583 in a clean clone. `numTotalTests` reads 1596 in both.
 * The total is the only figure in the reporter that moves when a test appears or
 * disappears for ANY reason, which is what lets it carry the closure argument
 * the ceiling's one declared entry depends on.
 *
 * The desktop suite stays on `numPassedTests`, DELIBERATELY and not by
 * oversight. Its skip count is a measured, machine-stable 0 — the desktop tree
 * declares no `runIf`, `skipIf`, `skip` or `todo` — so the two metrics coincide
 * today and switching it would change no verdict. It is a separate decision,
 * because the day a desktop guard is added the passed/total distinction starts
 * to bite there, and that change should be made against a measurement rather
 * than smuggled in here.
 *
 * The skip count is a CLAIM, not decoration: deleting it turns this into a
 * no-op that still exits 0, which is the failure mode UNVERIFIED-as-error
 * exists to prevent. A suite with a todo cannot be written in this form, which
 * is stated rather than papered over — `countsLine` surfaces the todo count.
 */
// `doc` is a parameter, not the closed-over `agents`, so `docs-verify-self-test`
// can drive this whole path against a synthetic document. That is the difference
// between a self-test of the arithmetic and a self-test of the claim: the former
// calls a helper, the latter proves the checker reads a number and compares it.
// It defaults to the real document, so the production path is unchanged.
// `platform` is a PARAMETER, defaulting to the running platform, and that is the
// seam the whole per-platform ceiling is tested through. Production omits it;
// `docs-verify-self-test` supplies `'linux'` to exercise the arm no Windows
// machine can reach. It is a parameter rather than a constant read at each use
// site for the same reason `doc` is: a self-test that could only reach the
// current platform's arm would be unable to show the derivation is per-platform
// at all, which is the requirement.
function reportSuite({
  doc = agents,
  counts,
  countRe,
  filesRe,
  runLabel,
  testsLabel,
  skippedLabel,
  filesLabel,
  testsMetric = 'passed',
  skipCheck = 'equality',
  ceilingRe,
  ceilingLabel,
  platform = process.platform,
}) {
  if (!counts.ok) {
    // No JSON. If the run also exited non-zero this is a real failure — a crash,
    // a bad config, a missing binary — and calling it UNVERIFIED would hide it
    // behind the word "unavailable" again.
    fail(runLabel, 'no failures', counts.problem);
    for (const [label, what] of [[testsLabel, 'test count'], [skippedLabel, 'skip count'], [filesLabel, 'file count']]) {
      unverified(label, '-', `${what} unavailable — ${counts.problem}`);
    }
    return;
  }
  if (counts.collectError) {
    fail(runLabel, 'no failures', `suite did not collect — ${counts.problem}`);
    for (const [label, what] of [[testsLabel, 'test count'], [skippedLabel, 'skip count'], [filesLabel, 'file count']]) {
      unverified(label, '-', `${what} unavailable — the suite did not collect`);
    }
    return;
  }

  const line = countsLine(counts);
  if (counts.failed > 0) fail(runLabel, 'no failures', line);
  // A non-zero exit with zero failed tests is neither green nor a test failure:
  // an unhandled error or a crash after the run. Reported, because the claim is
  // "this suite ran clean", and it did not.
  else if (counts.exit !== 0) fail(runLabel, 'no failures', `vitest exited ${counts.exit} with 0 failed tests — ${line}`);
  else pass(runLabel, 'no failures', line);

  // The metric is a PARAMETER, not an assumption baked into the shared helper.
  // The previous version compared the document's first number to
  // `counts.passed` unconditionally, which was the machine-dependent field for
  // the root suite; a shared helper that hardcodes a metric is how the two suites
  // get checked against different things without anybody deciding it.
  const testsDerived = testsMetric === 'total' ? counts.tests : counts.passed;
  if (doc.match(countRe)?.[1] == null) unverified(testsLabel, 'not stated', String(testsDerived));
  else if (Number(doc.match(countRe)[1]) === testsDerived) pass(testsLabel, doc.match(countRe)[1], String(testsDerived));
  else fail(testsLabel, doc.match(countRe)[1], String(testsDerived));

  if (skipCheck === 'ceiling') {
    reportSkipCeiling({ doc, counts, ceilingRe, skippedLabel, ceilingLabel, platform });
  } else {
    // Group 2 of the `N passed + M skipped` form. The root suite does not reach
    // this branch — it uses the ceiling — so the index is read from the document
    // again rather than from a hoisted `m` that only the desktop form has.
    const docSkipped = (doc.match(countRe) ?? [])[2];
    if (docSkipped == null) unverified(skippedLabel, 'not stated', String(counts.skipped));
    else if (Number(docSkipped) === counts.skipped) pass(skippedLabel, docSkipped, String(counts.skipped));
    else fail(skippedLabel, docSkipped, String(counts.skipped));
  }

  if (counts.files == null) {
    unverified(filesLabel, '-', 'no testResults array in the json document');
    return;
  }
  const docFiles = (doc.match(filesRe) ?? [])[1];
  if (docFiles == null) unverified(filesLabel, 'not stated', String(counts.files));
  else if (Number(docFiles) === counts.files) pass(filesLabel, docFiles, String(counts.files));
  else fail(filesLabel, docFiles, String(counts.files));
}

/**
 * Two claims about the named skip ceiling, and they are not the same claim.
 *
 *   1. `root vitest skipped` — the DOCUMENT's stated arms against the arms
 *      derived from the tree. This is the checked claim that makes the
 *      maintenance burden intended: adding a `test.runIf` raises the derived
 *      count, the document still says the old numbers, and the run goes red. The
 *      burden is the point; the alternative is a ceiling nobody reviews.
 *
 *   2. `root vitest skip ceiling` — the RUN against the arm the current platform
 *      selects. Observed skips must be within it, and every one of them must be
 *      attributable to a named entry. This is the claim that bites, and it is
 *      separate from (1) on purpose: a document that restates a stale ceiling and
 *      a run that skips more than the ceiling are different defects, and one
 *      message each is actionable where a merged one is not.
 *
 * BOTH ARMS ARE DERIVED, and this is the per-platform correction. Claim 1
 * compares the document's `N on win32 / M on non-win32` against
 * `derWin32Arm / derElsewhereArm`, each built by running the SAME `guardFiresOn`
 * predicate over the same entries at a different platform. Claim 2 then scores
 * the run against whichever arm `platform` selects. So the number is a property
 * of the TREE plus the platform, on every platform, rather than a property of
 * the machine the checker happens to be running on.
 *
 * `entries.length === 0` FAILS rather than passing an empty ceiling. A
 * vacuously-true "all observed skips are permitted" over an empty declared set
 * is the standing-rule failure this repository has hit repeatedly, and a broken
 * scanner is exactly how it would be reached here. The same holds for the
 * PLATFORM-SCOPED set: a tree whose derived entries all fail to fire on this
 * platform would otherwise derive a ceiling of 0 and pass every comparison
 * against a document that also said 0.
 */
function reportSkipCeiling({ doc, counts, ceilingRe, skippedLabel, ceilingLabel, platform = process.platform }) {
  const { entries, problems } = declaredSkipEntries(counts.filesList);
  const verdict = skipCeilingVerdict(entries, counts, platform);
  // Both arms, from one predicate at two platforms. `derWin32Declared` is the
  // guard half that only applies to the first arm, which is exactly why a single
  // number could not carry the claim.
  const derRunIf = entries.filter((e) => e.kind === 'runIf').length;
  // The ARM is the whole platform-scoped set, and it is taken from
  // `ceilingEntries` rather than recomputed as `runIf + declared` — summing the
  // two halves would re-introduce exactly the compensating-error shape the
  // separate-half checks exist to reject, one level up. The first version summed
  // them and read 27 for a 14-entry tree, because `derWin32Declared` was
  // itself derived as a platform-filtered count over ALL entries and so already
  // contained the 13 `runIf` sites. MEASURED: `27 on win32 / 13 on non-win32`.
  const derWin32Arm = ceilingEntries(entries, WIN32_PLATFORM).length;
  const derElsewhereArm = ceilingEntries(entries, NON_WIN32_PLATFORM).length;
  // The declared half, for the composition message and for the document's guard
  // count. Derived over the DERIVED entries rather than over
  // `DECLARED_SKIP_GUARDS`, because the claim is about the tree: a guard that
  // failed to locate contributes no entry, and counting the declaration instead
  // would report a half the tree does not have — the same check-one-level-up
  // mistake as the arm sum above, in the other direction.
  const derWin32Declared = entries.filter(
    (e) => e.kind === 'platform' && e.firesOn === WIN32_PLATFORM,
  ).length;
  // Which arm the current platform selects, as the DOCUMENT's figure for it.
  const selectedArm = platform === WIN32_PLATFORM ? derWin32Arm : derElsewhereArm;
  const activeNames = verdict.active.map(
    (e) => `${e.file}:${e.line} ${e.title} (${guardName(e)})`,
  );
  const detail =
    `${verdict.observed} observed / ${verdict.permitted} permitted on ${platform} · ` +
    `${verdict.active.length} of ${verdict.permitted} named entries active`;

  // Claim 1: the document's stated arms, as FOUR numbers.
  //
  // `docWin32`/`docElsewhere` are the two arms, `docWin32Guards` the declared
  // half that only the first arm carries, and `docRunIf` the half both carry.
  // They are checked SEPARATELY rather than by comparing a sum, because a sum
  // matches under compensating errors: a document that said
  // "14 = 1 platform + 12 runIf" while the tree held 13 would pass a sum check
  // and misdescribe the tree in the one place a reader looks to check it. The
  // derived halves are counted from the entries themselves, so the platform
  // entry and the `runIf` entries are separately falsifiable.
  //
  // The ORDER is load-bearing. `runIf` first, then the declared half, then the
  // two arms: the inner numbers are what the outer numbers are made of, so a
  // mismatch in an inner one is reported as the inner one. A reader who is sent
  // to fix the win32 arm when the `runIf` count moved would fix the wrong
  // number and be red again on the next run.
  const m = doc.match(ceilingRe) ?? [];
  const [docWin32, docElsewhere, docWin32Guards, docRunIf] = [m[1], m[2], m[3], m[4]];

  // The arm THIS platform selects, cross-checked against the run's own
  // `permitted`. Declared AFTER the destructuring above because the message
  // quotes the document's arms, and quoting a binding before its `const` is a
  // ReferenceError rather than a verdict — the one failure mode this report
  // cannot recover from. The first version placed this check above the parse and
  // MEASURED a crash: exit 1 with a stack trace and no claim output, which reads
  // as "the guard fired" to anyone not reading the trace.
  //
  // WHY THE CROSS-CHECK IS NOT REDUNDANT. `selectedArm` comes from the arm table
  // and `verdict.permitted` from a direct `ceilingEntries` call, so they are two
  // readings of the same predicate. A shared derivation would have no independent
  // second reading and could not disagree with itself — which is exactly how the
  // half-sum bug reached a green gate.
  if (selectedArm !== verdict.permitted) {
    fail(
      skippedLabel,
      `${docWin32 ?? 'not stated'}/${docElsewhere ?? 'not stated'}`,
      `the arm selected on ${platform} is ${selectedArm} but the run was scored against ` +
        `${verdict.permitted} — the document comparison and the run verdict disagree`,
    );
  }
  const derArms = `${derWin32Arm} on win32 / ${derElsewhereArm} on non-win32`;
  // The arm the RUN is scored against is derived independently of the arms the
  // DOCUMENT is compared against, from `verdict.permitted`. Deriving both from
  // the same expression is what let the half-sum bug read 27 in one place and 14
  // in another: a shared derivation has no independent second reading, so
  // nothing can disagree with itself. `selectedArm` is what the document's arm
  // for THIS platform is compared to, and it is asserted equal to
  // `verdict.permitted` so the two cannot drift into a claim and a verdict about
  // different numbers.
  const halves =
    `derived ${derArms} = ${derWin32Declared} declared guard(s) firing on win32 ` +
    `+ ${derRunIf} test.runIf site(s)` +
    (problems.length > 0 ? ` — ${problems.join('; ')}` : '');
  if (entries.length === 0) {
    // Named explicitly because a zero here would otherwise make BOTH claims
    // pass: the document cannot say 0, and "0 observed <= 0 permitted" is true.
    fail(skippedLabel, docWin32 ?? 'not stated', `0 named entries — the derivation is empty${problems.length > 0 ? ': ' + problems.join('; ') : ''}`);
  } else if (verdict.permitted === 0) {
    // The per-platform twin of the check above. A tree can derive entries and
    // still derive a CEILING OF ZERO on a platform none of them fire on, and
    // against a document that also said 0 every comparison here would be
    // satisfied. Named rather than assumed because the predicate is new.
    fail(skippedLabel, docWin32 ?? 'not stated', `0 entries permitted on ${platform} — the ceiling would be vacuous there${problems.length > 0 ? ': ' + problems.join('; ') : ''}`);
  } else if (docWin32 == null || docElsewhere == null) {
    unverified(skippedLabel, 'not stated', halves);
  } else if (Number(docRunIf) !== derRunIf) {
    // The runIf half is shared by both arms, so it is checked first. The fix is
    // different: this is a prose correction, not a tree correction, and a
    // message that said only "the ceiling is wrong" would send the reader to
    // count `runIf` sites in the tree.
    fail(skippedLabel, `${docWin32}/${docElsewhere} (of which ${docRunIf} runIf)`, `${halves} — the runIf half does not match`);
  } else if (Number(docWin32Guards) !== derWin32Declared) {
    fail(skippedLabel, `${docWin32}/${docElsewhere} (of which ${docWin32Guards} win32 guard)`, `${halves} — the declared-guard half does not match`);
  } else if (Number(docWin32) !== derWin32Arm) {
    fail(skippedLabel, `${docWin32}/${docElsewhere}`, `${halves} — the win32 arm does not match`);
  } else if (Number(docElsewhere) !== derElsewhereArm) {
    fail(skippedLabel, `${docWin32}/${docElsewhere}`, `${halves} — the non-win32 arm does not match`);
  } else {
    pass(skippedLabel, `${docWin32} on win32 / ${docElsewhere} on non-win32`, halves);
  }

  // Claim 2: the run against the ceiling.
  //
  // BOTH VIOLATIONS ARE REPORTED IN ONE MESSAGE, and the COUNT is checked FIRST.
  // That ordering is load-bearing rather than cosmetic. An earlier version tested
  // `unaccounted.length > 0` before `observed > permitted`, which made the count
  // check almost unreachable: a suite that genuinely gains skips gains
  // UNDECLARED ones, so the naming check always fired first and the
  // "observed > permitted" branch could only be reached by inventing a duplicate
  // of an existing entry. A check that is nearly unreachable is a check that
  // cannot be shown to work, and this one has to be shown. Checking the count
  // first means the common failure is reported as what it is — the suite gained
  // skips beyond the ceiling — with the unaccounted names attached so the reader
  // learns both facts in one line.
  if (problems.length > 0) {
    fail(ceilingLabel, 'no problems', problems.join('; '));
    return;
  }
  if (entries.length === 0) {
    fail(ceilingLabel, '0 observed / 0 permitted', 'no named entries — every ceiling check over an empty set is vacuous');
    return;
  }
  if (verdict.permitted === 0) {
    // The per-platform twin, and it is reached by a REAL shape rather than a
    // hypothetical one: every declared guard in the tree can be platform-gated,
    // and then a platform none of them fire on derives a ceiling of 0. `0 <= 0`
    // holds and every skip is "named" by the accounting map, so without this the
    // run claim would pass with an empty ceiling on a platform it has never been
    // measured on. Named rather than assumed because the predicate is new.
    fail(ceilingLabel, '0 observed / 0 permitted', `no named entry fires on ${platform} — the ceiling is empty there and every check over it is vacuous`);
    return;
  }
  const overCeiling = verdict.observed > verdict.permitted;
  const unnamed = verdict.unaccounted.length;
  if (overCeiling || unnamed > 0) {
    const parts = [];
    if (overCeiling) {
      parts.push(
        `${verdict.observed} observed > ${verdict.permitted} permitted on ${platform} — the suite gained ` +
          `${verdict.observed - verdict.permitted} skip(s) beyond the declared ceiling`,
      );
    }
    if (unnamed > 0) {
      const named = verdict.unaccounted.map((s) => `${s.file} "${s.title}"`).join(', ');
      parts.push(
        `${unnamed} skip(s) match no declared guard: ${named}` +
          (overCeiling ? '' : ' — within the ceiling, but not attributable to one'),
      );
    }
    fail(ceilingLabel, 'observed <= permitted, all named', parts.join('; '));
  } else if (verdict.observed > 0 && verdict.active.length === 0) {
    // Unreachable given the branch above, and kept anyway: a skip that matched no
    // entry while `unaccounted` is empty is an accounting bug, and this is where
    // it would be silent.
    fail(ceilingLabel, 'observed <= permitted, all named', `${verdict.observed} observed but no entry matched — accounting is broken`);
  } else {
    pass(ceilingLabel, 'observed <= permitted, all named', detail);
  }
  skipCeilingReport.push({ entries, verdict, activeNames });
}

/**
 * The guard call as written, for naming an entry in the printed list and in the
 * `--json` payload.
 *
 * BOTH kinds are rendered through this one function rather than the ternary at
 * each use site, and that is not tidiness. The first version wrote
 * `e.guardName(e)` — a property access on the entry object where a function was
 * meant — and it threw the moment the first `runIf` entry became ACTIVE, which
 * is to say it would have thrown in the working tree and not in a clean clone.
 * A crash inside claim reporting is the worst failure mode available: the run
 * dies with a stack trace instead of a verdict, and the reader learns nothing
 * about the ceiling. The `--json` consumer would have seen no document at all.
 */
function guardName(e) {
  return e.kind === 'platform' ? `test.skipIf(${e.condition})` : `test.runIf(${e.condition})`;
}

function countRustTests() {
  const p = join(ROOT, 'apps/desktop/src-tauri/src/main.rs');
  if (!existsSync(p)) return null;
  return (readFileSync(p, 'utf8').match(/^\s*#\[test\]/gm) ?? []).length;
}

/**
 * Module-level test reachability — the number `npm run test:blindspots` prints.
 *
 * Duplicated here rather than shelled out to, because that script is a
 * measurement with prose output and this one is a checker. It is the same walk:
 * resolve every quoted relative specifier transitively from each test file.
 */
function testReachability() {
  const SRC = join(ROOT, 'src');
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) all.push(p);
    }
  };
  walk(SRC);
  const prod = all.filter((f) => !f.endsWith('.test.ts'));
  // A production module imported ONLY by a test is not dead and not a shipping
  // cost - it is test scaffolding, and it belongs to neither bucket. The first
  // version of this walk counted `claim-matcher.ts` (imported only by
  // docs-verify-coverage.test.ts) as dead, which raised the dead count from 7 to
  // 8 and would have sent a reader looking for a Laya regression that does not
  // exist. Subtract the test-reachable set from the dead set rather than
  // reporting a module nobody can use as though it were unused.
  const tests = all.filter((f) => f.endsWith('.test.ts'));
  const importsOf = (file) => {
    const src = readFileSync(file, 'utf8');
    const out = [];
    for (const m of src.matchAll(/['"](\.[^'"]+)\.js['"]/g)) {
      const target = resolve(dirname(file), `${m[1]}.ts`);
      if (existsSync(target)) out.push(target);
    }
    return out;
  };
  const reach = (entries) => {
    const seen = new Set();
    const queue = entries.filter(existsSync);
    while (queue.length > 0) {
      const f = queue.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const d of importsOf(f)) if (!seen.has(d)) queue.push(d);
    }
    return seen;
  };
  const byTest = reach(tests);
  const byProd = reach([join(SRC, 'daemon.ts'), join(SRC, 'cli.ts')]);
  const blind = prod.filter((f) => byProd.has(f) && !byTest.has(f));
  return { total: prod.length, shipping: prod.filter((f) => byProd.has(f)).length, blind: blind.length, tests: tests.length };
}

function countE2ETests() {
  const dir = join(ROOT, 'apps/desktop/e2e');
  if (!existsSync(dir)) return null;
  let tests = 0;
  let specs = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.spec.ts'))) {
    specs += 1;
    tests += (readFileSync(join(dir, f), 'utf8').match(/^\s*test\(/gm) ?? []).length;
  }
  return { tests, specs };
}

/**
 * Narrative claims: the ones the numeric table above structurally cannot see.
 *
 * These exist because the four doc falsities fixed during the persona-wiring
 * sprint were all PROSE, and `docs:verify` caught none of them. It caught the
 * test counts and the source-line count automatically; "persona references are
 * all 0", "earcons.ts is a persona effect", "knowledge/ influences no spoken
 * word" and a stale `daemon.ts:607` all had to be found by hand. A check that
 * only covers the numbers is a check with a known blind spot, and this file's
 * whole argument is that a green gate says nothing about prose.
 *
 * The same rule applies: no expected value appears here. Each one is parsed out
 * of AGENTS.md and compared against the tree.
 */

/** Persona mentions, counted as LINES (not occurrences) — the unit AGENTS.md states. */
function personaRefCounts() {
  const files = {
    'narrator.ts': 'src/orchestrator/narrator.ts',
    'coordinator.ts': 'src/orchestrator/coordinator.ts',
    'prompt-optimizer.ts': 'src/orchestrator/prompt-optimizer.ts',
    'brain.ts': 'src/voice/brain.ts',
  };
  const re = /persona|PersonaId|NOUR|KAREEM/i;
  const out = {};
  for (const [label, path] of Object.entries(files)) {
    if (!existsSync(join(ROOT, path))) return null;
    out[label] = read(path).split('\n').filter((l) => re.test(l)).length;
  }
  return out;
}

/**
 * Two independent earcon facts, because "earcons.ts does not exist" alone is
 * satisfied by renaming it. The pitch-constant scan catches the reintroduction
 * of the AUDIO under any filename, and the file scan catches a new module that
 * reintroduces the concept without those literals.
 */
function earconFacts() {
  const roots = [join(ROOT, 'src'), join(ROOT, 'apps/desktop/src')];
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts')) files.push(p);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  const byName = files.filter((f) => /earcon/i.test(f.replace(/\\/g, '/')));
  const byPitch = files.filter((f) => /659\.25|987\.77|1318\.5/.test(readFileSync(f, 'utf8')));
  return { modules: byName.length, pitchHits: byPitch.length };
}

/**
 * Who imports `src/knowledge/` in production, and how many come via the barrel.
 *
 * The barrel split matters on its own: `knowledge/index.js` re-exports the BM25
 * retriever and the whole corpus, so an importer of the barrel drags a search
 * index into its import graph. Pinning the barrel count is what stops a future
 * edit from quietly moving the daemon onto that path.
 */
function knowledgeImportFacts() {
  const SRC = join(ROOT, 'src');
  const mods = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) mods.push(p);
    }
  };
  walk(SRC);
  const importers = new Set();
  let barrel = 0;
  for (const f of mods) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+'([^']*knowledge\/[^']+)'/g)) {
      importers.add(f);
      if (/knowledge\/index\.js/.test(m[1])) barrel += 1;
    }
  }
  return { importers: importers.size, barrel };
}

/**
 * A cited `file.ts:NNN` anchor is real if the file exists, the line exists, AND
 * the line is not blank or a bare delimiter.
 *
 * WHY THE CONTENT CHECK EXISTS. The first version of this function asserted
 * only `line <= fileLineCount`, and a Reality Checker audit found 2 of the 5
 * anchors AGENTS.md cited pointing at a comment, a `{`, and a blank line — with
 * the gate GREEN. The script's own header admitted the limit ("does not verify
 * the line is still the RIGHT line"), which made a documented non-check being
 * cited as a protection. The same drift had already happened once before
 * (`daemon.ts:607` → `:790`) and shipped.
 *
 * WHAT THIS STILL DOES NOT DO, stated plainly so it is not over-claimed: it
 * cannot tell whether a line contains the SPECIFIC thing the document claims.
 * That needs the document to quote the line. What it can catch is the common
 * case — a pointer decayed past the end of the region it described, landing on
 * whitespace, a bare brace or a comment. Blank and brace-only lines are what
 * both stale anchors turned out to be.
 */
/**
 * Classifiers for "this cited line is not code".
 *
 * Built with RegExp constructors because the three comment shapes are `//`,
 * `/*` and `*` - each a metacharacter in a literal, and hand-escaped versions of
 * exactly these three have been produced wrong twice while editing this file.
 *
 * `/^[/*]+$/` alone is NOT sufficient: it matches only a line that is nothing
 * but slashes and stars, so the `// ...` line this check was written for, and a
 * JSDoc continuation like `* @param x`, both read as valid code. A code review
 * caught that by running the check rather than reading it.
 */
const bareDelimiterRe = new RegExp('^[[\\](){}();,]+$');
const lineCommentRe = new RegExp('^' + '//');
const blockCommentRe = new RegExp('^' + '/\\*');
const jsdocRe = new RegExp('^\\*');

function citedAnchors() {
  // AGENTS.md writes the line reference INSIDE the backticks — `daemon.ts:790` —
  // not as `daemon.ts`:790. Both spellings appear across the file's history, so
  // accept either. An earlier version only accepted the second and reported
  // "no citations found" on a document with five of them.
  // `.rs` is in this alternation, and it has to be here together with the two
  // index changes below. Widening ONLY the citation pattern makes every `main.rs`
  // anchor in AGENTS.md resolve to "file not found" - an honest FAIL, but for the
  // wrong reason, and a reader who has seen nine anchors flip red for a missing
  // file learns to distrust the red. The three parts are one change because one
  // part without the other two produces a failure that names the wrong cause.
  //
  // `main.rs` was invisible to this check until now: the pattern required
  // `.tsx?`, the index collected only `.ts`/`.tsx`, and the roots did not include
  // `apps/desktop/src-tauri/src` at all. Nine of AGENTS.md's citations name it.
  const re = /`([A-Za-z0-9_.-]+\.(?:tsx?|rs)):(\d+)`/g;
  // Resolve by BASENAME, recursively. The docs cite `brain.ts:108` and
  // `daemon.ts:790` as bare filenames while the files live at `src/voice/` and
  // `src/` — a fixed two-root lookup called a valid citation "file not found",
  // which is a false FAIL that trains a reader to ignore the check.
  const index = new Map();
  // `apps/desktop/src-tauri/src` is the Rust supervisor's source root. It is a
  // root rather than a file because the filter below indexes by BASENAME
  // recursively, and hardcoding `main.rs` as a special case would be the kind of
  // narrow fix that reads as complete while the next Rust file cites the same
  // way. Verified: with this root, `main.rs` resolves to exactly one file, so no
  // citation of it is reported ambiguous.
  const indexRoots = [
    join(ROOT, 'src'),
    join(ROOT, 'apps/desktop/src'),
    join(ROOT, 'apps/desktop/src-tauri/src'),
  ];
  // A bare basename is AMBIGUOUS in this tree, and silently picking the first
  // match is how the check passes on the wrong file. A code review caught it:
  // `vault.ts` resolved to `src/memory/vault.ts` (the Obsidian note scaffolder)
  // rather than `src/voice/vault.ts` (the keyring), so a citation about
  // `machine.key` was being validated against an unrelated line 29 and reported
  // green. There are four colliding basenames here — `index.ts` x7, `vault.ts`
  // x2, `types.ts` x2, `vad.ts` x2.
  //
  // So an ambiguous citation is reported as AMBIGUOUS, which fails, instead of
  // being resolved by a coin flip. A citation that cannot be checked is not a
  // passing check.
  const collect = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) collect(p);
      // `.rs` alongside `.ts`/`.tsx`. The `.test.ts` exclusion stays TypeScript-
      // only: Rust tests live inside `main.rs` under `#[cfg(test)]`, so there is
      // no separate `.test.rs` file to exclude here.
      else if (/\.(ts|tsx|rs)$/.test(p) && !p.endsWith('.test.ts')) {
        const seen = index.get(e.name);
        if (seen === undefined) index.set(e.name, [p]);
        else seen.push(p);
      }
    }
  };
  for (const r of indexRoots) if (existsSync(r)) collect(r);
  // The searched roots, named in the failure message from the ACTUAL list rather
  // than from a hand-written string. The hand-written form said "src/ or
  // apps/desktop/src/" and went stale the moment src-tauri/src was added, which
  // is how a "file not found" line can name two roots while three were searched.
  const searchedRoots = indexRoots
    .filter(existsSync)
    .map((r) => r.replace(ROOT, '').replace(/^[/\\]+/, '').replace(/\\/g, '/'))
    .join(', ');
  const out = [];
  const doc = typeof globalThis.__agentsOverride === 'string' ? globalThis.__agentsOverride : agents;
  for (const m of doc.matchAll(re)) {
    const name = m[1];
    const line = Number(m[2]);
    const hits = index.get(name);
    if (hits === undefined) {
      out.push({ name, line, ok: false, why: `file not found in ${searchedRoots}` });
      continue;
    }
    if (hits.length > 1) {
      const rel = (p) => p.replace(ROOT, '').replace(/\\/g, '/');
      out.push({
        name,
        line,
        ok: false,
        why: `ambiguous basename — ${hits.length} files share it: ${hits.map(rel).join(', ')}`,
      });
      continue;
    }
    const hit = hits[0];
    const all = readFileSync(hit, 'utf8').split('\n');
    if (line < 1 || line > all.length) {
      out.push({ name, line, ok: false, why: `${hit.replace(ROOT, '').replace(/\\/g, '/')} has ${all.length} lines` });
      continue;
    }
    // The content check. A pointer that drifted onto whitespace, a bare
    // delimiter, a comment or a JSDoc continuation is not pointing at code.
    const lineText = (all[line - 1] ?? '').trim();
    const degenerate =
      lineText === '' ||
      bareDelimiterRe.test(lineText) ||
      lineCommentRe.test(lineText) ||
      blockCommentRe.test(lineText) ||
      jsdocRe.test(lineText);
    if (degenerate) {
      out.push({
        name,
        line,
        ok: false,
        why: describeNonCode(lineText),
      });
      continue;
    }
    out.push({ name, line, ok: true, why: 'resolves to code' });
  }
  return out;
}

/** Name why a cited line is not code, so the failure is actionable. */
function describeNonCode(t) {
  if (t === '') return 'line is blank';
  if (lineCommentRe.test(t)) return 'line is a line comment';
  if (blockCommentRe.test(t)) return 'line opens a block comment';
  if (jsdocRe.test(t)) return 'line is a JSDoc continuation';
  if (bareDelimiterRe.test(t)) return 'line is a bare delimiter';
  return 'line is not code';
}

// ── derivation ───────────────────────────────────────────────────────────────

// The anchor scan needs the doc text, and `citedAnchors` closes over `agents`,
// so AGENTS.md is read before any derivation runs. Everything below only reads.
// ── self-test: run the behavioural guard on citedAnchors
//
// Not in the vitest suite on purpose: a test that shells out here would spawn
// the whole suite twice. This is the only guard that proves the anchor checker
// WORKS rather than that its source contains certain words.
if (process.argv.includes('--self-test')) {
  const { selfTestCitedAnchors, selfTestSkipCeiling } = await import('./docs-verify-self-test.mjs');
  // `results` is handed over as a reader rather than the array, because the
  // cases below need to INSPECT what a synthetic run claimed. Passing the array
  // would let a case read the real gate's verdicts and pass vacuously — the
  // exact "coverage that reads as present while being absent" shape this file
  // exists to prevent. `resetResults` is why one case cannot see another's
  // output either.
  const resetResults = () => { results.length = 0; skipCeilingReport.length = 0; };
  const readResults = () => results.map((r) => ({ ...r }));
  const res = [
    ...selfTestCitedAnchors(ROOT, citedAnchors),
    ...selfTestSkipCeiling({
      ROOT,
      declaredSkipEntries,
      ceilingEntries,
      skipCeilingVerdict,
      reportSuite,
      resetResults,
      readResults,
    }),
  ];
  let bad = 0;
  for (const [name, ok] of res) {
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
    if (!ok) bad += 1;
  }
  console.log('');
  console.log(bad === 0
    ? 'self-test passed - ' + res.length + ' behavioural check(s).'
    : 'self-test FAILED - ' + bad + ' of ' + res.length + '.');
  process.exit(bad === 0 ? 0 : 1);
}

// In `--json` mode stdout is EXACTLY one JSON document and nothing else: the
// only consumer is `doctor --bundle`, and a banner line in front of the payload
// turns "the tree has drifted" into "the tool could not parse its output", which
// are different findings and only one of them is true.
if (!process.argv.includes('--json')) {
  console.log('docs:verify — deriving truth from the tree…\n');
}

const agents = existsSync(join(DOC_ROOT, 'AGENTS.md'))
  ? readFileSync(join(DOC_ROOT, 'AGENTS.md'), 'utf8')
  : '';
const pkg = JSON.parse(read('package.json'));

// 1–5. The root and desktop vitest suites.
//
// FOUR claims for the root suite — the run itself ("no failures"), the TOTAL,
// the skip CEILING, and the file count — and four for the desktop suite, where
// the skip is still an equality because its count is a measured, machine-stable
// 0.
//
// WHY THE ROOT CLAIM IS THE TOTAL AND NOT THE PASS COUNT. This is the change
// this commit exists for, and the measurement is in `vitestCounts` above: at
// 6a90518 the same commit reads 1595 passed + 1 skipped in the working tree and
// 1583 passed + 13 skipped in a clean clone, with 1596 total on both sides. The
// pass/skip SPLIT is a function of which gitignored artifacts exist on the disk,
// so no single figure could satisfy both environments and the check was red
// before this change. The total is a function of the tree.
//
// WHY THE SKIP IS A CEILING AND NOT A FIGURE. For the same reason, from the
// other direction: 12 of the 13 `test.runIf` prerequisites in this tree are
// gitignored artifacts a clean checkout does not have, and the 13th is the
// installed app's runtime dir, which lives in the user's profile and so
// TRAVELS WITH THE MACHINE. An equality had no satisfiable value. The ceiling is
// a set of named entries — see `DECLARED_SKIP_GUARDS` and
// `declaredSkipEntries` — and the document states its cardinality, so adding a
// guard without raising the ceiling is a visible failure in both directions.
//
// The skip remains a CLAIM, not a footnote. A correct-by-design skip is a fact
// about the platform: `src/daemon.test.ts:1216` skips on win32 because
// `ensureIpcToken` refuses to generate where a 0600 mode is a no-op, and the
// Rust supervisor provisions that path with a protected DACL instead.
//
// The optional `(?: [^**]*)?` in each pattern tolerates a reason INSIDE the
// bold — `+ 1 skipped (Windows platform, by design)` — and the recommended
// spelling puts it outside instead, in prose the parser does not read. The
// pattern is strict about the numbers and loose about the words around them,
// for the reason the test-reachability patterns already state: a false FAIL
// trains a reader to `git checkout AGENTS.md`.
reportSuite({
  counts: vitestCounts('.', []),
  // The documented form is `root **N total** (F files)` and the claim is
  // `numTotalTests`. The `+ M skipped` half of the old form is GONE from the
  // root sentence, not merely unread: a number the document states in the claim
  // shape but no check consumes is the "coverage that reads as present while
  // being absent" shape in prose, and there is already a sentence further down
  // this file about a figure that was quoted for a cycle after it went unchecked.
  //
  // The optional `(?: [^**]*)?` in each pattern tolerates a reason INSIDE the
  // bold — `**1596 total (97 files, 1 skip observed)**` — and the recommended
  // spelling puts it outside instead, in prose the parser does not read. The
  // pattern is strict about the numbers and loose about the words around them,
  // for the reason the test-reachability patterns already state: a false FAIL
  // trains a reader to `git checkout AGENTS.md`.
  countRe: /root \*\*(\d+) total(?: [^**]*)?\*\*/,
  filesRe: /root \*\*\d+ total(?: [^**]*)?\*\* \((\d+) files\)/,
  runLabel: 'root vitest (no failures)',
  testsLabel: 'root vitest tests',
  skippedLabel: 'root vitest skipped',
  filesLabel: 'root vitest files',
  testsMetric: 'total',
  skipCheck: 'ceiling',
  // The ceiling's TWO ARMS, read out of the SAME sentence that names the
  // platform skip: `skip ceiling **N on win32 / M on non-win32** (1 win32
  // platform skip + K test.runIf prerequisites)`. Four numbers are captured, so
  // the claim can name which half drifted — "the ceiling is wrong" is not an
  // actionable message and "13 runIf sites, the document says 12" is.
  //
  // WHY TWO ARMS IN THE DOCUMENT RATHER THAN ONE ARM PER MACHINE. A single
  // number can only be compared against the machine running the check, so a
  // document carrying one number is a claim that is either red or wrong on every
  // platform but the one it was written on. Stating both arms keeps the claim a
  // property of the TREE on every OS, and the `1` in the guard half is captured
  // rather than assumed so it is checked too.
  //
  // The pattern states the composition rather than a bare `**N**` on purpose: a
  // document that says "a named ceiling of 14" without saying what the 14 is
  // cannot be reviewed, which is the whole point of naming the entries. A bare
  // number would be a check that verifies arithmetic.
  //
  // Both arms are REQUIRED to match. An older single-arm form in this file was a
  // false FAIL generator on any machine that did not match the author's, and the
  // fix is to require the complete form rather than to make the second arm
  // optional — an optional arm is an arm nobody maintains.
  ceilingRe:
    /skip ceiling \*\*(\d+) on win32 \/ (\d+) on non-win32\*\* \((\d+) win32 platform skip \+ (\d+) test\.runIf prerequisites\)/,
  ceilingLabel: 'root vitest skip ceiling',
});

// The desktop suite takes the same shape as the root one, and KEEPS the equality
// skip check and the `passed` metric, for a measured reason rather than by
// omission: 2026-10-01, the desktop tree declares zero `runIf`, `skipIf`, `skip`
// and `todo` call sites, so its skip count is a measured 0 that no environment
// can move, and `passed` and `total` coincide at 506.
//
// That is the whole justification, and it is a MEASURED one, which is why the
// root suite's change does not silently become the desktop suite's. The moment a
// desktop guard is added this suite develops the same machine-dependence, and
// then `testsMetric`/`skipCheck` are two options away from the root's treatment.
reportSuite({
  counts: vitestCounts('apps/desktop', []),
  countRe: /desktop \*\*(\d+) passed \+ (\d+) skipped(?: [^**]*)?\*\*/,
  filesRe: /desktop \*\*\d+ passed \+ \d+ skipped(?: [^**]*)?\*\* \((\d+) files\)/,
  runLabel: 'desktop vitest (no failures)',
  testsLabel: 'desktop vitest tests',
  skippedLabel: 'desktop vitest skipped',
  filesLabel: 'desktop vitest files',
});

// 6. Every DECLARED skip guard must still be locatable, checked here as well as
//    inside the ceiling — not as a second verdict on the same fact, but because
//    the ceiling's message does not lead with it.
//
//    `reportSkipCeiling` already reports an unlocatable guard as a problem and
//    fails the run-check claim, so the gate is red either way. The reason for the
//    second claim is DIAGNOSTIC, and it is measured rather than assumed: while
//    break-testing a deleted guard (probe-shrunk-suite-5e1a) the reader saw three
//    red claims, two of which were about counts, and had to read the third to
//    learn that a guard had been deleted. A check whose failure is genuine but
//    whose message points at the wrong cause is half a check — and "a figure
//    nobody reviews" is the failure mode this file exists to prevent.
//
//    It is also CHEAP, which is the other reason it is here rather than only
//    inside the ceiling: `declaredSkipEntries([])` scans no file, so this costs
//    one literal lookup and needs no test run at all.
const guardLiveness = declaredSkipEntries([]);
if (guardLiveness.problems.length > 0) {
  fail(
    'skip guards declared',
    `${DECLARED_SKIP_GUARDS.length} declared guard(s) located`,
    guardLiveness.problems.join('; '),
  );
} else if (DECLARED_SKIP_GUARDS.length === 0) {
  // Unreachable while the array is a non-empty literal, and kept for the reason
  // this file keeps making the same point: a claim whose subject is an empty set
  // passes vacuously. `DECLARED_SKIP_GUARDS.length` is the one input in this
  // file that is a literal rather than a derivation, so it is the one that can
  // be emptied by an edit that looks like a deletion.
  fail('skip guards declared', 'at least one', 'the declared guard list is empty — every ceiling check over it is vacuous');
} else {
  pass(
    'skip guards declared',
    `${DECLARED_SKIP_GUARDS.length} declared guard(s)`,
    DECLARED_SKIP_GUARDS.map((d) => `${d.file} · ${d.guard}(${d.condition})`).join('; '),
  );
}

// 7. Cargo
const cargo = countRustTests();
if (cargo != null) {
  const doc = (agents.match(/`cargo test` \*\*(\d+)\*\*/) ?? [])[1];
  if (doc == null) unverified('cargo tests', 'not stated', String(cargo));
  else if (Number(doc) === cargo) pass('cargo tests', doc, String(cargo));
  else fail('cargo tests', doc, String(cargo));
}

// 8. E2E — static derivation, clearly labelled as such. Running Playwright here
//    would need ports 4096/4097/4197 and would fight the developer's own dev
//    server, so this is a count, not an execution.
const e2e = countE2ETests();
if (e2e) {
  const doc = (agents.match(/E2E \*\*(\d+)\*\* across (\d+) specs/) ?? []).slice(1);
  if (doc.length === 2) {
    if (Number(doc[0]) === e2e.tests) pass('e2e tests (static count)', doc[0], String(e2e.tests));
    else fail('e2e tests (static count)', doc[0], String(e2e.tests));
    if (Number(doc[1]) === e2e.specs) pass('e2e specs', doc[1], String(e2e.specs));
    else fail('e2e specs', doc[1], String(e2e.specs));
  } else unverified('e2e tests', 'not stated', String(e2e.tests));
}

// 9. Reachability
const reach = reachability();
for (const [label, docRe, der] of [
  ['live modules', /LIVE production modules\s*:\s*(\d+)/, reach.live],
  ['dead modules', /DEAD production modules\s*:\s*(\d+)/, reach.dead + reach.guarded],
  ['test-only scaffolding modules', /TEST-ONLY scaffolding modules\s*:\s*(\d+)/, reach.scaffolding],
  ['live source lines', /live source lines\s*:\s*(\d+)/, reach.lines],
]) {
  const doc = (agents.match(docRe) ?? [])[1];
  if (doc == null) unverified(label, 'not stated', String(der));
  else if (Number(doc) === der) pass(label, doc, String(der));
  else fail(label, doc, String(der));
}

// 10. Gate composition — compare the documented chain to the actual script.
const actualChain = (pkg.scripts['test:vantrilex'] ?? '').split('&&').map((s) => s.trim());
const documented = (agents.match(/`test:vantrilex` is \*\*(.+?)\*\*/) ?? [])[1] ?? '';
// Map each real stage to the word the doc must contain for it.
const stageNeedles = {
  'npm run typecheck': 'typecheck',
  'npm run typecheck:tests': 'typecheck:tests',
  'npm run lint': 'eslint',
  'npm run lint:ox': 'oxlint',
  'npm run test': 'root vitest',
  'npm run test:desktop': 'desktop vitest',
  'npm run test:e2e': 'e2e',
};
for (const stage of actualChain) {
  const needle = stageNeedles[stage] ?? stage;
  if (documented.toLowerCase().includes(needle.toLowerCase())) pass(`gate stage: ${stage}`, 'documented', stage);
  else fail(`gate stage: ${stage}`, `missing "${needle}" from AGENTS.md`, stage);
}
const expectedStageCount = actualChain.length;
const docStageCount = (documented.match(/→/g) ?? []).length + 1;
if (docStageCount !== expectedStageCount) {
  fail('gate stage count', String(docStageCount), String(expectedStageCount));
} else pass('gate stage count', String(docStageCount), String(expectedStageCount));

// 11. Narrative claims — persona reach into each system prompt.
const prefs = personaRefCounts();
if (prefs == null) {
  unverified('persona refs', '-', 'a system-prompt file is missing');
} else {
  for (const [label, der] of Object.entries(prefs)) {
    // Each figure is read out of its own backticked slot in the same sentence,
    // so reordering the sentence cannot silently reassign one file's number to
    // another file's claim.
    const re = new RegExp('`' + label.replace('.', '\\.') + '`\\s*\\*\\*(\\d+)\\*\\*');
    const doc = (agents.match(re) ?? [])[1];
    if (doc == null) unverified(`persona refs: ${label}`, 'not stated', String(der));
    else if (Number(doc) === der) pass(`persona refs: ${label}`, doc, String(der));
    else fail(`persona refs: ${label}`, doc, String(der));
  }
}

// 12. Narrative claims — the earcon removal, checked two independent ways.
const ear = earconFacts();
for (const [label, re, der] of [
  ['earcon modules', /holds \*\*(\d+)\*\* files matching `earcon\*`/, ear.modules],
  // The figure PRECEDES its own description ("**0** occurrences of the old pitch
  // constants `659.25` / ..."), so the pattern must run in that order. Three
  // earlier shapes assumed the reverse and matched nothing, which surfaced as
  // UNVERIFIED — a check that reads as covered but extracts no figure is worse
  // than no check at all, so the direction is now asserted rather than assumed.
  [
    'earcon pitch constants',
    /\*\*(\d+)\*\* occurrences of the old pitch constants `659\.25` \/ `987\.77` \/ `1318\.5`/,
    ear.pitchHits,
  ],
]) {
  const doc = (agents.match(re) ?? [])[1];
  if (doc == null) unverified(label, 'not stated', String(der));
  else if (Number(doc) === der) pass(label, doc, String(der));
  else fail(label, doc, String(der));
}

// 13. Narrative claims — knowledge/ production importers, and the barrel split.
const kf = knowledgeImportFacts();
for (const [label, re, der] of [
  ['knowledge importers', /half-connected\.\*\* It now has \*\*(\d+)\*\* production importers/, kf.importers],
  ['knowledge barrel importers', /exactly \*\*(\d+)\*\* imports the barrel/, kf.barrel],
]) {
  const doc = (agents.match(re) ?? [])[1];
  if (doc == null) unverified(label, 'not stated', String(der));
  else if (Number(doc) === der) pass(label, doc, String(der));
  else fail(label, doc, String(der));
}

// 14. Module-level test reachability.
//
//     The count is over ALL production modules, not just the shipping-reachable
//     ones, and that distinction is load-bearing. `docs:verify` also reports 7
//     DEAD modules (the Laya set); counting only the 51 that ship makes the two
//     figures disagree with `test:blindspots`, which counts 58 and subtracts its
//     own "neither shipped nor tested" bucket. The first version of this check
//     derived from the shipping set and read 48 where the document says 55 — a
//     real disagreement between two tools, and the fix is to make the basis
//     explicit rather than to adjust a number until it matches.
const tr = testReachability();
for (const [label, re, der] of [
  ['test-reachable modules', /\*\*(\d+) of (\d+)\*\* (?:production|shipping) modules/, tr.total - tr.blind],
  // The sentence is "The 3 modules no test reaches are `cli.ts` (247 lines)...".
  // An earlier pattern spanned sentences with `[^.]*?` and matched nothing,
  // reporting UNVERIFIED for a figure the document states plainly — the same
  // looks-covered-but-extracts-nothing failure as the earcon regex, and the
  // reason UNVERIFIED is fatal caught it instead of letting it slide.
  //
  // Both patterns here are deliberately loose about the words AROUND the number
  // and strict about the number itself. A code review found that tightening them
  // to match the current phrasing exactly caused a false FAIL the moment the
  // surrounding sentence was legitimately reworded — which trains a reader to
  // `git checkout AGENTS.md` instead of editing it. The figure is the claim; the
  // prose around it is not.
  ['test-blind modules', /(\d+) modules no test reaches/, tr.blind],
]) {
  const m = agents.match(re);
  const doc = m?.[1];
  if (doc == null) unverified(label, 'not stated', String(der));
  else if (Number(doc) === der) pass(label, doc, String(der));
  else fail(label, doc, String(der));
  // The denominator is checked too, where the claim states one. It moves
  // whenever a module is added, and it is the number the match used to capture
  // and silently drop: swapping 58 for 999, 1 and 0 each passed the check.
  const denom = m?.[2];
  if (denom !== undefined && label === 'test-reachable modules') {
    const derTotal = tr.total;
    if (Number(denom) === derTotal) pass('test total modules', denom, String(derTotal));
    else fail('test total modules', denom, String(derTotal));
  }
}

// 15. Every `file.ts:NNN` anchor AGENTS.md cites must still resolve to a line
//     that exists. This does NOT prove the line is still the right one.
const anchors = citedAnchors();
const dangling = anchors.filter((a) => !a.ok);
if (anchors.length === 0) {
  unverified('cited line anchors', '-', 'no `file.ts:NNN` citations found');
} else if (dangling.length === 0) {
  pass('cited line anchors', `${anchors.length} cited`, 'all resolve');
} else {
  fail(
    'cited line anchors',
    `${anchors.length} cited`,
    `${dangling.length} dangling: ` +
      dangling.map((a) => `${a.name}:${a.line} (${a.why})`).join(', '),
  );
}

// ── report ───────────────────────────────────────────────────────────────────

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'UNVERIFIED');
const passed = results.filter((r) => r.status === 'ok');

// `--json` is ADDITIVE and changes nothing about the default output. It exists
// for one consumer: `doctor --bundle` (src/diag/bundle.ts), which must report
// what docs:verify actually found rather than parsing this table. Parsing prose
// is how a diagnostic tool ends up reporting a remembered result, and a
// remembered result in a public bug report is a lie.
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify({
      tool: 'docs:verify',
      schemaVersion: 1,
      total: results.length,
      passed: passed.length,
      failed: failed.length,
      unverified: skipped.length,
      failedNames: [...failed, ...skipped].map((r) => r.name),
      checks: results.map((r) => ({
        name: r.name,
        documented: String(r.documented),
        derived: String(r.derived),
        status: r.status,
      })),
      // The named ceiling, enumerated. The human table CLAMPS its derived cell,
      // and a clamped list of 14 entries cannot be read, so a consumer of this
      // document that wanted to know WHICH declared guards were active in the
      // run had no way to find out. Additive: `doctor --bundle` reads `checks`
      // and ignores this.
      skipCeiling: skipCeilingReport.map((r) => ({
        observed: r.verdict.observed,
        // `platform` and the `derived`/`permitted` pair are all additive. A
        // consumer reading `permitted` needs to know WHICH platform it is the
        // ceiling for, or on a non-win32 machine the number is not the one the
        // tree supports — the same defect the document arms exist to prevent,
        // relocated into the machine-readable surface.
        platform: r.verdict.platform,
        derived: r.verdict.derived,
        permitted: r.verdict.permitted,
        active: r.activeNames,
        unaccounted: r.verdict.unaccounted.map((u) => `${u.file} :: ${u.title}`),
        entries: r.entries.map((e) => ({
          kind: e.kind,
          file: e.file,
          line: e.line,
          title: e.title,
          condition: e.condition,
          firesOn: e.firesOn,
          active: r.activeNames.some((n) => n.startsWith(`${e.file}:${e.line} `)),
          permittedHere: guardFiresOn(e, r.verdict.platform),
        })),
      })),
    }),
  );
  // Same exit contract as the human path: UNVERIFIED is an error, not a warning.
  process.exit(failed.length || skipped.length ? 1 : 0);
}

// Column widths are derived from the data, but each CELL is clamped, and the
// clamp is the point. The suite verdicts are sentences — "suite did not
// collect — Transform failed with 1 error: — <path>:2:38: ERROR: …" is 180
// characters — and two things were wrong before: a fixed 13-char DERIVED column
// printed them straight into the STATUS column (`…(0 bytes)FAIL`), and sizing
// the column to the longest one blows the table out to 250 columns. The full
// text is never lost: it is printed verbatim in the per-claim lines below the
// table, which are unbounded.
const CELL = 64;
const cell = (s, n = CELL) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const w = Math.max(...results.map((r) => r.name.length));
const wd = Math.max(11, ...results.map((r) => cell(String(r.documented), 40).length));
const wv = Math.max(7, ...results.map((r) => cell(String(r.derived)).length));
console.log('  ' + 'CHECK'.padEnd(w) + 'DOCUMENTED'.padEnd(wd + 2) + 'DERIVED'.padEnd(wv + 2) + 'STATUS');
console.log('  ' + '-'.repeat(w + wd + wv + 6));
for (const r of results) {
  const mark = r.status === 'ok' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log('  ' + r.name.padEnd(w) + cell(String(r.documented), 40).padEnd(wd + 2) + cell(String(r.derived)).padEnd(wv + 2) + mark);
}
console.log('');

// The named skip ceiling, enumerated and UNCLAMPED.
//
// WHY IT IS PRINTED AND NOT LEFT IN THE TABLE. The table's DERIVED cell is
// clamped to 64 characters because suite verdicts are sentences. The ceiling
// detail is a LIST of up to 14 named entries plus which of them were active in
// this run, and a clamped list is not a list a reader can check — it would read
// as "1 of 14" with the 13 inactive names truncated away, which is precisely
// the "13, none of which I can account for" reading the requirement exists to
// prevent. So the enumeration is printed whole, one entry per line, with the
// active ones marked.
//
// Every suite that ran a ceiling check is reported, not just the first: the loop
// is over the collected reports so a second suite cannot be silently omitted by
// this block being written for one shape.
// `verdict.derived` is the count the TREE declares and `verdict.permitted` the
// count the PLATFORM allows, and the line states both whenever they differ —
// which on a non-win32 machine is every run, and a line reading "1 observed /
// 14 permitted" there would be a figure the tree does not support.
for (const r of skipCeilingReport) {
  const { verdict } = r;
  const scope = verdict.derived === verdict.permitted
    ? ''
    : ` (${verdict.derived} declared in the tree, ${verdict.permitted} of them fire on ${verdict.platform})`;
  console.log(
    `skip ceiling — ${verdict.observed} observed / ${verdict.permitted} permitted on ${verdict.platform}${scope}, ` +
      `${verdict.active.length} of ${verdict.permitted} named entries active in this run:`,
  );
  for (const e of r.entries) {
    const on = r.activeNames.some((n) => n.startsWith(`${e.file}:${e.line} `));
    // A third state for an entry that exists, is named, and cannot fire here.
    // Collapsing it into `inactive` would read as "declared and dormant", which
    // is a different and wrong statement on a platform its condition excludes.
    const mark = on ? 'ACTIVE  ' : e.firesOn == null || e.firesOn === verdict.platform ? 'inactive' : 'other   ';
    const note = mark === 'other   ' ? ` — does not fire on ${verdict.platform}` : '';
    console.log(`  ${mark} ${e.file}:${e.line} · ${guardName(e)} · "${e.title}"${note}`);
  }
  for (const u of verdict.unaccounted) {
    console.log(`  UNNAMED  ${u.file} · "${u.title}" — within the ceiling, attributable to no declared guard`);
  }
  console.log('');
}
if (failed.length) {
  console.error(`docs:verify FAILED — ${failed.length} claim(s) contradict the code:`);
  for (const f of failed) console.error(`  - ${f.name}: doc says ${f.documented}, actual is ${f.derived}`);
  console.error('\nFix the DOCUMENT, not the script. The script has no expected values in it.');
  process.exit(1);
}
if (skipped.length) {
  console.warn(`docs:verify passed with ${skipped.length} UNVERIFIED item(s) — these are NOT confirmed:`);
  for (const s of skipped) console.warn(`  - ${s.name}: ${s.derived}`);
  // DELETING a documented figure turns the check into a no-op that still exits
  // 0. Observed by break-testing: removing the earcon count from AGENTS.md left
  // every other claim green, so the harness reported success while silently
  // covering one claim less than before. A check that can be switched off by
  // editing the document it audits is not a check, so losing a claim is an
  // error rather than a warning.
  //
  // `src:verify/tests/10-CHECKPOINT.md` and the README are exempt: they are
  // narrative documents, not the audit surface. Only AGENTS.md is held to this.
  console.error(
    `\ndocs:verify FAILED — ${skipped.length} claim(s) became UNVERIFIED, which means a\n` +
      'documented figure was removed or became unreadable. A claim that silently\n' +
      'stops being checked is worse than one that fails: exit code stays 0 and\n' +
      'coverage silently shrinks. Restore the figure, or delete the claim from\n' +
      'this script deliberately if the thing it tracked is genuinely gone.',
  );
  process.exit(1);
}
console.log(`docs:verify passed — ${results.length} claim(s) match the code.`);
process.exit(0);
