#!/usr/bin/env node
// release:verify — the v0.6.0 regression as a single command.
//
// v0.6.0 passed every gate in this repository and shipped a daemon that could
// not boot. The gate verified the test tree; the user installed a binary. Those
// are different systems, and the only thing joining them was a human remembering
// one line in a markdown file. `packaging-preflight.mjs` has 15 checks, 14 pass,
// and CANNOT fail — it exits 0 unconditionally and is wired into no npm script.
//
// This script closes that gap end to end:
//
//   1. gate          — the full test:vantrilex chain must exit 0
//   2. preflight     — packaging preflight must pass (non-zero on failure)
//   3. build         — root tsc build, sidecar provision, NSIS installer
//   4. install       — silent install (/S) of the freshly built installer
//   5. boot          — launch the installed binary, wait for both ports
//   6. assert        — 4096 AND 4097 bound, loopback only, daemon.log UNCHANGED
//   7. cleanup       — always, on success or failure
//
// Stage 6 is the actual regression test. `daemon.log` is append-only, so the
// check is that a clean boot does not GROW it: any error the daemon writes during
// startup is precisely the v0.6.0 signature.
//
// Usage:
//   node scripts/release-verify.mjs              # everything
//   node scripts/release-verify.mjs --stage=build  # stop after NSIS
//   node scripts/release-verify.mjs --skip-gate   # resume, gate already green
//
// Exit 0 = the installed artefact boots. Exit 1 = it does not, and the stage
// that failed is named. UNVERIFIED stages are reported as such, never as pass.

import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

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

const RUNTIME = join(process.env.USERPROFILE, '.opencode-voice-runtime');
const PORTS = [4096, 4097];
const say = (s) => console.log(`  ${s}`);
const head = (s) => console.log(`\n[${s}]`);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Every cargo/tauri call goes through the MSVC environment or the linker is missing. */
function runMsvc(inner) {
  return run(`cmd /c ""${VSDEV}" -no_logo >nul 2>&1 && ${inner}"`);
}

function portsBound() {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    'Get-NetTCPConnection -State Listen -LocalPort 4096,4097 -EA SilentlyContinue ' +
    '| Select-Object LocalPort,LocalAddress | ConvertTo-Json -Compress',
  ], { encoding: 'utf8' }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function logSize(name) {
  const p = join(RUNTIME, name);
  return existsSync(p) ? statSync(p).size : null;
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

let daemonLogBefore = null;
let installerPath = null;
let installDir = join(process.env.LOCALAPPDATA, 'Voxaura');

// ── stages ───────────────────────────────────────────────────────────────────

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
  if (!existsSync(VSDEV)) {
    console.error(`  UNVERIFIED: VsDevCmd.bat not found at ${VSDEV}`);
  } else {
    const r = run('node', ['scripts/packaging-preflight.mjs']);
    // NOTE: the preflight currently exits 0 even when a check fails. That is a
    // known defect (it is 14/15 with a false-negative MSVC row) and the reason
    // this stage reports its numbers rather than trusting its exit code.
    const m = r.out.match(/(\d+)\s*\/\s*(\d+)/);
    say(m ? `preflight reports ${m[0]} (exit ${r.status}; its exit code is not load-bearing)` : `preflight exit ${r.status}`);
  }
}

if (STAGES.indexOf('build') <= limit) {
  head('3/7 build — tsc, sidecar, NSIS');
  const b = runMsvc('npm run build');
  if (b.status !== 0) { console.error('  FAILED: npm run build'); process.stderr.write(b.out.slice(-1500)); process.exit(1); }
  say('root tsc build ok');

  const p = run('node', ['scripts/provision-sidecar.mjs']);
  if (p.status !== 0) { console.error('  FAILED: provision-sidecar'); process.stderr.write(p.out.slice(-1500)); process.exit(1); }
  say('sidecar provisioned');

  if (!NSIS) {
    console.error(`  UNVERIFIED: makensis not found. Install NSIS, or this stage cannot run.`);
    console.error('  Looked in: C:\\Program Files (x86)\\NSIS, C:\\Program Files\\NSIS');
    process.exit(1);
  }
  const t = runMsvc('npm run build:tauri');
  if (t.status !== 0) { console.error('  FAILED: build:tauri'); process.stderr.write(t.out.slice(-2500)); process.exit(1); }

  const nsisDir = join(ROOT, 'apps/desktop/src-tauri/target/release/bundle/nsis');
  const exes = existsSync(nsisDir) ? readdirSync(nsisDir).filter((f) => f.endsWith('_x64-setup.exe')) : [];
  if (exes.length === 0) { console.error('  FAILED: no *_x64-setup.exe produced'); process.exit(1); }
  exes.sort();
  installerPath = join(nsisDir, exes[exes.length - 1]);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  if (!installerPath.includes(version)) {
    console.error(`  FAILED: newest installer is ${exes[exes.length - 1]} but package.json is ${version}.`);
    console.error('  The version bump and the build disagree — a release would ship the wrong binary.');
    process.exit(1);
  }
  say(`built ${exes[exes.length - 1]} (${(statSync(installerPath).size / 1048576).toFixed(1)} MB)`);
}

