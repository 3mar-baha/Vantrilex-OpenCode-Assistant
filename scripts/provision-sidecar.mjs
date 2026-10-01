#!/usr/bin/env node
// Provision the bundled sidecar so a fresh Windows install needs ZERO
// prerequisites (no Node, no npm, no repo checkout) beyond entering API keys.
//
//   node scripts/provision-sidecar.mjs          # assemble the payload
//   node scripts/provision-sidecar.mjs --check  # verify it against dist/, no writes
//
// Output: apps/desktop/src-tauri/sidecar/
//   node.exe            system Node binary, copied
//   dist/               compiled daemon (served by `node dist/cli.js serve`)
//   package.json        copy of scripts/sidecar-manifest.json (PINNED, see W18)
//   package-lock.json   copy of scripts/sidecar-package-lock.json (COMMITTED)
//   node_modules/       installed with `npm ci` against that committed lock
//
// The sidecar is gitignored (large binaries) and declared as a Tauri bundle
// resource, so it rides inside the NSIS installer.
//
// ── W16: WHY PROVISIONING IS WIRED WHERE IT IS ───────────────────────────────
//
// This script used to be called from exactly one place (`release-verify.mjs`)
// and from no npm script. `build:tauri` did not re-provision, so the payload in
// the installer was whatever the last release run happened to leave on disk.
// MEASURED at the start of the W16 fix: root `dist/` held 330 files and the
// shipped sidecar 327 — `dist/cli/agent.js` (the Phase 2 `agent`/`wait`
// headless verbs) was ABSENT from the payload, and 30 more files differed by
// content while 297 matched byte for byte. Nothing crashed: the payload was
// internally self-consistent, being a complete copy of an OLDER `dist/`, so it
// quietly ran the pre-`849cf9b` daemon.
//
// Three things now close that, and each is independently sufficient:
//   1. `prebuild:tauri` runs this script before every `tauri build`
//      (apps/desktop/package.json), so no installer can be cut from a stale
//      payload.
//   2. `--check` compares the payload against `dist/` by content hash, in BOTH
//      directions, and refuses anything stale, extra or missing.
//   3. `release:verify` stage 3 provisions and then re-checks, and stage 3 also
//      runs `--check` against the freshly built `dist/`.
//
// ── W18: WHY THE MANIFEST AND LOCK ARE COMMITTED FILES ──────────────────────
//
// `rmSync(sidecar)` above used to destroy any lockfile, and the script then
// ran `npm install` (not `ci`) against three CARET RANGES, writing a
// gitignored lock into the directory it had just emptied. The installer's
// dependency tree was therefore a function of the npm registry's state at
// provisioning time, not of anything in git. Two rebuilds a week apart could
// ship different code under one version number.
//
// Now: `scripts/sidecar-manifest.json` (exact pins, committed) and
// `scripts/sidecar-package-lock.json` (committed lockfileVersion 3, 39 entries)
// are copied in AFTER the wipe, and `npm ci` installs from the lock. `npm ci`
// fails if the two ever disagree, so the lock cannot drift from the manifest.
//
// INDEPENDENCE, and the pino lesson. This manifest does NOT inherit from the
// root package.json. A dependency deleted at the root is still shipped inside
// the installer until it is deleted from BOTH places. That is how `pino`
// survived the v0.7.2 payload despite `createLogger` having no callers, and
// `eventsource` the same case. `--check` now enforces the removal
// mechanically (see the audit below) rather than relying on having remembered
// to grep for importers first.
//
// ── W19: WHY THERE IS AN AUDIT AND NOT A GREP ────────────────────────────────
//
// The previous payload shipped `runtime/laya/laya-engine.js` with a static
// `import * as ort from 'onnxruntime-node'`, a package deliberately absent from
// the payload (native module — the whole v0.6.0 lesson). It did not crash only
// because all seven laya modules are unreachable from the production roots.
// That is an accident, not a guard, and it is one `import` away from the v0.6.0
// black hole: the module graph would fail to load and 4097 would never open,
// with every unit, Rust and E2E test still green.
//
// `scripts/sidecar-payload-audit.mjs` makes it deliberate. It classifies by
// reachability rather than grepping, because the two cases are different in
// kind: an UNREACHABLE module with an unresolvable import is a landmine, and so
// is a STATICALLY reachable one — but a DYNAMICALLY reached one can be
// legitimate, and one is. MEASURED: `runtime/vad.js` also imports
// `onnxruntime-node`, it IS dynamically reachable from `daemon.js`, and nothing
// breaks because `src/daemon.ts:1157` puts the `import()` inside a promise whose
// `.catch` returns `null`, degrading the gate to the RMS energy gate (pinned by
// `src/policy/sidecar-safety.test.ts`). A flat grep guard would have failed the
// build on that file and taught every reader to ignore the guard. It is declared
// in `DYNAMIC_MISSING_OK` with its anchor instead.
//
// The audit runs BEFORE the copy and AFTER the install, because the two catch
// different mistakes: before, it judges `dist/` against the manifest that is
// about to be installed (catching a dependency the payload does not carry);
// after, it judges the assembled payload (catching a copy or prune that broke
// it). It is also what makes the laya exclusion explicit rather than accidental.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPayload } from './sidecar-payload-audit.mjs';

