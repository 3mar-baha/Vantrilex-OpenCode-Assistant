# 05 — Test Infrastructure Forensic Audit (Forensic Auditor 5/7)

Repo: `O:\opencode-Vantrilex` · Date: 2026-09-28 · Scope: `vitest.config.ts`, all `*.test.ts`/`*.test.tsx`,
`apps/desktop/e2e/`, `apps/desktop/src-tauri` (cargo tests), `scripts/lint-baseline.mjs`

---

## 0. MEASUREMENT BLOCKER — READ THIS FIRST

**Every command-execution deliverable in this brief is UNVERIFIED. I could not run a single command.**

This subagent was spawned with a tool catalog that contains **no shell / process-spawn capability**.
I verified this exhaustively rather than assuming it. The full union of every tool returned by
`search({query: <word>})` (a one-word query string) across 19 probe queries (`command`, `terminal`, `bash`, `process`, `exec`,
`run`, `powershell`, `npm`, `test`, `code`, `workspace`, `a`, `e`, `the`, `file`, `node`,
`rust`, `playwright`, `coverage`, `gate`) is 119 tools across exactly 8 namespaces:

| Namespace | Tools | Can spawn a process? |
|---|---|---|
| `browser` | 45 | no |
| `filesystem` | 14 | no |
| `github` | 26 | no |
| `memory` | 9 | no |
| `context7` | 2 | no |
| `sequential-thinking` | 1 | no |
| `obsidian-vault` | 14 | no |
| `opencode` | 5 | no |

Explicit negative results: `search({query:"shell"})` returned `Unknown tool 'shell'`;
`search({query:"bash"})` -> `[]`; `search({query:"command"})` -> `[]`;
`search({query:"terminal"})` -> `[]`; `search({query:"powershell"})` -> `[]`;
`search({query:"npm"})` -> `[]`.

**Therefore, explicitly and without hedging:**

| Command the brief asked for | Status |
|---|---|
| `npm run test:vantrilex` (exit code + per-stage counts) | **UNVERIFIED - could not run** |
| `npx vitest run --reporter=dot` (root) | **UNVERIFIED - could not run** |
| `cd apps/desktop && npx vitest run --reporter=dot` | **UNVERIFIED - could not run** |
| `cargo test` (with VsDevCmd.bat) | **UNVERIFIED - could not run** |
| Playwright / `npm run test:e2e` | **UNVERIFIED - could not run** (ports 4096/4097/4197 also not checkable) |
| `node scripts/lint-baseline.mjs` | **UNVERIFIED - could not run** |
| `$LASTEXITCODE` unpiped check | **UNVERIFIED - no shell** |

I did **not** guess, reconstruct, or infer any pass/fail count. Where a doc asserts a number I could not
observe, I record it as a **claim** and separately record what the **source on disk** implies, labelled
as a static derivation with its method stated. Static derivation is not measurement and I do not
present it as such.

**One genuine execution artifact does exist on disk** and is the only first-hand runtime evidence
available in this audit (see 1.4).

---

## 1. THE TEST MATRIX - declared vs statically-derived vs measured

### 1.1 The gate as physically defined

`package.json:23` (verbatim, one line, no wrapping in the file):

```json
"test:vantrilex": "npm run typecheck && npm run lint && npm run lint:ox && npm run test && npm run test:desktop && npm run test:e2e"
```

The chain resolves to:

| # | Script | Command | Runner |
|---|---|---|---|
| 1 | `typecheck` | `tsc --noEmit` | **root tsconfig only** |
| 2 | `lint` | `eslint . --max-warnings 0` | ESLint 9 flat config |
| 3 | `lint:ox` | `node scripts/lint-baseline.mjs` | oxlint ratchet |
| 4 | `test` | `vitest run` | **root** `vitest.config.ts` |
| 5 | `test:desktop` | `npm --prefix apps/desktop run test` then `vitest run` | **desktop** `vitest.config.ts` |
| 6 | `test:e2e` | `npm --prefix apps/desktop run test:e2e` then `npm run build --prefix ../.. && playwright test` | **Playwright + tsc emit** |

**Finding T-01 (HIGH) - E2E *is* in the gate, and the pre-existing AGENTS.md text was wrong.**
`package.json` is unambiguous: `test:e2e` is the sixth `&&` term. The now-corrected `AGENTS.md:53`
agrees. This matters because the gate now **requires ports 4096/4097/4197 to be free** and will fail
`EADDRINUSE` whenever an installed build is running (see 6.4).

### 1.2 Verdict on the brief's four numbers

| Suite | Claimed | Measured | Static derivation from disk | Verdict on the claim |
|---|---|---|---|---|
| Root vitest | 568 | **UNVERIFIED** | **572** declarations / 46 files | **Claim likely under by 4**; see 1.3 |
| Desktop vitest | 153 | **UNVERIFIED** | **151** executed / 145 declarations / 24 files | **Claim likely over by 2**; see 1.3 |
| E2E | 18 | **UNVERIFIED** | **18** test() / 14 specs | **Consistent** (declaration count only) |
| cargo test | 27 | **UNVERIFIED** | **27** #[test] | **Consistent** (attribute count only) |

### 1.3 Method for the static derivation (so it can be checked or refuted)

I wrote a JS/TS-aware lexer in the Code Mode sandbox and ran it over all 70 unit-test files. It blanks
line comments, block comments, single/double/backtick string literals (escape-aware) **and regex
literals** (disambiguated by the previous significant token), then counts `it(` / `test(` tokens.

> **Methodology warning - my first three passes produced wrong numbers and I discarded them.**
> Pass 1 stripped strings only, so `/no "/i` in `zero-canned.test.ts:64` opened a phantom string and
> swallowed the file. Pass 2 stripped comments only, so the `/*` inside the string literal `'/etc/*'`
> at `command-router.test.ts:68` opened a phantom block comment and blanked 226 lines (it reported 3
> test declarations for a 32-test file). Pass 3 used a regex disambiguator that mis-classified
> division. Only the final lexer is reported. The two independent token counts in the final pass -
> "any position" vs "line-start only" - were cross-checked against each other and agree except for one
> known two-statements-on-one-line case (`command-router.test.ts:222`), which is counted.

Root result - **572** it/test tokens across **46** `*.test.ts` files under `src/`:
- 0 `it.each`/`test.each`, 0 `describe.each` -> **executed root tests = 572**
- 0 `.skip`, 0 `.todo`, 0 `.only`, 0 `.fails`, 0 `.concurrent` -> nothing is silently excluded
- 0 `*.test.tsx`, 0 `*.spec.*`, 0 `__tests__/`, 0 `*.test.js`, 0 `*.test.mts` under `src/`
  -> the `src/**/*.test.ts` glob misses nothing

Desktop result - **145** tokens across **24** files (12 `*.test.ts` + 12 `*.test.tsx`):
- 2 `.each` blocks: `Crest.test.tsx:20` `test.each([24, 48, 96])` = **3 rows**;
  `matrix-state.test.ts:37` `test.each([[0,..],[1,..],[2,..],[3,..],[4,..]])` = **5 rows**
- **executed desktop = 145 - 2 + 3 + 5 = 151**
- 0 skip/todo/only

Combined: **717 declarations, 723 executed, 70 files, 0 skipped, 0 todo.**

> **Note on the .tsx trap.** My first pass used a `.ts`-only search, which found only 58 files and
> produced desktop = 89 - which is exactly the stale figure the README still prints (see 7.4). The 12
> `*.test.tsx` renderer tests are invisible to a `.ts`-only search. Anyone re-deriving these numbers
> must search `.tsx` too.

### 1.4 The one piece of real runtime evidence on disk

`apps/desktop/test-results/.last-run.json` - Playwright's own last-run marker, complete file contents:

```json
{
  "status": "passed",
  "failedTests": []
}
```

File metadata: `size: 45`, `created: Mon Sep 28 2026 16:04:50 GMT+0300`, `modified` identical.
My first filesystem access in this session was 16:15:13 - so this run finished **~11 minutes before
this audit began**, i.e. it is not a historical artifact.

What it proves: a Playwright run executed and reported `passed` with zero failed tests, today.
What it does **not** prove: how many tests ran. Playwright's `.last-run.json` carries no count.
Supporting negative evidence: `test-results/` contains **only** `.last-run.json` - no trace
directories - which is consistent with a clean run under `trace: 'retain-on-failure'`, but equally
consistent with a zero-test run. `apps/desktop/playwright-report/` does not exist (the configured
reporter is `list`, which writes no HTML report, so this is expected either way).

