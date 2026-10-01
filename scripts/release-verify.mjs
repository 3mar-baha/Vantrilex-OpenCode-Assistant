#!/usr/bin/env node
// release:verify — the v0.6.0 regression as a single command.
//
// v0.6.0 passed every gate in this repository and shipped a daemon that could
// not boot. The gate verified the test tree; the user installed a binary. Those
// are different systems, and the only thing joining them was a human remembering
// one line in a markdown file.
//
// This script closes that gap end to end:
//
//   1. gate          — the full test:vantrilex chain must exit 0
//   2. preflight     — packaging environment, and every blocking MISS row fails
//   3. build         — root tsc build, sidecar provision + audit, NSIS installer
//   4. install       — silent install (/S) of the freshly built installer
//   5. boot          — launch the installed binary, wait for both ports
//   6. assert        — ports, loopback, and a DIAGNOSABLE clean boot (see below)
//   7. cleanup       — always, on success or failure, and it ASSERTS teardown
//
// ── WHY STAGE 6 READS STDOUT AND NOT STDERR ─────────────────────────────────
//
// The old stage 6 read `daemon.log` and asserted it did not grow. Measured on
// this machine before any of this changed: `daemon.log` was **0 bytes**, last
// written 2026-09-27, while `daemon-stdout.log` held 1042 bytes of
// `ok   daemon: ws=127.0.0.1:4097 serve=4096` — the actual banner. That is not
// a coincidence, it is `apps/desktop/src-tauri/src/main.rs:208-220`: stdout goes
// to `<stem>-stdout.log` and stderr to `<stem>.log`. The stage was watching the
// one stream the daemon barely uses, so it could not observe the startup it was
// written to observe. It passed on a clean boot and would equally have passed on
// a boot that printed a stack trace.
//
// Three ways that check could not fail, all fixed here:
//   - The guard was `after !== null && before !== null && after > before`, so an
//     ABSENT log — which is exactly what `LogPlan::Unavailable` produces
//     (main.rs:159-166, 193, a path with its own test at main.rs:2078) — skipped
//     the comparison entirely and reported nothing.
//   - stderr may land in a `LogPlan::Fallback` file named `daemon-<pid>-<n>.log`
//     when the canonical name is taken. The old check read ONE filename and would
//     never have seen it. The snapshot below reads the whole `daemon*.log` family.
//   - The runtime dir was never reset, so an upgrade run could never exercise
//     secret CREATION, and the pre-existing logs made "did not grow" a statement
//     about a file some earlier run had written.
//
// So stage 6 now asserts four separable things, and `evaluateBoot` is the pure
// function that decides them — which is what makes the guard testable at all. A
// check that can only be exercised by a 40-minute Tauri build is a check nobody
// verifies; see `test/release-verify-boot.test.ts`, which drives this function
// with an injected stdout error and requires a FAIL.
//
// ── WHAT "PASS" MEANS HERE ──────────────────────────────────────────────────
//
// Exit 0 = the installed artefact boots, binds both ports on loopback, and its
// output was both captured AND clean. Exit 1 = it does not, and the stage that
// failed is named. UNVERIFIED stages are reported as such, never as pass —
// which is why stage 2 fails rather than warning when MSVC is missing, and why
// stage 7 asserts teardown instead of hoping for it.

import { existsSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const NSIS = [
  'C:\\Program Files (x86)\\NSIS\\makensis.exe',
  'C:\\Program Files\\NSIS\\makensis.exe',
].find((p) => existsSync(p));
const VSDEV = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VsDevCmd.bat'
  .replace('Microsoft Visual Studio\\18\\Community\\VsDevCmd.bat',
           'Microsoft Visual Studio\\18\\Community\\Common7\\Tools\\VsDevCmd.bat');

const args = process.argv.slice(2);
const upTo = (args.find((a) => a.startsWith('--stage=')) ?? '').split('=')[1] ?? 'cleanup';
const skipGate = args.includes('--skip-gate');
const STAGES = ['gate', 'preflight', 'build', 'install', 'boot', 'assert', 'cleanup'];
const limit = STAGES.indexOf(upTo);
if (limit < 0) {
  console.error(`release:verify: unknown stage "${upTo}". Known: ${STAGES.join(', ')}`);
  process.exit(2);
}

// When imported by a test rather than run, do nothing. Every stage below has a
// side effect on the developer's machine — it installs, launches and kills
// processes — and a test that imports this module must not perform any of them.
// The guard is `process.argv[1]`, not an env flag, so it cannot be set by accident
// in a shell that happens to have the variable exported.
const RUNNING_AS_CLI = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

const RUNTIME = process.env.VOICE_RUNTIME_DIR
  ?? join(process.env.USERPROFILE, '.opencode-voice-runtime');
const PORTS = [4096, 4097];
const say = (s) => console.log(`  ${s}`);
const head = (s) => console.log(`\n[${s}]`);

/**
 * Preflight rows whose MISS must fail stage 2.
 *
 * `frontend dist built` is MISS on a clean checkout and is produced by stage 3, so
 * requiring it here would make the release flow unrunnable on the machine that
 * most needs to run it. Everything else must pass.
 */
export const PREFLIGHT_DEFERRABLE = new Set(['frontend dist built']);

/**
 * Preflight rows whose MISS is a KNOWN FALSE NEGATIVE, settled by running the real
 * thing instead of trusting the row.
 *
 * `packaging-preflight.mjs:35` resolves the linker with `which('cl') ?? which('link')`
 * on a BARE PATH. On Windows those tools exist only inside a developer command
 * prompt — they are exported by `VsDevCmd.bat` — so the row reports MISS on a
 * machine with Visual Studio fully installed and merely not-open-prompt. MEASURED
 * here: `14/15 checks pass` with `MISS MSVC linker (cl/link) — missing` while
 * `VsDevCmd.bat` sits at the exact path stage 3 uses.
 *
 * So the row can be neither trusted nor ignored. Stage 3 does not run in a bare
 * shell either — every cargo/tauri call goes through `runMsvc` — which is why the
 * release flow worked despite this row. Stage 2 therefore asks the MSVC environment
 * directly (`where cl`) and reports what it found, instead of failing a machine
 * that can build and passing one that cannot.
 *
 * `packaging-preflight.mjs` is not this milestone's write-set; the underlying
 * `which` is reported separately for an owner fix. Until then this Set is the
 * allowlist, and anything added to it must say here what settles it instead.
 */
export const PREFLIGHT_FALSE_NEGATIVE = new Set(['MSVC linker (cl/link)']);

/**
 * Parse `packaging-preflight.mjs` output into rows. Pure, and exported, because
 * stage 2's only real job is this decision and a decision that can only be
 * reached by running a 40-minute release is a decision nobody verifies.
 *
 * The preflight prints `PASS  <name>` / `MISS  <name> — <detail>` plus a
 * `N/M checks pass` summary, and — measured — exits 0 on every outcome, so its exit
 * code is not load-bearing and the rows are the whole signal.
 *
 * @returns {{rows: Array<{ok: boolean, name: string, detail: string}>, blocking: string[]}}
 *   `blocking` names the rows that must pass. Empty `rows` is itself a failure the
 *   caller must treat as one: a preflight whose output changed shape must not read
 *   as "all clear".
 */
export function parsePreflight(out) {
  const rows = [...String(out).matchAll(/^(PASS|MISS)\s{2}(.+?)(?:\s+—\s(.*))?$/gm)]
    .map((m) => ({ ok: m[1] === 'PASS', name: (m[2] ?? '').trim(), detail: (m[3] ?? '').trim() }));
  const blocking = rows.filter((r) => !r.ok && !PREFLIGHT_DEFERRABLE.has(r.name))
    .map((r) => `${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  return { rows, blocking };
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Every cargo/tauri call goes through the MSVC environment or the linker is missing. */
function runMsvc(inner) {
  return run(`cmd /c ""${VSDEV}" -no_logo >nul 2>&1 && ${inner}"`);
}

function portsBound() {
  // MUST tolerate a non-zero exit. `Get-NetTCPConnection` returns exit 1 when
  // nothing matches, which is the NORMAL state on the first poll of the boot
  // loop — the app has not bound a port yet. Using execFileSync here threw on
  // exactly that first poll and crashed the harness mid-boot, which is how the
  // previous run died at stage 5 with a working app underneath it.
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    'Get-NetTCPConnection -State Listen -LocalPort 4096,4097 -EA SilentlyContinue ' +
    '| Select-Object LocalPort,LocalAddress | ConvertTo-Json -Compress',
  ], { encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || out === '' || out === 'null') return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function logSize(name) {
  const p = join(RUNTIME, name);
  return existsSync(p) ? statSync(p).size : null;
}

// ── the log snapshot, and why it is a whole family of files ─────────────────

/**
 * Every `daemon*` log in the runtime dir, keyed by name.
 *
 * NOT just `daemon.log`. `main.rs:180-199` (plan_child_logs) falls back to
 * `daemon-<pid>-<seq>.log` when the canonical name cannot be opened, and
 * `main.rs:208-220` sends stdout to `daemon-stdout.log`. The old stage 6 read
 * one hardcoded filename, so a fallback file received every write and the check
 * saw an unchanged `daemon.log` — a PASS produced by looking at the wrong file.
 * The family is matched by prefix so a name this script has never heard of still
 * gets read.
 */
export function daemonLogFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^daemon.*\.log$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * Byte offset + size + a content hash per daemon log file.
 *
 * Size alone cannot support the assertion stage 6 needs. The check is about what
 * the boot ADDED, and these files are append-only and shared across every run
 * this machine has ever done — the pre-existing content is not this boot's
 * output and must not be judged as such. Offsets make "what did this boot write"
 * exactly answerable; the hash makes a rewrite (rather than an append) visible,
 * which a size comparison would call "unchanged" whenever the file happens to be
 * the same length.
 *
 * Absence is recorded as a MISSING ENTRY, never as size 0. Collapsing the two is
 * the bug being fixed: a `LogPlan::Unavailable` daemon wrote nowhere, and the old
 * guard could not tell that from a daemon that wrote nothing.
 */
export function snapshotDaemonLogs(dir) {
  const snap = { files: {}, missing: [] };
  for (const name of daemonLogFiles(dir)) {
    const p = join(dir, name);
    const size = statSync(p).size;
    snap.files[name] = { offset: size, size, sha: hashFile(p) };
  }
  return snap;
}

function hashFile(p) {
  // Imported lazily so this module stays loadable in a test environment where
  // the file may not exist at import time.
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/**
 * The bytes appended to `name` between two snapshots. '' when absent either side.
 *
 * `dir` is an EXPLICIT parameter rather than the module-level `RUNTIME` constant.
 * That is a measured correction, not a style choice: with `RUNTIME` captured at
 * import time, a test cannot point the delta reader at a temp directory, and the
 * only way to make it work was to mutate `process.env.VOICE_RUNTIME_DIR` — which
 * this function never reads again, so the tests silently read the developer's real
 * `~/.opencode-voice-runtime` and passed for the wrong reason. `RUNTIME` is still
 * the default the CLI stages use.
 */
export function logDelta(before, after, name, dir = RUNTIME) {
  const a = after.files[name];
  if (!a) return '';
  const b = before.files[name];
  const buf = readFileSync(join(dir, name));
  if (!b) return buf.toString('utf8');
  return buf.subarray(Math.min(b.offset, a.offset)).toString('utf8');
}

/**
 * THE STAGE-6 VERDICT. Pure, so it can be tested without an installed build.
 *
 * Four independent conditions, each able to fail on its own:
 *
 *   1. `stdoutGrew`  — the daemon's STDOUT stream must exist and have grown.
 *      This is the load-bearing one. The banner (`ok   daemon: ws=...`) is on
 *      stdout (cli.ts:215 via console.log), so a boot that printed nothing to
 *      stdout either crashed before its first log line or had its stdout capture
 *      fail — and `main.rs:1613-1615` handles that failure by CONTINUING
 *      (`log_line("daemon: stdout capture unavailable — continuing without it")`).
 *      A verifier that passes when the output went nowhere is not verifying.
 *   2. `stderrQuiet` — no daemon stderr stream may have grown. This keeps the
 *      original intent of the check, now on the stream it was meant to watch, and
 *      it covers the fallback files too.
 *   3. `stderrPresent` — at least one stderr stream must EXIST. Absence is the
 *      `LogPlan::Unavailable` signature and used to skip the check silently.
 *   4. `stdoutClean` — no error marker in the newly appended stdout text.
 *
 * Returns every failing condition with its evidence, never the first one. A
 * verifier that reports only the first problem makes the next run's diagnosis
 * depend on how many fixes the operator happened to make at once.
 */
export function evaluateBoot({ before, after, readDelta }) {
  const failures = [];
  const notes = [];

  // Split by stream. stdout is `<stem>-stdout.log`; everything else `daemon*` is
  // the stderr family, including any `daemon-<pid>-<seq>.log` fallback.
  const isStdout = (n) => /-stdout\.log$/.test(n);
  const stdoutNames = Object.keys(after.files).filter(isStdout);
  const stderrNames = Object.keys(after.files).filter((n) => !isStdout(n));

  // 1. stdout captured and used.
  if (stdoutNames.length === 0) {
    failures.push({
      code: 'stdout-capture-missing',
      detail: 'no daemon-stdout.log exists after a boot that reported both ports bound. main.rs:1613-1615 ' +
        'continues without stdout capture when the file cannot be opened, so this is the ' +
        'LogPlan/capture-unavailable path — the boot produced no diagnosable output.',
    });
  } else {
    let grew = 0;
    for (const n of stdoutNames) {
      const delta = readDelta(n);
      if (delta.trim().length > 0) grew += delta.length;
    }
    if (grew === 0) {
      failures.push({
        code: 'stdout-silent',
        detail: `daemon stdout log(s) [${stdoutNames.join(', ')}] did not grow during the boot. The daemon ` +
          'banner is printed to stdout (src/cli.ts:215 console.log), so a boot that added nothing to ' +
          'stdout is either not the build under test or had its output discarded.',
      });
    } else {
      notes.push(`daemon stdout grew ${grew} B across [${stdoutNames.join(', ')}]`);
    }

    // 4. error markers in what the boot actually wrote.
    const ERRORS = [
      { re: /\bERR_MODULE_NOT_FOUND\b/, label: 'ERR_MODULE_NOT_FOUND (v0.6.0: the module graph failed to load)' },
      { re: /\bMODULE_NOT_FOUND\b/, label: 'MODULE_NOT_FOUND' },
      { re: /\bCannot find (?:module|package)\b/, label: 'unresolvable import' },
      { re: /\bunhandled(?:Rejection)?\b/i, label: 'unhandled rejection' },
      { re: /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b/, label: 'uncaught JS exception' },
      { re: /\bEADDRINUSE\b/, label: 'EADDRINUSE (a port was already taken, so this boot did not bind it)' },
      { re: /^\s*(?:error|fatal|panic)\b/im, label: 'error/fatal/panic line' },
    ];
    for (const n of stdoutNames) {
      const delta = readDelta(n);
      for (const { re, label } of ERRORS) {
        const m = re.exec(delta);
        if (m) {
          const line = delta.slice(Math.max(0, delta.lastIndexOf('\n', m.index) + 1)).split('\n')[0];
          failures.push({
            code: 'stdout-error-marker',
            detail: `${label} in the daemon stdout delta of ${n}: "${line.trim()}"`,
          });
        }
      }
    }
  }

  // 3. stderr captured at all.
  if (stderrNames.length === 0) {
    failures.push({
      code: 'stderr-capture-missing',
      detail: 'no daemon stderr log exists. main.rs:212-220 open_child_stderr returns None on LogPlan::Unavailable ' +
        '(main.rs:159-166, 193) and main.rs:1622 then logs "bring-up failures will be silent" — the exact ' +
        'condition under which a startup error cannot be observed. The old check skipped silently here.',
    });
  }

  // 2. stderr quiet.
  for (const n of stderrNames) {
    const delta = readDelta(n);
    if (delta.trim().length > 0) {
      const tail = delta.split('\n').filter((l) => l.trim()).slice(-8).join(' | ');
      failures.push({
        code: 'stderr-not-quiet',
        detail: `a clean boot must not write to stderr, but ${n} grew ${delta.length} B: ${tail}`,
      });
    } else {
      notes.push(`daemon stderr ${n} unchanged (${after.files[n].size} B total, ${delta.length} B added)`);
    }
  }

  // Report rewritten files as a failure of their own: append-only means the
  // snapshot must only ever GROW, and a same-size rewrite would otherwise read
  // as "unchanged".
  for (const [name, a] of Object.entries(after.files)) {
    const b = before.files[name];
    if (b && a.size < b.size) {
      failures.push({
        code: 'log-truncated',
        detail: `${name} shrank ${b.size} -> ${a.size}. These files are append-only; a rewrite means the log ` +
          'was replaced, so "did not grow" cannot be concluded from it.',
      });
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

/**
 * Archive the runtime dir so a run exercises secret CREATION and so the logs
 * being asserted on belong to THIS boot.
 *
 * Not a deletion: the previous dir is moved to `<name>.pre-release-verify-<ts>`,
 * so a run that turns out to be chasing a state someone cared about is
 * reversible. Deleting it would also destroy the `machine.key` that decrypts the
 * user's vault, which is a far worse outcome than a slightly cluttered home dir.
 *
 * Returns the archive path, or null when there was nothing to archive.
 */
export function archiveRuntimeDir(dir, stamp) {
  if (!existsSync(dir)) return null;
  const archive = `${dir}.pre-release-verify-${stamp}`;
  try {
    rmSync(archive, { recursive: true, force: true });
  } catch { /* a stale archive is not worth failing the run over */ }
  try {
    require$rename(dir, archive);
  } catch (e) {
    throw new Error(`could not archive the runtime dir ${dir}: ${e.message}. Refusing to continue: ` +
      'without a clean dir, secret creation is never exercised and the log assertions compare this ' +
      "boot against a previous run's output.");
  }
  mkdirSync(dir, { recursive: true });
  return archive;
}

function require$rename(from, to) {
  // `renameSync` on a directory fails across devices; a copy+remove fallback is
  // not worth the complexity here because both paths share a parent by
  // construction (`${dir}.pre-...`), so this is always same-volume.
  return renameSync(from, to);
}

/** Stop anything holding our ports or running our binary, so a run is repeatable. */
function reap() {
  for (const pattern of ['voxaura.exe', 'Voxaura\\sidecar\\node.exe']) {
    run('taskkill', ['/F', '/IM', pattern]);
  }
  run('powershell', ['-NoProfile', '-Command',
    "Get-NetTCPConnection -State Listen -LocalPort 4096,4097 -EA SilentlyContinue " +
    "| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }"]);
}

/**
 * KILL_ON_JOB_CLOSE, asserted from the script side.
 *
 * `AGENTS.md:82` claims both children (opencode serve, the daemon) die with the
 * supervisor because they sit in a `KILL_ON_JOB_CLOSE` Job Object. Nothing in
 * the repo asserted it. The claim has an observable consequence: kill the
 * supervisor and the sidecar `node.exe` must disappear on its own, without
 * anyone taskkilling it by name. If it survives, the Job Object is not doing its
 * job and a quit leaves an orphaned daemon holding 4097.
 *
 * Returns null on success, or a description of the survivor.
 */
export function orphanedSidecarProcesses(installDir, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const target = 'Voxaura\\sidecar\\node.exe';
  const probe = () => {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue ` +
      `| Where-Object { $_.ExecutablePath -like '*${installDir.replace(/\\/g, '\\\\')}*' } ` +
      '| Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress',
    ], { encoding: 'utf8' });
    const out = (r.stdout ?? '').trim();
    if (r.status !== 0 || out === '' || out === 'null') return [];
    try {
      const parsed = JSON.parse(out);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  };
  let survivors = probe();
  while (survivors.length > 0 && Date.now() < deadline) {
    run('taskkill', ['/F', '/IM', 'voxaura.exe']);
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { encoding: 'utf8' });
    survivors = probe();
  }
  if (survivors.length === 0) return null;
  return `${survivors.length} sidecar node.exe process(es) survived the supervisor's death ` +
    `(pid ${survivors.map((s) => s.ProcessId).join(', ')}, expected under ${target}). ` +
    'KILL_ON_JOB_CLOSE is not taking effect; quitting the app would leave an orphaned daemon on 4097.';
}