// ── IMPORT GUARD ─────────────────────────────────────────────────────────────
//
// Everything below has destructive side effects: it `rmSync`s the whole sidecar
// directory, copies an 87 MB `node.exe`, and runs `npm ci`. This module exports
// `diffTrees` for `test/sidecar-payload.test.ts`, and a test that imports a
// module must not re-provision the developer's payload as a side effect.
//
// This was MEASURED, not anticipated: the first run of that test file printed the
// full provisioning transcript — "[sidecar] assembling …", "npm ci", "self-check
// ok" — because the import executed the script. The tests still passed, which is
// exactly what makes it dangerous: a test suite that silently rebuilds the tree
// it is asserting about can pass against a payload it just replaced.
//
// Guarded on `process.argv[1]`, not an env var, so it cannot be defeated by an
// exported environment variable in a shell that happens to have one.
const RUNNING_AS_CLI = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = join(root, 'apps', 'desktop', 'src-tauri', 'sidecar');
const distSrc = join(root, 'dist');
const manifestPath = join(root, 'scripts', 'sidecar-manifest.json');
const lockPath = join(root, 'scripts', 'sidecar-package-lock.json');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * SUBTREES DELIBERATELY NOT SHIPPED. Each entry is a decision, not a fact.
 *
 * `runtime/laya/` is the only one today. It is dead by decision (the 294 MB
 * ONNX model never loads, `layaLoad` has zero consumers, and `ui-server.ts`
 * reports `layaReady: false` precisely so no frame claims a feature that is not
 * live) — and it could not work if it were reached: `laya-engine.js` statically
 * imports `onnxruntime-node`, a native module the payload does not carry.
 *
 * So it is pruned here rather than shipped and quietly never loaded. Shipping it
 * was the actual W19 defect: an unreachable module with an unresolvable import
 * is invisible until someone wires it, and then it is the v0.6.0 black hole —
 * ERR_MODULE_NOT_FOUND at load, 4097 never opens, and every unit, Rust and E2E
 * test still green because E2E drives a stub daemon.
 *
 * PRUNING IS GUARDED, NOT TRUSTED. `assertPrunable` below refuses to delete a
 * subtree that has become reachable, so this list cannot rot into "we delete
 * live code". Adding an entry here is a claim that must stay true; a test in
 * `test/sidecar-payload.test.ts` pins both halves.
 */
const PRUNED_SUBTREES = [
  {
    path: 'runtime/laya',
    reason: 'dead by decision; laya-engine.js statically imports onnxruntime-node (native, absent from the payload) — see W19',
  },
];

// This precondition is a precondition of the CLI, not of the module. It was
// unguarded, which made `RUNNING_AS_CLI` incomplete: the guard above exists
// precisely so that importing this file for `diffTrees` is side-effect-free, and
// then this line killed the importer outright.
//
// MEASURED from a `--no-hardlinks` clone of d67e751, where `dist/` is gitignored
// and therefore absent: `test/sidecar-payload.test.ts` failed AT COLLECTION with
// `Error: process.exit unexpectedly called with "1"`, taking all 60-odd tests in
// that file with it. It passed in the working tree only because that tree had a
// stale `dist/` lying around — the same "green because of undeclared local state"
// class as the other two, one level deeper: not an assertion that was wrong but
// an import that could not be performed.
//
// Behaviour for the CLI is unchanged: run as the script with no `dist/`, and this
// still prints the same message and still exits 1. `RUNNING_AS_CLI &&` only
// removes the side effect from an import.
if (RUNNING_AS_CLI && !existsSync(join(distSrc, 'cli.js'))) {
  console.error('missing dist/cli.js — run `npm run build` first');
  process.exit(1);
}

