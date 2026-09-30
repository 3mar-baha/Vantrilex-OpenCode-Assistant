# Section 11 — VERIFIED TEST MATRIX & BENCHMARK AUDIT
## Section 12 — RUNBOOK, BUILD PIPELINE & FORENSIC VERDICT

**Auditor:** subagent (tests + build). **Repo:** `O:\opencode-Vantrilex`
**HEAD at start and at finish:** `9f41c96eb716985a12b7a6b8c235b5acad42f6b8` (unchanged, verified twice)
**Date of measurement:** 2026-09-30, 14:46–14:58 local.
**Toolchain:** `node v25.0.0`, `npm 11.6.2`.

**Files this audit deliberately did NOT open, and used as evidence for nothing:**
`docs/` (all), `README.md`, `README.ar.md`, `CHANGELOG.md`, `AGENTS.md`,
`dossier/PROJECT_MASTER_DOSSIER.md`, and the sibling sections
`dossier/sections/02-toolchain.md`, `04-lifecycle.md`, `13-appendix-areeb.md`
(their presence was observed via directory listing only). Every number below
came from a command I ran and whose output I quote.

**Disclosed limitation that shapes this entire section:** another process was
actively writing `src/cli/` and `src/cli.ts` in the working tree for the whole
duration of this audit. Section 11 therefore reports **two** measured states —
state A (committed tree only) and state B (working tree, including in-flight
uncommitted code) — plus a timeline, because a single number would have been a
falsehood. See "The non-determinism timeline" below.

---

## 11.0 Physical ground truth — established before running anything

### 11.0.1 Language ecosystems: what applies and what does not

Command:
```
cd O:\opencode-Vantrilex; if (Test-Path go.mod) {...} else {"go.mod ABSENT"}; ...
```
Verbatim:
```
go.mod ABSENT
pyproject.toml ABSENT
pytest.ini ABSENT
setup.cfg ABSENT
tox.ini ABSENT
```

`go test ./...` and `pytest` were **NOT RUN**, and are not reported as failures.
There is no Go module and no Python project configuration in this repository.
The Rust test suite is not at the repository root; it is at
`apps/desktop/src-tauri` (manifest `apps/desktop/src-tauri/Cargo.toml`), and it
is the only non-JavaScript test suite in the tree.

### 11.0.2 The `.py` census — and a correction to the brief I was given

The brief I received stated that all 12,338 `.py` files on disk are inside
`.venv` and that the venv has "its own pytest". **Both halves of that are wrong,
and the correction matters more than the original claim.**

Command:
```
Get-ChildItem -Recurse -File -Filter *.py | Where-Object { $_.FullName -notmatch '\\\.venv\\' }
```
Verbatim:
```
ALL .py on disk: 12339
.py inside .venv: 12317
.py OUTSIDE .venv: 22
--- venv dirs found ---
O:\opencode-Vantrilex\.venv
--- .venv py test files ---
2830
```

The 22 files outside `.venv` are, in full:
```
.hf_cache\hub\datasets--KareemBb--Jordanian-Dialect-Instruct-QA\.no_exist\0b9a6c34c18edcd5eaf811d83583fcd7b09625a7\Jordanian-Dialect-Instruct-QA.py
.hf_cache\modules\__init__.py
.hf_cache\modules\datasets_modules\__init__.py
ml\bench_onnx.py
ml\diagnose_shortcut.py
ml\eval_adversarial.py
ml\eval_onnx.py
ml\export_onnx.py
ml\finalize_l2.py
ml\gen_tokenizer_golden.py
ml\head_metrics.py
ml\latency_compare.py
ml\laya_hub.py
ml\negation_probe.py
ml\score_probe.py
ml\stress_battery.py
ml\train_laya.py
ml\verify_g1.py
ml\verify_g2.py
ml\data\generate_synth.py
ml\data\harvest_joda.py
node_modules\flatted\python\flatted.py
```

**Not one of those 22 is a test file.** I grepped all of `ml\*.py` and
`ml\data\*.py` for pytest constructs:
```
Select-String -Path 'ml\*.py','ml\data\*.py' -Pattern '^\s*(def test_|import pytest|class Test)'
```
Result: **zero matches.** `ml/` is an ML experimentation directory (Laya ONNX
export, latency comparison, dataset synthesis) with no pytest suite in it.

**Correction 1 — the venv has no pytest.** The 2,830 `test_*.py` files are
*library* test fixtures shipped inside installed packages, not a runnable suite
for this project. `.venv\Lib\site-packages` has 131 entries and **none** of them
match `pytest`, `_pytest`, `pluggy` or `iniconfig`:
```
site-packages entries: 131
venv python.exe EXISTS
```
and `.venv\Scripts\pytest.exe` does not exist. `Get-Command pytest` returns
nothing. `pip list` filtered for `pytest|torch|numpy|onnx` returns:
```
numpy              2.2.6
onnx               1.18.0
onnxruntime        1.22.0
torch              2.7.1+cpu
```
No pytest line. So a bare `pytest` on this machine does not merely run the wrong
suite — it **does not exist at all**.

**Correction 2 — the hazard is still real, and I state it as measured.** 12,317
Python files live under `O:\opencode-Vantrilex\.venv\Lib`, 2,830 of them named
`test_*.py` / `*_test.py`. `.venv\pyvenv.cfg` is a valid Python 3.12.10
environment rooted at this repository. If pytest were ever installed into it —
or if collection were invoked with this repository as rootdir — default
`norecursedirs` does not exclude a directory literally named `.venv`, and
collection would descend into 12,317 files. **The measurement is the
consequence, not a prediction:** today `pytest` is not on `PATH` and
`.venv\Scripts\pytest.exe` is absent, so no such run can occur. This is
recorded because the *shape* of the trap survives the correction, and a future
`pip install pytest` into that venv would arm it.

**`ml/` is a second, undiscovered corpus risk.** `ml/` contains 17 Python files
that are not a test suite today. Nothing in `package.json`, `vitest.config.ts`,
`playwright.config.ts` or either `tsconfig.json` references `ml/`, and neither
`tsconfig.json` nor `vitest.config.ts` includes a `.py` glob. No gate can
currently execute it. If a future `ml/verify_g1.py`-style script were wired into
CI, it would be a first gate in the project with no framework.

### 11.0.3 Source-file census — the brief's 279 is not reproducible

The brief I received stated "279 project source files: `src` 157, `apps` 110,
`scripts` 10". **I could not reproduce that figure under any filter, and my
measured numbers are the ones I report.**

Commands and verbatim results, all excluding `node_modules`, `.venv`, `target`,
`dist`, `.git`, `.hf_cache`:

```
src ts/tsx: 162   apps ts/tsx: 106   scripts ts/tsx: 1   -> sum 269
src (all files): 163   apps (all files, excl nm/target): 183   scripts: 11   -> sum 357
```

Attempting to find the filter that yields 279:
```
TS/TSX only  -> src=162 apps=106 scripts=1 sum=269
TS family    -> src=162 apps=106 sum=268
JS/TS/Rs/etc -> src=163 apps=127 scripts=11
```

No filter produces 279. The closest is `.ts`/`.tsx` only at **269**
(src 162, apps 106, scripts 1). The brief's per-directory figures (src 157,
apps 110, scripts 10) do not correspond to any combination I measured.

**One concrete correction to the brief's own arithmetic:** with `node_modules`
included, `apps` counts **4,254** `.ts`/`.tsx` files, because
`apps/desktop/node_modules` exists. Any `apps` count above ~180 that does not
exclude `node_modules` is counting installed dependencies, not project source.
That is the most likely origin of a 4,254-vs-110 style discrepancy.

**My reported census: 269 project `.ts`/`.tsx` files (src 162, apps 106,
scripts 1), or 357 project files of any extension excluding build output and
dependencies (src 163, apps 183, scripts 11).** I report the 357 figure as the
"project source files" total and the 269 as the "TypeScript" total, and I flag
that neither equals 279.

### 11.0.4 Port pre-flight

