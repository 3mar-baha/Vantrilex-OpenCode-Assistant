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

// Resolve oxlint. Audit finding F-02, and the fix is NOT what it looks like.
//
// `oxlint` is declared in devDependencies (pinned exact, no caret) but is absent
// from node_modules, so every run was resolving an AMBIENT GLOBAL binary. Two
// independent pre-existing blockers stop `npm install` from fixing it:
//
//   1. `eslint-plugin-prettier@4.2.5` peer-conflicts with
//      `@eslint-community/eslint-utils@4.10.1` -> ERESOLVE. Present with oxlint
//      removed entirely, so it is unrelated to oxlint.
//   2. oxlint's OPTIONAL peer on `vite-plus` carries a `link:./src/types`
//      dependency, which npm cannot fetch. `legacy-peer-deps=true` suppresses the
//      peer error but then installs vite-plus and dies with EUNSUPPORTEDPROTOCOL.
//
// Pinning to 1.0.0 / 1.10.0 / 1.20.0 / 1.85.0 / 1.86.0 all still fail, so no
// version of the 1.x line installs cleanly alongside vitest 2.x.
//
// So the local install is genuinely blocked, and the honest response is to make
// the gate REFUSE to run on a global binary rather than quietly succeed on one.
// A gate that appears to enforce something it is not enforcing is the exact
// defect F-02 describes; failing loudly is strictly better than passing falsely.
//
// Override with VOXAURA_ALLOW_GLOBAL_OXLINT=1 when you deliberately want the
// ambient binary, e.g. on a machine where the local install is known good.
const localBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');
const useLocal = existsSync(localBin);
const allowGlobal = process.env['VOXAURA_ALLOW_GLOBAL_OXLINT'] === '1';

if (!useLocal && !allowGlobal) {
  console.error(
    'lint-baseline: oxlint is not installed in node_modules/.bin.\n' +
      '\n' +
      '  REFUSING to run the gate on an ambient global binary. A global oxlint is\n' +
      '  not the version pinned in devDependencies, so the gate would be enforcing\n' +
      '  something other than what the project declares - which is finding F-02.\n' +
      '\n' +
      '  `npm install` cannot currently fix this: the tree has two pre-existing\n' +
      '  blockers (an eslint-plugin-prettier peer conflict, and oxlint\'s optional\n' +
      '  vite-plus peer carrying a link: protocol npm cannot fetch). See\n' +
      '  dossier/PHASE2_AUDIT_REPORT.md finding F-02.\n' +
      '\n' +
      '  To run deliberately on the ambient binary:\n' +
      '    VOXAURA_ALLOW_GLOBAL_OXLINT=1 npm run lint:ox',
  );
  process.exit(1);
}

// Spawn rules, both learned the hard way:
//   - `npx` and `node_modules/.bin/*.cmd` are Windows batch shims. execFileSync
//     cannot spawn them directly: npx gives ENOENT, a .cmd gives EINVAL. Both
//     have to go through `cmd /c`.
//   - On POSIX both are real executables and spawn directly.
const spawnOpts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
const isWindows = process.platform === 'win32';
const target = useLocal ? localBin : 'oxlint';
const run = () =>
  isWindows
    ? execFileSync('cmd', ['/c', target], spawnOpts)
    : execFileSync(target, [], spawnOpts);

if (!useLocal) {
  console.warn('lint-baseline: VOXAURA_ALLOW_GLOBAL_OXLINT=1 - running an UNPINNED ambient oxlint.');
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
