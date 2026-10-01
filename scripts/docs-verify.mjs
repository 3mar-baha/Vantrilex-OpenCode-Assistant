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
    // `numPendingTests` is vitest's name for a skipped test, and it is the
    // field the documented `+ N skipped` figure is compared against. The root
    // suite's single skip is `src/daemon.test.ts:1216`,
    // `test.skipIf(process.platform === 'win32')`, which is permanent on this
    // platform by design: `ensureIpcToken` refuses to generate where a 0600
    // mode is a no-op, because the Rust supervisor provisions that path with a
    // protected DACL instead.
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

/**
 * Report one suite's claims. Shared by the root and desktop blocks so the two
 * cannot drift apart again — they are the same check, and the copy that made
 * "some failing" appear once already cost a rewrite.
 *
 * The documented form is `root **N passed + M skipped** (F files)`. BOTH
 * numbers are checked against the reporter's own fields, separately:
 * `numPassedTests` and `numPendingTests`. The previous check compared the
 * document's first number to `numTotalTests`, which counts a skip as a test, so
 * a truthful skip count made the figure unresolvable and the only spelling that
 * parsed was the one that hid the skip.
 *
 * The skip count is a CLAIM, not decoration: deleting it turns this into a
 * no-op that still exits 0, which is the failure mode UNVERIFIED-as-error
 * exists to prevent. A suite with a todo cannot be written in this form, which
 * is stated rather than papered over — `countsLine` surfaces the todo count.
 */
function reportSuite({ counts, countRe, filesRe, runLabel, testsLabel, skippedLabel, filesLabel }) {
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

  const m = agents.match(countRe);
  const docPassed = m?.[1];
  const docSkipped = m?.[2];
  if (docPassed == null) unverified(testsLabel, 'not stated', String(counts.passed));
  else if (Number(docPassed) === counts.passed) pass(testsLabel, docPassed, String(counts.passed));
  else fail(testsLabel, docPassed, String(counts.passed));
  if (docSkipped == null) unverified(skippedLabel, 'not stated', String(counts.skipped));
  else if (Number(docSkipped) === counts.skipped) pass(skippedLabel, docSkipped, String(counts.skipped));
  else fail(skippedLabel, docSkipped, String(counts.skipped));

  if (counts.files == null) {
    unverified(filesLabel, '-', 'no testResults array in the json document');
    return;
  }
  const docFiles = (agents.match(filesRe) ?? [])[1];
  if (docFiles == null) unverified(filesLabel, 'not stated', String(counts.files));
  else if (Number(docFiles) === counts.files) pass(filesLabel, docFiles, String(counts.files));
  else fail(filesLabel, docFiles, String(counts.files));
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
  const { selfTestCitedAnchors } = await import('./docs-verify-self-test.mjs');
  const res = selfTestCitedAnchors(ROOT, citedAnchors);
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

// 1–4. The root and desktop vitest suites.
//
// Four claims each, not two: the run itself ("no failures"), the passed count,
// the SKIP count, and the file count. The skip is a claim rather than a
// footnote because a correct-by-design skip is a fact about the platform, and a
// document that must write `+ 0 skipped` to satisfy the checker has been told
// to state something false. `src/daemon.test.ts:1216` skips on win32 by design:
// `ensureIpcToken` refuses to generate where a 0600 mode is a no-op, because the
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
  countRe: /root \*\*(\d+) passed \+ (\d+) skipped(?: [^**]*)?\*\*/,
  filesRe: /root \*\*\d+ passed \+ \d+ skipped(?: [^**]*)?\*\* \((\d+) files\)/,
  runLabel: 'root vitest (no failures)',
  testsLabel: 'root vitest tests',
  skippedLabel: 'root vitest skipped',
  filesLabel: 'root vitest files',
});

// The desktop suite takes the same shape as the root one, for the same reason:
// its documented number used to be compared against `numTotalTests`, so a
// desktop skip would have been absorbed into the total silently. Measured
// 2026-10-01: the desktop tree has zero `skipIf`/`skip`/`todo`, so its skip
// count is a measured 0 rather than an assumption.
reportSuite({
  counts: vitestCounts('apps/desktop', []),
  countRe: /desktop \*\*(\d+) passed \+ (\d+) skipped(?: [^**]*)?\*\*/,
  filesRe: /desktop \*\*\d+ passed \+ \d+ skipped(?: [^**]*)?\*\* \((\d+) files\)/,
  runLabel: 'desktop vitest (no failures)',
  testsLabel: 'desktop vitest tests',
  skippedLabel: 'desktop vitest skipped',
  filesLabel: 'desktop vitest files',
});
// 5. Cargo
const cargo = countRustTests();
if (cargo != null) {
  const doc = (agents.match(/`cargo test` \*\*(\d+)\*\*/) ?? [])[1];
  if (doc == null) unverified('cargo tests', 'not stated', String(cargo));
  else if (Number(doc) === cargo) pass('cargo tests', doc, String(cargo));
  else fail('cargo tests', doc, String(cargo));
}

// 6. E2E — static derivation, clearly labelled as such. Running Playwright here
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

// 7. Reachability
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

// 8. Gate composition — compare the documented chain to the actual script.
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

// 9. Narrative claims — persona reach into each system prompt.
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

// 10. Narrative claims — the earcon removal, checked two independent ways.
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

// 11. Narrative claims — knowledge/ production importers, and the barrel split.
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

// 12. Module-level test reachability.
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

// 13. Every `file.ts:NNN` anchor AGENTS.md cites must still resolve to a line
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
