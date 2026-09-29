#!/usr/bin/env node
// test-blindspots.mjs — which PRODUCTION modules does no test ever load?
//
// WHY THIS EXISTS. Coverage thresholds are inert here: `vitest.config.ts`
// documents that `coverage.enabled` defaults to false, no gate passes
// `--coverage`, and `@vitest/coverage-v8` is not installed. So the number has
// never been measured, and any threshold written now would be a guess wearing
// a number's clothes.
//
// This script answers the SAME question — where is the testing blind? — using
// only what is already installed. It is not a coverage percentage and does not
// pretend to be: it reports which modules no test can reach, which is the part
// a percentage hides. A file at 0% and a file no test imports look identical in
// an aggregate number.
//
// METHOD. Walk every relative import transitively from each test file, the same
// way `docs:verify` walks from `daemon.ts` + `cli.ts` for reachability. A
// production module that no test reaches is a blind spot: it ships, it is
// typechecked, and no test ever executes it.
//
// This counts TRANSITIVE reachability, so a module imported by a covered module
// counts as reachable. That is the honest bar: it is reachable, not asserted.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const all = walk(SRC);
const prod = all.filter((f) => !f.endsWith('.test.ts'));
const tests = all.filter((f) => f.endsWith('.test.ts'));

/** Resolve quoted relative specifiers, static and dynamic. */
function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/['"](\.[^'"]+)\.js['"]/g)) {
    const target = resolve(dirname(file), `${m[1]}.ts`);
    if (existsSync(target)) out.push(target);
  }
  return out;
}

function reachFrom(entries) {
  const seen = new Set();
  const queue = entries.filter(existsSync);
  while (queue.length > 0) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

// Reachable from ANY test file, transitively.
const testReachable = reachFrom(tests);
// Reachable from production entrypoints — the set that actually ships.
const prodReachable = reachFrom([join(SRC, 'daemon.ts'), join(SRC, 'cli.ts')]);

const rel = (f) => f.replace(ROOT, '').replace(/\\/g, '/');

// Blind spots: SHIPS (production-reachable) but NO TEST reaches it.
const blind = prod.filter(
  (f) => prodReachable.has(f) && !testReachable.has(f) && existsSync(f),
).sort();

// Also worth reporting: modules no test reaches AND that do not ship — those are
// the dead set, already accounted for elsewhere. Reported separately so the two
// are never confused.
const neither = prod.filter((f) => !prodReachable.has(f) && !testReachable.has(f)).sort();

const pct = ((prod.length - blind.length) / prod.length) * 100;

console.log(`test-blindspots — ${tests.length} test files, ${prod.length} production modules\n`);
console.log(`  ships and is reached by >=1 test : ${prod.length - blind.length}`);
console.log(`  SHIPS but NO test reaches it    : ${blind.length}`);
console.log(`  module-level reachability       : ${pct.toFixed(1)}%`);
console.log(`  (not line coverage. It cannot be: no coverage provider is installed.)`);
console.log(`  neither shipped nor tested       : ${neither.length}\n`);

if (blind.length > 0) {
  console.log('  SHIPPING MODULES NO TEST REACHES:');
  for (const f of blind) {
    const lines = readFileSync(f, 'utf8').split('\n').length;
    console.log(`    ${rel(f).padEnd(46)} ${String(lines).padStart(5)} lines`);
  }
  console.log('');
}
if (neither.length > 0) {
  console.log('  DEAD (ships to nothing, tested by nothing) — the known Laya set:');
  for (const f of neither) console.log(`    ${rel(f)}`);
  console.log('');
}

// ── Entry-point dispatch is a distinct, worse blind spot ─────────────────────
//
// `cli.ts` shows up above as a shipping module no test reaches, and the reason
// matters: nothing imports it. It is a top-level ENTRY POINT, executed as a
// process, so "no importer" is its normal shape rather than a smell. That makes
// the walk-based method structurally unable to flag the risk it carries: the
// argv dispatch decides which command runs, which is boundary logic, and the
// E2E suite does not exercise it either because E2E drives `stub-daemon.mjs`
// rather than the real `cli.js`.
//
// Reported separately so the two cases are never confused. A dispatch bug is not
// "this file lacks tests"; it is "the thing that decides what the program does
// is unverified".
const entrypoints = prod.filter((f) => {
  const rel2 = f.replace(ROOT, '').replace(/\\/g, '/');
  return rel2.endsWith('/cli.ts') || rel2.endsWith('/daemon.ts');
});
const untestedEntrypoints = entrypoints.filter((f) => !testReachable.has(f));

if (untestedEntrypoints.length > 0) {
  console.log('  ENTRY POINTS WITH NO TEST (dispatch logic unverified):');
  for (const f of untestedEntrypoints) {
    const lines = readFileSync(f, 'utf8').split('\n').length;
    console.log(`    ${rel(f).padEnd(46)} ${String(lines).padStart(5)} lines`);
  }
  console.log('    ^ these ship, are executed as processes, and decide what runs.');
  console.log('');
}

// Exit code is intentionally 0. This is a measurement, not a gate: a threshold
// set before anyone decided what the number means is the exact defect that made
// the old `lines: 80` worthless. Wire it into a gate only with the owner's
// decision recorded.
process.exit(0);