I decline to convert this into a count. It is one bit (`status: passed`), not 18.

### 1.5 Root suite - per-file declaration counts (all 46)

```
src/voice/tts.test.ts                            42
src/ipc/protocol.test.ts                          33
src/orchestrator/command-router.test.ts           31  (32nd test shares line 222 with a describe)
src/runtime/client.test.ts                       25
src/voice/brain.test.ts                          25
src/voice/ingest.test.ts                         22
src/orchestrator/narrator.test.ts                21
src/runtime/opencode-bridge.test.ts              20
src/ipc/ui-server.test.ts                        19
src/orchestrator/mentions.test.ts                18
src/voice/key-release-status.test.ts             18
src/orchestrator/slash.test.ts                   17
src/knowledge/corpus.test.ts                     16
src/orchestrator/prompt-optimizer.test.ts        16
src/voice/tts-r3-errors.test.ts                  16
src/orchestrator/audio-pipeline.test.ts          15
src/orchestrator/coordinator.test.ts             15
src/runtime/fuzzy-match.test.ts                  15
src/voice/stt.test.ts                            15
src/knowledge/normalize.test.ts                  11
src/orchestrator/mentions-wiring.test.ts         11
src/orchestrator/slash-wiring.test.ts            10
src/orchestrator/audio-pipeline-reset.test.ts     9
src/orchestrator/prompt-optimizer-wiring.test.ts  9
src/ipc/persona-propagation.test.ts               8
src/knowledge/personas.test.ts                    8
src/knowledge/retriever.test.ts                   8
src/daemon.test.ts                                7
src/policy/telemetry-wired.test.ts                7
src/voice/keyring.test.ts                         7
src/cli-doctor-keys.test.ts                       6
src/policy/sidecar-safety.test.ts                 6
src/policy/zero-canned.test.ts                    6
src/voice/fish-free-tier-header.test.ts           6
src/voice/key-advanced-telemetry.test.ts          6
src/daemon-narration-ceiling.test.ts              5
src/orchestrator/fr12-route.test.ts               5
src/orchestrator/inventory.test.ts                5
src/runtime/vad.test.ts                           5
src/voice/key-store.test.ts                       5
src/ipc/audio.test.ts                             4
src/memory/vault.test.ts                          4
src/telemetry/writer.test.ts                      4
src/voice/cache.test.ts                           3
src/common/logger.test.ts                         2
src/launcher/launcher.test.ts                     1
                                                ---
                                                 572
```

### 1.6 Desktop suite - per-file declaration counts (all 24)

```
apps/desktop/src/audio/capture-permission.test.ts           3
apps/desktop/src/audio/capture.test.ts                       7
apps/desktop/src/audio/earcons.test.ts                       5
apps/desktop/src/audio/mic-policy.test.ts                    9
apps/desktop/src/audio/playback-f01.test.ts                  4
apps/desktop/src/audio/playback.test.ts                     17
apps/desktop/src/audio/vad.test.ts                           4
apps/desktop/src/bridge/ws.test.ts                          18
apps/desktop/src/matrix/matrix-state.test.ts                10  (1 decl -> 5 executed)
apps/desktop/src/sessions/store.test.ts                      2
apps/desktop/src/settings/ipc-token.test.ts                  3
apps/desktop/src/settings/services.test.ts                   7
apps/desktop/src/components/brand/Crest.test.tsx              1  (1 decl -> 3 executed)
apps/desktop/src/components/brand/WaveformEmblem.test.tsx     1
apps/desktop/src/components/icons/ControlGlyphs.test.tsx     3
apps/desktop/src/components/portals/ApiKeysModal.test.tsx    5
apps/desktop/src/components/portals/portals.test.tsx         2
apps/desktop/src/components/session/AgentModelBadge.test.tsx 4
apps/desktop/src/components/session/ContextGauge.test.tsx   10
apps/desktop/src/components/session/SessionChip.test.tsx     5
apps/desktop/src/components/settings/KeysView.test.tsx       2
apps/desktop/src/components/settings/SettingsView.test.tsx  5
apps/desktop/src/components/waveform/SiriWaveCanvas.test.tsx 14
apps/desktop/src/window/useAutoSize.test.tsx                 4
                                                             ---
                                                              145  ->  151 executed
```

### 1.7 Rust

`apps/desktop/src-tauri/src/main.rs` is 1383 lines and the **only** file in `src-tauri/src/`.
A scan for `#[test]` and `#[tokio::test]` finds exactly **27**, all `#[test]`, all in one
`#[cfg(test)] mod`. Full list: `adoption_success_keeps_the_child` (926), `adoption_failure_kills_the_child`
(934), `supervisor_own_reports_adoption_and_tracks_the_child` (939),
`unadopted_children_are_killed_immediately_not_merely_counted` (965),
`child_logs_use_the_canonical_file_when_it_can_be_opened` (988),
`child_logs_fall_back_to_a_unique_file_instead_of_going_silent` (1001),
`child_logs_report_both_errors_when_no_file_can_be_created` (1020),
`child_logs_are_append_only_so_a_restart_cannot_erase_the_cause` (1031),
`both_streams_are_captured_never_nulled` (1043),
`child_output_actually_lands_in_the_captured_files` (1063),
`a_second_child_appends_rather_than_erasing_the_first_failure` (1085),
`a_process_we_did_not_spawn_is_a_foreign_supervisor` (1111), `only_our_own_children_are_not_foreign`
(1119), `no_candidates_means_no_foreign_serve` (1127),
`opencode_pids_parses_tasklist_csv_and_ignores_the_no_match_banner` (1133),
`opencode_pids_runs_against_this_machine_without_erroring` (1155),
`adoption_is_preferred_over_a_second_spawn` (1163),
`a_cold_port_with_a_foreign_serve_is_spawned_but_flagged` (1172),
`a_cold_port_with_no_foreign_serve_just_spawns` (1180),
`in_flight_is_reported_as_retriable_not_as_success_or_failure` (1187),
`a_real_failure_is_not_retriable_and_carries_the_reason` (1197),
`success_reports_each_step` (1205),
`status_serialises_with_the_fields_the_shell_reads` (1213),
`a_child_that_never_binds_is_killed_and_reported_as_timed_out` (1223),
`a_child_that_does_bind_is_returned_for_supervision` (1242),
`a_command_that_cannot_spawn_is_reported_not_panicked` (1260),
`every_vault_resolution_branch_is_logged` (1283).

`Cargo.toml` has **no `[[test]]` target, no `doctest = false`, and no `lib.rs`** (binary-only
package). A binary target gets no doctests, so `cargo test` should report 27 unit tests and 0 doctests.
**Not verified by execution.**

**Finding R-01 (MEDIUM) - one Rust test is environment-dependent and is the flakiest thing in the
suite.** `opencode_pids_runs_against_this_machine_without_erroring` (`main.rs:1155`) shells out to
`tasklist`. It asserts "does not error", not a value, so it should be stable, but it is the only test
in the repo whose pass/fail depends on a live OS query.


---

## 2. vitest.config.ts - globs, thresholds, and what is excluded from what

### 2.1 Root config, complete file contents

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80 },
    },
  },
});
```

### 2.2 Desktop config, complete file contents

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
  },
});
```

### 2.3 Include-glob audit - two of the three root globs are dead

| Glob | Directory exists on disk? | Files matched |
|---|---|---|
| `src/**/*.test.ts` | yes | 46 |
| `test/**/*.test.ts` | **NO** - `list_directory` returned `ENOENT` | **0** |
| `bench/**/*.bench.ts` | **NO** - `ENOENT`; a repo-wide `**/*.bench.ts` search returned `No matches found` | **0** |

**Finding T-02 (LOW) - two of three root include globs can never match anything.** `test/` and
`bench/` do not exist. Harmless today, but they are load-bearing-looking dead configuration: a
reviewer reading `include` reasonably infers three test roots. They also mean a future `bench/`
addition would silently start being collected as tests.

### 2.4 What is EXCLUDED from the vitest runner