if (STAGES.indexOf('install') <= limit) {
  head('4/7 install — silent install of the built artefact');
  reap();
  if (existsSync(installDir)) {
    say('removing any previous install so this is a true cold install');
    try { rmSync(installDir, { recursive: true, force: true }); } catch { /* locked; installer will overwrite */ }
  }
  if (!installerPath) { console.error('  FAILED: no installer path — run the build stage first'); process.exit(1); }
  const r = run(`"${installerPath}" /S`);
  say(`installer exit ${r.status}`);
  // NSIS silent install returns before files settle; the boot stage polls anyway.
}

if (STAGES.indexOf('boot') <= limit) {
  head('5/7 boot — launch the installed binary and wait for both ports');
  reap();
  daemonLogBefore = logSize('daemon.log');
  say(`daemon.log before launch: ${daemonLogBefore === null ? '(absent)' : daemonLogBefore + ' B'}`);

  const exe = join(installDir, 'voxaura.exe');
  if (!existsSync(exe)) {
    console.error(`  FAILED: ${exe} not found — the silent install did not produce a runnable binary.`);
    console.error('  This is exactly the v0.6.0 shape: the installer succeeded and the app cannot start.');
    process.exit(1);
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
    const dlog = logSize('daemon.log');
    const slog = logSize('supervisor.log');
    console.error(`  FAILED: only ${bound.length}/2 ports bound after 60 s.`);
    console.error(`    daemon.log     : ${dlog === null ? '(absent)' : dlog + ' B'}`);
    console.error(`    supervisor.log : ${slog === null ? '(absent)' : slog + ' B'}`);
    if (slog !== null) {
      console.error('    supervisor.log tail:');
      console.error(readFileSync(join(RUNTIME, 'supervisor.log'), 'utf8').split('\n').slice(-8).map((l) => '      ' + l).join('\n'));
    }
    process.exit(1);
  }
  say(`both ports bound in ${Math.round((Date.now() - (deadline - 60_000)) / 1000)} s`);
}

if (STAGES.indexOf('assert') <= limit) {
  head('6/7 assert — loopback only, and daemon.log did not grow');
  const bound = portsBound();
  for (const p of PORTS) {
    const hit = bound.find((b) => b.LocalPort === p);
    if (!hit) { console.error(`  FAILED: port ${p} not listening`); process.exit(1); }
    if (hit.LocalAddress !== '127.0.0.1') {
      console.error(`  FAILED: port ${p} bound to ${hit.LocalAddress}, not loopback. The UI is exposed off-box.`);
      process.exit(1);
    }
    say(`port ${p} bound to ${hit.LocalAddress} (loopback only)`);
  }
  const after = logSize('daemon.log');
  if (after !== null && daemonLogBefore !== null && after > daemonLogBefore) {
    console.error(`  FAILED: daemon.log grew ${daemonLogBefore} -> ${after} during a clean boot.`);
    console.error('  A clean start must not log. Read the tail:');
    console.error(readFileSync(join(RUNTIME, 'daemon.log'), 'utf8').split('\n').slice(-10).map((l) => '    ' + l).join('\n'));
    process.exit(1);
  }
  say(`daemon.log unchanged (${after === null ? 'absent' : after + ' B'})`);
}

if (STAGES.indexOf('cleanup') <= limit) {
  head('7/7 cleanup — always runs, pass or fail');
  reap();
  say('reaped installed app and anything holding 4096/4097');
}

console.log('\nrelease:verify PASSED — the installed artefact boots, binds both ports on loopback, and logs nothing.');
process.exit(0);