const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'));

/**
 * Compare two trees by CONTENT, not by name or mtime.
 *
 * Content is the only comparison that can see the W16 defect. A name-and-mtime
 * check calls a payload with every file present and the right timestamps fresh,
 * which is precisely the state a stale-but-complete copy is NOT in only by
 * luck — and `cpSync` preserves mtimes, so the naive check passes forever.
 * Hashing 330 small files costs a few hundred ms and runs once per provision.
 */
/**
 * Decide whether a declared prune may proceed. PURE, and exported, because this
 * is the guard that decides whether live code gets deleted.
 *
 * The reachability proof is what keeps the prune honest. Without it the list is a
 * silent way to delete live code the first time someone wires a module in — and a
 * `dist/` that boots in dev would fail only in an installed build, which is the
 * v0.6.0 shape wearing a different hat. A subtree that has become reachable is a
 * DECISION the tree has already made; refusing to prune forces that decision to be
 * written down (wire it properly, or move the file) rather than inherited from a
 * list someone edited while tired.
 *
 * It returns a REASON rather than exiting, for two reasons: `process.exit` inside
 * a library function cannot be tested, and an early-exiting prune reports one
 * problem when there may be several. `pruneDeclared` turns a non-null reason into
 * the exit.
 *
 * @param {{path: string, reason: string}} entry one PRUNED_SUBTREES entry
 * @param {string[]} unreachable modules the audit proved unreachable
 * @returns {string|null} null = safe to prune; a string = why it must not
 */
export function pruneRefusal(entry, unreachable) {
  const reached = unreachable.filter((m) => m.startsWith(`${entry.path}/`));
  if (reached.length === 0) {
    return `${entry.path} is reachable from the production roots, so it is live code, not dead weight. ` +
      'Wire it properly (and add whatever it imports to scripts/sidecar-manifest.json) or remove the ' +
      'entry from PRUNED_SUBTREES — deleting it here would ship a payload that cannot load. ' +
      'If it became reachable and you believe that is right, the prune declaration is stale and ' +
      'this refusal is the bug, not the wiring.';
  }
  return null;
}

/** The modules a declared prune covers, i.e. the ones proved unreachable under it. */
export function prunedModulesFor(entry, unreachable) {
  return unreachable.filter((m) => m.startsWith(`${entry.path}/`));
}

/**
 * Remove each `PRUNED_SUBTREES` entry, but only after proving it is still
 * unreachable from the production roots.
 *
 * @returns {{modules: string[], files: string[]}} the dist-relative `.js` module
 *   paths and ALL file paths (maps, `.d.ts`, anything else) actually removed.
 *   Both are needed: the module list proves the reachability claim, while the
 *   full file list is what the self-check compares against — a prune that only
 *   excused `.js` would still report the `.js.map` and `.d.ts` siblings of the
 *   same modules as MISSING, which is the exact false alarm that fired here.
 */
function pruneDeclared(payloadDir, payloadDist, deps) {
  const before = auditPayload({ payloadDir, distDir: payloadDist, availablePackages: Object.keys(deps) });
  const modules = [];
  const files = [];
  for (const entry of PRUNED_SUBTREES) {
    const target = join(payloadDist, ...entry.path.split('/'));
    if (!existsSync(target)) {
      console.error(`[sidecar] prune target missing: ${entry.path} — update PRUNED_SUBTREES, do not leave a stale entry`);
      process.exit(1);
    }
    const refusal = pruneRefusal(entry, before.unreachable);
    if (refusal) {
      console.error(`[sidecar] REFUSING to prune ${entry.path}: ${refusal}`);
      process.exit(1);
    }
    const reached = prunedModulesFor(entry, before.unreachable);
    const all = listFilesRecursive(payloadDist).filter((f) => f.startsWith(`${entry.path}/`));
    rmSync(target, { recursive: true, force: true });
    console.log(`[sidecar] pruned ${entry.path}/ — ${reached.length} unreachable modules, ${all.length} files, not shipped`);
    console.log(`[sidecar]   reason: ${entry.reason}`);
    modules.push(...reached);
    files.push(...all);
  }
  return { modules, files };
}

