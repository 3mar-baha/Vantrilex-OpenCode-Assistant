// Pin the oxlint warning count so a regression cannot be traded against an
// unrelated fix. `--deny-warnings` alone stops new warnings appearing in an empty
// tree; it does not stop a net-zero swap (fix one, introduce one) from passing.
//
// Run as part of `lint:ox`. Exits non-zero when the count moves in either
// direction, and prints what to do about it.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Current known baseline. Lower is better; raise it only when a warning is
 *  deliberately accepted, and say why in the commit that does so. */
const BASELINE = 8;

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BASELINE_FILE = join(ROOT, 'scripts', 'lint-baseline.json');

// Resolve oxlint robustly. Two traps, both hit while writing this:
//
//   1. `npx` is a .cmd shim on Windows and is NOT spawnable from a Node child
//      process (ENOENT). It works from a shell, not from execFileSync.
//   2. `oxlint` is declared in devDependencies but was NOT present in
//      node_modules - it resolved from a global install (v1.85.0). That is a
//      reproducibility defect in its own right, recorded separately; here we
//      prefer the local copy and fall back to PATH so the gate still runs.
const localBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');
const useLocal = existsSync(localBin);
const cmd = useLocal ? localBin : 'oxlint';
const args = useLocal ? [] : [];
// On Windows a bare `oxlint` is a .ps1/.cmd shim, so it must go through the shell.
const run = () =>
  process.platform === 'win32' && !useLocal
    ? execFileSync('cmd', ['/c', 'oxlint'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    : execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

if (!useLocal) {
  console.warn(
    'lint-baseline: oxlint not found in node_modules/.bin - falling back to PATH.\n' +
      '  This means the gate is running a globally-installed oxlint, not the version\n' +
      '  pinned in devDependencies. Run `npm install` to make the gate reproducible.',
  );
}

const out = run();
const m = out.match(/Found (\d+) warnings? and (\d+) errors?/);
if (m === null) {
  console.error('could not parse oxlint output; refusing to guess');
  console.error(out.slice(-500));
  process.exit(2);
}
const warnings = Number(m[1]);
const errors = Number(m[2]);

// A committed baseline file wins when present, so the number is reviewable in a
// diff rather than buried in this script.
const onDisk = existsSync(BASELINE_FILE) ? Number(readFileSync(BASELINE_FILE, 'utf8').trim()) : null;
const expected = onDisk ?? BASELINE;

console.log(`oxlint: ${warnings} warning(s), ${errors} error(s); baseline ${expected}`);

if (errors > 0) {
  console.error(`  FAIL: ${errors} error(s)`);
  process.exit(1);
}
if (warnings > expected) {
  console.error(
    `  FAIL: ${warnings} warnings, baseline is ${expected} (+${warnings - expected}).\n` +
      `  oxlint is advisory, so this will not fail the build unless enforced. Fix them,\n` +
      `  or - if one is deliberately accepted - raise scripts/lint-baseline.json and\n` +
      `  say in the commit why.`,
  );
  process.exit(1);
}
if (warnings < expected) {
  console.log(
    `  baseline is stale: ${warnings} < ${expected}. Lower scripts/lint-baseline.json\n` +
      `  to ${warnings} so the gate keeps catching regressions.`,
  );
  process.exit(1);
}
console.log('  OK');
