import { mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
// Typed by scripts/release-verify.d.mts. Importing this module runs NO stage:
// `RUNNING_AS_CLI` guards everything that installs, launches or kills anything, and
// that is what makes driving the boot verdict here safe. It was measured, not
// assumed — the first version of this file let the import run the whole script.
import {
  archiveRuntimeDir,
  daemonLogFiles,
  evaluateBoot,
  logDelta,
  parsePreflight,
  PREFLIGHT_DEFERRABLE,
  PREFLIGHT_FALSE_NEGATIVE,
  snapshotDaemonLogs,
} from '../scripts/release-verify.mjs';
import type { BootVerdict, StreamSnapshot } from '../scripts/release-verify.mjs';

// W17: `release:verify` stage 6 could not fail.
//
// It read `daemon.log` — child STDERR — and asserted that file did not grow.
// MEASURED on this machine before any change: `daemon.log` was 0 bytes, last
// written 2026-09-27, while `daemon-stdout.log` held 1042 bytes of
// `ok   daemon: ws=127.0.0.1:4097 serve=4096`. That is not a coincidence:
// `apps/desktop/src-tauri/src/main.rs:208` routes the child's stdout to
// `<stem>-stdout.log` and `:212` routes stderr to `<stem>.log`, and the daemon
// prints its banner with `console.log` (src/cli.ts:215). The stage watched the
// stream the daemon barely writes and ignored the one it announces itself on.
//
// Its guard was also three-way (`after !== null && before !== null && after >
// before`), so it skipped the comparison entirely when the log was absent —
// which is what `LogPlan::Unavailable` (main.rs:159-166, 193, with its own test at
// main.rs:2078) produces and what main.rs:1613-1615 explicitly continues past. A
// verifier that passes when the output went nowhere is not verifying.
//
// These tests drive the pure `evaluateBoot` against a real temp filesystem. The
// break case is the DoD: a daemon that logs an ERROR TO STDOUT must fail the
// stage. A stage-6 guard that can only be exercised by a 40-minute Tauri build is
// a guard nobody exercises, which is how this one got here.

const REPO_ROOT = join(import.meta.dirname, '..');
const RUNTIME = join(process.env.USERPROFILE ?? '', '.opencode-voice-runtime');

type Snapshot = StreamSnapshot;
type Verdict = BootVerdict;

const read = (p: string): string => readFileSync(p, 'utf8');
const scratch = (): string => mkdtempSync(join(tmpdir(), 'voxaura-boot-assert-'));

/**
 * Reproduce the stage's own delta computation against a temp dir.
 *
 * Mirrors `logDelta` in release-verify.mjs: read from the pre-boot byte offset to
 * the current end, clamped so a shrunken file cannot produce a negative slice. The
 * `deltaOf` test below pins that this really returns the appended bytes and not
 * the whole file — without it, a clean-pass result could be an artefact of the
 * helper rather than a property of the evaluator.
 */
function deltaReader(dir: string, before: Snapshot): (name: string) => string {
  const after = snapshotDaemonLogs(dir);
  // Uses the script's OWN `logDelta`, not a reimplementation. A second copy of the
  // offset arithmetic could drift, and then these tests would be asserting about a
  // different function than the stage runs.
  return (name: string): string => logDelta(before, after, name, dir);
}

function verdictFor(dir: string, before: Snapshot): Verdict {
  return evaluateBoot({ before, after: snapshotDaemonLogs(dir), readDelta: deltaReader(dir, before) });
}

/** A runtime dir shaped like a clean boot: stderr file present but empty. */
function cleanBootDir(): string {
  const dir = scratch();
  writeFileSync(join(dir, 'daemon.log'), '', 'utf8');
  return dir;
}

const BANNER = 'ok   daemon: ws=127.0.0.1:4097 serve=4096 (token redacted)\n';

describe('W17 · stage 6 reads the stream the daemon banner is actually on', () => {
  test('the banner is printed to stdout, and main.rs sends stdout to -stdout.log', () => {
    // The premise both halves of this fix rest on. If a future refactor moves the
    // banner to stderr, this fails and the comments in release-verify.mjs get
    // revisited rather than silently becoming wrong.
    //
    // TARGET CORRECTED, not loosened. This read `dist/cli.js`, which is
    // gitignored (.gitignore:3 `dist/`), so the premise the entire W17 fix
    // rests on was verifiable only on a machine that had already run
    // `npm run build`. MEASURED from a `--no-hardlinks` clone of d67e751:
    //
    //   ENOENT: no such file or directory, open '<clone>\dist\cli.js'
    //
    // The claim is about the daemon printing to stdout, and the TRACKED source
    // of that claim is `src/cli.ts` — `console.log(\`ok   daemon: ws=…\`)`. That
    // is what is asserted here, so the premise is checked in every clean
    // checkout. The compiled artifact carries the same line and is asserted
    // separately below, under its own name and its own stated prerequisite,
    // rather than being what the premise silently depends on.
    expect(read(join(REPO_ROOT, 'src/cli.ts'))).toMatch(/console\.log\(`ok {3}daemon:/);
    const rust = read(join(REPO_ROOT, 'apps/desktop/src-tauri/src/main.rs'));
    expect(rust).toMatch(/format!\("\{stem\}-stdout\.log"\)/);
    expect(rust).toMatch(/fn open_child_stdout[\s\S]{0,400}open_append/);
  });

  // HONEST GATE — not a silent `return`, which would report PASS and read as
  // coverage while being absent. Vitest lists this as SKIPPED when `dist/` is
  // absent, and the name states the prerequisite that produces it.
  test.runIf(existsSync(join(REPO_ROOT, 'dist/cli.js')))(
    'the BUILT dist/cli.js carries the same stdout banner [skipped unless `npm run build` has produced dist/cli.js]',
    () => {
      expect(read(join(REPO_ROOT, 'dist/cli.js'))).toMatch(/console\.log\(`ok {3}daemon:/);
    },
  );

  test('a CLEAN boot passes, and the notes are real observations', () => {
    const dir = cleanBootDir();
    try {
      const before = snapshotDaemonLogs(dir);
      appendFileSync(join(dir, 'daemon-stdout.log'), BANNER + 'next: Ctrl+C to stop\n', 'utf8');
      const v = verdictFor(dir, before);
      expect(v.failures).toEqual([]);
      expect(v.ok).toBe(true);
      // A passing verdict with no notes would be indistinguishable from "nothing
      // was checked", which is the shape of the defect being fixed.
      expect(v.notes.length).toBeGreaterThan(0);
      expect(v.notes.join(' ')).toContain('stdout grew');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a daemon that logs an ERROR TO STDOUT fails the stage', () => {
    // The DoD, verbatim. The error goes to the stream the old stage never read.
    const dir = cleanBootDir();
    try {
      const before = snapshotDaemonLogs(dir);
      appendFileSync(
        join(dir, 'daemon-stdout.log'),
        BANNER + "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'onnxruntime-node' imported from dist/runtime/vad.js\n",
        'utf8',
      );
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      const marker = v.failures.find((f) => f.code === 'stdout-error-marker');
      expect(marker, `expected stdout-error-marker, got ${JSON.stringify(v.failures)}`).toBeDefined();
      expect(marker!.detail).toContain('ERR_MODULE_NOT_FOUND');
      expect(marker!.detail).toContain('daemon-stdout.log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: the OLD guard passes on that identical error — the defect was real', () => {
    // Proof the previous check was blind rather than merely under-tested. The old
    // logic verbatim: `daemon.log` size before and after, three-way guard, stderr
    // only, no content inspection.
    const dir = cleanBootDir();
    try {
      const sizeBefore = readFileSync(join(dir, 'daemon.log')).length;
      appendFileSync(join(dir, 'daemon-stdout.log'),
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'onnxruntime-node'\n", 'utf8');
      const sizeAfter = readFileSync(join(dir, 'daemon.log')).length;
      const oldPasses = !(sizeAfter !== null && sizeBefore !== null && sizeAfter > sizeBefore);
      expect(oldPasses).toBe(true);

      // …and the new evaluator, on the same tree, does not.
      const before = snapshotDaemonLogs(dir);
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: NO daemon log at all fails — LogPlan::Unavailable is not a pass', () => {
    const dir = scratch();
    try {
      const v = evaluateBoot({ before: { files: {} }, after: snapshotDaemonLogs(dir), readDelta: () => '' });
      expect(v.ok).toBe(false);
      const codes = v.failures.map((f) => f.code);
      expect(codes).toContain('stdout-capture-missing');
      expect(codes).toContain('stderr-capture-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a boot that binds both ports but prints NOTHING to stdout fails', () => {
    const dir = cleanBootDir();
    try {
      writeFileSync(join(dir, 'daemon-stdout.log'), '', 'utf8');
      const before = snapshotDaemonLogs(dir);
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      // stdout-silent, NOT stderr: that is the whole point of the fix.
      expect(v.failures.map((f) => f.code)).toContain('stdout-silent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: anything on stderr fails — the original intent, on the right stream', () => {
    const dir = cleanBootDir();
    try {
      const before = snapshotDaemonLogs(dir);
      appendFileSync(join(dir, 'daemon-stdout.log'), BANNER, 'utf8');
      appendFileSync(join(dir, 'daemon.log'), 'UnhandledPromiseRejection: boom\n', 'utf8');
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      expect(v.failures.map((f) => f.code)).toContain('stderr-not-quiet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a FALLBACK stderr file is read — daemon.log can be the wrong filename', () => {
    // main.rs:180-199 plan_child_logs writes to `daemon-<pid>-<seq>.log` when the
    // canonical name cannot be opened. The old stage read one hardcoded filename
    // and would have reported "unchanged" while every byte went elsewhere.
    const dir = cleanBootDir();
    try {
      const before = snapshotDaemonLogs(dir);
      appendFileSync(join(dir, 'daemon-1234-0.log'), 'daemon failed to open: EPERM\n', 'utf8');
      appendFileSync(join(dir, 'daemon-stdout.log'), BANNER, 'utf8');
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      expect(v.failures.map((f) => f.code)).toContain('stderr-not-quiet');
      expect(v.failures.some((f) => f.detail.includes('daemon-1234-0.log'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a log that SHRANK is reported — append-only, so equal size is not unchanged', () => {
    const dir = cleanBootDir();
    try {
      writeFileSync(join(dir, 'daemon.log'), 'x'.repeat(100), 'utf8');
      const before = snapshotDaemonLogs(dir);
      writeFileSync(join(dir, 'daemon.log'), '', 'utf8');
      appendFileSync(join(dir, 'daemon-stdout.log'), BANNER, 'utf8');
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      expect(v.failures.map((f) => f.code)).toContain('log-truncated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: a panic/fatal line on stdout fails without any JS error marker', () => {
    const dir = cleanBootDir();
    try {
      const before = snapshotDaemonLogs(dir);
      appendFileSync(join(dir, 'daemon-stdout.log'), BANNER + 'fatal: serve password rejected\n', 'utf8');
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      expect(v.failures.map((f) => f.code)).toContain('stdout-error-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BREAK: EADDRINUSE on stdout fails — the boot did not bind the port it claimed', () => {
    const dir = cleanBootDir();
    try {
      const before = snapshotDaemonLogs(dir);
      appendFileSync(join(dir, 'daemon-stdout.log'), BANNER + 'listen EADDRINUSE: address already in use 127.0.0.1:4097\n', 'utf8');
      const v = verdictFor(dir, before);
      expect(v.ok).toBe(false);
      expect(v.failures.map((f) => f.code)).toContain('stdout-error-marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the delta reader returns only what THIS boot appended', () => {
    // Without this, the clean-pass test could be green for the wrong reason: a
    // delta helper that returned the whole file would also "pass" a clean boot,
    // and would have made the ERR_MODULE_NOT_FOUND test pass for the wrong reason
    // too (it would be reading pre-boot text rather than the injected line).
    const dir = cleanBootDir();
    try {
      appendFileSync(join(dir, 'daemon-stdout.log'), 'PREVIOUS_RUN_MARKER\n', 'utf8');
      const before = snapshotDaemonLogs(dir);
      appendFileSync(join(dir, 'daemon-stdout.log'), 'THIS_BOOT_MARKER\n', 'utf8');
      const d = deltaReader(dir, before)('daemon-stdout.log');
      expect(d).toContain('THIS_BOOT_MARKER');
      expect(d).not.toContain('PREVIOUS_RUN_MARKER');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ALL failures are reported, not just the first', () => {
    // A verifier that stops at the first problem makes the next diagnosis depend
    // on how many fixes the operator happened to make at once.
    const dir = scratch();
    try {
      const before: Snapshot = { files: {} };
      const v = evaluateBoot({ before, after: snapshotDaemonLogs(dir), readDelta: () => '' });
      expect(v.failures.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('W17 · the runtime dir is reset so secret CREATION is exercised', () => {
  // HONEST GATE. This asserts a fact about the LOCAL machine: that a real,
  // installed build put the banner on stdout and left stderr empty. That is
  // only observable where such a build has run.
  //
  // It was `if (!existsSync(RUNTIME)) return;` — a silent skip. A bare `return`
  // inside a test body reports PASS, so on any machine without the runtime dir
  // this read as four passing assertions while asserting none. That is the
  // defect class this whole milestone exists to remove, sitting inside the file
  // written to remove it. `test.runIf` reports SKIPPED instead, which is
  // visible, and the name names the prerequisite.
  test.runIf(existsSync(RUNTIME))(
    'MEASURED: the real runtime dir has both daemon streams, stdout holding the banner [skipped unless the app has been installed and run once]',
    () => {
      const files = daemonLogFiles(RUNTIME);
      expect(files).toContain('daemon-stdout.log');
      expect(files).toContain('daemon.log');
      expect(readFileSync(join(RUNTIME, 'daemon-stdout.log')).length).toBeGreaterThan(0);
      expect(read(join(RUNTIME, 'daemon-stdout.log'))).toMatch(/daemon: ws=127\.0\.0\.1:4097/);
    },
  );

  test('archiving moves the dir aside and leaves a fresh, empty one', () => {
    // This is what makes an upgrade run exercise secret CREATION rather than
    // adoption of files an earlier run left behind. Not a delete: `machine.key`
    // decrypts the user's vault and this must never be what destroys it.
    const dir = scratch();
    try {
      writeFileSync(join(dir, 'machine.key'), 'SECRET', 'utf8');
      writeFileSync(join(dir, 'daemon-stdout.log'), 'old output', 'utf8');
      const archive = archiveRuntimeDir(dir, 'test-stamp');
      expect(archive).toBe(`${dir}.pre-release-verify-test-stamp`);
      expect(existsSync(archive!)).toBe(true);
      expect(read(join(archive!, 'machine.key'))).toBe('SECRET');
      expect(existsSync(dir)).toBe(true);
      expect(daemonLogFiles(dir)).toEqual([]);
      rmSync(archive!, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('archiving a non-existent dir is a no-op, not a crash', () => {
    const dir = join(scratch(), 'never-created');
    expect(archiveRuntimeDir(dir, 'test-stamp')).toBeNull();
  });

  test('a snapshot of a fresh dir records ABSENCE, not size 0', () => {
    // The distinction the old guard lost: "absent" meant "skip the check" and 0
    // meant "nothing was written". Only the first is a diagnosability failure.
    const dir = scratch();
    try {
      expect(snapshotDaemonLogs(dir).files).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('W17 · KILL_ON_JOB_CLOSE is asserted, not assumed', () => {
  test('the Job Object flag is present in the supervisor source', () => {
    expect(read(join(REPO_ROOT, 'apps/desktop/src-tauri/src/main.rs'))).toMatch(/KILL_ON_JOB_CLOSE/);
  });

  test('release-verify exports the orphan probe and fails the run when it survives', () => {
    // Exercising the probe needs a live installed build, which is out of scope this
    // session (no NSIS build permitted). What is in scope is that the claim now has
    // a check attached: `AGENTS.md:82` asserted KILL_ON_JOB_CLOSE and nothing in
    // the repo ever looked.
    const src = read(join(REPO_ROOT, 'scripts/release-verify.mjs'));
    expect(src).toMatch(/export function orphanedSidecarProcesses/);
    expect(src).toMatch(/const orphans = orphanedSidecarProcesses\(installDir\)/);
    // A FAILURE, not a warning.
    expect(src).toMatch(/fail\(7, `KILL_ON_JOB_CLOSE is not taking effect/);
  });

  test('BREAK: a boot failure dumps the STREAM the failure is on', () => {
    // The old failure path printed `daemon.log` only — stderr, the file measured
    // at 0 B across three days of boots — while the banner and any module-load
    // error live on stdout. So the log that explains the failure was not in the
    // report.
    const src = read(join(REPO_ROOT, 'scripts/release-verify.mjs'));
    expect(src).toMatch(/const streams = daemonLogFiles\(RUNTIME\)/);
    expect(src).toMatch(/daemon streams : \$\{streams\.length === 0/);
    // Every stream's tail, not one hardcoded filename.
    expect(src).toMatch(/for \(const name of \[\.\.\.streams, 'supervisor\.log'\]\)/);
  });

  test('BREAK: a partial run does not claim the installed artefact booted', () => {
    // MEASURED while testing this script: `--stage=preflight --skip-gate` printed
    // "release:verify PASSED — the installed artefact boots, binds both ports on
    // loopback, and its output was captured…" after verifying nothing of the sort.
    // No installer built, none installed, nothing launched. The false-PASS shape
    // this whole script exists to close was sitting in its own last line.
    const src = read(join(REPO_ROOT, 'scripts/release-verify.mjs'));
    expect(src).toMatch(/if \(limit < STAGES\.indexOf\('assert'\)\)/);
    expect(src).toMatch(/NOT VERIFIED: the installed artefact has NOT been built/);
    expect(src).toMatch(/const VERIFIED = STAGES\.filter/);
    // No CODE path may emit the unconditional claim. Comments are excluded on
    // purpose: the comment above it quotes the old line verbatim to record what was
    // measured, and matching that quote would make this assertion unfalsifiable by
    // deleting the fix.
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(code).not.toMatch(/release:verify PASSED — the installed artefact boots/);
  });
});

describe('W17 · stage 2 can fail', () => {
  // The preflight's real output shape, measured by running it on this machine:
  // `14/15 checks pass` with `MISS  MSVC linker (cl/link) — missing — install VS
  // Build Tools`. Note the em-dash separator and the extra ` — ` inside the detail.
  const PREFLIGHT_OK = [
    'Voxaura packaging preflight',
    '====================================================',
    'PASS  node ≥22 — C:\\Program Files\\nodejs\\node.exe',
    'PASS  npm — C:\\Program Files\\nodejs\\npm',
    'PASS  MSVC linker (cl/link) — link.exe',
    'PASS  NSIS makensis — C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'PASS  frontend dist built',
    '====================================================',
    '15/15 checks pass',
  ].join('\n');

  test('an all-PASS preflight yields no blocking rows', () => {
    const { rows, blocking } = parsePreflight(PREFLIGHT_OK);
    expect(rows).toHaveLength(5);
    expect(blocking).toEqual([]);
    expect(rows[0]).toEqual({ ok: true, name: 'node ≥22', detail: 'C:\\Program Files\\nodejs\\node.exe' });
  });

  test('BREAK: a MISS on a blocking row is a blocking failure', () => {
    // MEASURED on this machine: `packaging-preflight.mjs` reports exactly this —
    // 14/15, with the MSVC linker MISS — and EXITS 0. Before this change stage 2
    // printed those numbers and continued, so a machine with no linker looked
    // identical to a ready one until cargo failed 20 minutes into a build.
    //
    // The MSVC row appears in `blocking` (it is not deferred); stage 2 then settles
    // it by probing the MSVC environment and only keeps it blocking if THAT is
    // negative too. Asserted here as the parser's half — the probe's half needs a
    // Visual Studio install and is asserted at the source below.
    const measured = PREFLIGHT_OK
      .replace('PASS  MSVC linker (cl/link) — link.exe', 'MISS  MSVC linker (cl/link) — missing — install VS Build Tools')
      .replace('15/15 checks pass', '14/15 checks pass');
    const { blocking } = parsePreflight(measured);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toContain('MSVC linker');
    expect(blocking[0]).toContain('missing');

    // A row that is neither deferred nor a known false negative is blocking with
    // no escape hatch at all.
    const noNsis = PREFLIGHT_OK
      .replace('PASS  NSIS makensis — C:\\Program Files (x86)\\NSIS\\makensis.exe', 'MISS  NSIS makensis');
    expect(parsePreflight(noNsis).blocking).toEqual(['NSIS makensis']);
  });

  test('BREAK: `frontend dist built` is deferred, everything else is not', () => {
    // Deferring that one row is what makes the flow runnable on a clean checkout.
    // Deferring any OTHER row would be the defect — including a row nobody has
    // heard of, which is why the allowlist is a Set of one rather than a filter on
    // a name prefix.
    const missingFrontend = PREFLIGHT_OK.replace('PASS  frontend dist built', 'MISS  frontend dist built');
    expect(parsePreflight(missingFrontend).blocking).toEqual([]);

    const missingNpm = PREFLIGHT_OK.replace('PASS  npm — C:\\Program Files\\nodejs\\npm', 'MISS  npm');
    expect(parsePreflight(missingNpm).blocking).toEqual(['npm']);

    const unknownRow = PREFLIGHT_OK.replace('PASS  npm — C:\\Program Files\\nodejs\\npm', 'MISS  some future check');
    expect(parsePreflight(unknownRow).blocking).toEqual(['some future check']);
  });

  test('BREAK: unparseable output yields zero rows, and the caller must fail on that', () => {
    // The caller asserts `rows.length === 0` → fail. Asserted here as the shape,
    // and the caller's behaviour by the source assertions below.
    expect(parsePreflight('total garbage from a rewritten preflight').rows).toEqual([]);
    expect(parsePreflight('').rows).toEqual([]);
  });

  test('BREAK: a detail containing its own em-dash separator still parses whole', () => {
    // `MISS  MSVC linker (cl/link) — missing — install VS Build Tools` has two
    // em-dashes. A greedy or non-anchored regex truncates the detail and the
    // failure message becomes useless, so the measured string is pinned.
    const { rows } = parsePreflight('MISS  MSVC linker (cl/link) — missing — install VS Build Tools');
    expect(rows).toEqual([{ ok: false, name: 'MSVC linker (cl/link)', detail: 'missing — install VS Build Tools' }]);
  });

  test('the MSVC MISS is a known false negative, settled by probing the real environment', () => {
    // MEASURED on this machine: `packaging-preflight.mjs:35` resolves the linker with
    // `which('cl') ?? which('link')` on a BARE PATH, and reports
    // `MISS MSVC linker (cl/link) — missing` while `VsDevCmd.bat` sits at the path
    // stage 3 uses. Treating that row as blocking would fail every machine with
    // Visual Studio installed and no prompt open — which is most of them.
    expect(PREFLIGHT_FALSE_NEGATIVE.has('MSVC linker (cl/link)')).toBe(true);
    // It must NOT be in the DEFERRED set: deferring means "stage 3 makes it true",
    // and nothing makes a bare `which` find cl.exe. It has to be settled by probing.
    expect(PREFLIGHT_DEFERRABLE.has('MSVC linker (cl/link)')).toBe(false);
    const src = read(join(REPO_ROOT, 'scripts/release-verify.mjs'));
    expect(src).toMatch(/for \(const name of PREFLIGHT_FALSE_NEGATIVE\)/);
    expect(src).toMatch(/where cl 2>NUL & where link 2>NUL/);
    // The probe runs INSIDE the MSVC environment, not in a bare shell.
    expect(src).toMatch(/const where = runMsvc\(/);
  });

  test('stage 2 wires the parser into a fail(2, ...), not a print', () => {
    const src = read(join(REPO_ROOT, 'scripts/release-verify.mjs'));
    expect(src).toMatch(/const \{ rows, blocking \} = parsePreflight\(pre\.out\)/);
    // The false-negative rows are settled first, then the remainder decides.
    expect(src).toMatch(/const hardBlocking = blocking\.filter/);
    expect(src).toMatch(/if \(failing\.length > 0\)/);
    expect(src).toMatch(/fail\(2, `packaging preflight reported \$\{failing\.length\} blocking MISS/);
    // The old shape printed the numbers and continued regardless.
    expect(src).not.toMatch(/its exit code is not load-bearing`\)/);
    // MSVC absence must be fatal, not "UNVERIFIED".
    expect(src).toMatch(/fail\(2, `VsDevCmd\.bat not found/);
    expect(src).not.toMatch(/UNVERIFIED: VsDevCmd\.bat/);
  });

  test('an unparseable preflight is a failure, not an implicit pass', () => {
    const src = read(join(REPO_ROOT, 'scripts/release-verify.mjs'));
    expect(src).toMatch(/could not parse any preflight rows/);
    expect(src).toMatch(/fail\(2, `could not parse/);
  });

  test('the known defect in packaging-preflight.mjs is pinned, not hidden', () => {
    // It exits 0 unconditionally. This milestone works around that by parsing
    // rows; the script itself is not in this milestone's write-set. Pinning the
    // defect means the day someone adds `process.exit`, this test fails and the
    // owner is told to drop the workaround — rather than the comment rotting
    // unnoticed in both directions.
    expect(read(join(REPO_ROOT, 'scripts/packaging-preflight.mjs'))).not.toMatch(/process\.exit\(/);
  });
});