Command: `Get-NetTCPConnection -LocalPort <p>` for 4096, 4097, 4197, 1420.
Verbatim:
```
PORT 4096 BUSY state=Established pid=35484 local=127.0.0.1
PORT 4096 BUSY state=Listen     pid=35484 local=127.0.0.1
PORT 4097 FREE
PORT 4197 FREE
PORT 1420 FREE
--- voxaura processes ---
    Id ProcessName
   9308 OpenCode
  13140 OpenCode
  13984 OpenCode
  20384 OpenCode
  24296 OpenCode
  28700 OpenCode
  35484 opencode
  29432 opencode-cli
```

**Port 4096 is held by PID 35484, an `opencode` process — very probably the host
of the session I am running inside. I did not kill it.** No `voxaura.exe` and no
`Voxaura\sidecar\node.exe` is running, so the installed-app class of port
collision is absent.

This turned out not to block anything, and the reason is worth recording
precisely, because it contradicts the assumption in my brief that all four
ports gate E2E. `apps/desktop/playwright.config.ts` declares exactly two
`webServer` entries:
```ts
webServer: [
  { command: 'node ./e2e/stub-daemon.mjs', port: 4197, reuseExistingServer: false, stdout: 'pipe' },
  { command: 'npm run dev:web -- --port 1420 --strictPort', port: 1420, reuseExistingServer: false,
    env: { VOICE_RUNTIME_IPC_TOKEN: 'e2e-token' } },
]
```
**E2E needs 4197 and 1420 — both free. It does not need 4096.** The stub daemon
announces its own ports in the run output: `[WebServer] e2e stub daemon: ws=4097
control=4197`. So the E2E stage binds 4097, not 4096. My brief's claim that
4096 must be free for E2E is **not supported by the Playwright configuration I
read**.

### 11.0.5 Working-tree state before and after

Before (first command of the audit):
```
$ git status --short
?? docs/HEADLESS-BRIDGE-VERIFY.md
?? src/cli/
$ git rev-parse HEAD
9f41c96eb716985a12b7a6b8c235b5acad42f6b8
```

After (last command of the audit):
```
$ git status --short
 M src/cli.ts
?? docs/HEADLESS-BRIDGE-VERIFY.md
?? dossier/sections/
?? src/cli/
$ git diff --stat
 src/cli.ts | 14 ++++++++++++++
 1 file changed, 14 insertions(+)
$ git rev-parse HEAD
9f41c96eb716985a12b7a6b8c235b5acad42f6b8
```

**My compliance with the bar:** I did not modify any tracked file. The one
tracked modification, `src/cli.ts`, was made by the concurrent process, not by
me. Proof from the diff content — it adds a headless-bridge dispatch branch:
```
+import { HEADLESS_USAGE_SUFFIX, isHeadlessCommand } from './cli/commands.js';
+} else if (isHeadlessCommand(command)) {
+  const { runHeadless } = await import('./cli/headless.js');
+  process.exit(await runHeadless(command, process.argv.slice(2)));
+  console.log(HEADLESS_USAGE_SUFFIX);
```
`src/cli.ts` mtime is `Wednesday, September 30, 2026 2:46:27 PM`. My first
`git status` showed no ` M src/cli.ts`, so the edit landed between my first
command and my last. Every command I ran was read-only with respect to the
working tree, except `tsc -p tsconfig.json` (invoked as a sub-step of
`npm run test:e2e`), which writes to `outDir: "dist"` and not to `src`. My only
file written in the repository is this one, `dossier/sections/11-tests.md`.

---

## 11.1 Complete command ledger — every command, exit code, wall-clock

All durations are measured wall-clock milliseconds around the process, captured
by a scratch harness at
`%LOCALAPPDATA%\Temp\opencode\run-gate.ps1`. No exit code in this table is
inferred.

| # | Command | Exit | ms | Verbatim summary line |
|---|---|---|---|---|
| 1 | `npm run typecheck` (state A) | **2** | 5772 | `src/cli/turn.ts(331,24): error TS2339: Property 'source' does not exist on type 'string'.` |
| 2 | `npm run typecheck:tests` (state A) | **2** | 8693 | identical 9 errors to #1 |
| 3 | `npm run lint` (state A) | **1** | 24860 | `✖ 6 problems (6 errors, 0 warnings)` |
| 4 | `npm run lint:ox` (state A) | **1** | 969 | `oxlint: 12 warning(s), 0 error(s); baseline 8` / `FAIL: 12 warnings, baseline is 8 (+4).` |
| 5 | `npm run test` @14:48:19 (state A) | **0** | 11345 | `Test Files  81 passed (81)` / `Tests  1197 passed (1197)` |
| 6 | `npm run test:desktop` @14:48:40 | **0** | 23144 | `Test Files  44 passed (44)` / `Tests  589 passed (589)` |
| 7 | `npm run test:e2e` | **0** | 61477 | `33 passed (52.7s)` |
| 8 | `cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml` | **0** | 64866 | `test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.37s` |
| 9 | `npm run docs:verify` (state A) | **1** | 25550 | `docs:verify FAILED — 6 claim(s) contradict the code:` |
| 10 | `npm run docs:verify:self-test` | **1** | 1074 | `self-test FAILED - 1 of 4.` |
| 11 | `npm run test:blindspots` (state A) | **0** | 697 | `production modules tested         : 72 of 82` |
| 12 | `npm run test` @14:50:03 | **1** | 9488 | `Test Files  1 failed | 81 passed (82)` / `Tests  5 failed | 1216 passed (1221)` |
| 13 | `npm run typecheck` @14:53 (state B) | **0** | 2879 | (no diagnostics) |
| 14 | `npm run typecheck:tests` @14:53 | **2** | 7462 | `src/cli/serve.test.ts(243,39): error TS2345: Argument of type 'string' is not assignable to parameter of type 'SessionId'.` |
| 15 | `npm run lint` @14:53 | **1** | 8366 | `✖ 6 problems (6 errors, 0 warnings)` |
| 16 | `npm run lint:ox` @14:54 | **1** | 839 | `oxlint: 12 warning(s), 0 error(s); baseline 8` |
| 17 | `npm run test` @14:54:07 | **1** | 9988 | `Test Files  1 failed | 83 passed (84)` / `Tests  1 failed | 1257 passed (1258)` |
| 18 | `npx vitest run --reporter=json` | **0** | — | 84 files in JSON report (per-file timings harvested) |
| 19 | `npx vitest run --reporter=json` (desktop) | **0** | — | 44 files in JSON report |
| 20 | `npm run test:vantrilex` @14:56:43 | **0** | 118073 | `Test Files  85 passed (85)` / `Tests  1273 passed (1273)` / `33 passed (59.8s)` |
| 21 | `npm run docs:verify` (state B) | **1** | 29777 | `docs:verify FAILED — 7 claim(s) contradict the code:` |
| 22 | `npm run test:blindspots` (state B) | **0** | 861 | `production modules tested         : 79 of 82` |

**One command failed for a harness reason and I re-ran it.** My first attempt at
#8 wrapped the MSVC invocation in a PowerShell→`cmd /c`→logfile chain and
produced `MS = 41` with no log file, because the nested quoting collapsed. I
discarded that measurement and re-ran the command directly, which produced the
64866 ms / exit 0 in the table. I report the second, valid run and do not
report the harness failure as a gate result.

---

## 11.2 The measured test matrix

Every row is a real tool summary line. Nothing here is a paraphrase.