function hashTree(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p).replace(/\\/g, '/'), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

/**
 * W16's DoD: a stale sidecar must be detectable without provisioning first.
 * Returns a list of human-readable differences; empty means identical.
 *
 * @param {{expectedAbsent?: string[]}} [opts]
 *   `expectedAbsent` are source-relative files that are INTENTIONALLY not
 *   shipped (the `PRUNED_SUBTREES`). They are matched by exact path, not by
 *   prefix: a prefix filter would excuse `runtime/laya/index.js` going missing
 *   AND would excuse an unrelated `runtime/laya-extra/foo.js` going missing,
 *   which is the opposite of the property this function exists to prove.
 *   Anything missing that is not named here is still reported.
 */
export function diffTrees(sourceDir, targetDir, { expectedAbsent = [] } = {}) {
  const problems = [];
  if (!existsSync(targetDir)) return [`${targetDir} does not exist — run \`npm run sidecar:provision\``];
  const excused = new Set(expectedAbsent);
  const excusedButPresent = [];
  const a = hashTree(sourceDir);
  const b = hashTree(targetDir);
  for (const [f, h] of a) {
    if (!b.has(f)) {
      if (excused.has(f)) continue;
      problems.push(`MISSING in payload: ${f} (present in dist/)`);
    } else if (b.get(f) !== h) {
      problems.push(`DIFFERS: ${f} (${statSync(join(sourceDir, f)).size} B in dist/ -> ${statSync(join(targetDir, f)).size} B in payload; content hash differs)`);
    } else if (excused.has(f)) {
      excusedButPresent.push(f);
    }
  }
  // A prune that did not happen is a silent behaviour change, not a pass: the
  // payload now carries modules the audit was told are unprunable.
  for (const f of excusedButPresent) problems.push(`PRUNE NOT APPLIED: ${f} is declared pruned but is present in the payload`);
  for (const f of b.keys()) if (!a.has(f)) problems.push(`EXTRA in payload: ${f} (not in ${sourceDir})`);
  return problems;
}

/** An exact semver literal and nothing else: no ^, no ~, no x, no ranges, no tags. */
const EXACT_PIN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * W18's guard, as a PURE function over two JSON documents. Exported so a test can
 * prove it rejects a caret range — this check used to be inline in a
 * `process.exit` path, which means it could only be exercised by running the
 * whole provisioner, and a provisioner run is 87 MB of copying and an `npm ci`.
 *
 * Returns every problem rather than the first, because the three checks
 * (unpinned / lock-missing / lock-disagrees) are independent and an operator
 * fixing them one at a time is the normal case.
 *
 * @param {object} manifest the parsed scripts/sidecar-manifest.json
 * @param {object|null} lock the parsed lockfile, or null when it does not exist
 * @returns {string[]} empty means the manifest and lock are usable together
 */
export function manifestLockProblems(manifest, lock) {
  const problems = [];

  const unpinned = Object.entries(manifest?.dependencies ?? {})
    .filter(([, v]) => !EXACT_PIN.test(String(v)))
    .map(([k, v]) => `${k}: ${v}`);
  if (unpinned.length > 0) {
    problems.push(
      `the sidecar manifest is not pinned — every version must be an exact semver literal ` +
      `(offenders: ${unpinned.join(', ')}). A range makes the installer's tree a function of the ` +
      'registry at provisioning time, which is the W18 defect.',
    );
  }

  if (!lock) {
    problems.push(
      'no committed lockfile. The payload must be a function of committed files, not registry state; ' +
      'without a lock `npm ci` cannot run.',
    );
    return problems;
  }

  const root_ = lock.packages?.[''];
  if (!root_) {
    problems.push('the committed lock has no root package entry — regenerate it');
    return problems;
  }
  if (JSON.stringify(root_.dependencies) !== JSON.stringify(manifest.dependencies)) {
    problems.push(
      'the committed lock disagrees with the manifest, so `npm ci` would fail. Regenerate: ' +
      'cd <tmp>; copy scripts/sidecar-manifest.json to package.json; ' +
      'npm install --package-lock-only --omit=dev; copy package-lock.json to scripts/sidecar-package-lock.json',
    );
  }
  if (lock.name !== manifest.name || lock.version !== manifest.version) {
    problems.push(
      `the committed lock is ${lock.name}@${lock.version} but the manifest is ${manifest.name}@${manifest.version} — ` +
      'npm ci would fail on the root version',
    );
  }
  return problems;
}