let snapshotBefore = null;
let installerPath = null;
let installDir = join(process.env.LOCALAPPDATA, 'Voxaura');
let bootStart = 0;

/** Exit non-zero, naming the stage. Every stage failure routes through here. */
function fail(stage, message, extra = '') {
  console.error(`\nrelease:verify FAILED at stage ${stage}.`);
  console.error(`  ${message}`);
  if (extra) process.stderr.write(extra);
  process.exit(1);
}

// ── stages ───────────────────────────────────────────────────────────────────
//
// Everything below is inside `if (RUNNING_AS_CLI)`. The exports above are the
// testable surface; the stages are the untestable-in-CLI part, and importing this
// module must never install, launch or kill anything.

if (RUNNING_AS_CLI) {

if (STAGES.indexOf('gate') <= limit && !skipGate) {
  head('1/7 gate — the full test:vantrilex chain');
  const r = run('npm', ['run', 'test:vantrilex']);
  if (r.status !== 0) {
    console.error('release:verify FAILED at stage 1 (gate).');
    process.stderr.write(r.out.split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
  say('gate exit 0');
}

if (STAGES.indexOf('preflight') <= limit) {
  head('2/7 preflight — packaging environment');
  // This stage used to PRINT the preflight's numbers and continue. It cannot do
  // that: `scripts/packaging-preflight.mjs` has no `process.exit`, so it exits 0
  // on every outcome (measured here: `14/15 checks pass` with a `MISS` on the
  // MSVC linker, exit 0). Trusting that exit code would make the stage
  // decorative — a green row of 14/15 read as "preflight passed".
  //
  // `scripts/packaging-preflight.mjs` is NOT this milestone's write-set, so the
  // fix lives here: parse its `MISS` rows and fail on the ones that block a
  // Windows bundle. The preflight itself should still gain a `process.exit` —
  // reported to the owner separately — but this stage no longer depends on that
  // having happened.
  if (!existsSync(VSDEV)) {
    // Was `UNVERIFIED:` + continue. Without the MSVC environment there is no
    // linker, so stage 3 cannot produce an installer; proceeding would only
    // discover it 20 minutes later inside cargo with a much worse message.
    fail(2, `VsDevCmd.bat not found at ${VSDEV} — no MSVC environment, so no linker, so no NSIS bundle.`);
  }
  const pre = run('node', ['scripts/packaging-preflight.mjs']);
  const { rows, blocking } = parsePreflight(pre.out);
  if (rows.length === 0) {
    fail(2, `could not parse any preflight rows out of the output (exit ${pre.status}). ` +
      'A preflight whose output changed shape must not read as "all clear".', pre.out);
  }
  for (const row of rows) {
    if (row.ok) say(`PASS  ${row.name}`);
  }
  // Settle each known-false-negative row by asking the environment the row could
  // not reach, then keep it blocking only if that answer is also negative. An
  // unparseable answer is treated as negative: defaulting to "fine" would make the
  // exception a loophole.
  const settled = [];
  for (const name of PREFLIGHT_FALSE_NEGATIVE) {
    const row = rows.find((r) => r.name === name);
    if (!row || row.ok) continue;
    const where = runMsvc('where cl 2>NUL & where link 2>NUL');
    const found = where.status === 0 && /cl\.exe|link\.exe/i.test(where.out);
    if (found) {
      say(`${name}: preflight says MISS (it resolves on a bare PATH), but the MSVC environment has it — ${where.out.split('\n')[0].trim()}`);
    } else {
      settled.push(`${name} — the MSVC environment has neither cl.exe nor link.exe (${VSDEV})`);
    }
  }
  const hardBlocking = blocking.filter((b) => ![...PREFLIGHT_FALSE_NEGATIVE].some((n) => b.startsWith(n)));
  const failing = [...hardBlocking, ...settled];
  if (failing.length > 0) {
    fail(2, `packaging preflight reported ${failing.length} blocking MISS row(s):`,
      failing.map((b) => `    MISS  ${b}`).join('\n') + '\n');
  }
  const deferred = rows.filter((r) => !r.ok && PREFLIGHT_DEFERRABLE.has(r.name));
  for (const r of deferred) say(`deferred (built by stage 3)  ${r.name}`);
  say(`preflight: ${rows.length - deferred.length}/${rows.length} rows pass, exit ${pre.status} (its exit code is NOT load-bearing — it is always 0)`);
}

if (STAGES.indexOf('build') <= limit) {
  head('3/7 build — tsc, sidecar provision + audit, NSIS');
  // Stamped BEFORE the build: everything verified afterwards must be newer.
  const buildStartedAt = Date.now();
  const b = runMsvc('npm run build');
  if (b.status !== 0) fail(3, 'npm run build', b.out.slice(-1500));
  say('root tsc build ok');

  // W16: provisioning runs BEFORE `build:tauri`, and the payload is then
  // re-verified against the `dist/` this stage just built. Without the second
  // step, "provisioned" only means the script exited 0 — the W16 defect was a
  // sidecar three builds behind, self-consistent and silently serving the wrong
  // daemon. `provision-sidecar.mjs` self-checks too; this is the check from the
  // outside, which is the one that survives a future edit to that script.
  const p = run('node', ['scripts/provision-sidecar.mjs']);
  if (p.status !== 0) fail(3, 'provision-sidecar', p.out.slice(-2500));
  say('sidecar provisioned (pinned manifest + committed lock + payload audit)');

  const c = run('node', ['scripts/provision-sidecar.mjs', '--check']);
  if (c.status !== 0) {
    fail(3, 'the sidecar payload does not match the dist/ just built — refusing to bundle a stale payload.',
      c.out.slice(-2500));
  }
  const okLine = c.out.split('\n').find((l) => l.startsWith('sidecar: OK'));
  say(okLine ?? 'sidecar:check exit 0');

  if (!NSIS) {
    fail(3, 'makensis not found — no NSIS bundle can be produced. Looked in: ' +
      'C:\\Program Files (x86)\\NSIS, C:\\Program Files\\NSIS');
  }
  // `build:tauri` lives in apps/desktop/package.json, NOT the root manifest.
  // Running it from root fails with "Missing script" — which is exactly what
  // happened on the first execution of this harness.
  const t = runMsvc('npm run build:tauri --prefix apps/desktop');
  if (t.status !== 0) fail(3, 'build:tauri (apps/desktop)', t.out.slice(-2500));

  const nsisDir = join(ROOT, 'apps/desktop/src-tauri/target/release/bundle/nsis');
  const exes = existsSync(nsisDir) ? readdirSync(nsisDir).filter((f) => f.endsWith('_x64-setup.exe')) : [];
  if (exes.length === 0) fail(3, 'no *_x64-setup.exe produced');
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  // STALE-ARTEFACT GUARD. The bundle directory keeps one installer per release,
  // so a previous run's binary for the SAME version is sitting right there.
  // Selecting by name alone would install that one and report success — proving
  // yesterday's code and calling it today's. This is the v0.6.0 failure wearing a
  // different hat: a green check on an artefact nobody built from the tree under
  // test. Only an installer newer than buildStartedAt may be installed.
  const fresh = exes
    .map((f) => join(nsisDir, f))
    .filter((f) => f.includes(version))
    .filter((f) => statSync(f).mtimeMs > buildStartedAt)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (fresh.length === 0) {
    const stale = exes.filter((f) => f.includes(version));
    fail(3, `no installer for ${version} was produced by THIS build.` +
      (stale.length
        ? '\n  A stale artefact is present and was deliberately NOT used:\n' +
          stale.map((s) => `    ${s}  built ${new Date(statSync(join(nsisDir, s)).mtimeMs).toISOString()}`).join('\n') +
          '\n  Delete the bundle directory and re-run, or the boot check below is meaningless.'
        : ''));
  }
  installerPath = fresh[0];
  say(`built ${installerPath.split(/[\\/]/).pop()} (${(statSync(installerPath).size / 1048576).toFixed(1)} MB, produced by this run)`);
}

if (STAGES.indexOf('install') <= limit) {
  head('4/7 install — silent install of the built artefact');
  reap();
  if (existsSync(installDir)) {
    say('removing any previous install so this is a true cold install');
    try { rmSync(installDir, { recursive: true, force: true }); } catch { /* locked; installer will overwrite */ }
  }
  if (!installerPath) fail(4, 'no installer path — run the build stage first');
  const r = run(`"${installerPath}" /S`);
  // The installer returning 0 is NOT proof the install happened; NSIS returns
  // before files settle and a failed silent install can still exit 0. The boot
  // stage verifies by launching, so this only records what was observed.
  say(`installer exit ${r.status} (not load-bearing on its own — stage 5 launches the binary and proves the files settled)`);
  // NSIS silent install returns before files settle; the boot stage polls anyway.
}

if (STAGES.indexOf('boot') <= limit) {
  head('5/7 boot — launch the installed binary and wait for both ports');
  reap();

  // W17: archive the runtime dir BEFORE snapshotting, so (a) this boot creates
  // `ipc.token` / `serve.pass` / `machine.key` from scratch rather than adopting
  // files an earlier run left behind — the upgrade path was never exercised —
  // and (b) the logs stage 6 judges are this boot's alone. Not a delete:
  // `machine.key` decrypts the user's vault, and this script must not be the
  // thing that destroys it.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = archiveRuntimeDir(RUNTIME, stamp);
  say(archive
    ? `archived the previous runtime dir to ${archive} — secret CREATION will be exercised, not adoption`
    : 'runtime dir did not exist — a cold first run');

  bootStart = Date.now();
  snapshotBefore = snapshotDaemonLogs(RUNTIME);
  say(`daemon log streams before launch: ${Object.keys(snapshotBefore.files).length === 0 ? '(none — expected after the archive)' : Object.keys(snapshotBefore.files).join(', ')}`);

  const exe = join(installDir, 'voxaura.exe');
  if (!existsSync(exe)) {
    fail(5, `${exe} not found — the silent install did not produce a runnable binary.\n` +
      '  This is exactly the v0.6.0 shape: the installer succeeded and the app cannot start.');
  }
  say(`launching ${exe}`);
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 60_000;
  let bound = [];
  while (Date.now() < deadline) {
    bound = portsBound();
    if (bound.length >= PORTS.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (bound.length < PORTS.length) {
    const slog = logSize('supervisor.log');
    // Dump EVERY daemon stream, not just `daemon.log`. On a boot failure the
    // stdout stream is where the banner and any module-load error live, and the
    // old failure path printed stderr only — so the log that explains the failure
    // was not in the report.
    const streams = daemonLogFiles(RUNTIME);
    console.error(`  FAILED: only ${bound.length}/2 ports bound after 60 s.`);
    console.error(`    supervisor.log : ${slog === null ? '(absent)' : slog + ' B'}`);
    console.error(`    daemon streams : ${streams.length === 0 ? '(NONE — output capture failed entirely)' : streams.join(', ')}`);
    for (const name of [...streams, 'supervisor.log']) {
      if (!existsSync(join(RUNTIME, name))) continue;
      console.error(`    ${name} tail:`);
      console.error(readFileSync(join(RUNTIME, name), 'utf8').split('\n').filter((l) => l.trim())
        .slice(-10).map((l) => '      ' + l).join('\n'));
    }
    process.exit(1);
  }
  say(`both ports bound in ${Math.round((Date.now() - bootStart) / 1000)} s`);
}

// THE v0.6.0 REGRESSION TEST, and the stage that used to be decorative.
//
// The old version read `daemon.log` (child STDERR) and asserted it did not grow.
// Measured before this change on this machine: `daemon.log` was 0 B and last
// written 2026-09-27, while `daemon-stdout.log` held 1042 B of `ok daemon: ws=…`.
// `main.rs:208` sends stdout to `<stem>-stdout.log`; the daemon prints its banner
// with `console.log` (src/cli.ts:215). So the stage watched the stream the daemon
// barely writes and ignored the one it announces itself on — it could not have
// seen a startup error printed to stdout, and its guard was
// `after !== null && before !== null && after > before`, which also skipped
// entirely when the file was absent (the LogPlan::Unavailable case).
//
// `evaluateBoot` is pure and imported by test/release-verify-boot.test.ts, which
// drives it with a daemon that logged an ERROR to stdout and requires a FAIL.
if (STAGES.indexOf('assert') <= limit) {
  head('6/7 assert — loopback only, and a DIAGNOSABLE clean boot');
  const bound = portsBound();
  for (const p of PORTS) {
    const hit = bound.find((b) => b.LocalPort === p);
    if (!hit) fail(6, `port ${p} not listening`);
    if (hit.LocalAddress !== '127.0.0.1') {
      fail(6, `port ${p} bound to ${hit.LocalAddress}, not loopback. The UI is exposed off-box.`);
    }
    say(`port ${p} bound to ${hit.LocalAddress} (loopback only)`);
  }

  const after = snapshotDaemonLogs(RUNTIME);
  const verdict = evaluateBoot({
    before: snapshotBefore ?? { files: {} },
    after,
    readDelta: (name) => logDelta(snapshotBefore ?? { files: {} }, after, name),
  });
  for (const n of verdict.notes) say(n);
  if (!verdict.ok) {
    console.error(`  the boot produced ${verdict.failures.length} diagnosability failure(s):`);
    for (const f of verdict.failures) console.error(`    [${f.code}] ${f.detail}`);
    const streams = daemonLogFiles(RUNTIME);
    for (const name of streams) {
      console.error(`    ${name} tail:`);
      console.error(readFileSync(join(RUNTIME, name), 'utf8').split('\n').filter((l) => l.trim())
        .slice(-12).map((l) => '      ' + l).join('\n'));
    }
    process.exit(1);
  }
  say(`daemon output captured and clean — streams: ${Object.keys(after.files).join(', ')}`);
}

if (STAGES.indexOf('cleanup') <= limit) {
  head('7/7 cleanup — always runs, pass or fail');
  reap();
  // KILL_ON_JOB_CLOSE, asserted rather than assumed. `AGENTS.md:82` claims both
  // children die with the supervisor; nothing checked it. `reap()` kills
  // `voxaura.exe` BY NAME, so if the sidecar `node.exe` is still alive afterwards
  // it can only be alive because the Job Object did not take it — which means
  // quitting the app for real leaves an orphaned daemon holding 4097.
  say('reaped installed app and anything holding 4096/4097');
  const orphans = orphanedSidecarProcesses(installDir);
  if (orphans) {
    fail(7, `KILL_ON_JOB_CLOSE is not taking effect.\n  ${orphans}`);
  }
  say('no orphaned sidecar process survived the supervisor (KILL_ON_JOB_CLOSE holds)');
}

// A partial run must not claim the whole thing passed.
//
// MEASURED while testing this script: `--stage=preflight --skip-gate` printed
// "release:verify PASSED — the installed artefact boots, binds both ports on
// loopback, and its output was captured…" after verifying nothing of the sort —
// no installer was built, none was installed, nothing was launched. The same line
// printed on `--stage=build`. This is the false-PASS shape the whole script exists
// to close, sitting in its own last line, so it states only what was actually run.
//
// `VERIFIED` lists the stages that completed; the exit code is 0 either way
// because a partial run succeeded at what it was asked to do. What it must not do
// is say more than that.
const VERIFIED = STAGES.filter((s) => STAGES.indexOf(s) <= limit && !(s === 'gate' && skipGate));
console.log(`\nrelease:verify PASSED for the stages it ran: ${VERIFIED.join(' → ')}.`);
if (limit < STAGES.indexOf('assert')) {
  console.log(`NOT VERIFIED: the installed artefact has NOT been built, installed, launched or`);
  console.log(`asserted (stopped after "${upTo}"). Run the full \`npm run release:verify\` for that claim.`);
}
if (VERIFIED.includes('assert')) {
  console.log('The installed artefact boots, binds both ports on loopback, and its output was');
  console.log('captured on the stream it was written to and read clean.');
}
process.exit(0);

} // end RUNNING_AS_CLI