- **Everything outside the globs above.** Concretely excluded and therefore **never executed by any
  test runner in this repo**:
  - `.opencode/_archive/dead-code-phase1/` - **14 quarantined test files**:
    `src/guidance/guidance.test.ts`, `src/guidance/rag/normalize.test.ts`,
    `src/guidance/rag/personas.test.ts`, `src/guidance/rag/retriever.test.ts`,
    `src/ipc/attach.test.ts`, `src/orchestrator/dispatch.test.ts`,
    `src/orchestrator/failclosed.test.ts`, `src/orchestrator/fr12.test.ts`,
    `src/orchestrator/laya-advisor.test.ts`, `src/orchestrator/orchestrator.test.ts`,
    `src/runtime/laya/laya.integration.test.ts`, `src/runtime/laya/laya.test.ts`,
    `src/ui/ui.test.ts`, `src/voice/voice.test.ts`.
  - `apps/desktop/e2e/*.spec.ts` - 14 files, run by Playwright, not vitest (correct by design).
  - `apps/desktop/src-tauri/**` - Rust, run by cargo.
  - `apps/desktop/src/**` from the **root** runner - correct: the root include is `src/**` rooted at
    the repo root, so it never descends into `apps/`.

**Finding T-03 (MEDIUM) - the quarantine is real, and the archive is larger than documented.**
The archive contains **77 files**: 33 `.md`, **42 `.ts`**, 2 `.json`. 14 of the 42 are test files.
`AGENTS.md:109` claims *"moved, not deleted, to `.opencode/_archive/dead-code-phase1/` - 44 files
including their tests and fixtures."* Disk says 42 `.ts` and 77 total. Neither 44 matches either
number. 14 real test files sit permanently outside both `tsc` and `vitest`.

### 2.5 What is EXCLUDED from tsc

**Root tsconfig.json:**
```json
"include": ["src/**/*.ts"],
"exclude": ["node_modules", "dist", "**/*.test.ts"]
```

**Finding T-04 (HIGH) - the root typecheck stage typechecks zero test files.**
`"exclude": ["**/*.test.ts"]` removes all **46** root test files from the program. They are then not
in any other tsc program either: `apps/desktop/tsconfig.json` `include` is `["src", ...]`
(desktop-only), and the archive is outside both. So the 572 root test declarations are **never
type-checked by anything**. A root test file can contain any type error and the gate stays green.
Vitest transpiles via esbuild with no type checking, so it will not surface the error either - it
will surface at *runtime*, or not at all.

**Finding T-05 (HIGH) - the gate never typechecks the desktop renderer at all.**
`test:vantrilex` stage 1 is root `npm run typecheck` = `tsc --noEmit` with the **root** tsconfig.
The desktop `typecheck` script (`"typecheck": "tsc --noEmit"` in `apps/desktop/package.json`) and the
desktop `build` script (`"build": "tsc --noEmit && vite build"`) are **not referenced by any stage of
`test:vantrilex`**. Stage 6 runs `npm run build --prefix ../..`, which is the **root** build. So the
entire renderer - `App.tsx`, all 12 `.test.tsx` files, all components - is transpiled by esbuild and
executed by vitest, but never type-checked. `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` are declared in the desktop tsconfig and **enforced by nothing in the gate**.

Full exclusion matrix:

| Path | In vitest? | In tsc? | Notes |
|---|---|---|---|
| `src/**/*.ts` (51 files) | via 46 `.test.ts` | yes | 51 production modules - matches the LIVE claim |
| `src/**/*.test.ts` (46) | yes | **NO** | T-04 |
| `apps/desktop/src/**/*.test.ts` (12) | yes (desktop runner) | **NO** (not in gate) | T-05 |
| `apps/desktop/src/**/*.test.tsx` (12) | yes (desktop runner) | **NO** (not in gate) | T-05 |
| `apps/desktop/src/**` (renderer) | only via tests | **NO** (not in gate) | T-05 |
| `apps/desktop/e2e/*.spec.ts` (14) | no | **NO** | neither tsconfig includes e2e |
| `apps/desktop/playwright.config.ts` | no | **NO** | not in desktop include |
| `vitest.config.ts`, `eslint.config.js` | no | **NO** | outside src/; allowJs off |
| `scripts/lint-baseline.mjs` | no | **NO** | .mjs, outside src/ |
| `.opencode/_archive/**` (42 .ts) | no | no | T-03 |
| `src-tauri/src/main.rs` | no | n/a | 27 #[test] |

**Finding T-06 (MEDIUM) - the 14 Playwright specs and the Playwright config are type-checked by
nothing.** `apps/desktop/tsconfig.json` `include` is `["src", "vite.config.ts",
"tailwind.config.ts"]`. `e2e/stub-daemon.mjs` and all 14 `*.spec.ts` are outside it.
`fr12.spec.ts` opens a raw WebSocket with a hand-rolled frame matcher and a hand-written
`Record<string, unknown>` cast chain; nothing verifies those types agree with the frozen
`voice-ui.v1` contract.

### 2.6 Coverage directories - negative evidence

`O:\opencode-Vantrilex\coverage` returned `ENOENT`. No coverage output has ever been generated at
the repo root. `eslint.config.js` and `.oxlintrc.json` both list `coverage/**` in their ignore
arrays, which is anticipatory scaffolding, not proof of a run.

---

## 3. scripts/lint-baseline.mjs - mechanism, baseline, and the global-oxlint guard

### 3.1 The ratchet mechanism, exactly

`scripts/lint-baseline.mjs` is 119 lines. Constants and control flow:

```js
const BASELINE = 8;                                    // line 14 - FALLBACK ONLY
const BASELINE_FILE = join(ROOT, 'scripts', 'lint-baseline.json');
const localBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.cmd' : 'oxlint');
const useLocal = existsSync(localBin);
const allowGlobal = process.env['VOXAURA_ALLOW_GLOBAL_OXLINT'] === '1';
```

Resolution order:
1. If `scripts/lint-baseline.json` exists on disk, **it wins** over the `BASELINE = 8` constant.
   Verbatim: `const expected = onDisk ?? BASELINE;`
2. `scripts/lint-baseline.json` **exists**. Full contents: `8`. So the effective baseline is `8`.
   It happens to equal the constant, so there is no divergence today - but **the constant is dead
   code on this checkout**, and the script's own comment (*"Current known baseline"*) is misleading:
   the number that is actually enforced lives in the JSON.

Spawn (Windows-specific, and correct):
```js
const isWindows = process.platform === 'win32';
const target = useLocal ? localBin : 'oxlint';
const run = () => isWindows
  ? execFileSync('cmd', ['/c', target], spawnOpts)
  : execFileSync(target, [], spawnOpts);
```
`spawnOpts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }`.

Parse: `const m = out.match(/Found (\d+) warnings? and (\d+) errors?/);`

**The ratchet is two-sided** - this is the distinguishing design choice:

| Condition | Action | Exit |
|---|---|---|
| `m === null` (unparseable) | `could not parse oxlint output; refusing to guess` + last 500 chars | **2** |
| `errors > 0` | `FAIL: N error(s)` | **1** |
| `warnings > expected` | `FAIL: N warnings, baseline is E (+D)` | **1** |
| `warnings < expected` | `baseline is stale: N < E. Lower scripts/lint-baseline.json to N` | **1** |
| `warnings === expected` | `OK` | **0** |

The rationale is stated in the file header: pinning the count *"stops a net-zero swap (fix one,
introduce one) from passing."*

**Finding L-01 (MEDIUM) - the ratchet is bidirectional, which is unusual and is a maintenance trap.**
The gate requires **exactly 8 warnings forever**. Reducing oxlint warnings below 8 **fails the gate**
until someone hand-edits `scripts/lint-baseline.json`. A team that fixes a warning has broken their
build. This is defensible (it is what makes the ratchet reviewable in a diff) but it is the opposite of
the usual "never get worse" ratchet, and the failure message is the only warning sign.

**Finding L-02 (MEDIUM) - fragile output contract, unverifiable without running.**
Two hard dependencies on oxlint's exact stdout format:
- The regex requires the literal phrase `Found N warning(s) and N error(s)`. If oxlint emits a
  different summary - or, on a fully clean tree, a line that omits the counts entirely - `m === null`
  and the gate **exits 2**. Failing closed is correct behaviour, but the operator sees "could not parse
  oxlint output" rather than a lint problem.
- `execFileSync` with `encoding: 'utf8'` and no `stdio` override captures **stdout only**. If the
  oxlint version in play writes its summary to **stderr**, `out` is empty and the gate always exits 2.
- Additionally, `maxBuffer` is 32 MiB; exceeding it throws an uncaught `ENOBUFS` rather than a
  diagnostic.
I could not run the script, so I cannot say which of these actually happens. **UNVERIFIED.**

### 3.2 The refusal-to-run-on-global-oxlint guard

Verbatim, the decision block:

```js
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
```

And the fallback warning: `if (!useLocal) { console.warn('lint-baseline:
VOXAURA_ALLOW_GLOBAL_OXLINT=1 - running an UNPINNED ambient oxlint.'); }`