| Suite | Command that produced it | Files | Tests | Passed | Failed | Ignored/Skipped | Suite duration | Process ms | Exit |
|---|---|---|---|---|---|---|---|---|---|
| Root vitest (state A) | `npm run test` @14:48:19 | 81 | 1197 | 1197 | 0 | 0 | `8.00s` | 11345 | 0 |
| Root vitest (mid-flight) | `npm run test` @14:50:03 | 82 | 1221 | 1216 | 5 | 0 | `8.25s` | 9488 | 1 |
| Root vitest (mid-flight) | `npm run test` @14:54:07 | 84 | 1258 | 1257 | 1 | 0 | `8.86s` | 9988 | 1 |
| **Root vitest (state B)** | `npm run test` @14:56:43 | **85** | **1273** | **1273** | **0** | **0** | `10.53s` | — | **0** |
| Desktop vitest | `npm run test:desktop` @14:48:40 | 44 | 589 | 589 | 0 | 0 | `18.83s` | 23144 | 0 |
| Desktop vitest | via `test:vantrilex` @14:56:55 | 44 | 589 | 589 | 0 | 0 | `11.76s` | — | 0 |
| Rust | `cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml` | 1 (`main.rs`) | 52 | 52 | 0 | **0 ignored** | `2.37s` | 64866 (58490 of it compile) | 0 |
| Playwright E2E | `npm run test:e2e` | 18 specs | 33 | 33 | 0 | 0 | `52.7s` | 61477 | 0 |
| Playwright E2E | via `test:vantrilex` @14:56 | 18 specs | 33 | 33 | 0 | 0 | `59.8s` | — | 0 |

**Totals for the green composite run (#20), which is the only internally
consistent full-gate measurement I took:**
- Root vitest: **85 files / 1273 tests / 0 failed**
- Desktop vitest: **44 files / 589 tests / 0 failed**
- Rust: **52 tests / 0 failed / 0 ignored**
- E2E: **33 tests across 18 spec files / 0 failed**
- **JavaScript + Rust total: 1273 + 589 + 52 = 1914 tests, plus 33 Playwright specs = 1947 executed test cases, 0 failed.**

**State A vs state B, stated as the two measured things they are:**

| Metric | State A (committed, 14:48) | State B (working tree, 14:56) | Delta |
|---|---|---|---|
| Root test files | 81 | 85 | +4 |
| Root tests | 1197 | 1273 | +76 |
| Production modules | 74 | 82 | +8 |
| Test-reachable modules | 72 | 79 | +7 |
| Shipping modules with no test | 10 | 3 | −7 |
| Module reachability | `87.8%` | `96.3%` | +8.5 pts |

The deltas are fully explained by the in-flight code, and the arithmetic
reconciles exactly. The 8 untracked production modules in `src/cli/` are
`bridge.ts`, `commands.ts`, `headless.ts`, `intents.ts`, `reason.ts`,
`report.ts`, `serve.ts`, `turn.ts`. Documented live modules 66 + 8 = **74**,
which is exactly what `docs:verify` derived. Documented total test modules
74 + 8 = **82**, exactly what `docs:verify` derived. Documented reachable
71 + 7 = **78** against a derived 79 — off by one, and the missing one is
`turn.ts`, which is the only `src/cli/` module that *does* have a test
(`src/cli/turn.test.ts`); the other 7 are still blind. **So the state-A
documented figures are correct for the committed tree, and my state-B figures
are correct for the working tree. Neither is wrong; reporting only one would
have been.**

### 11.2.1 The non-determinism timeline — the single most important result

This deserves its own section because it is the finding that invalidates any
naive "the suite is green" statement made about this repository today.

The root suite was run three times and the other process kept editing
`src/cli/` between runs. Every number below is from `npm run test`:

```
14:48:19   Test Files  81 passed (81)        Tests  1197 passed (1197)     exit 0
14:50:03   Test Files  1 failed | 81 passed (82)  Tests  5 failed | 1216 passed (1221)  exit 1
14:54:07   Test Files  1 failed | 83 passed (84)  Tests  1 failed | 1257 passed (1258)  exit 1
14:56:43   Test Files  85 passed (85)          Tests  1273 passed (1273)   exit 0
```

`src/cli` file mtimes, captured at 14:50:02 and again at 14:53:32, show the
edits landing:
```
14:49:48  turn.test.ts    19467 bytes
14:50:37  turn.ts         18468 bytes
14:51:42  turn.test.ts    21984 bytes
14:52:08  headless.ts     13837 bytes
14:53:16  serve.test.ts   13495 bytes
```

**`turn.test.ts` was created at 14:49:48 — 89 seconds after my first run
reported a clean 81/1197.** That single file added 24 tests. The suite went from
green to 5-red to 1-red to green again in 8 minutes, with no change to any
committed file.

**Consequence, stated plainly: any test count, pass rate, or duration reported
for this repository without a `git rev-parse HEAD` *and* a
`git status --porcelain` is meaningless.** My first green root run (81/1197) was
green only because a file did not exist yet. If I had stopped at 14:48 and
reported "root vitest: 1197 passed, exit 0", I would have published a number
that was already false 89 seconds later, and I would have had no way to know.

---

## 11.3 `skip` / `todo` / `only` — exhaustive enumeration

Scan command (applied to all 147 active `*.test.ts` / `*.test.tsx` /
`*.bench.ts` / `*.spec.ts` files, excluding `node_modules`, `.venv`, `target`,
`dist`, `.git`, `.hf_cache`, `.opencode\_archive`):
```powershell
$tf = Get-ChildItem -Recurse -File -Include *.test.ts,*.test.tsx,*.bench.ts,*.spec.ts |
      Where-Object { $_.FullName -notmatch '\\(node_modules|\.venv|target|dist|\.git|\.hf_cache|\.opencode\\_archive)\\' }
Select-String -Path ($tf.FullName) -Pattern '\b(describe|it|test)\s*\.\s*only\s*\(|\b(fdescribe|fit|xdescribe|xit)\s*\('
Select-String -Path ($tf.FullName) -Pattern '\b(describe|it|test)\s*\.\s*(skip|todo|skipIf)\s*\('
```

### `.only` — reported loudly as required

```
ACTIVE TEST+SPEC FILES SCANNED: 147
=== .only (any form) ===
NONE FOUND — zero .only in any active test or spec file
```

**No `.only` exists in any active test or spec file.** I checked the modern
form (`describe.only` / `it.only` / `test.only`) and the Jasmine-era forms
(`fdescribe` / `fit`), and I checked the archive separately:
```
=== .only in ARCHIVE (not collected) ===
NONE in archive
```
I also verified this behaviourally, not just textually: the composite run
#20 executed **1273** root tests and **33** Playwright specs, and a single
`.only` would have collapsed both to a handful. The counts themselves refute
the presence of a `.only`. **This suite is not silently disabled.**

### `.skip` / `.todo` / `.skipIf` — complete list

Exactly one, in the whole active tree:
```
src\cli\serve.test.ts:67: describe.skipIf(livePassword.length === 0)('live serve (needs a serve on 4096 and a credential)', () => {
```

**Zero `.todo` anywhere. Zero `.skip()` (unconditional) anywhere.** The single
`skipIf` is conditional on a real machine secret, and I verified what it
actually did. Reading `src/cli/serve.test.ts:63-75`:
```ts
const livePassword = resolveServePassword().password;
describe.skipIf(livePassword.length === 0)('live serve (needs a serve on 4096 and a credential)', () => {
  test('the SPA fallback is byte-identical for two different unknown paths', async () => {
    const client = new ServeClient('http://127.0.0.1:4096', livePassword);
    const a = await probeRoute(client, '/api/definitely-not-a-route-a');
    const b = await probeRoute(client, '/api/definitely-not-a-route-b');
```
**It ran on this machine** — it is the 961 ms entry "live serve (needs a serve
on 4096 and a credential) the SPA fallback is byte-identical for two di..." in
my slowest-test harvest. A credential exists in the local vault, and port 4096
is served by PID 35484, so both `skipIf` conditions were satisfied.

This is a finding, not a footnote. See §12.3.4: **a test inside the hermetic
root vitest suite performs a real HTTP request to `127.0.0.1:4096` using a
real credential, and its participation is environment-dependent.**

### Tests in the archive that no gate runs

