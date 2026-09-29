#!/usr/bin/env node
// docs:verify — mechanically re-derive every number AGENTS.md and README.md
// claims, and fail if the code disagrees.
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

/** Run a vitest suite with the JSON reporter and return {tests, files}. */
function vitestCounts(cwd, include) {
  const args = ['vitest', 'run', '--reporter=json', ...(include ?? [])];
  const r = spawnSync('npx', args, { cwd: join(ROOT, cwd), encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  let json;
  const start = r.stdout.indexOf('{');
  if (start < 0) return null;
  try { json = JSON.parse(r.stdout.slice(start)); } catch { return null; }
  // `numTotalTests` is authoritative and already accounts for `test.each`
  // expansion. A static grep of `test(` does NOT: it undercounted the desktop
  // suite by 2 here, which would have produced a false failure.
  //
  // The FILE count is `testResults.length`, NOT `numTotalTestSuites` — the
  // latter counts `describe` blocks (184 for the root suite, against 53 files).
  // Getting that wrong would have made this script "prove" a false claim true by
  // demanding the doc be corrected to match a buggy derivation.
  return {
    tests: json.numTotalTests ?? null,
    files: Array.isArray(json.testResults) ? json.testResults.length : null,
    passed: json.numPassedTests ?? null,
  };
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
  const re = /`([A-Za-z0-9_.-]+\.tsx?):(\d+)`/g;
  // Resolve by BASENAME, recursively. The docs cite `brain.ts:108` and
  // `daemon.ts:790` as bare filenames while the files live at `src/voice/` and
  // `src/` — a fixed two-root lookup called a valid citation "file not found",
  // which is a false FAIL that trains a reader to ignore the check.
  const index = new Map();
  const indexRoots = [join(ROOT, 'src'), join(ROOT, 'apps/desktop/src')];
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
      else if (/\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts')) {
        const seen = index.get(e.name);
        if (seen === undefined) index.set(e.name, [p]);
        else seen.push(p);
      }
    }
  };
  for (const r of indexRoots) if (existsSync(r)) collect(r);
  const out = [];
  const doc = typeof globalThis.__agentsOverride === 'string' ? globalThis.__agentsOverride : agents;
  for (const m of doc.matchAll(re)) {
    const name = m[1];
    const line = Number(m[2]);
    const hits = index.get(name);
    if (hits === undefined) {
      out.push({ name, line, ok: false, why: 'file not found in src/ or apps/desktop/src/' });
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

console.log('docs:verify — deriving truth from the tree…\n');

const agents = existsSync(join(DOC_ROOT, 'AGENTS.md'))
  ? readFileSync(join(DOC_ROOT, 'AGENTS.md'), 'utf8')
  : '';
const pkg = JSON.parse(read('package.json'));

// 1. Root vitest
const root = vitestCounts('.', []);
if (root) {
  const doc = (agents.match(/root \*\*(\d+) passed/) ?? [])[1];
  if (root.tests !== root.passed) fail('root vitest (all passing)', `${root.passed}/${root.tests}`, 'some failing');
  else if (doc == null) unverified('root vitest tests', 'not stated', String(root.tests));
  else if (Number(doc) === root.tests) pass('root vitest tests', doc, String(root.tests));
  else fail('root vitest tests', doc, String(root.tests));
} else unverified('root vitest tests', '-', 'vitest json reporter unavailable');

// 2. Root test files
if (root?.files != null) {
  const doc = (agents.match(/root \*\*\d+ passed \+ 0 skipped\*\* \((\d+) files\)/) ?? [])[1];
  if (doc == null) unverified('root vitest files', 'not stated', String(root.files));
  else if (Number(doc) === root.files) pass('root vitest files', doc, String(root.files));
  else fail('root vitest files', doc, String(root.files));
}

// 3. Desktop vitest
const desk = vitestCounts('apps/desktop', []);
if (desk) {
  const doc = (agents.match(/desktop \*\*(\d+)\*\*/) ?? [])[1];
  if (desk.tests !== desk.passed) fail('desktop vitest (all passing)', `${desk.passed}/${desk.tests}`, 'some failing');
  else if (doc == null) unverified('desktop vitest tests', 'not stated', String(desk.tests));
  else if (Number(doc) === desk.tests) pass('desktop vitest tests', doc, String(desk.tests));
  else fail('desktop vitest tests', doc, String(desk.tests));
} else unverified('desktop vitest tests', '-', 'vitest json reporter unavailable');

// 4. Desktop test files
if (desk?.files != null) {
  const doc = (agents.match(/desktop \*\*\d+\*\* \((\d+) files\)/) ?? [])[1];
  if (doc == null) unverified('desktop vitest files', 'not stated', String(desk.files));
  else if (Number(doc) === desk.files) pass('desktop vitest files', doc, String(desk.files));
  else fail('desktop vitest files', doc, String(desk.files));
}

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

const w = Math.max(...results.map((r) => r.name.length));
console.log('  ' + 'CHECK'.padEnd(w) + '  DOCUMENTED   DERIVED       STATUS');
console.log('  ' + '-'.repeat(w + 34));
for (const r of results) {
  const mark = r.status === 'ok' ? 'PASS' : r.status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log('  ' + r.name.padEnd(w) + '  ' + String(r.documented).padEnd(12) + String(r.derived).padEnd(13) + mark);
}

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'UNVERIFIED');
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