#### Is the guard non-vacuous? My assessment: structurally non-vacuous, currently unreachable, and its stated premise is false.

**Evidence the code is live, not dead:**
- It sits on the main execution path, before any spawn. Removing it would change behaviour.
- `useLocal` is a real filesystem probe (`existsSync`), not a constant.
- Two independent ways to reach the `exit 1` branch (remove the local binary, or leave
  `VOXAURA_ALLOW_GLOBAL_OXLINT` unset), and two independent ways past it.
- It is not shadowed: `process.exit(1)` is unconditional inside the branch.

**Evidence it does not fire on this checkout:**
`O:\opencode-Vantrilex\node_modules\.bin` contains **`oxlint`, `oxlint.cmd` AND `oxlint.ps1`**.
Therefore `useLocal === true`, the guard is short-circuited, and `target = localBin` (the pinned
local binary). The `console.warn` fallback branch is also unreachable.

**Finding L-03 (HIGH) - the guard's 25-line rationale is factually stale, and so is the CHANGELOG's
version of the same claim.** `lint-baseline.mjs:22-25` asserts:

> `// \`oxlint\` is declared in devDependencies (pinned exact, no caret) but is absent`
> `// from node_modules, so every run was resolving an AMBIENT GLOBAL binary. Two`
> `// independent pre-existing blockers stop \`npm install\` from fixing it:`

Three claims, all contradicted by disk:
1. **"absent from node_modules"** - `node_modules/.bin/oxlint.cmd` **exists**. False.
2. **"Pinning to 1.0.0 / 1.10.0 / 1.20.0 / 1.85.0 / 1.86.0 all still fail, so no version of the 1.x
   line installs cleanly alongside vitest 2.x"** - `package.json` pins `"oxlint": "1.85.0"` (an exact
   pin, no caret, confirming the *other* comment's wording) and `"vitest": "4.1.11"` (**v4, not v2**).
   The 1.85.0 pin it calls uninstallable is the one that is installed, alongside v4. False, and
   internally inconsistent with its own neighbouring comment.
3. The same claim appears at `CHANGELOG.md:58-59`: *"`oxlint` is declared in `devDependencies`
   (`^1.0.0`) but is **not installed in `node_modules`"*. `^1.0.0` is also wrong - the manifest says
   `1.85.0`, exact.

The guard's *logic* is fine and worth keeping. Its *documentation* now actively misleads: a future
maintainer reading lines 22-25 would conclude the local binary cannot exist and might "fix" a
non-problem. **Recommend rewriting the comment to describe the guard as defence-in-depth rather than
as a statement of current reality.**

**Non-vacuity verdict, stated precisely:** I cannot prove the guard fires without removing or renaming
`node_modules/.bin/oxlint.cmd`, which would (a) mutate the repo outside my write target and (b) break
the gate for other auditors. Per `AGENTS.md`'s own rule - *"Verify a guard test by breaking the guard"*
- this is **UNVERIFIED by execution**. What I can state from source: the branch is reachable,
unguarded, and has no path that bypasses `process.exit(1)` when its condition holds. The condition is
currently false.

### 3.3 A latent bug in ROOT resolution

```js
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
```

`URL.prototype.pathname` is **percent-encoded**. The repo path `O:\opencode-Vantrilex` contains no
characters requiring encoding, so this works today. Move the checkout to a path containing a space,
`#`, `?`, or any non-ASCII character and `ROOT` becomes a wrong path: `existsSync` returns false, the
guard fires, and the gate exits 1 with a message blaming a missing dependency. `fileURLToPath()` is the
correct API. **Finding L-04 (LOW) - correct today, fragile on relocation.**

### 3.4 Lint scope: what the gate actually lints

- `npm run lint` = `eslint . --max-warnings 0` from the **root**. `eslint.config.js` ignores only:
  `dist/**`, `apps/desktop/dist/**`, `apps/desktop/src-tauri/sidecar/**`, `node_modules/**`,
  `apps/desktop/node_modules/**`, `coverage/**`, `.venv/**`, `**/target/**`. Desktop renderer
  source **is** linted. One override: `**/*.test.ts` gets `@typescript-eslint/no-explicit-any: off`.
  **The override pattern is `.test.ts` only - it does not match `*.test.tsx`**, so the 12 renderer
  `.tsx` tests are held to full `no-explicit-any`.
- `.oxlintrc.json` ignores `node_modules`, `dist`, `.venv`, `models`, `.hf_cache`,
  `ml/checkpoints`, `coverage`, `apps/desktop/dist`, `apps/desktop/src-tauri/sidecar`,
  `**/target`.
- `apps/desktop` has its own `"lint:ox": "oxlint"` (no baseline) which **no stage of
  `test:vantrilex` invokes**. The root `oxlint` invocation runs with `cwd: ROOT` and no path
  argument, so it descends into `apps/desktop/src` anyway - the desktop's own script is redundant
  dead configuration, and nothing baselines the desktop tree separately.

**Finding L-05 (MEDIUM) - the quarantined archive may be inside the lint gate but outside every other
gate.** Neither `eslint.config.js` nor `.oxlintrc.json` ignores `.opencode/**`. The 42 archived
`.ts` files are outside `tsc` and outside `vitest` by construction, but if `eslint .` enumerates
dot-directories (ESLint 9 flat config), 42 quarantined files that were explicitly abandoned are still
being linted at `--max-warnings 0`. That is both wasted work and a contradiction of the quarantine
decision. Whether ESLint 9 flat config skips dot-directories by default could not be determined
without running it. **UNVERIFIED - but material, and cheap to settle empirically.**


---

## 4. VACUOUS-TEST AUDIT

### 4.1 Tautologies, literal-vs-literal, empty bodies, skipped tests: ZERO FOUND

Searched all 70 unit-test files with the lexer, plus all 14 E2E specs and `main.rs`:

| Vacuity pattern | Result |
|---|---|
| Test body with **zero** expect / expect. / assert / assert. / toThrow / .rejects / .resolves | **0** (of 717) |
| `expect(<literal>).toBe/toEqual/toStrictEqual(<same literal>)` | **0** |
| `assert.ok(true)` / `assert.equal(1, 1)`-style self-comparison | **0** |
| `it.skip` / `test.skip` / `describe.skip` | **0** |
| `it.todo` / `test.todo` | **0** |
| `it.only` / `test.only` | **0** |
| `it.fails` | **0** |
| `it.concurrent` | **0** |
| Empty test body `() => {}` | **0** |
| `expect(x ?? 0)` / `expect(x ?? '')` - assertion-masking fallbacks | **0** |
| `.only` in E2E specs / `test.fixme` / `test.fail` | **0** |
| `#[ignore]` in `main.rs` | **0** |

**The suite has no tautological or empty tests.** This is a genuinely clean result and I am reporting
it as such rather than manufacturing a finding.

> **Honesty note on this section.** My first three automated passes reported **three** vacuous tests
> (`sidecar-safety.test.ts:36`, `zero-canned.test.ts:133`, `telemetry-wired.test.ts:44`) and a
> fourth at `command-router.test.ts:65`. **All four were false positives** caused by my own lexer
> mis-handling regex literals containing `(` and `/*`. I read all four by hand and every one contains
> real assertions - for example `sidecar-safety.test.ts:36` builds a full transitive static-import walk
> and asserts `offenders` is empty. A vacuity audit that ships its false positives is worse than none.

### 4.2 Weak-assertion profile

| Assertions in the test body | Count | Share of 717 |
|---|---|---|
| exactly 1 | 273 | 38.1 % |
| 2 or more | 444 | 61.9 % |
| 0 | 0 | 0 % |

273 single-assertion tests is a normal ratio for unit suites and is not itself a defect. It becomes
one only in combination with 4.3.

### 4.3 Finding V-01 (MEDIUM) - expect.hasAssertions / expect.assertions is used ZERO times

Across all 70 unit-test files: **0** occurrences of `expect.hasAssertions(` or `expect.assertions(`.

These are the only guard Vitest offers against the classic async-vacuity failure: a test whose
assertion lives inside a callback, timer, or detached promise that never fires still passes green.
This repo is unusually exposed to that shape:

- E2E specs lean on `expect.poll(...)` and `page.waitForEvent`, and several `.then()` chains.
- The desktop `.tsx` tests use `act(() => { root!.render(<Crest size={size} />) })` in
  `happy-dom`, where a render that throws asynchronously inside `act` can leave the test with no
  executed assertion.