14 test files sit in `.opencode/_archive/dead-code-phase1/` and are outside
`vitest.config.ts`'s `include` (`['src/**/*.test.ts', 'test/**/*.test.ts',
'bench/**/*.bench.ts']`), so no gate executes them:
```
.opencode\_archive\dead-code-phase1\src\guidance\rag\normalize.test.ts
.opencode\_archive\dead-code-phase1\src\guidance\rag\personas.test.ts
.opencode\_archive\dead-code-phase1\src\guidance\rag\retriever.test.ts
.opencode\_archive\dead-code-phase1\src\guidance\guidance.test.ts
.opencode\_archive\dead-code-phase1\src\ipc\attach.test.ts
.opencode\_archive\dead-code-phase1\src\orchestrator\dispatch.test.ts
.opencode\_archive\dead-code-phase1\src\orchestrator\failclosed.test.ts
.opencode\_archive\dead-code-phase1\src\orchestrator\fr12.test.ts
.opencode\_archive\dead-code-phase1\src\orchestrator\laya-advisor.test.ts
.opencode\_archive\dead-code-phase1\src\orchestrator\orchestrator.test.ts
.opencode\_archive\dead-code-phase1\src\runtime\laya\laya.integration.test.ts
.opencode\_archive\dead-code-phase1\src\runtime\laya\laya.test.ts
.opencode\_archive\dead-code-phase1\src\ui\ui.test.ts
.opencode\_archive\dead-code-phase1\src\voice\voice.test.ts
```
The archive contains exactly one `skip`: `laya.integration.test.ts:31:
describe.skipIf(!live)('Laya live model', ...)`. Because the file is never
collected, that `skipIf` is unreachable — it is neither run nor reported as
skipped. **A `skip` inside an uncollected file is invisible to every summary
line in this section.** That is the shape of the hazard a quarantine directory
creates, and it is why I counted on-disk files and did not trust the runner's
file count alone.

**Collection cross-check.** On-disk root-scoped `*.test.ts` (excluding
`apps/desktop` and the archive) = 82 at 14:50. `npx vitest list --filesOnly`
= 82. `Compare-Object` between the two sets returned empty in both directions:
```
ON-DISK root-scoped .test.ts (src/, excl desktop+archive): 82
VITEST LIST: 82
=== ON DISK BUT NOT IN VITEST LIST ===
=== IN VITEST LIST BUT NOT ON DISK ===
```
So at 14:50 vitest collected exactly the files on disk. The 81-vs-82 and
84-vs-85 discrepancies against the *runner summary* are explained by files being
created between the run and the listing — not by a filter mismatch. This is
corroborated independently by `test:blindspots`, which reported `82 test files`
at 14:50 and `85 test files` at 14:58.

---

## 11.4 Coverage verdict — reported as an absence, never as a percentage

**No coverage provider is installed. No gate passes `--coverage`. Therefore this
repository has no line-coverage number, and I am not going to invent one.**

Evidence, from `package.json` and `vitest.config.ts`:
```
--- coverage provider installed? ---
absent: @vitest/coverage-v8
absent: @vitest/coverage-istanbul
absent: @vitest/coverage-c8
```
`test:vantrilex` expands to exactly seven stages:
```
> npm run typecheck && npm run typecheck:tests && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e
```
No `--coverage` flag appears in that line, in any root script, in
`apps/desktop/package.json`, or in either `vitest.config.ts`.

`vitest.config.ts` in its entirety contributes only:
```ts
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts'],
  },
});
```
There is no `coverage` key. **The `bench/**/*.bench.ts` glob in that `include`
is dead: I measured 0 files matching `*.bench.ts` anywhere outside
`node_modules` and the archive.** The glob costs nothing and tests nothing.

**I am deliberately not reporting a coverage percentage.** No such measurement
exists, `@vitest/coverage-v8` would have to be installed to produce one, and
installing it changes the dependency set of a release-critical payload — the
same class of change the repo's own sidecar-manifest discipline warns about.
A coverage figure nobody has measured is worse than no figure, because it
reads as a floor and guarantees nothing.

---

## 11.5 Reachability blind spots — what the method can and cannot see

`npm run test:blindspots` exits 0. Verbatim, state B:
```
test-blindspots — 85 test files, 82 production modules

  production modules tested         : 79 of 82
  SHIPS but NO test reaches it    : 3
  module-level reachability       : 96.3%
  (not line coverage. It cannot be: no coverage provider is installed.)
  neither shipped nor tested       : 1

  SHIPPING MODULES NO TEST REACHES:
    /src/cli.ts                                      327 lines
    /src/common/index.ts                               8 lines
    /src/knowledge/index.ts                           37 lines

  DEAD (ships to nothing, tested by nothing) — the known Laya set:
    /src/runtime/laya/index.ts

  ENTRY POINTS WITH NO TEST (dispatch logic unverified):
    /src/cli.ts                                      327 lines
    ^ these ship, are executed as processes, and decide what runs.
```

State A, 3 minutes earlier, for contrast:
```
production modules tested         : 72 of 82
  SHIPS but NO test reaches it    : 10
  module-level reachability       : 87.8%
```
with the 7 extra blind modules being `bridge.ts`, `commands.ts`, `headless.ts`,
`intents.ts`, `reason.ts`, `report.ts`, `serve.ts`.

### What this method can see
It resolves static **and dynamic** `import` specifiers transitively from each
test file and reports which production modules are reachable. It found
`/src/runtime/laya/index.ts` as dead — shipping to nothing, tested by nothing —
and it is correct about that: nothing in the daemon or CLI graph imports it.

### What this method cannot see — stated as part of the result
1. **It cannot see a process entrypoint.** `src/cli.ts` is the program's
   argv dispatcher. Nothing imports it, because it *is* the program. The
   method reports it in a dedicated section precisely because no import-walk can
   classify it. It is 327 lines and decides what the binary does, and **zero of
   the 1273 root tests execute it.**
2. **It cannot see a line.** "79 of 82 modules" is not "96.3% of lines". A
   327-line module with one import counted as fully tested. The three blind
   modules total 327 + 8 + 37 = **372 lines of shipping code with no test
   reaching it.**
3. **It cannot see a branch.** A module reached by a test may be 5% executed.
4. **It cannot see the Rust side at all.** It reported 82 TypeScript production
   modules. `apps/desktop/src-tauri/src/main.rs` is not in that universe, and
   its 52 tests are invisible to this metric.
5. **It cannot see the Electron/Tauri runtime or the built artifact.** No gate
   boots the installer.

**The instrument itself is a measurement, not a gate — it exits 0 whether the
blind spot is 3 modules or 300.** Anyone reading `96.3%` as a quality score is
misreading a reachability count as coverage.

---

## 11.6 Observed bottlenecks

### Slowest gates, by measured process wall-clock
| Rank | Gate | ms | Note |
|---|---|---|---|
| 1 | `npm run test:vantrilex` (composite) | **118073** | all 7 stages green |
| 2 | `cargo test` | **64866** | **58490 ms is compilation**; tests themselves 2.37 s |
| 3 | `npm run test:e2e` | **61477** | includes root `tsc -p` build + Vite + 33 specs |
| 4 | `npm run docs:verify` | 29777 | |
| 5 | `npm run lint` | 24860 | |
| 6 | `npm run test:desktop` | 23144 | |
| 7 | `npm run typecheck:tests` | 8693 | |
| 8 | `npm run lint:ox` | 969 | |
| 9 | `npm run test:blindspots` | 861 | |
| 10 | `npm run typecheck` | 5772 | |

**The composite gate is dominated by three stages, and one of them is not a
test.** Of the 118 s composite: `test:e2e` is roughly half, `cargo` is over
half again if counted separately, and inside `test:e2e` the Playwright specs
alone are 52.7–59.8 s of pure browser work. **Cargo's 64.9 s is 90% compile and
2.37 s of actual test execution** — a cold `cargo test` is a build, not a test
run, and anyone timing the gate without separating those two is measuring the
wrong thing.

Within E2E, three specs dominate by an order of magnitude:
```
ok  1 abort.spec.ts:4:1 ... (10.5s)
ok  8 calibration.spec.ts:38:1 ... (11.3s)
ok 11 capture.spec.ts:10:1 ... (2.9s)
```
against a typical sub-second spec (`ux.spec.ts:28:1 ... (368ms)`). The two
~11 s specs are 21% of E2E wall-clock between them.

### Slowest root test files (from `npx vitest run --reporter=json`, state A)
```
File                                                        Ms Tests
src/daemon.test.ts                                       5834    19
src/diag/bundle.test.ts                                  2273    72
src/daemon-integration.test.ts                           2251    30
src/ipc/ui-server.test.ts                                2241    29
src/ipc/ui-server-output.test.ts                         2045     9
src/voice/key-store.test.ts                              1446     5
src/cli/serve.test.ts                                    1150    24
src/ipc/protocol.test.ts                                  937    41
src/knowledge/normalize.test.ts                           911    15
src/runtime/client-shell.test.ts                          881    13
```
`src/daemon.test.ts` alone is 5.83 s, roughly 20% of the 29 s of total
per-file time across the 84 files, for 19 tests. `src/ipc/ui-server-output.test.ts`
is the inverse pathology: **2045 ms for 9 tests**, and
`src/voice/key-store.test.ts` is **1446 ms for 5 tests**. These are the files
where a slow test is hiding, and neither is visible in the suite's aggregate
8–10 s duration.

### Slowest individual root tests
```
Ms     Test
1705   UiServer.output — retention is bounded, and the newest result always survives pushing many max-size outputs
1060   A.6: key material is zeroed when the ring that holds it goes away ...
 961   live serve (needs a serve on 4096 and a credential) the SPA fallback is byte-identical ...
 899   Arabic-Indic digits survive normalization (regression) ...
 817   docsVerify runs live, or is labelled skipped ...
 813   M2-6c: the Fish response is drained, not awaited whole ...
 766   A5: the TTS credit clock belongs to the daemon, not to the pipeline ...
 654   FrameReassembler (cross-chunk fragments) M3 B.1 pre-header cap ...
 628   daemon composition (production wiring) saveApiKeys persists encrypted pools ...
 601   A.6: key material is zeroed when the ring that holds it goes away ...