/**
 * Is the payload's `node.exe` fit to ship? Exported and injected so a test can
 * prove it rejects an unrunnable binary without shipping 87 MB per case.
 *
 * Three conditions, in increasing strictness, and the order matters:
 *
 *   1. It EXISTS. A missing `node.exe` is the clean case to catch.
 *   2. It is at least `MIN_NODE_EXE_BYTES`. A zero-byte or truncated file
 *      satisfies `existsSync`, rides inside the installer, and dies at the first
 *      `node.exe dist/cli.js serve` — the v0.6.0 shape, one swallowed copy error
 *      away. The floor is 1 MiB rather than a byte count because every Windows
 *      `node.exe` measured on this machine is 87-92 MB, so nothing real is near it
 *      and a stub cannot clear it.
 *   3. It RUNS and reports the expected version. Size is necessary, not
 *      sufficient: a large file can still be the wrong architecture, or a Node
 *      from a different major. Running it is the only check that proves the
 *      shipped interpreter can start, and it costs one process spawn. The version
 *      must match the interpreter that built the shipped `dist/` — a mismatch
 *      means the payload would execute bytecode under a different runtime.
 *
 * `run` is injected so a test can supply a `node.exe` of any shape.
 *
 * @returns {string|null} null when the binary is fit to ship; otherwise the reason
 */
export function nodeExeProblem(path, expectedVersion, run = defaultNodeRun) {
  const MIN_NODE_EXE_BYTES = 1024 * 1024;
  if (!existsSync(path)) return 'node.exe is absent from the payload';
  const size = statSync(path).size;
  if (size < MIN_NODE_EXE_BYTES) {
    return `payload node.exe is ${size} B, below the ${MIN_NODE_EXE_BYTES} B floor. A truncated or ` +
      'zero-byte node.exe ships a payload that cannot run the daemon.';
  }
  let reported;
  try {
    reported = run(path).trim();
  } catch (e) {
    return `payload node.exe did not run: ${String(e.message).split('\n')[0]}`;
  }
  if (reported !== expectedVersion) {
    return `payload node.exe reports ${reported}, this interpreter is ${expectedVersion}. The shipped dist/ ` +
      'was built by this Node, so the payload must carry the same one.';
  }
  return null;
}

function defaultNodeRun(path) {
  return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 30_000 });
}

/** Every range specifier must be gone; a caret reintroduced here fails the build. */
function assertPinned(manifest) {
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
  const problems = manifestLockProblems(manifest, lock);
  if (problems.length > 0) {
    for (const p of problems) console.error(`sidecar manifest/lock: ${p}`);
    process.exit(1);
  }
}

/** dist-relative list of EVERY file under `dir`, any extension. */
function listFilesRecursive(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out;
}



function reportAudit(label, opts) {
  const r = auditPayload(opts);
  for (const a of r.allowed) console.log(`[sidecar] ${label} allow  ${a}`);
  if (!r.ok) {
    console.error(`[sidecar] ${label} audit FAILED (${r.fatal.length}):`);
    for (const f of r.fatal) console.error(`[sidecar]   FATAL ${f}`);
    console.error('[sidecar] The payload cannot load as shipped. This is the v0.6.0 shape.');
    process.exit(1);
  }
  console.log(`[sidecar] ${label} audit ok — ${r.modules} modules, ${r.staticReachable} statically reachable, ${r.unreachable.length} unreachable`);
}