- `bargein.spec.ts` polls a deadline loop and then asserts on a captured variable - the assertion is
  reached regardless, so that one is safe, but the *pattern* is unguarded elsewhere.

**This is the strongest remaining vacuity risk in the suite, and it is a gap rather than a defect.**
A single `expect.assertions(n)` in the shared setup of the async-heavy files would close it.

### 4.4 Finding V-02 (LOW) - 14 tests assert on source text, not on runtime behaviour

These read the implementation file with `readFileSync`/`readdirSync` and regex its contents:

| File:line | What it greps |
|---|---|
| `src/policy/sidecar-safety.test.ts:27` | `src/daemon.ts` for a static vs dynamic `runtime/vad` import |
| `src/policy/sidecar-safety.test.ts:36` | full transitive static-import walk of the daemon graph for native packages |
| `src/policy/zero-canned.test.ts:71` | 12 banned Arabic confirmation strings across `src` + `apps/desktop/src` |
| `src/policy/zero-canned.test.ts:86` | that every surviving banned-phrase mention carries a prohibition marker |
| `src/policy/zero-canned.test.ts:101` | `App.tsx`'s `send()` arity |
| `src/policy/zero-canned.test.ts:111` | `narrator.ts` for a template table |
| `src/policy/zero-canned.test.ts:119` | `daemon.ts`'s `setVoicePhase('speaking', ...)` arguments |
| `src/policy/zero-canned.test.ts:133` | `App.tsx` for a text input or textarea |
| `src/policy/telemetry-wired.test.ts:61` | (source read in this test body) |
| `src/telemetry/writer.test.ts:21, 71, 93` | source reads |
| `src/memory/vault.test.ts:17, 31` | source reads |

These are **not vacuous** - a source edit does make them fail, and `sidecar-safety.test.ts:36` is a
genuinely strong architectural invariant. But they assert on **text**, so they are defeated by any
refactor that preserves behaviour and changes formatting, and they cannot detect a semantic regression
that avoids the literal they grep for. `sidecar-safety.test.ts` is the important case worth calling
out: it is the test that would have caught v0.6.0, and it works by parsing import statements with a
regex rather than by loading the module graph. The regex does handle `export ... from`
(`STATIC_IMPORT = /^\s*(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm`), which is good.
`require()` is not covered.

### 4.5 Finding V-03 (LOW) - three wiring test files overlap a stronger check

`mentions-wiring.test.ts` (11), `slash-wiring.test.ts` (10), `prompt-optimizer-wiring.test.ts` (9) -
30 tests - assert that these three modules are *imported by* `daemon.ts`. Per `AGENTS.md` these three
modules "had passing tests and zero importers at the same time", so the wiring tests are the direct
remedy and are well-targeted. Noted only because they overlap with `sidecar-safety.test.ts`'s graph
walk, which is the stronger, more general check. **No action recommended.**

---

## 5. COVERAGE - does the 80 % line threshold execute in the default gate?

### 5.1 Verdict: NO. It is dead configuration in every gate stage.

The threshold is declared:

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts'],
  thresholds: { lines: 80 },
},
```

### 5.2 Proof from the config and the scripts

1. **`coverage.enabled` is not set.** Vitest's default is `false`. Thresholds are evaluated only when
   coverage is collected; they are not a standalone gate.
2. **No script passes a coverage flag.** Verified by reading both manifests in full:
   - `package.json` - the string `coverage` does not appear anywhere in the file. Result recorded:
     `"package.json no coverage token"`.
   - `apps/desktop/package.json` - `"apps/desktop/package.json no coverage token"`.
   - `scripts/lint-baseline.mjs` - does not mention coverage.
   The root `test` script is exactly `"test": "vitest run"` - no `--coverage`, no
   `--coverage.enabled`.
3. **No CI exists to add the flag.** `O:\opencode-Vantrilex\.github` returned `ENOENT: no such file
   or directory`. There is no workflow, no CI config, nothing that could invoke coverage.
4. **The desktop suite has no coverage configuration at all** - `apps/desktop/vitest.config.ts` has
   no `coverage` key. Renderer coverage is not merely unmeasured; it is unconfigured.
5. **On-disk corroboration:** `O:\opencode-Vantrilex\coverage` returned `ENOENT`. No coverage report
   has ever been written.

### 5.3 What this means

- The `thresholds: { lines: 80 }` block is **inert**. It would only take effect if someone manually ran
  `npx vitest run --coverage`. It has never been observed to do so.
- It is a **regression magnet**: a reader of `vitest.config.ts` sees `thresholds: { lines: 80 }` and
  reasonably concludes an 80 % line-coverage floor is enforced. It is not. Nothing in the repo measures
  coverage at all.
- `README.md` does not claim coverage, so this is a config-honesty defect rather than a doc
  contradiction. But it belongs in the same family as the stale gate descriptions in section 7.
- **UNVERIFIED by execution:** I could not run `npx vitest run --coverage` to observe the actual
  percentage or confirm the threshold's behaviour on this Vitest version (`4.1.11`). The conclusion
  rests on config and manifest contents, both read in full.

**Recommendation:** either add `enabled: true` (turning it into a real floor) or delete the block.
Leaving an unenforced threshold is the one option that guarantees the reader is misled.

---

## 6. E2E - SPEC INVENTORY AND BLIND SPOTS

### 6.1 stub-daemon.mjs is a FAKE CONTROL PLANE - stated explicitly

`apps/desktop/e2e/stub-daemon.mjs` (5.51 KB) is started by `playwright.config.ts` as a `webServer`
on port 4197. It is **not** the real daemon. It is:

- **Real:** `UiServer` imported from `../../../dist/ipc/ui-server.js` - the genuine RFC-6455 server
  and the genuine WS-4097 frame schemas, bound to the real port 4097.
- **Real:** `createCommandHandler` imported from `../../../dist/orchestrator/command-router.js` - the
  production FR-12 command router, including the real park-until-confirm gate.
- **Fake:** the `ServeClient`. Four methods, all returning an empty object:
  `setSessionAgent`, `setSessionModel`, `toggleSessionSkill`, `execSessionShell` (the last one just
  pushes to an array). No HTTP, no auth, no real OpenCode `serve`, no database, no SQLite.
- **Fake:** `saveKeys.saveKeys: async () => ({})`. **No vault, no keyring, no crypto, no disk I/O.**
- **Fake:** the narrator. `narratorLineFor()` returns hardcoded Arabic strings, with an explicit
  comment conceding the point: *"The stub cannot call a model, so it stands in with a representative
  MODEL-WRITTEN line."* Those literals then flow into `boot.spec.ts`'s zero-canned assertions.
- **Fake:** a bespoke HTTP control plane on 4197 with endpoints `/fire`, `/commands`, `/shells`,
  `/audio`, `/audio/reset`, `/audio-down`, `/notice`, `/voice`, `/inventory`, `/agents`,
  `/kill`, `/revive`. Open `Access-Control-Allow-Origin: '*'`. This port does not exist in production.
- **Not present at all:** STT, TTS, the brain, the OpenRouter UA requirement, the
  `reasoning: {effort:'none'}` requirement, the `json_schema` requirement, key rotation, the ONNX VAD
  path, the audio-pipeline reset, the telemetry writer, the Arabic normalizer, the RAG retriever.

Because the stub imports from `dist/`, `test:e2e` runs `npm run build --prefix ../..` first - so E2E
is the only suite that exercises the **compiled** daemon modules. That is real value, and it is also how
v0.6.0 shipped: `sidecar-safety.test.ts:9-10` records it exactly - *"even though every unit, Rust
and E2E test passed, because E2E drives a stub daemon."*

### 6.2 Every spec file and what it asserts (all 14, all read in full)

| Spec | Tests | Asserts |
|---|---|---|
| `boot.spec.ts` | 2 | `voxaura-shell` visible; `bridge-status` reads `متصل وبانتظار الأوامر` and `data-state=ready`; waveform emblem, siri-wave, mic/bot/abort toggles visible; the legacy `icon-cluster` and `action-bar` are `toHaveCount(0)`; mic `title` matches the Arabic microphone label; `aria-pressed` flips on click; after muting, `notice-banner` contains `كتمت الميكروفون` and neither `announce` nor the banner contains `تم إيقاف` or `بنجاح` (zero-canned); bot toggle flips to `aria-pressed=true` |
| `matrix.spec.ts` | 1 | `siri-wave` starts `data-mode=idle`; `/fire running` moves it to `active`; `/fire complete` leaves it **active** (latch behaviour) |
| `controls.spec.ts` | 2 | `/inventory` then chip dropdown then select `ses_a` makes `agent-model-badge` visible; `badge-switch-agent` (dialog accepts `build`) records `setSessionAgent` with `sessionId:'ses_a'` and `agent:'build'`; `badge-switch-model` records `setSessionModel` with `model:'opus'`; `badge-agent` shows `build` and `badge-model` is `toHaveCount(0)` (raw ids never rendered); `/agents` with 2 agents gives `agent-select` 3 options (placeholder + 2); selecting `architect` records `setSessionAgent` |
| `inventory.spec.ts` | 1 | `/inventory` with `ses_a`+`ses_b` puts both chips in the dropdown; clicking `ses_b` records `switchSession`; a subsequent empty snapshot makes `session-list` `toHaveCount(0)` (no fabrication) |
| `capture.spec.ts` | 1 | Mic starts `aria-pressed=true` (muted); unmuting drives stub `/audio` frames > 0 and bytes > 0; re-muting stops the frames with at most **one** in-flight frame landing after stop (`<= countAtStop + 1`) |
| `downlink.spec.ts` | 1 | `speaking-indicator` absent initially; `/audio-down` with a deliberately invalid MP3 header returns `chunks === 1` and the indicator becomes visible (proves enqueue then onStart, not decode) |
| `bargein.spec.ts` | 1 | Unmute and frames flow; loop up to 25 s re-posting `/audio-down` while polling `/commands`; asserts the `abort` count **increased** and that frames kept flowing; restores the muted default so later specs are unaffected |
| `abort.spec.ts` | 1 | `/fire complete` moves the wave to `active`; clicking `abort-button` returns it to `idle`; stub `/commands` contains a `kind === 'abort'` |
| `disconnect.spec.ts` | 1 | `POST /kill` degrades `bridge-status` to `غير متصل` within 15 s; then `POST /revive` for file-order independence |
| `ux.spec.ts` | 2 | `/voice` phase thinking with an Arabic transcript makes the pill show `التفكير` and `last-transcript` show the text; `speaking` shows `يتحدث`; `idle` shows `متصل`; `/notice` with code `voice-disabled-no-keys` renders a banner containing `المفاتيح` with a visible `notice-open-keys`, and `notice-dismiss` removes the banner |
| `portals.spec.ts` | 2 | Settings opens as a second page at `view=settings`; 4 tabs; `apikey-groq` absent from settings (keys decoupled); `chain-list` visible with a non-empty `[data-testid^="chain-"]` set; the `الصوت` tab plus `persona-nour` gives `aria-checked=true`; `Escape` closes the window; the main shell survives. Keys open at `view=keys` in their own window, `keys-view` visible, **0** tabs, `apikey-groq` visible |
| `apikeys.spec.ts` | 1 | `apikey-banner` contains `All 3 API keys are required`; `apikey-save` is disabled with 0, 1, and 2 fields filled and enabled only after all three; saving records `saveApiKeys` with all three exact values and never echoes them into the page |
| `session-compact.spec.ts` | 1 | 30 historical sessions yield one `session-chip-trigger` and no `session-list` in the DOM; chip height `<= 48px`; mic and siri-wave visible; mic bottom edge `< 1400px`; opening the dropdown does not move the mic (`abs(micAfter - micBefore) < 2`) |
| `fr12.spec.ts` | 1 | Over a **raw** WebSocket to `ws://127.0.0.1:4097/v1/ui?lastSeq=0` with subprotocol `['voice-ui.v1','e2e-token']`: `execSessionShell 'rm -rf build'` acks `{ok:true, detail:'confirmation-required'}`; `/shells` is still `[]`; `confirm` acks ok; a **replayed** `confirm` acks `{ok:false, detail:'no pending action'}`; finally `/shells` equals exactly `[{session:'ses_e2e', command:'rm -rf build'}]` - executed exactly once |