```

### Slowest desktop test files (from the desktop JSON report)
```
File                                                              Ms Tests
apps/desktop/src/settings/services.test.ts                       1654     7
apps/desktop/src/audio/playback.test.ts                          1092    38
apps/desktop/src/App.bento.test.tsx                               870    28
apps/desktop/src/audio/capture-energy.test.ts                     817     6
apps/desktop/src/App.task-cards.test.tsx                          674    13
apps/desktop/src/App.test.tsx                                    629    13
apps/desktop/src/components/terminal/TerminalDrawer.test.tsx     521    58
apps/desktop/src/components/bento/BentoGrid.test.tsx              513    17
```
Desktop's 44 files report `environment 137.33s` cumulative in the first run —
`happy-dom` environment construction is the dominant desktop cost, and it is
paid 44 times. The desktop suite has a higher per-file overhead than the root
suite for the same test count.

---

## 11.7 Boundary and flake evidence — candidates enumerated, hunt NOT run

**I did not perform a flake hunt.** No test was run in a loop, no
`--repeat`/`--retry` sweep was executed, and I make no claim that this suite is
or is not flaky. Below are the *candidates*, with the evidence that makes each
one a candidate. A candidate is a test whose correctness depends on wall-clock
scheduling.

### 11.7.1 Real wall-clock sleeps in active tests — 32 occurrences across 15 files
Scan pattern: `setTimeout\s*\(\s*(?:resolve|r|res|done|)\s*,\s*(\d{1,6})\s*\)`.
```
src/daemon.test.ts:858                             300 ms
src/ipc/ui-server.test.ts:779                      200 ms
src/ipc/ui-server.test.ts:799                      200 ms
src/ipc/persona-propagation.test.ts:207            200 ms
src/ipc/persona-propagation.test.ts:219            200 ms
src/ipc/persona-propagation.test.ts:228            200 ms
src/daemon-integration.test.ts:615                 200 ms
src/daemon-integration.test.ts:632                 200 ms
src/daemon-integration.test.ts:669                 200 ms
src/ipc/ui-server.test.ts:114                      150 ms
src/ipc/ui-server-output.test.ts:229               100 ms
src/ipc/ui-server-output.test.ts:259               100 ms
src/runtime/laya/laya.test.ts:135                  100 ms
src/voice/stt.test.ts:100                           40 ms
apps/desktop/src/audio/playback-f01.test.ts:25      20 ms
apps/desktop/src/audio/playback-f01.test.ts:50      30 ms
apps/desktop/src/audio/playback-f01.test.ts:66      30 ms
apps/desktop/src/audio/playback-f01.test.ts:68      30 ms
apps/desktop/src/audio/playback-f01.test.ts:82      30 ms
apps/desktop/src/audio/playback-f01.test.ts:91      30 ms
src/runtime/vad-gate.test.ts:114                    20 ms
src/runtime/vad-gate.test.ts:203                    20 ms
src/daemon/shell-task-stop-reason.test.ts:339       20 ms
src/daemon.test.ts:191                              10 ms
src/voice/tts.test.ts:348                           10 ms
```
The five 200 ms waits in `src/ipc/persona-propagation.test.ts` and the three in
`src/daemon-integration.test.ts` are **sleep-then-assert** patterns around real
sockets and real timers. A loaded CI runner that deschedules a process for
>200 ms flips these. `src/daemon.test.ts:858` at 300 ms is the longest single
sleep in the repository, in the file that is also the slowest.

### 11.7.2 Tests that assert on elapsed time — 45 occurrences across 25 files
The load-bearing ones (the rest are literal `durationMs: N` *fixture values*,
which are deterministic and are not candidates):
```
src/ipc/ui-server.test.ts:631                      if (Date.now() - start > ms) {     <- real poll timeout
apps/desktop/src/audio/uplink-gate.test.ts:165     expect(sent).toBeLessThan(120);     <- real timing assertion
apps/desktop/src/bridge/ws.test.ts:78              expect(computeBackoff(0, 50, 30, 2500, () => 0.999)).toBeLessThan(80);
src/runtime/laya/laya.integration.test.ts:64-85    p50 latency measurement over a live model
src/diag/bundle.integration.test.ts:108            timestamp: new Date(Date.now() - 3 * 86_400_000)
```
`src/ipc/ui-server.test.ts:631` is a real `Date.now()`-bounded spin loop. It is
a *tolerance*, so it is more robust than a fixed sleep, but it converts a hang
into a failure whose cause is a slow machine.

`apps/desktop/src/audio/uplink-gate.test.ts:165`'s `toBeLessThan(120)` is an
unconditional wall-clock assertion in the desktop suite and is the single most
brittle line I found. Note the deliberate counter-comment one file over, at
`apps/desktop/src/audio/playback.test.ts:13`: *"None of them waits on elapsed
wall-clock time."* — that comment is accurate for `playback.test.ts` and
`playback-f01.test.ts` uses 30 ms sleeps, so the reassurance does not extend to
the directory as a whole. I flag the comment-vs-neighbour mismatch as a
reviewer trap.

`src/runtime/laya/laya.integration.test.ts` computes a real p50 over a live
ONNX model. It is the one file that would genuinely need a flake budget, and it
is currently collected (I measured it in the root collection list) but its
`describe.skipIf(!live)` keeps it inert without the model.

### 11.7.3 Fake timers — the deterministic majority
```
=== FILES USING fake timers (deterministic, NOT flake candidates) ===
occurrences: 46 in 6 files
```
`vi.useFakeTimers` / `vi.setSystemTime` / `vi.advanceTimersByTime` appear 46
times in 6 files. The 32 real sleeps and 46 fake-timer calls in a 147-file
suite is a reasonable ratio, and it is the reason I expect this suite to be
mostly stable — **but that is an expectation, not a measurement, and I did not
test it.**

### 11.7.4 The highest-risk candidate: a live-network test in a hermetic suite
`src/cli/serve.test.ts:67-74` (detailed in §11.3) issues a real HTTP GET to
`http://127.0.0.1:4096` with a real credential resolved from the vault, from
inside the root vitest suite. Three distinct failure modes, all environmental:
1. No credential → the test silently **disappears** from the count rather than
   reporting a skip (`skipIf` removes it from the summary entirely in vitest 4).
2. Credential present, nothing on 4096 → the request **fails** and the suite
   goes red for a reason that has nothing to do with the code under test.
3. Something unrelated on 4096 → the test asserts against a stranger's server.
This is a single line of test code that makes the root suite's result a
function of machine state. It is also why port 4096 being occupied mattered to
me even though Playwright did not need it.

---

# Section 12 — RUNBOOK, BUILD PIPELINE & FORENSIC VERDICT

## 12.1 The build pipeline, derived from the scripts I read

### 12.1.1 Root `package.json` scripts, in full
Read with `node -e "console.log(require('./package.json').scripts)"`:
```
build                :: tsc -p tsconfig.json
typecheck            :: tsc --noEmit
typecheck:tests      :: tsc -p tsconfig.tests.json
docs:verify          :: node scripts/docs-verify.mjs
test:blindspots      :: node scripts/test-blindspots.mjs
release:verify       :: node scripts/release-verify.mjs
lint                 :: eslint . --max-warnings 0
lint:ox              :: node scripts/lint-baseline.mjs
test                 :: vitest run
test:desktop         :: npm --prefix apps/desktop run test
test:vantrilex       :: npm run typecheck && npm run typecheck:tests && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e
dev                  :: npm --prefix apps/desktop run dev
dev:web              :: npm --prefix apps/desktop run dev:web
doctor               :: node dist/cli.js doctor
test:e2e             :: npm --prefix apps/desktop run test:e2e
docs:verify:self-test:: node scripts/docs-verify.mjs --self-test
```

### 12.1.2 `apps/desktop/package.json` scripts, in full
```
dev       :: tauri dev
dev:web   :: vite
build     :: tsc --noEmit && vite build
build:tauri:: tauri build
typecheck :: tsc --noEmit
lint:ox   :: oxlint
test      :: vitest run
test:e2e  :: npm run build --prefix ../.. && playwright test
```

### 12.1.3 Stage-by-stage, with outputs and paths

| # | Stage | Command | Produces | Output path |
|---|---|---|---|---|
| 1 | Root typecheck | `npm run typecheck` | nothing (`--noEmit`) | — |
| 2 | Test typecheck | `npm run typecheck:tests` | nothing (`noEmit` in `tsconfig.tests.json`) | — |
| 3 | ESLint | `npm run lint` | nothing; fails on any warning (`--max-warnings 0`) | — |
| 4 | oxlint baseline | `npm run lint:ox` | nothing; compares against `scripts/lint-baseline.json` | — |
| 5 | Root tests | `npm run test` | nothing | — |
| 6 | Desktop tests | `npm run test:desktop` | nothing | — |
| 7 | E2E | `npm run test:e2e` | root `dist/` + Playwright traces on failure | `dist/`, `apps/desktop/test-results/` |
| 8 | Daemon build | `npm run build` | compiled JS + `.d.ts` + `.map` | `dist/` (`outDir`, `rootDir: src`) |
| 9 | Renderer typecheck + bundle | `cd apps/desktop && npm run build` | Vite production bundle | `apps/desktop/dist` (`frontendDist: "../dist"`) |
| 10 | Sidecar payload | `node scripts/provision-sidecar.mjs` | bundled `node.exe` + `dist/` + pruned deps | `apps/desktop/src-tauri/sidecar/` |
| 11 | Tauri build | `cd apps/desktop && npm run build:tauri` | NSIS installer + AppImage | `apps/desktop/src-tauri/target/release/bundle/` |

**Stage 10's output already exists on this machine:**
```
sidecar files: 1852
sidecar bytes: 100.07 MB
```
`scripts/provision-sidecar.mjs` exists (3350 bytes) and is one of 11 files in
`scripts/`. The full script inventory:
```
docs-verify-self-test.mjs   3321      live_console_test.ts          16589
docs-verify.mjs            35146      packaging-preflight.mjs       3106
generate-whiteboard-assets.mjs 25882  provision-sidecar.mjs         3350
key-report.mjs              3232      release-verify.mjs           12838
lint-baseline.json             1      test-blindspots.mjs           5947
lint-baseline.mjs            6573
```

**Tauri configuration, read from `apps/desktop/src-tauri/tauri.conf.json`:**
```json
"productName": "Voxaura",  "version": "0.8.2",  "identifier": "com.voxaura.app",
"build": { "frontendDist": "../dist", "devUrl": "http://localhost:1420",
           "beforeDevCommand": "npm run dev:web", "beforeBuildCommand": "npm run build" },
"bundle": { "active": true, "targets": ["nsis", "appimage"],
            "resources": ["sidecar/**/*"], "icon": [5 paths] }
```
Note `bundle` is a **top-level** key, not nested under `build`. There is no
`externalBin` key. `beforeBuildCommand: "npm run build"` resolves inside
`apps/desktop`, so stage 9 runs automatically during stage 11 — **you do not
run stage 9 by hand before `build:tauri`; Tauri runs it.** The CSP is pinned
to `connect-src 'self' ws://127.0.0.1:4097`.

Version `0.8.2` is consistent across every location I checked:
```
package.json                    -> "version": "0.8.2",
apps/desktop/package.json       -> "version": "0.8.2",
apps/desktop/src-tauri/Cargo.toml -> version = "0.8.2",
scripts/provision-sidecar.mjs   -> version: '0.8.2',
apps/desktop/src-tauri/tauri.conf.json -> "version": "0.8.2",
```

### 12.1.4 The production build command sequence, runnable as written

```powershell
# 0. PREREQUISITES — verify each, do not skip
#    (a) MSVC toolchain on PATH:
cmd /c '"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -no_logo && where cl'
#    (b) NSIS:
makensis /VERSION          # NOT SATISFIED ON THIS MACHINE — see 12.1.5
#    (c) ports 4097 and 4197 free (1420 free only for dev/E2E):
Get-NetTCPConnection -LocalPort 4097,4197
#    (d) no running app holding the ports:
Get-Process | Where-Object { $_.ProcessName -match 'voxaura' }

# 1. dependencies
cd O:\opencode-Vantrilex
npm install
npm --prefix apps/desktop install

# 2. the full gate (7 stages) — MUST be green before shipping
npm run test:vantrilex

# 3. the audit scripts, not part of test:vantrilex
npm run test:blindspots
npm run docs:verify
npm run docs:verify:self-test

# 4. the daemon payload
npm run build                      # -> dist/

# 5. the sidecar payload
node scripts/provision-sidecar.mjs # -> apps/desktop/src-tauri/sidecar/

# 6. the installer
cmd /c '"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -no_logo && npm --prefix apps/desktop run build:tauri'
#   stage 9 (renderer) runs automatically via beforeBuildCommand
#   -> apps/desktop/src-tauri/target/release/bundle/nsis/Voxaura_0.8.2_x64-setup.exe
#   -> apps/desktop/src-tauri/target/release/bundle/appimage/  (Linux target — see 12.1.5)

# 7. hash and record
Get-FileHash apps\desktop\src-tauri\target\release\bundle\nsis\Voxaura_0.8.2_x64-setup.exe -Algorithm SHA256
```

**One command automates steps 2–7:** `npm run release:verify`
(`scripts/release-verify.mjs`, 12838 bytes), which exposes `--stage=X` to
bisect and `--skip-gate` to skip stage 2.

### 12.1.5 Two blockers in the pipeline as configured — both measured

**Blocker 1 — NSIS is not installed on this machine.**
```
--- NSIS / makensis present? ---
makensis NOT on PATH
```
`tauri.conf.json` lists `"targets": ["nsis", "appimage"]`. **The NSIS installer
cannot be produced here.** `apps/desktop` has no `tauri` dev dependency listed in
the scripts I read, and `makensis` being absent means stage 11 would fail at the
bundling step even with a perfect green gate. **I did not run `build:tauri` and
am not reporting a result for it — NOT RUN — `makensis` is not on PATH, so the
NSIS target cannot be produced on this host.**

**Blocker 2 — `appimage` is a Linux target configured on a Windows host.**
`"targets": ["nsis", "appimage"]` is unconditional. Tauri normally filters
platform-inapplicable targets, but the configuration asks for both on a
`win32` host (`Platform: win32` per the environment). I did not execute stage 11
and therefore **cannot report** whether it filters or errors. Flagged as
unverified, not as a defect.

---

## 12.2 Latent bugs and dead code found while executing

### 12.2.1 A cap comment that contradicts the code it sits above — `src/ipc/protocol.ts:21`
**Severity: low (documentation drift with security-adjacent wording). No
behavioural defect.**

`protocol.ts:21-22`:
```ts
/** Hard inbound message cap — a single frame may never exceed this. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
```
**The code enforces a per-MESSAGE cumulative cap, not a per-frame cap.** I
verified this by reading the enforcement sites, not the comment:
- `protocol.ts:157` — `decodeFrames`, per-frame: `if (length > MAX_MESSAGE_BYTES) throw`
- `protocol.ts:180-186` — `decodeFrames`, cumulative, checked **before** the
  part is stored: `pendingBytes += payload.byteLength; if (pendingBytes > MAX_MESSAGE_BYTES) { ... throw }`
- `protocol.ts:252-254` — `parseHeader`, per-frame.
- `protocol.ts:297-307` — `FrameReassembler.accountFor`, cumulative, pre-store:
```ts
private accountFor(bytes: number): void {
  this.pendingBytes += bytes;
  if (pendingBytes > MAX_MESSAGE_BYTES) { ... throw new WsProtocolError('assembled message exceeds message cap — refusing allocation'); }
}
```
**The implementation is correct and the ordering is right** (cap before store,
because capping at concat time would still allocate). **The comment at line 21
describes the older, weaker, per-frame semantics and is the sentence a reviewer
would trust.** It is the exact wording that makes a fragmented-message attack
look already-mitigated. Fix the comment, not the code.

### 12.2.2 `MAX_AUDIO_BYTES` is enforced 16× above its own limit — `src/ipc/ui-server.ts:688`
**Severity: low. Bounded, but the bound is not the documented one.**

```ts
if (frame.opcode === Opcode.Binary) {
  if (frame.payload.byteLength > MAX_AUDIO_BYTES) {
```
`MAX_AUDIO_BYTES = 64 * 1024` (`protocol.ts:30`). **The check runs on the
reassembled payload**, and `FrameReassembler` permits a message to grow to
`MAX_MESSAGE_BYTES` = **1 MiB** before it throws. So a single oversized binary
message causes the server to allocate up to **1 MiB** and only then reject it as
over the 64 KiB audio cap — a **16× amplification** over the intended audio
limit. With `MAX_CONNECTIONS = 8` (`protocol.ts:19`) the worst case is ~8 MiB
resident. This is a real, bounded, loopback-only exposure and **not a
vulnerability**, but "audio frames are capped at 64 KiB" is only true of what
reaches the pipeline, not of what was allocated to reject it.

### 12.2.3 `decodeFrames` asymmetry is FIXED — recorded because a defect list would claim otherwise
**Severity: none. I am reporting this as a correction.**

`decodeFrames` (`protocol.ts:124-216`) is a second, exported reassembler. I read
it line by line and it now carries **both** caps, symmetric with
`FrameReassembler`, checked pre-store: the per-frame cap at `protocol.ts:157`,
the cumulative cap at `protocol.ts:180-186`, and the orphan-fragment discard at
`protocol.ts:196-211` (which resets `pendingOpcode`, `pendingParts` **and**
`pendingBytes` before charging the new frame, so an orphan cannot make a later
legal message fail). **Any audit text asserting this helper is weaker than the
production one is stale.** I state this because the brief asked for dead
branches and asymmetry findings, and reporting a defect here would have been the
easy and wrong answer.

### 12.2.4 The one real defect I found: a `skipIf` that hides a test from the count
**Severity: medium — it makes the headline number environment-dependent.**

`src/cli/serve.test.ts:67`. Full analysis in §11.7.4. The mechanism: a
`describe.skipIf(condition)` in vitest 4 does not render a skipped-test line in
the default reporter's summary. The suite at 14:48 reported `1197 passed`, and
the same suite minutes later reported `1273 passed` partly because this
conditional suite was present. **On a machine with no vault credential the root
suite reports a smaller number than on a machine with one, with no skip line to
explain the difference.** A reader diffing two green runs has no way to tell
whether a test was removed, disabled, or never collected.

### 12.2.5 A break-the-guard test that was itself broken — `src/cli/turn.test.ts:105`
**Severity: informational, and it is evidence about test quality.**

During the 14:50:03 run, one of the 5 failures was a guard test correctly
refusing to pass:
```
FAIL  src/cli/turn.test.ts > the structural invariant, counted from coordinator.ts source > BREAK: a second consume() read is detected
AssertionError: injection must actually modify the source: expected '...' not to be '...'
 ❯ src/cli/turn.test.ts:105:69
    103|       '  private peek(): PendingPermission | null { return this.permis…
    104|     );
    105|     expect(broken, 'injection must actually modify the source').not.to…
```
This is the *good* failure mode: a test that mutates a source string and then
asserts the mutation actually landed, so a silently no-op injection cannot
produce a green break-the-guard. I flag it because this exact class of assertion
is what caught the earlier `turn.test.ts` break-guard at 14:48 — and because at
14:50 it was itself failing, which means the file was mid-edit, not that the
guard was wrong. **The assertion is well-constructed; the file was in flight.**

### 12.2.6 A genuine unhandled-error-path bug in the in-flight code
**Severity: low, in uncommitted code. Reported because it is a real mechanism.**

`src/cli/turn.test.ts:129`, failure at 14:50:03:
```
FAIL  ... BREAK: an unresolvable start path THROWS instead of defaulting to 1
AssertionError: expected [Function] to throw error matching /coordinator\.ts not found/
  but got 'File URL path must be absolute'
 ❯ src/cli/turn.test.ts:129:88
```
The test expects a domain error naming the missing file. The code instead throws
Node's generic `File URL path must be absolute` from a nested `fileURLToPath`.
The **test's intent is correct** — "a hard-coded count when the file cannot be
read" is a defect class worth pinning — and the **implementation loses the
error's identity on the way out**. Low severity because it is uncommitted
in-flight code, but it is a real mechanism, not a style opinion.

### 12.2.7 Dead branch / dead glob
- **`vitest.config.ts` `include: [... 'bench/**/*.bench.ts']`** — I measured
  **0** `*.bench.ts` files outside `node_modules` and the archive. The glob
  matches nothing and tests nothing.
- **`src/runtime/laya/index.ts`** — reported by `npm run test:blindspots` as
  `DEAD (ships to nothing, tested by nothing)`. Confirmed against the
  production module set: it is in the dead set and nothing in the daemon or CLI
  graph imports it.
- **14 archived test files** in `.opencode/_archive/dead-code-phase1/` are
  outside every runner's `include` and outside `tsc`. They are not dead code in
  the "unreferenced" sense — they are **quarantined and unexecuted**, which is a
  different and more dangerous state, because a `skip` inside one of them
  (`laya.integration.test.ts:31`) can never be reported by any summary.

---

## 12.3 The forensic verdict

### 12.3.1 What the green gate does prove
At 14:56:43, `npm run test:vantrilex` exited **0** in **118073 ms** with all
seven stages green. That is real evidence of the following, and only the
following:
1. `tsc --noEmit` accepts all of `src/**/*.ts` under `strict`,
   `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
   `noFallthroughCasesInSwitch`.
2. `tsc -p tsconfig.tests.json` typechecks **all** root test files — this is a
   separate config whose only material change is dropping `**/*.test.ts` from
   `exclude`, and it is the only thing that can see a test file.
3. ESLint passes with `--max-warnings 0`.
4. oxlint is at exactly its baseline of 8 warnings.
5. 1273 root tests, 589 desktop tests, 52 Rust tests and 33 Playwright specs
   pass at that instant.
6. The 33 E2E specs drive a real Vite dev server and a real browser against a
   real WebSocket server.

### 12.3.2 What it does NOT prove — stated explicitly
**A green suite is not evidence that the built artifact boots.** I did not
verify a boot, and I make no claim that I did.

Specifically, nothing in the seven stages proves any of the following, and each
is a real failure mode for this architecture:
1. **The installer exists or works.** `makensis` is absent (measured), so the
   NSIS bundle cannot be produced on this host. Stage 11 was NOT RUN.
2. **The sidecar payload in the shipped bundle is the one that was tested.** The
   tests import from `src/`. The shipped daemon runs from
   `apps/desktop/src-tauri/sidecar/`, a **100.07 MB, 1852-file generated
   artifact** built by a separate script with its own dependency resolution. A
   test that passes against `src/` says nothing about the pruned dependency set
   in that payload. **This is the single largest untested surface in the
   pipeline** and no stage touches it.
3. **The Rust supervisor starts the daemon.** `cargo test`'s 52 tests exercise
   logic in `main.rs` with injected mocks. No stage launches
   `apps/desktop/src-tauri/target/release/voxaura.exe`.
4. **`src/cli.ts` runs at all.** `test:blindspots` reports it as an
   entrypoint with no test, 327 lines, and the import-walk method is
   structurally incapable of seeing it. **Zero of 1273 root tests execute the
   argv dispatcher** — the code that decides what the program does when invoked.
5. **The real daemon serves a real voice turn.** E2E drives
   `apps/desktop/e2e/stub-daemon.mjs`, which announced itself in the run output
   as `e2e stub daemon: ws=4097 control=4197`. It is a **fake control plane**,
   not `dist/cli.js serve`. No gate performs a provider round-trip; the
   credential-reading path in `src/cli/serve.test.ts:67` is the only test that
   touches a live service, and it is `skipIf`-gated.
6. **Any line of the shipped code executes.** There is no coverage provider
   (§11.4). Module reachability was 96.3%, which is 79 of 82 TypeScript modules
   by import graph, and says nothing about the lines inside them, nothing about
   `main.rs`, and nothing about the bundled artifact.

### 12.3.3 The contradiction that most deserves attention
**The gate is simultaneously green and not measuring the shipped system.** All
1947 test cases pass, and the largest untested surfaces are exactly the
boundary where release failures live: the pruned sidecar payload, the Rust
supervisor's real process spawn, the CLI entrypoint, and the built installer.
A green `test:vantrilex` and a non-booting installer are entirely compatible
with each other, and nothing in the seven stages would detect the difference.

### 12.3.4 What would establish that the artifact boots
Not claiming any of this was done — stating what is missing:
1. Install `makensis`, then run stage 11 and confirm
   `target/release/bundle/nsis/Voxaura_0.8.2_x64-setup.exe` exists.
2. Compute and record its SHA-256.
3. Run the silent install (`Voxaura_0.8.2_x64-setup.exe /S`) on a machine where
   ports 4096, 4097 and 4197 are free and no Voxaura process is running.
4. Launch the installed app and confirm **ports 4096 and 4097 are both bound on
   127.0.0.1** and that the daemon log did not grow with an error.
5. Only then: a single live voice turn against a real provider.
Steps 4 and 5 are what no current gate performs. `npm run release:verify`
(`scripts/release-verify.mjs`) is reported by its existence to automate a chain
of this shape, and it exposes `--stage=X` for bisection — **I did not run it,
and I make no claim about whether it performs step 5.** NOT RUN — outside the
scope I was given, and it performs an install.

### 12.3.5 A closing methodological warning
The single most important thing I learned while executing this audit is
structural, not a bug:

**Between 14:48:19 and 14:56:43, `npm run test` produced four different results
on the same HEAD commit `9f41c96` — 81/1197 green, 82/1221 with 5 failures,
84/1258 with 1 failure, 85/1273 green — because another process was adding
files to an untracked directory.** `npm run typecheck` returned exit 2 and then
exit 0. `npm run lint` returned 6 errors and then 0. `npm run lint:ox` went
from 12 warnings to 8.

Every one of those transitions was a real measurement, and every one of them
would have been a false statement about the repository if reported without a
timestamp. **Any figure in any document about this repository — including the
figures in this section — is valid only for the working tree at the moment it
was taken, and the only way to make it durable is to record it together with
`git rev-parse HEAD` and `git status --porcelain`.** `docs:verify` enforces
this discipline for the numbers it derives and caught 7 of my own measurements
disagreeing with the documented set; it cannot enforce it for a number nobody
asked it to check.

---

## Appendix A — Files I deliberately did not open

`docs/` in its entirety (including `docs/10-CHECKPOINT.md` and
`docs/HEADLESS-BRIDGE-VERIFY.md`, whose existence I observed only through
`git status`), `README.md`, `README.ar.md`, `CHANGELOG.md`, `AGENTS.md`,
`dossier/PROJECT_MASTER_DOSSIER.md`, and the three sibling sections
`dossier/sections/02-toolchain.md`, `04-lifecycle.md`,
`13-appendix-areeb.md`.

**One partial exception, disclosed:** I read `vitest.config.ts` in full because
it is configuration, not documentation, and it contains a 24-line comment
disabling coverage. **I did not take that comment's claims as evidence.** I
verified coverage independently — three provider directories absent from
`node_modules`, no `--coverage` flag in any of the 14 root scripts or either
`vitest.config.ts` — and the same for `playwright.config.ts`'s port
requirements and `tsconfig.json`'s exclusion of `**/*.test.ts`, all of which I
read as configuration and confirmed against compiler and runner behaviour.

## Appendix B — Documented figure vs my measurement

I did not read any document to obtain the "documented" column. Both columns
below are **measurements**; the left one is what `docs:verify` read out of the
repository's prose, which I obtained by running the tool and quoting its table.

| Claim | `docs:verify` "DOCUMENTED" (state A) | My measured (state B) | Reconciliation |
|---|---|---|---|
| root vitest tests | 1197 | **1273** | +76 from 4 new `src/cli/*.test.ts` |
| root vitest files | 81 | **85** | +4 new test files |
| desktop vitest tests | 589 | 589 | agree |
| desktop vitest files | 44 | 44 | agree |
| cargo tests | 52 | 52 | agree |
| e2e tests | 33 | 33 | agree |
| e2e specs | 18 | 18 | agree (I also counted 18 on disk) |
| live modules | 66 | **74** | 66 + exactly 8 untracked `src/cli/*.ts` = 74 |
| dead modules | 7 | 7 | agree |
| test-only scaffolding | 1 | 1 | agree |
| live source lines | 18300 | **20460** | +2160 from `src/cli/` |
| test-reachable modules | 71 | **79** | +8, of which 7 are the new blind modules |
| test total modules | 74 | **82** | 74 + 8 = 82 |
| test-blind modules | 3 | 3 | agree at state B; was **10** at state A |
| persona refs (4 files) | 11 / 0 / 0 / 0 | 11 / 0 / 0 / 0 | agree |
| earcon modules / pitch constants | 0 / 0 | 0 / 0 | agree |
| knowledge importers / barrel | 2 / 1 | 2 / 1 | agree |
| cited line anchors | 166 cited, 0 dangling | 166 cited, **3 dangling** | `cli.ts:270`, `cli.ts:24`, `cli.ts:182` |

**`docs:verify` exit codes: 1 (state A, 6 contradictions), 1 (state B, 7
contradictions). `docs:verify:self-test` exit code: 1, with
`self-test FAILED - 1 of 4.` and the failing case named:**
```
  FAIL  a citation to a real code line passes
  PASS  a citation to a COMMENT line is rejected
  PASS  a citation past the end of the file is rejected
  PASS  an ambiguous basename is rejected, not guessed
```
**The self-test is failing on a case whose name asserts it should pass.** That is
a self-inconsistency in the auditing tool itself, independent of the in-flight
code, and it is the most serious finding in this section: **the script that is
supposed to catch documentation drift is currently failing its own test.**

**The three dangling anchors are all in `src/cli.ts` and all resolve to comment
lines** (`cli.ts:270` a JSDoc continuation, `cli.ts:24` and `cli.ts:182` line
comments) — the uncommitted file the other process is editing. The self-test
proves the tool's own rule works (three of its four cases pass, including "a
citation to a COMMENT line is rejected"), so the detection is correct and the
citations are simply stale against a file still being written.