// ── --check: verify only, never write ─────────────────────────────────────────
// Split from the assemble path on purpose. `--check` is the guard a test and a
// CI step call; it must be impossible for it to "fix" the staleness it is
// reporting, because a check that repairs what it measures measures nothing.
if (CHECK_ONLY && RUNNING_AS_CLI) {
  const manifest = readManifest();
  assertPinned(manifest);
  const installed = JSON.parse(readFileSync(join(sidecar, 'package.json'), 'utf8'));
  if (JSON.stringify(installed.dependencies) !== JSON.stringify(manifest.dependencies)) {
    console.error('sidecar: FAIL — the payload manifest is not the committed pinned manifest');
    console.error(`  payload : ${JSON.stringify(installed.dependencies)}`);
    console.error(`  committed: ${JSON.stringify(manifest.dependencies)}`);
    process.exit(1);
  }
  const payloadDist = join(sidecar, 'dist');
  if (!existsSync(payloadDist)) {
    console.error('sidecar: FAIL — the payload has no dist/ — run `npm run sidecar:provision`');
    process.exit(1);
  }
  // The prune must be re-derived here, not trusted from the file. `--check` is
  // the guard a test and a CI step call, and it is asked "is this payload
  // correct?" about bytes on disk that may have been written by anything.
  const expectedAbsent = [];
  for (const entry of PRUNED_SUBTREES) {
    if (existsSync(join(payloadDist, ...entry.path.split('/')))) {
      console.error(`sidecar: FAIL — ${entry.path}/ is present in the payload but is declared pruned`);
      console.error(`  ${entry.reason}`);
      process.exit(1);
    }
    // Every file kind, not just `.js`: the emitted `.js.map` and `.d.ts`
    // siblings of a pruned module are gone too, and excusing only the modules
    // reports them as MISSING on every single run.
    expectedAbsent.push(...listFilesRecursive(distSrc).filter((f) => f.startsWith(`${entry.path}/`)));
  }
  if (expectedAbsent.length === 0) {
    console.error('sidecar: FAIL — no file in dist/ matches any declared prune; PRUNED_SUBTREES is stale');
    process.exit(1);
  }

  const problems = diffTrees(distSrc, payloadDist, { expectedAbsent });
  if (problems.length > 0) {
    console.error(`sidecar: STALE — the payload does not match dist/ (${problems.length} difference(s)):`);
    for (const p of problems.slice(0, 25)) console.error(`  ${p}`);
    if (problems.length > 25) console.error(`  ... and ${problems.length - 25} more`);
    console.error('sidecar: fix with `npm run sidecar:provision`');
    process.exit(1);
  }
  // `node.exe` is checked for PRESENCE and for SIZE. Presence alone is a
  // coverage gap of the same family this file exists to close: a zero-byte or
  // truncated `node.exe` satisfies `existsSync`, ships inside the installer, and
  // fails at the first `node.exe dist/cli.js serve` — the v0.6.0 shape, one
  // uncaught copy error away. The floor is 1 MiB, not a byte count: every
  // Windows `node.exe` measured on this machine is 87-92 MB, so a threshold far
  // below the smallest real binary still cannot be cleared by a stub.
  const nodeExeInPayload = join(sidecar, 'node.exe');
  const nodeProblem = nodeExeProblem(nodeExeInPayload, process.version);
  if (nodeProblem) {
    console.error(`sidecar: STALE — ${nodeProblem}`);
    process.exit(1);
  }
  console.log(`[sidecar] node.exe ${statSync(nodeExeInPayload).size} B, runs, reports ${process.version} (matches this interpreter)`);
  reportAudit('payload', { payloadDir: sidecar });
  console.log(`sidecar: OK — payload matches dist/ (${hashTree(payloadDist).size} files content-hashed both ways, ${expectedAbsent.length} declared-pruned)`);
  process.exit(0);
}