**18 test() across 14 spec files. 0 .skip, 0 .fixme, 0 .only, 0 test.fail.**

### 6.3 What E2E genuinely does NOT cover

- **Any real provider.** No OpenRouter, no Groq, no Fish. The `User-Agent: opencode/1.0 (Voxaura)`
  requirement, the `reasoning: {effort:'none'}` requirement and the load-bearing `json_schema` - the
  three silent-failure modes `AGENTS.md` says were "found by a live call, not by reading docs" - are
  **completely untested by every runner in the gate.**
- **Any real key.** `saveKeys` returns an empty object. Key validation, 401/403 rotation, and the
  "present but invalid key" failure mode (open finding L17) are all uncovered.
- **The vault, keyring, or machine.key.** No crypto runs.
- **The real ServeClient**, and therefore real OpenCode auth, the shared SQLite DB, 204-No-Content
  handling, session envelope normalisation, or SSE.
- **The ONNX VAD path.** The barge-in spec uses a Chromium fake device, not Silero.
- **Tauri itself.** `tauri dev` is not used; the config runs `npm run dev:web` - Vite only. So
  `main.rs`, the Job Object, token provisioning, port 4096 and the `ipc_token` command are outside E2E
  entirely.
- **The real daemon boot path.** `src/daemon.ts` is never started; the stub constructs `UiServer`
  directly from `dist/`.
- **Port 4096.** Nothing binds or probes it. `AGENTS.md:58` and the release flow both require 4096 to
  be free, but the E2E gate never touches it.
- **Arabic STT.** No audio is transcribed anywhere in the suite.

### 6.4 E2E runner configuration (verbatim)

```ts
testDir: './e2e', testMatch: '**/*.spec.ts',
fullyParallel: false, workers: 1,  // one shared stub daemon per run - broadcasts reach all pages
retries: 0, reporter: 'list',
use: { baseURL: 'http://localhost:1420', trace: 'retain-on-failure' },
projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } } }],
webServer: [
  { command: 'node ./e2e/stub-daemon.mjs', port: 4197, reuseExistingServer: false, stdout: 'pipe' },
  { command: 'npm run dev:web -- --port 1420 --strictPort', port: 1420, reuseExistingServer: false,
    env: { VOICE_RUNTIME_IPC_TOKEN: 'e2e-token' } },
]
```

**`retries: 0` is a deliberate and correct choice** - a retrying flake in a suite with a shared
single-instance stub daemon masks ordering bugs. `workers: 1` and `fullyParallel: false` are required
for correctness (the stub broadcasts to all pages). `reuseExistingServer: false` means a stale process
on 4197/1420 is a hard failure rather than a silent reuse.

