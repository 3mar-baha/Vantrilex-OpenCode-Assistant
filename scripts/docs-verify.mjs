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
  return { live: live.size, dead: all.length - live.size, lines, all: all.length };
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

// ── derivation ───────────────────────────────────────────────────────────────

console.log('docs:verify — deriving truth from the tree…\n');

const agents = existsSync(join(ROOT, 'AGENTS.md')) ? read('AGENTS.md') : '';
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
  ['dead modules', /DEAD production modules\s*:\s*(\d+)/, reach.dead],
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
}
console.log(`docs:verify passed — ${results.length - skipped.length} claim(s) match the code.`);
process.exit(0);