// The assemble path. Guarded for the same reason as `--check` above: importing
// this module must not wipe and rebuild the payload. `diffTrees` is exported for
// tests; everything below it is the CLI's job.
if (RUNNING_AS_CLI) {

console.log('[sidecar] assembling ' + sidecar);
const manifest = readManifest();
assertPinned(manifest);
rmSync(sidecar, { recursive: true, force: true });
mkdirSync(sidecar, { recursive: true });

// 1. Node runtime (the exact binary running this script).
const nodeExe = process.execPath;
cpSync(nodeExe, join(sidecar, 'node.exe'));
console.log('[sidecar] node.exe <- ' + nodeExe);

// 2. Compiled daemon, then the declared prune.
cpSync(distSrc, join(sidecar, 'dist'), { recursive: true });
console.log('[sidecar] dist/ copied');

const pruned = pruneDeclared(sidecar, join(sidecar, 'dist'), manifest.dependencies);

// 3. Pinned manifest + COMMITTED lock, copied in AFTER the wipe above. The order
//    matters and is the W18 fix: the old flow wiped the directory and then let
//    `npm install` invent a lock inside it, so the payload was a function of the
//    registry. `npm ci` installs strictly from the lock and FAILS if the lock
//    and the manifest disagree, which turns a silent drift into a build error.
writeFileSync(join(sidecar, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
cpSync(lockPath, join(sidecar, 'package-lock.json'));
console.log(`[sidecar] pinned manifest (${Object.keys(manifest.dependencies).length} exact pins) + committed lock copied`);

// 4. Audit `dist/` against the PINNED MANIFEST before installing. This is what
//    makes a root-level dependency removal actually prune the payload: it
//    compares the imports the code really emits against the package names the
//    installer will carry, so `pino` cannot survive here the way it survived
//    v0.7.2.
//
//    `availablePackages` is the manifest's dependency list, NOT a check against
//    the ROOT node_modules. Using the root tree would answer a different and much
//    weaker question: the root holds packages the payload deliberately omits, so
//    the very omission that must be caught here would be waved through. That
//    distinction is not cosmetic — it is the difference between "the installer
//    carries everything this code imports" and "the repo does".
reportAudit('payload (pre-install, judged against the PINNED MANIFEST)', {
    payloadDir: sidecar,
    distDir: join(sidecar, 'dist'),
    availablePackages: Object.keys(manifest.dependencies),
  });

// 5. Install from the lock.
console.log('[sidecar] npm ci (committed lock, --ignore-scripts)');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: sidecar,
  stdio: 'inherit',
  shell: true,
});

// 6. Re-audit the ASSEMBLED payload, judged against what `npm ci` ACTUALLY
//    installed rather than what the manifest promised. The two audits catch
//    different mistakes: step 4 asks "will the installer carry every package this
//    code imports?", step 6 asks "does the tree on disk now resolve?", which
//    also covers a partially-written copy and an `npm ci` that installed
//    something other than the lock.
reportAudit('payload (post-install, judged against installed node_modules)', { payloadDir: sidecar });

// 7. Self-verify. Provisioning that does not check its own output is how a
//    stale payload survived in the first place: the script reported "done" over a
//    tree it had never compared to anything.
//
//    The prune is accounted for EXPLICITLY rather than filtered out of the
//    result. `expectedAbsent` means "this file is missing from the payload and
//    that is intended"; anything else missing is still a failure. A filter that
//    silently dropped any `runtime/laya/` path from the comparison would be
//    indistinguishable from a prune that ate live code.
const post = diffTrees(distSrc, join(sidecar, 'dist'), { expectedAbsent: pruned.files });
if (post.length > 0) {
  console.error('[sidecar] SELF-CHECK FAILED — the assembled payload does not match dist/:');
  for (const p of post.slice(0, 25)) console.error(`  ${p}`);
  process.exit(1);
}
const shipped = hashTree(join(sidecar, 'dist'));
console.log(`[sidecar] self-check ok — payload matches dist/ (${shipped.size} files shipped, ${pruned.modules.length} declared-pruned modules, ${pruned.files.length} files)`);

console.log('[sidecar] done. Contents:');
console.log(execFileSync('powershell', ['-NoProfile', '-Command',
  `Get-ChildItem -Force '${sidecar}' | Select-Object Name, Length | Format-Table -AutoSize | Out-String`],
  { encoding: 'utf8' }));
console.log('[sidecar] total size:');
console.log(execFileSync('powershell', ['-NoProfile', '-Command',
  `'{0:N1} MB' -f ((Get-ChildItem -Recurse -File -Force '${sidecar}' | Measure-Object -Property Length -Sum).Sum / 1MB)`],
  { encoding: 'utf8' }));

} // end RUNNING_AS_CLI