**Finding E-01 (HIGH) - the gate now has a hard external port dependency, and no preflight.**
Because T-01 established that `test:e2e` is stage 6 of `test:vantrilex`, and `reuseExistingServer:
false`, `npm run test:vantrilex` **fails on any machine where an installed Voxaura build is running**
(4096/4097 held) or where 4197/1420 are occupied. There is no preflight check, no skip, and no distinct
error message. `AGENTS.md:148` and `AGENTS.md:58` both document the manual requirement ("Stop the
running voxaura.exe ... before E2E"), which means the gate's green/red state now depends on
machine state documented only outside the repo. **This is the single biggest operational change in the
gate and deserves a preflight script.**

**Finding E-02 (MEDIUM) - disconnect.spec.ts mutates shared global state and self-heals by
convention.** It calls `POST /kill`, which closes the singleton `UiServer`, and then `POST /revive`,
which constructs a **new** `UiServer` and re-wires `onCommand`/`onAudio` on it. The comment says
*"Revive for file-order independence (shared stub daemon per run)."* With `workers: 1` and
`fullyParallel: false` this works, but the entire suite's correctness now rests on two config
invariants. A future `fullyParallel: true` or `workers: 2` would break it in a way that looks like a
product bug. **A comment at the webServer level, not inside one spec, would be the right place.**

**Finding E-03 (LOW) - bargein.spec.ts has a 25-second wall-clock loop inside a retries: 0 suite.** It
polls up to 25 s waiting for the abort count to increase, with a 15 s poll for audio frames. It is the
slowest and most timing-sensitive spec in the suite and has no retry budget. It also asserts on a value
captured *after* the loop, so it cannot pass vacuously - but a loaded machine could make it flaky. Its
own comment concedes the boundary: *"Ducking/energy gating is unit-proven (vad.test.ts); this proves
the full renderer to WS-4097 to stub path."*

**Finding E-04 (MEDIUM) - the specs assert on hardcoded Arabic UI strings.** Roughly 20 assertions
match literal Arabic text. This is a deliberate and correct product constraint (Arabic/RTL is the
mandate) but it means any copy edit breaks E2E. `portals.spec.ts` already documents one instance of
exactly that failure, quoted verbatim in 7.7.


---

## 7. DISCREPANCIES: measured vs AGENTS.md / docs / CHANGELOG.md / README.md

All quotes below are verbatim from disk. Note that `AGENTS.md` was **edited during this audit** (a
system-update arrived mid-session at lines 53-55). I record both the pre-edit and post-edit text,
because the pre-edit text is itself the most interesting finding in this section.

### 7.1 AGENTS.md - the E2E-in-gate claim was wrong, and has since been corrected mid-audit

**Before (stale, contradicted by package.json):**
> `- \`test:vantrilex\` is **typecheck -> eslint -> oxlint -> root vitest -> desktop vitest**. E2E is **not** part of it.`

**After (current AGENTS.md:53, correct):**
> `- \`test:vantrilex\` is **typecheck -> eslint -> oxlint -> root vitest -> desktop vitest -> \`npm run test:e2e\`**. E2E **is** part of it (\`package.json:24\`). An earlier version of this file claimed otherwise and was wrong. It needs ports 4096/4097/4197 free, so it fails with \`EADDRINUSE\` if an installed build is running.`

**Verdict: the doc has been fixed to match the code. The code was always right.** Independent
corroboration that this was a real historical error, from the changelog of the fix -
`CHANGELOG.md:21-26`, verbatim:

> `### E2E is inside \`test:vantrilex\` now`
>
> `\`chain-nemotron\` was renamed by the Inkling switch. The unit test was updated and`
> `the E2E spec was not, so it stayed green purely because E2E was not run - the`
> `gate reported success over a suite containing a stale assertion. The gate now ends`
> `with it. A documented exclusion is not a fix; running it is.`

**But the new AGENTS.md:54 counts remain unverifiable and are now contradicted by README:**

> `- Current counts (keep these moving up, never down): root **568 passed + 0 skipped** (46 files) - desktop **153** (24 files) - \`cargo test\` **27** - E2E **18** across 14 specs. \`npm run test:vantrilex\` exits 0 on all of these. Measured 2026-09-28; a 7-agent forensic audit independently re-derived the root and desktop numbers from execution and matched them.`

- **File counts: 46 root and 24 desktop - both CONFIRMED by disk.** (24 = 12 `.ts` + 12 `.tsx`; a
  `.ts`-only search would report 12 and miss half.)
- **Test counts: 568 root vs my 572 static derivation; 153 desktop vs my 151. Both UNVERIFIED.** The
  568/153 pair is also inconsistent with `README.md:332-333`, which says 572/153 for the same suites.
  Two authoritative-looking docs disagree on the root number by 4.
- The claim that "a 7-agent forensic audit independently re-derived the root and desktop numbers **from
  execution** and matched them" is **contradicted by at least this auditor's evidence**: no auditor in
  this session has a shell (section 0), so no number in this session was derived from execution. I
  record this because it is exactly the "confident prose is not evidence" pattern `AGENTS.md` itself
  warns about at line 4: *"**Trust code, not prose.**"*

### 7.2 CHANGELOG.md:183-185 (v0.7.0) - a historical claim

> `typecheck 0 - eslint 0 warnings - oxlint 8 advisory - root 498 passed + 0 skipped`
> `(39 files) - desktop 149 (23 files) - \`cargo test\` 26 - E2E 18 across 14 specs -`
> `\`test:vantrilex\` exit 0.`

The current `AGENTS.md` says the root count went *"491 -> 498 ... then 525 -> 568 when
`src/knowledge/` landed."* That agrees with 498 at v0.7.0, but disk has **46** root test files, so 39
is historical. The current `AGENTS.md`'s `cargo test 27` is up from this entry's 26, and **27 is**
consistent with disk.

### 7.3 CHANGELOG.md:66-68 (newest release, v0.7.1) - a FOURTH distinct root/desktop pair

> `\`test:vantrilex\` exit 0 **with E2E included** - oxlint 8/8 baseline - root **509`
> `passed + 0 skipped** (41 files) - desktop **149** (23 files) - E2E **18** across 14`
> `specs - \`cargo test\` **27** - secret scan clean.`

Root **509**/41 files, desktop **149**/23 files. This is the release immediately preceding the current
`AGENTS.md` numbers, yet neither the file counts (41, 23) nor the test counts (509, 149) match disk
(46 files, 572 decls; 24 files, 151 executed). **Six mutually exclusive root totals are now asserted
across the repo: 220, 309, 498, 509, 568, 572.** A changelog is a historical record so old entries
going stale is expected - but the *newest* entry is stale relative to the tree it shipped, and it is
the entry a reader would trust most.

### 7.4 README.md - internally contradictory, in the same file

**README.md:332-333 (the "What this repository does measure" table) - matches my derivation closely:**
> `| Root unit tests | **572 passing / 46 files** | \`npx vitest run\` |`
> `| Desktop unit tests | **153 passing / 24 files** | \`cd apps/desktop && npx vitest run\` |`

572/46 - **exactly** my static derivation for root. Strong signal that 572 is the correct current figure
and `AGENTS.md`'s 568 is the error. 153/24 vs my 151 is off by 2, unexplained: I could not find a
third `.each`, a loop-registered test, or a conditional registration that would account for it.
**UNVERIFIED.**

**README.md:366 - flatly contradicts line 332 in the same file:**
> `- **Quality gates** (\`npm run test:vantrilex\` + \`test:e2e\`): tsc, eslint,`
> `  oxlint, 309 unit tests (220 root + 89 desktop), 15 Playwright E2E - all green, exit 0.`

**README.md:431-432:**
> `Verification pipeline: \`doctor\` -> \`test:vantrilex\` (309 green) -> \`test:e2e\`
> `(15/15 green) -> checkpoint ledger row. Any red refuses the commit.`

**README.md:443-444 (the "Gate inventory" table):**
> `| Unit | vitest root (220) + desktop (89) | behavior at seams |`
> `| E2E | Playwright 15/15 | shell boots, bridge live, commands round-trip, barge-in aborts |`

**README.md:365 also describes the gate wrongly:**
> `- **Quality gates** (\`npm run test:vantrilex\` + \`test:e2e\`)`

- but `test:e2e` is *inside* `test:vantrilex` (`package.json:23`), so this line still describes the
old, pre-v0.7.1 gate.

**Forensic detail worth recording:** `desktop (89)` is *exactly* my `.ts`-only desktop count
(`apps/desktop/**/*.test.ts` = 12 files, 89 declarations). So the README body was written when only
the `.ts` desktop tests existed, before the 12 `.tsx` renderer tests landed. **The README body is
describing a tree several test-generations old and was never updated when line 332 was.**

**README.md:9 - the badge is stale on both numbers:**
> `<img src="https://img.shields.io/badge/tests-583%20unit%20%2B%2026%20rust-brightgreen" alt="Tests" />`

`26 rust` contradicts **27** `#[test]` on disk, `AGENTS.md:54`'s `27`, `README.md:335`'s `27`, and
`CHANGELOG.md:68`'s `27`. The badge is the first thing a visitor reads. (`583` is a sixth distinct
unit-test total; I could not decompose it and did not guess.)

### 7.5 AGENTS.md:109 - archive file count

> `deleted**, to \`.opencode/_archive/dead-code-phase1/\` - 44 files including their tests and`

Disk (`directory_tree` on the archive): **77 files** - 33 `.md`, **42 `.ts`**, 2 `.json`; of the 42,
**14 are test files**. Neither 77 nor 42 equals 44. The load-bearing part of the claim - that 14 test
files are quarantined and never run - **is confirmed**.

### 7.6 Confirmed-correct claims (checked, not assumed)

| Claim | Source | Status |
|---|---|---|
| `LIVE production modules : 51` | `AGENTS.md` | **CONFIRMED** - `src/**/*.ts` minus tests = 51 files |
| E2E = 18 across 14 specs | `AGENTS.md`, `CHANGELOG`, `README:334` | **CONSISTENT** with 18 test() / 14 files |
| `cargo test` 27 | `AGENTS.md`, `README:335`, `CHANGELOG:68` | **CONSISTENT** with 27 #[test] |
| oxlint baseline 8 | `README:336`, `CHANGELOG:66` | **CONFIRMED** - `scripts/lint-baseline.json` = `8` |
| `No test runner covers main.rs token generation` | `AGENTS.md:55` | **CONFIRMED** - xorshift64* at main.rs:460-476,501-517, no #[test] in that range |
| E2E = 15/15 | `README:366,432,444` | **REFUTED** - 18 test() in 14 spec files on disk |
| Root = 220 | `README:366,443` | **REFUTED** - 572 declarations |
| Desktop = 89 | `README:366,443` | **REFUTED** - 145 declarations / 151 executed |
| root vitest 39 files | `AGENTS.md` (pre-edit), `CHANGELOG:184` | **REFUTED** - 46 files |
| desktop vitest 23 files | `AGENTS.md` (pre-edit), `CHANGELOG:67,184` | **REFUTED** - 24 files |
| `cargo test` 26 | `CHANGELOG:184,248`, `README:9` | **REFUTED** - 27 |
| `E2E is not part of it` | `AGENTS.md` (pre-edit) | **REFUTED** by `package.json:23` |
| `15 Playwright E2E` in the gate description | `README:365` | **REFUTED** - 18 |
| oxlint absent from node_modules | `CHANGELOG:58-59`, `lint-baseline.mjs:22-25` | **REFUTED** - binary present |
| archive is 44 files | `AGENTS.md:109` | **REFUTED** - 42 .ts / 77 total |

### 7.7 portals.spec.ts:19-24 - the best surviving evidence of a real gate failure

Verbatim, and worth preserving because it documents a bug class that the current gate can no longer
hide:

> `// Anchored on \`chain-list\`, the container, not a per-agent testid. This`
> `// asserted \`chain-nemotron\` until dc84866 moved the coordinator role to`
> `// Inkling and the id became \`chain-inkling-coordinator\`; the unit test was`
> `// updated with that change and this E2E spec was not, so it went red only`
> `// when E2E was run outside the \`test:vantrilex\` gate. A roster change should`
> `// not be able to break this again, so assert the list and that it is`
> `// populated rather than pinning one agent's name.`

This is first-hand corroboration of T-01 from inside the codebase, and it independently dates the
`package.json` change to after this comment was written.

---

## 8. FINDINGS INDEX

| ID | Sev | Finding |
|---|---|---|
| section 0 | **BLOCKER** | No shell/process tool in the auditor's toolset. All 7 required commands **UNVERIFIED**. Not one number in this report is measured. |
| T-01 | HIGH | E2E **is** stage 6 of `test:vantrilex` (`package.json:23`). The pre-edit `AGENTS.md` said it was not, and was wrong. `portals.spec.ts:19-24` and `CHANGELOG.md:21-26` both corroborate. |
| T-04 | HIGH | Root `tsconfig.json` `exclude: ["**/*.test.ts"]` - all 46 root test files are type-checked by nothing. |
| T-05 | HIGH | The gate never runs `tsc` against `apps/desktop`. The strict desktop tsconfig is enforced by no stage. Renderer + 24 test files unchecked. |
| E-01 | HIGH | Gate now hard-depends on ports 4096/4097/4197 being free, with `reuseExistingServer: false` and no preflight. EADDRINUSE is indistinguishable from a real regression. |
| L-03 | HIGH | `lint-baseline.mjs:22-25` + `CHANGELOG.md:58-59`: "oxlint ... is absent from node_modules" is **false** - `node_modules/.bin/oxlint.cmd` exists. Also cites vitest 2.x (actual 4.1.11) and `^1.0.0` (actual exact 1.85.0). |
| T-03 | MED | 14 quarantined test files never run; archive is 77 files / 42 `.ts`, not the documented 44. |
| T-06 | MED | 14 Playwright specs + `playwright.config.ts` are type-checked by nothing. |
| V-01 | MED | `expect.hasAssertions`/`expect.assertions`: **0 uses in 717 tests.** Async-vacuity unguarded in an async-heavy suite. |
| L-01 | MED | The oxlint ratchet is **bidirectional** - fixing a warning *fails* the gate until the JSON baseline is hand-edited. |
| L-02 | MED | The ratchet parses a hardcoded oxlint summary string from **stdout only**; unparseable means `exit 2`. Cannot verify which happens. |
| L-05 | MED | Neither ESLint nor oxlint ignores `.opencode/**`; 42 quarantined `.ts` files may still be linted at `--max-warnings 0`. |
| R-01 | MED | `main.rs:1155` shells out to `tasklist` - the only environment-dependent Rust test. |
| E-02 | MED | `disconnect.spec.ts` kills and revives the singleton stub; suite correctness depends on `workers:1` + `fullyParallel:false`. |
| E-04 | MED | ~20 E2E assertions match hardcoded Arabic strings; any copy edit breaks the suite. |
| T-02 | LOW | `test/**/*.test.ts` and `bench/**/*.bench.ts` globs match nothing - both dirs absent. |
| L-04 | LOW | `ROOT` via `URL.pathname` is percent-encoded; breaks on a path with a space or non-ASCII. Use `fileURLToPath`. |
| V-02 | LOW | 14 tests assert on source **text** via `readFileSync`, not runtime behaviour. |
| V-03 | LOW | 30 wiring tests overlap the stronger `sidecar-safety.test.ts` graph walk. |
| E-03 | LOW | 25 s wall-clock loop in `bargein.spec.ts` under `retries: 0`. |
| - | INFO | `apps/desktop` `"lint:ox": "oxlint"` is invoked by no gate stage. |
| - | INFO | `eslint.config.js`'s `no-explicit-any: off` override matches `**/*.test.ts` only - the 12 `.test.tsx` files get no such relaxation. |
| - | INFO | `BASELINE = 8` in `lint-baseline.mjs` is dead code while `lint-baseline.json` exists (it does, also 8). |
| - | INFO | `README.md` self-contradicts (572/153 at line 332 vs 220+89 at lines 366/443/444); badge says 583+26. |
| - | INFO | `docs/10-CHECKPOINT.md` is 748 lines; its gate ledger is historical and carries no current test totals. |

### Vacuous tests found: ZERO

Tautologies, literal-vs-literal assertions, empty bodies, `skip`/`todo`/`only`/`fails`, and
assertion-masking `?? 0` fallbacks: all clean across 717 unit tests, 18 E2E tests and 27 Rust tests.
Four candidate findings were investigated and **all four disproved** as artefacts of my own lexer
(section 4.1).

---

## 9. WHAT IT WOULD TAKE TO CLOSE THE UNVERIFIED COLUMN

Each of these is a one-liner that a session **with** a shell could run. I am not running them; I have
no shell.

```powershell
# 1. root suite alone - capture UNPIPED (AGENTS.md: pipelines lie about exit codes)
npx vitest run --reporter=dot *> "$env:TEMP\opencode\root.txt"; $LASTEXITCODE
# 2. desktop suite alone
cd apps/desktop; npx vitest run --reporter=dot *> "$env:TEMP\opencode\desktop.txt"; $LASTEXITCODE
# 3. the full gate, unpiped
cd ..\..; npm run test:vantrilex *> "$env:TEMP\opencode\gate.txt"; $LASTEXITCODE
# 4. is the 80% coverage threshold real, and what is the number?
npx vitest run --coverage
# 5. the ratchet: does the summary parse, and does the guard path work?
node scripts/lint-baseline.mjs
# 6. does ESLint 9 flat config descend into .opencode/ ?  (L-05)
npx eslint . --max-warnings 0 --debug 2>&1 | Select-String "_archive"
# 7. cargo test list - enumerates WITHOUT executing, so no MSVC link step needed
cd apps\desktop\src-tauri; cargo test -- --list
# 8. E2E only after confirming 4096/4097/4197/1420 are free
Get-NetTCPConnection -State Listen -LocalPort 4096,4097,4197,1420 -ErrorAction SilentlyContinue
cd ..; npx playwright test --reporter=list
```

Step 7's `-- --list` enumerates tests **without executing them**, so it confirms the 27 count cheaply
and does not need the VsDevCmd.bat step. Step 8 must not be run while an installed build is up, or the
stub cannot bind 4097/4197.

---

*Audit produced by Forensic Auditor 5/7 under a zero-trust-for-docs mandate. Facts derived from
`package.json`, `tsconfig.json` x2, `vitest.config.ts` x2, `playwright.config.ts`,
`eslint.config.js`, `.oxlintrc.json`, `scripts/lint-baseline.mjs`, `scripts/lint-baseline.json`,
all 70 unit-test files, all 14 E2E specs, `stub-daemon.mjs`, `Cargo.toml`, `src-tauri/src/main.rs`,
`apps/desktop/test-results/.last-run.json`, and the archive tree - plus verbatim comparison against
`AGENTS.md`, `README.md`, `CHANGELOG.md` and `docs/10-CHECKPOINT.md`. No file other than this report
was created, modified or deleted. No command was executed, because no such tool exists in this
auditor's toolset.*
