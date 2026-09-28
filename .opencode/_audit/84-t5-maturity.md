# T5 — Maturity scorecard, industry practice, and roadmap v0.8.0 → v1.0.0

**Track:** 5 of 5 · **Repo:** `O:\opencode-Vantrilex` · **Date:** 2026-09-28
**Status:** research only. No code modified. No commit, no push.
**Method:** zero trust for docs. Every code claim carries a `file:line` or a command
that reproduces it. Anything I could not execute is marked **UNVERIFIED**.

---

## 0. What I actually ran (the evidence base)

| Command | Result |
|---|---|
| `npx vitest run` (root) | **656 passed / 53 files / 0 skipped**, 9.07 s |
| `cd apps/desktop && npx vitest run` | **142 passed / 24 files**, 7.86 s |
| `cargo test --no-default-features` | **48 passed / 0 failed**, 2.33 s (`s2_secret_tests` + `phase2_tests`) |
| static count of `test(` across `apps/desktop/e2e/*.spec.ts` | **18 across 14 specs** — matches the claimed number; Playwright itself **not** run by me (**UNVERIFIED**) |
| `npm run typecheck:tests` | exit **0** |
| `npm ls pino` | `pino@9.14.0 extraneous` |
| independent import walk from `src/daemon.ts` + `src/cli.ts` (static **and** dynamic, comments NOT stripped) | **LIVE 51 / DEAD 7 / unresolved 0** |
| `Get-ChildItem .github` at repo root | **does not exist** — no CI |

The E2E suite is not executed in this report because it needs ports 4096/4097/4197
and the orchestrator owns the port lock. The 18 figure is a *declaration* count, not a
run count — a distinction `.opencode/_audit/05-tests.md:140-147` already makes and is
correct to make.

---

# PART 1 — HONEST MATURITY SCORECARD

## Scores

| # | Dimension | Score | One-line verdict |
|---|---|---|---|
| 1 | Test coverage & gate integrity | **3 / 5** | Large, honest, chained, ratcheted unit discipline. Zero coverage measurement. The gate stops at `dist/` modules with mocked I/O and cannot see either defect class that has actually shipped. |
| 2 | Observability | **2 / 5** | A real, redacted, rotating JSONL bus exists and is wired. There is no crash telemetry at all, no structured logging in the daemon, no correlation ids, and 2 of 6 schema subsystems have never been produced by anything. |
| 3 | Build & release engineering | **2 / 5** | The runbook is genuinely excellent. There is no CI, the version bump is a hand-run script with a wrong assertion, the lockfile still declares a removed dependency, and the "preflight" tool cannot fail. |
| 4 | Security posture | **2 / 5** | The keyring is well built. The *review process* is the defect: a non-CSPRNG and a dead redactor both shipped and both survived for multiple releases. |
| 5 | Architecture & modularity | **4 / 5** | The best dimension by a distance. Zero-dependency RFC-6455 server, explicit composition root, disciplined ESM. Deducted for 7 deliberately quarantined modules that AGENTS.md claims do not exist, and for a knowledge layer whose own index admits it is off the product path. |
| 6 | Documentation integrity | **1 / 5** | A net liability. Fabricated figures still ship in an SVG; AGENTS.md — the operating contract every agent reads — is stale on six load-bearing facts including a fixed security defect presented as open. |

---

## 1. Test coverage & gate integrity — 3 / 5

### What is true and good

- `package.json:24` chains six stages: `typecheck && typecheck:tests && lint && lint:ox && test && test:desktop && test:e2e`. E2E **is** inside it. `scripts/lint-baseline.mjs:17` pins `BASELINE = 8` and `scripts/lint-baseline.json` contains `8`, and the script fails in **both** directions (`:106-127`) — a genuine two-sided ratchet, not a `--max-warnings` impersonation.
- `scripts/lint-baseline.mjs:37-63` **refuses to run on an ambient global oxlint** and exits 1 with an explanation. That is the correct response to finding F-02 and it is rare discipline.
- `src/policy/sidecar-safety.test.ts:26-32` pins the v0.6.0 failure class as a *graph* invariant, with the comment "A graph invariant is the only thing that survives the next person's refactor."
- `src/policy/telemetry-wired.test.ts:8-12` exists specifically because the diagnostics bus "was fully built, schema-validated and unit tested, and then never called by anything."
- `src/policy/laya-sidecar-safety.test.ts:226` pins that `laya-engine.ts` is *never statically reachable* from `daemon.ts`.

The team has clearly learned to write guard tests for its own failure modes. That is
the single most valuable thing in this repo and it deserves saying plainly.

### What the gate proves

- 656 root + 142 desktop + 48 cargo + 18 E2E assertions execute and pass **today, on this machine**.
- `tsc --noEmit` clean for production sources; `tsc -p tsconfig.tests.json` clean for test sources (**0 errors**, measured — the "62 errors" in `AGENTS.md:62` is history, not current).
- ESLint `--max-warnings 0` clean.
- The oxlint warning count is exactly at its pinned baseline, and the pin moves both ways.
- E2E is the **only** suite that exercises compiled `dist/` output (`apps/desktop/package.json` `test:e2e` = `npm run build --prefix ../.. && playwright test`), covering the real `UiServer`, the real WS-4097 frame schemas, and the real FR-12 router with its park-until-confirm gate.
- The daemon's import graph contains no static edge to a native package, so a missing native binary cannot take the daemon down at load time.

### What the gate does NOT prove — proven from the stub source

`apps/desktop/e2e/stub-daemon.mjs` is **not** the product. Reading it end to end:

- **Real:** `UiServer` imported from `dist/ipc/ui-server.js` (line 4), `createCommandHandler` from `dist/orchestrator/command-router.js` (line 5). Bound to real port 4097 (line 145).
- **Fake — the `ServeClient`:** lines 17-25. `setSessionAgent`, `setSessionModel`, `toggleSessionSkill` all `async () => ({})`. `execSessionShell` (lines 21-24) pushes to an in-memory array and returns `{}`. **No HTTP, no auth, no OpenCode, no SQLite, no SSE.**
- **Fake — the keyring:** line 27. `saveKeys: { saveKeys: async () => ({}) }`. **No vault, no AES-GCM, no `machine.key`, no disk I/O.**
- **Fake — the narrator:** lines 33-42. `narratorLineFor()` returns four hardcoded Arabic strings. The file's own comment (lines 29-32) concedes it: *"The stub cannot call a model, so it stands in with a representative MODEL-WRITTEN line."*
- **Fake — a control plane that does not exist in production:** lines 58-144, `/fire`, `/commands`, `/shells`, `/audio`, `/audio/reset`, `/audio-down`, `/notice`, `/voice`, `/inventory`, `/agents`, `/kill`, `/revive`, on port 4197 with `Access-Control-Allow-Origin: '*'` (line 61).
- **Absent entirely:** `src/daemon.ts` is never started. `main.rs` never runs. The Job Object never runs. Tauri never runs — `playwright.config.ts:26-32` starts `npm run dev:web` (Vite only). Port 4096 is never bound or probed. No OpenRouter, no Groq, no Fish. **No audio is ever transcribed.**
- The stub also fakes the Tauri IPC surface the renderer depends on, so an E2E pass is evidence about the renderer plus two production modules, and about nothing else.

Concretely, the gate proves **nothing at all** about the three requirements `AGENTS.md:94-98` says were *"found by a live call, not by reading docs"*: the mandatory `User-Agent: opencode/1.0 (Voxaura)`, the mandatory `reasoning: {effort:'none'}`, and the load-bearing `json_schema`. Only `node dist/cli.js live` and `scripts/live_console_test.ts` touch real APIs, and neither is in `package.json:24`.

### Four gate defects that are not yet fixed

1. **`scripts/packaging-preflight.mjs` cannot fail.** It prints a readiness matrix and its last statement is a `console.log` — there is no `process.exit(1)` anywhere in the file. It is also not referenced by any script in `package.json:16-31`. It is a diagnostic, not a gate, but it is named `preflight` and its output reads like a verdict. This is the exact shape of finding F-02: *a thing that appears to enforce something and enforces nothing.*
2. **The gate has an undocumented hard external dependency.** `playwright.config.ts:28` and `:31` set `reuseExistingServer: false`, so `npm run test:vantrilex` fails with `EADDRINUSE` on any machine where an installed build holds 4096/4097. The requirement to stop the app is documented only in prose (`AGENTS.md:53`, `AGENTS.md:74`) and there is no preflight check inside the gate.
3. **Coverage has never been measured, and the fake floor is gone.** `vitest.config.ts` now has **no `coverage` block at all** — lines 5-27 are a 24-line comment explaining why, followed by `include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'bench/**/*.bench.ts']`. Two of those three globs point at trees that do not exist (no root `test/`, no `bench/`). So the correct conclusion — "no floor, because no number" — is also still not enforced as a *measurement task*. It is a comment, and comments do not ratchet.
4. **No CI.** There is no `.github/` at the repo root. Every gate in this report was executed by me, in this session, by hand.

### Score rationale

3, not 4, because the number of tests and the strength of the guard-test culture are not the same axis as "can this gate catch a broken release". It demonstrably cannot, twice over: v0.6.0 passed every gate and could not boot (`AGENTS.md:166`, and `src/policy/sidecar-safety.test.ts:9-10` records it), and the 25-second first-paint bug shipped after that. Not 2, because the discipline is real, the ratchets are real, and the policy-test files are the kind of thing most teams never write.

---

## 2. Observability — 2 / 5

### The `SubsystemSchema`, who produces each value, and who is dead

`src/telemetry/writer.ts:37`:

```
const SubsystemSchema = z.enum(['STT', 'BRAIN', 'TTS', 'LAYA', 'LAUNCHER', 'KEYRING']);
```

| Value | Producer | Status |
|---|---|---|
| `STT` | `src/daemon.ts:566, 574, 747` | **LIVE** — OK at :566, ERROR at :574, DEGRADED/`STT_TIMEOUT` at :747 |
| `BRAIN` | `src/daemon.ts:602, 617, 624, 672, 710, 722, 731` | **LIVE** — DEGRADED/CONFIG_INVALID at :602, DEGRADED/BRAIN_TIMEOUT at :710, OK at :617/:624/:722, ERROR/BRAIN_FAILED at :731 |
| `TTS` | `src/daemon.ts:780, 783` | **LIVE** — OK at :780, ERROR/`TTS_FAILED` at :783 |
| `KEYRING` | `src/daemon.ts:809` | **LIVE** — DEGRADED/`KEYS_MISSING`, fired from `rebuildVoice()` at :801-818. Note: this is the only `KEYRING` producer and it fires only on the keyless branch. |
| `LAYA` | **nothing.** Only references are `writer.ts:37` (the union), `src/policy/laya-sidecar-safety.test.ts:302` (asserts the *string* appears in some source file), and `src/ipc/ui-server.ts:389` (`layaReady: false` hardcoded, with the comment at :382-384 that the model is 294 MB and `layaLoad` has zero consumers). | **DEAD PRODUCER** |
| `LAUNCHER` | **nothing.** `src/launcher/index.ts:1` exports `probeHealth`, and it *is* live — called at `src/daemon.ts:183` and `src/cli.ts:35`. But no call site ever emits `subsystem: 'LAUNCHER'`. A live health probe that records nothing. | **DEAD PRODUCER** |

**And the guard does not catch this.** `src/policy/telemetry-wired.test.ts:28` iterates `['STT', 'BRAIN', 'TTS']` only. It does not assert `KEYRING`, and it does not assert that *every* union member has a producer. So the schema can grow a member with no producer, permanently, with the guard green. `LAYA` is the standing example: the repo quarantined the feature and left the telemetry union member behind. `LAUNCHER` is worse, because the feature is alive.

### Crash telemetry: there is none. Anywhere.

- **Node side:** grep for `uncaughtException` and `unhandledRejection` across `src/**/*.ts` returns **zero hits**. An unhandled rejection in the daemon produces Node's default stderr line and nothing structured. Nothing lands in `voice-runtime.jsonl`.
- **Rust side:** `apps/desktop/src-tauri/src/main.rs` is 2,903 lines and contains **no** `std::panic::set_hook`, **no** `catch_unwind`, **no** `tracing`, and **no** `log::` macro. The only `panic!` calls are inside `#[cfg(test)]` (lines 1706, 1719, 1765, 1776, 1807, 1840, 1859, 1871, 2076, 2105, 2697). A panic in the supervisor kills the process with a stderr line that goes nowhere durable, because the supervisor's own stdout/stderr are not captured by anything.
- `apps/desktop/src-tauri/Cargo.toml` has exactly one observability-relevant dependency: `getrandom = "0.3"` at line 20. There is no crash crate, no logging crate.

### Structured logging: exists, and is 95% dead

`src/common/logger.ts:266` exports `createLogger`. Its production callers, exhaustively:

- `src/telemetry/writer.ts:101` — the fallback logger for a **flush failure only**, and the flush-failure `logger.warn` at `writer.ts:151` fires only when `appendFileSync` throws.

That is it. `src/common/logger.ts` is imported by exactly two production modules: `src/common/index.ts:7` (re-export, and `src/cli.ts:7` imports that barrel) and `src/telemetry/writer.ts:3`. **`createLogger` has one production caller in the entire codebase.**

Consequence: the daemon has **no structured logging at all**. Its diagnostics are:

- `ui.notice(...)` frames — a WS-4097 render, not a log (`src/daemon.ts:252, 375, 421, 584, 601, 607, 613, 633, 738, 754, 789, 816`).
- One `console.error` at `src/daemon.ts:257`, raw `err.message`, unredacted, landing in `daemon-stdout.log`.
- `console.log` in `src/cli.ts` — 21 sites, human-facing CLI output, which is correct and not a defect.

So: **the whole of `voice-runtime.jsonl` is structured; the whole of `daemon.log`, `daemon-stdout.log`, `supervisor.log` and `opencode.log` is unstructured, and those are the files an operator opens first.** The three files cannot be joined, because there is no correlation id in any of them.

### Tracing: none.

No span ids, no trace context, no propagation. The only identity in the system is `sessionId`, which is `activeSession ?? 'none'` (`src/daemon.ts:457`) — so a user who reports "it broke at 14:03" cannot be mapped to a session unless they remember which session they were in.

### Is the redaction wired into the telemetry path, or only the logger?

**Both, and they are different things.** This distinction matters and the recent wave got it right:

- **Telemetry path:** `src/telemetry/writer.ts:113` calls `redactObject(...)` on the row **structurally, before `JSON.stringify`**. The comment at :106-112 is explicit that `sessionId` is `z.string().min(1)` and could carry key material if a caller passed an error-derived id. So the telemetry bus is protected. This is good work.
- **Logger:** `src/common/logger.ts:277` calls `redactSecrets(args)` on every argument before rendering, and `:283` calls `redactObject(bindings)`. Good.
- **Neither covers the channel users actually see.** `src/ipc/ui-server.ts:210-211`:

  ```ts
  notice(code: string, detail: string, level: 'info'|'warn'|'error' = 'warn'): number {
    return this.broadcastFrame(NoticeFrameSchema.parse({ type: 'notice', seq: 0, code, detail, level }));
  }
  ```

  **No redaction.** And `src/daemon.ts:584`, `:738` and `:789` interpolate a raw provider error into `detail`:

  ```ts
  ui.notice('brain-failed', `تعذّر توليد الرد: ${err instanceof Error ? err.message : 'خطأ'}`, 'error');
  ```

  So the redactor that was just written, wired, and unit-tested protects a JSONL file, while a provider's `err.message` travels **unredacted into the HUD**, where it is rendered in Arabic and is one screenshot away from a bug report. Whether Groq / Fish / OpenRouter ever echo an `Authorization` header in an error body is **UNVERIFIED** — I did not make a failing call — but the path is real, the guard is absent, and the cost of closing it is one function call plus one test. `src/daemon.ts:257`'s `console.error` is the same gap into `daemon-stdout.log`.

### Two more concrete defects

- **`main.rs:525-539` `log_line` is a read-modify-write of the whole file.** `fs::read_to_string(&path)` then `fs::write(&path, existing)` on every call, across 30 call sites. Two threads logging concurrently lose one line, and line *N* costs O(file size). It is also, uniquely among the runtime files, **not** covered by `restrict_to_owner` (comment at :521-524 says so explicitly, and that reasoning is correct — it carries no credential).
- **Telemetry rotation is single-generation.** `writer.ts:161-170` renames to `.1` on overflow, so you keep at most two files. For a bus whose purpose is post-hoc diagnosis, a crash that fills the file destroys the earlier evidence. `maxBytes` defaults to 10 MiB (`:100`), which at measured latencies is a lot of rows, so this is a latent problem rather than an active one.

### Score rationale

2, not 3, because "observability" in the sense an operator means it — *when it broke and why* — is not served. It answers "is it failing?" and "how slow is it?" from one file, and nothing else answers "what happened to this person?". 2, not 1, because the diagnostics bus is real, is wired, is redacted correctly, is schema-validated at the boundary (`writer.ts:112` `RecordInputSchema.parse` throws on bad input), rotates, logs its own failures, and is flushed on shutdown (`src/daemon.ts:869` inside `stop()`). That is more than most projects this size will ever have.

---

## 3. Build & release engineering — 2 / 5

### The release runbook (from `AGENTS.md:157-166`) — and what is wrong with executing it by hand

The runbook is genuinely one of the better artefacts in the repo. It prescribes exact file targets, an explicit ordering, SHA-256 recording, a stop-the-app prerequisite, **commit before tag** (because `gh release create` auto-tags at whatever HEAD is at that moment), and a `git rev-list -n 1 <tag>` verification. Step 6 is the important one:

> `AGENTS.md:166` — "**Only an installed build proves anything.** After building, `Voxaura_<v>_x64-setup.exe /S`, launch it, and confirm 4096+4097 bound with `daemon.log` at 0 bytes. v0.6.0 passed every gate and could not start at all."

That is the correct lesson, correctly learned, written down. **It is also a step a human must remember to perform**, and it is the only step that would have caught v0.6.0.

### The version-bump guard is wrong, and its failure mode is the one that already happened

`AGENTS.md:157` prescribes `apps/desktop/package-lock.json` (root `packages[""].version`) as a bump target and instructs: *"Do the edits in Node with an exact-occurrence assertion per file."*

The assertion cannot be satisfied. I measured it: `apps/desktop/package-lock.json` contains `"version": "0.7.2"` at **line 3 and line 9**. An exact-occurrence assertion of `1` fails on a file that is *already correct*. The operator's only responses are to weaken the assertion (losing the guard everywhere) or to special-case the lock (losing it for that file). Either way the next bump is unguarded.

`AGENTS.md:157` also records that this hazard already bit: *"The 0.6.1 bump also **missed** the guide, the hero banner and the lock file."* So this is a **recurrence**, documented, still unguarded. And I can confirm no guard exists: `scripts/` contains only `generate-whiteboard-assets.mjs`, `key-report.mjs`, `lint-baseline.mjs`, `lint-baseline.json`, `live_console_test.ts`, `packaging-preflight.mjs`, `provision-sidecar.mjs`. There is no bump script.

For the record, the current version metadata **is** consistent — I verified all eight: root `package.json:3`, `apps/desktop/package.json:3`, root `package-lock.json:3` and `:9`, `apps/desktop/package-lock.json:3` and `:9`, `tauri.conf.json:4`, `Cargo.toml:3`, `scripts/provision-sidecar.mjs:47`, `README.md:12`, `README.ar.md:13`, `docs/00-PROJECT-GUIDE.md:17`, `assets/hero-banner.svg` (`v0.7.2`). That is 13 occurrences across 9 files, hand-maintained.

### A live manifest defect, right now

`package.json:32-37` no longer declares `pino`. `package-lock.json:15` **still declares `"pino": "^9.0.0"`** in the root package's dependencies, and resolves 12 pino-family packages: `pino` (:3343), `@pinojs/redact` (:1033), `atomic-sleep` (:1956), `on-exit-leak-free` (:3152), `pino-abstract-transport` (:3365), `pino-std-serializers` (:3374), `process-warning` (:3419), `quick-format-unescaped` (:3445), `real-require` (:3451), `safe-stable-stringify` (:3516), `sonic-boom` (:3582), `thread-stream` (:3650).

`npm ls pino` returns `pino@9.14.0 extraneous`.

The Wave-2 fix was **correct and complete for the thing that mattered**: `src/common/logger.ts` no longer imports pino, so pino is not in the resolved runtime graph — `.opencode/_audit/40-w2b-redaction.md` proves this with an ESM resolve trace, and I independently confirm `grep '^import' dist/common/logger.js` is empty. The **residue was not cleaned**, and the sidecar manifest *was* cleaned (`scripts/provision-sidecar.mjs:57-61` is now `groq-sdk`, `lru-cache`, `zod`). So the installer payload is correct and the root tree is carrying 12 extraneous packages.

Whether `npm ci` hard-fails or silently installs them on this lock/package.json skew is **UNVERIFIED** — I did not run it, because it would delete `node_modules` on the machine running the gate.

### Score rationale

2, not 1, because the runbook exists, is correct, records the v0.6.0 lesson, and the sidecar is built by a script rather than by hand. 2, not 3, because there is no CI, the version guard is structurally unsatisfiable, the root lockfile is skewed, and `packaging-preflight.mjs` is a diagnostic with a gate's name.

---

## 4. Security posture — 2 / 5

### The three facts in the brief, confirmed and contextualised

1. **The xorshift defect shipped and survived.** Confirmed from the pre-fix state as recorded in `.opencode/_audit/06-security-build.md:18` (F1) and `.opencode/_audit/20-w3-csprng.md` §1: a 64-bit xorshift64\* seeded `nanos() as u64 ^ pid`, emitting all 32 bytes from **four** steps, written with `fs::write` and **zero** permission calls, with `(0600)` comments that were pure fiction. The W3 worker recovered the seed from live output by building an exact inverse (`xorshift64_unstep`, `main.rs:1696`), proving the effective keyspace was the launch-window nanoseconds — roughly 2^30 bits behind a token that *looks* like 256.
   **Fixed** in commit `2529fc3` via `getrandom = "0.3"` (`Cargo.toml:20`) — which was already in `Cargo.lock` transitively via Tauri, so the entire lock diff is one line — plus `restrict_to_owner` (`main.rs:537`) using `SetEntriesInAclW` + `SetNamedSecurityInfoW` with `PROTECTED_DACL_SECURITY_INFORMATION`, and fail-closed deletion on ACL failure (`main.rs:494`).
   **It now has 8 Rust tests** (`s2_secret_tests::*`, verified passing in my `cargo test` run) including `the_attack_does_break_the_historical_generator` and `the_weak_generator_has_not_been_reinstated`.
   **Why it survived for releases:** `AGENTS.md:55` states it plainly — *"No test runner covers `main.rs` token generation."* There were 27 `#[test]` cases in `main.rs` and none of them touched `main.rs:460-476`. A security defect in the one file the test suite does not cover, in a repo with no CI, is a defect that survives indefinitely.

2. **`pino` loaded on every start.** Confirmed by the W2b resolve trace (`40-w2b-redaction.md` §2): `src/cli.ts:7` → `src/common/index.ts:7` → `src/common/logger.ts:1` `import pino from 'pino'`, executed on every CLI and daemon start, 173 specifiers before and 172 after. **Removed** from source and from the sidecar manifest. **Still present** in `package-lock.json:15` and installed (12 packages, `npm ls` = extraneous).

3. **The secret-redacting logger was dead code.** `.opencode/_audit/06-security-build.md:19` (F2): `createLogger`/`redactSecrets` had **zero** production callers. Independently confirmed — the rewrite is now reachable through exactly one path, `writer.ts:101`, and its `warn` fires only on a flush failure.

### What that says about the review process — the honest answer

**It says the review process had no teeth on files outside `src/`, and no mechanism at all for "a security control exists but nothing calls it."**

Three independent instances of one root cause:

| Instance | Why nothing caught it |
|---|---|
| xorshift secrets in `main.rs` | No test runner covers `main.rs`. The file has 2,903 lines and 48 tests — but not one on the token generator. |
| `pino` shipped in the installer | Not a code defect. It was a **dependency** defect, found by an import-graph trace, not by any gate. `scripts/lint-baseline.mjs` lints source; nothing lints `package.json` for unimported dependencies. |
| `redactSecrets` had no callers | The failure mode is **invisible to a green suite**: a redaction function with no callers is a *passing* function. Only a reachability walk finds it — and the repo did not have one until v0.7.0. |

There is a fourth, still open: `.opencode/_audit/06-security-build.md:22` (F5) records that `.gitignore` has **no rule for `ipc.token` or `serve.pass`**, proven with `git check-ignore -v`. Let that stand: the file holding the WS bearer token is not gitignored. It lives in `~/.opencode-voice-runtime/`, outside the repo, so it does not currently endanger the repo — but the *reason* it is safe is that the path happens to be outside the working tree, not that anyone decided it should be.

Also still open: **L17** — a key that is *present but invalid* is indistinguishable from a healthy one until the first utterance, because a 401/403 advances the key silently (`src/voice/keyring.ts:176` `keyAdvanced()`). `AGENTS.md:56` flags this in prose. It is the single most likely "user reports broken, we cannot reproduce" cause, and no gate can see it.

### What is genuinely good

The vault is well built and the team knows it: AES-256-GCM in `vault/keyring.dat`, `machine.key` beside it, key pools with rotation, `doctor` reporting counts and never values (`src/cli.ts:71`), a `zero-canned` policy test, and a fail-closed `write_protected_secret`. The W3 remediation is exemplary engineering — it chose `getrandom` over `rand` specifically to avoid a PRNG dependency tree, it discovered that `fs::set_permissions(0o600)` is a **silent no-op on Windows** (it maps to `SetFileAttributes`, i.e. only `FILE_ATTRIBUTE_READONLY`) and refused to copy the Unix idiom into a second false claim, and it made the ACL application fail closed by deleting the file. That is senior work. It was simply done years late.

### Score rationale

2, not 1, because the crypto and the vault are now correct and the fix for S2 is genuinely high-quality. 2, not 3, because a security posture is a property of the *process*, not of one file — and this process shipped a weak token generator, a dead redactor, an unshipped-pruned dependency, and an un-gitignored secret file, all undetected, all for more than one release cycle.

---

## 5. Architecture & modularity — 4 / 5

### The 0-of-51 claim is now false, and that is the finding

`AGENTS.md:92-100` states, in a fenced block presented as measured output:

```
LIVE production modules : 51
DEAD production modules : 0
live source lines       : 8056
dead source lines       : 0
```

I re-derived it with an independent walker (static `from` clauses **and** `import()` **and** bare `import '…'` specifiers, resolving every quoted relative specifier, 0 unresolved):

```
ALL_PRODUCTION_TS 58
LIVE 51
DEAD 7   src/runtime/laya/{constants,index,laya-engine,loader,telemetry,tokenizer,types}.ts
LIVE_LINES 8599        (method-dependent; the audit's walker reported 8056)
UNRESOLVED 0
```

**51 live is confirmed exactly. 0 dead is not.** Seven modules under `src/runtime/laya/` are unreachable from both `src/daemon.ts` and `src/cli.ts`. They are *supposed* to be: `src/policy/laya-sidecar-safety.test.ts:16-23` pins "A. `laya-engine.ts` must NEVER be statically reachable from `src/daemon.ts`" and `:261` pins that `loader.ts` may only reach the engine through `import()`. `laya-engine.ts:1` imports `onnxruntime-node`, and a static edge from `daemon.ts` is the v0.6.0 failure.

So this is a **deliberate, test-enforced quarantine** — architecturally correct — presented in `AGENTS.md` as "0 dead". A quarantine is not dead code; it is an *undocumented component*, and the doc that should describe it (`AGENTS.md:104-111`) still describes the *previous* quarantine (44 files in `.opencode/_archive/dead-code-phase1/`) and says the RAG layer "may want to wire properly in a later phase" — which `07-doc-reconciliation.md:43` already flagged as stale, since `src/knowledge/` has since landed and is live. I am re-flagging it because it is still stale.

### Three dead desktop components with PASSING tests

`.opencode/_audit/03-desktop.md:597-607` found three. I re-checked all three against current `HEAD`:

| Module | Current state |
|---|---|
| `src/audio/earcons.ts` | **Removed** by W6. The file and its test are gone; `apps/desktop/src/audio/` now holds `capture`, `playback`, `vad` and their tests. |
| `src/components/portals/CredentialPortal.tsx` | **Removed** by W6, and W6 deleted its test too, with the reasoning recorded at `apps/desktop/src/components/portals/portals.test.tsx:52-58`: *"Its test went with it: a green test on unreachable code is the defect, not the mitigation."* That is exactly right and it is the correct precedent. |
| `src/components/brand/Crest.tsx` (24 lines, 3 green tests) | **Still present and still dead.** Exhaustive grep over `apps/desktop/src` and `apps/desktop/e2e`: the only hits are `Crest.tsx` itself (lines 1, 3, 7, 14, 15) and `Crest.test.tsx` (lines 4, 19, 25, 27). The header uses `WaveformEmblem`. **This is the live instance of the defect class and nothing is queued to remove it.** |

So: 2 of 3 were correctly fixed during the audit wave, and the audit's own standard ("a green test on unreachable code is the defect") was applied to them. The third was missed. That is a good ratio and it is still not zero.

Also partially dead: `src/matrix/matrix-state.ts` — only `matrixForDaemonState` reaches `App.tsx`. `MATRIX_SIZE`, `createField`, `targetInto`, `targetFor`, `lerpToward`, `converged`, `stateBase`, `stateAccent`, `borderMask`, `LERP_ALPHA` are imported only by `matrix-state.test.ts`, and the entire colour-field renderer (`:67-153`) has no runtime caller. The 48×48 matrix is never drawn.

### The test that pinned a bug

`apps/desktop/src/bridge/ws.test.ts:75` is named `'opens the loopback URL with subprotocol + bearer token, resumes seq'`. Its assertion was `expect(created[0].url).toBe(UI_WS_URL)` — **no `?lastSeq=`**. With no param, the server's `lastSeqOf` returns `NaN`, `src/ipc/ui-server.ts` skips the entire replay block, and a cold launch received `hello` and nothing else. Because the inventory interval only pushes on change, the shell sat with an empty session list and agent selector. Measured live: **25 seconds, hello only.**

Three things are true here and all three belong in the score:

1. The test's *name* asserted a behaviour its *body* contradicted. That is the defect, and it survived because a reviewer reading names would not have opened the assertion.
2. The fix and its dedicated guard are both in place: `ws.ts:281` `withQuery(base, 'lastSeq', String(Math.max(0, this.lastSeq)))`, and `ws.test.ts:103` `'the resume cursor is sent on the very first connect, not only on reconnect'` — whose own comment (`:108-109`) records that it was **verified by breaking it**.
3. That guard is the reason the count went *down* to 12 tests for the renderer and the fix still shipped. The comment at `ws.test.ts:104-109` explains exactly why a naive guard would miss it: `lastSeq` is `-1` as a "never connected" sentinel, so any code keying the param off `>= 0` silently omits it on connect #1 and leaves every other test in the file green.

This is the strongest single artefact in the repo. It is also the second time a *test name* has been the only thing lying.

### How these change the score

The 0-of-51 figure is genuinely impressive and, before today, genuinely verified twice by independent walkers. It earned a 5 on its own.

It does not earn a 5 now, because: the number it reports is wrong (7, not 0) and nobody re-derived it after the Laya work landed; a 24-line React component is unreachable from the app while carrying three passing tests; a 100-line colour-field renderer has no caller; and the knowledge layer's own `src/knowledge/index.ts:4-7` says *"The knowledge layer is NOT wired into the live narration path yet"* — which means a shipped, tested, 14-module RAG subsystem is reachable from exactly one place, `node dist/cli.js knowledge "<query>"` (`src/cli.ts:17, 241-242`). That is a legitimate architecture (a CLI-queryable knowledge base), but it is not what `docs/18-VOICE-PIPELINE.md` describes, and it is not what the feature name implies.

4, not 5. And the deduction is entirely about **truthfulness of the metric**, not about the structure — which is the distinction this repo keeps conflating.

---

## 6. Documentation integrity — 1 / 5

### The three items in the brief, plus what I found that is worse

**The fabricated benchmark figures.** `README.md:313-320` withdrew ten of them from the prose. **They are still in the repository, in a file that still contains them.** `assets/benchmark-matrix.svg` (13,683 bytes) carries, in one line of hand-drawn SVG text: `94.8%`, `81.2%`, `+13.6%`, `99.1%`, `88.4%`, `+10.7%`, `98.6%`, `84.0%`, `+14.6%`, `180 ms`, `450 ms`, `2.5x faster`, `91.4%`, `76.5%`, `+14.9%` — **fifteen** numeric claims, against a README that says "ten". There is no baseline. No harness. No measurement. Nothing named `bench/` exists (`vitest.config.ts:27` includes `bench/**/*.bench.ts` for a directory that was never built, and `package.json` has no `bench` script).

The README's own withdrawal note (`:319-320`) says *"Do not re-add the `<img>` tag until the file is regenerated from a real harness, or deleted."* **It has not been deleted.** The note documents the correct remedy and did not apply it. Five numbers in the README's withdrawal paragraph (`94.8 %`, `99.1 %`, `98.6 %`, `180 ms`, `91.4 %`) are themselves re-publicised in the README, so the withdrawal is also incomplete on its own terms.

**The ledger tally that does not sum.** `dossier/PROJECT_MASTER_DOSSIER.md:716`: *"**Tally: 20 closed · 3 open (L6, L16, L17, L22 = 4) · 1 partial (L18).**"* — "3 open" immediately followed by a list of four ids. Counting the table at `:691-714`: **23 rows are CLOSED** (19 plain, plus L6/L16/L17/L22 marked "CLOSED (v0.7.0)"), 1 is PARTIAL. Correct tally: 23 closed / 0 open / 1 partial. And `docs/10-CHECKPOINT.md:744-745` states the same ledger *correctly* ("L18 is the only non-CLOSED row"). Two documents in one repository disagree about the same table and the dossier is the wrong one.

**The knowledge chunk that asserts something false.** `src/knowledge/shared/architecture.ts:77-84`, chunk `arch-gates`:

> `'The test:vantrilex gate runs typecheck, eslint, oxlint, root vitest, then desktop vitest. ' + 'End-to-end tests are NOT part of that gate and run separately.'`

`package.json:24` includes `&& npm run test:e2e` as the sixth term. `AGENTS.md:53` says so explicitly and calls the earlier version of itself wrong for claiming otherwise. This chunk is *shipped in the product's knowledge base* — the layer whose job is to be Tier-1 shared ground truth that a persona reads out loud. It is the same error as the `AGENTS.md` one, copied into a place where the repo's own convention (`src/knowledge/index.ts:6-7`: *"claiming otherwise would be the exact 'documented as shipped while unreachable' defect this project keeps hunting"*) is violated in the very file that states the convention.

Same file, `:67-72`, chunk `arch-reachability`, asserts *"Dead code in src is zero, at 51 live modules and 8056 source lines."* Measured: 7 dead.

### What is worse: `AGENTS.md` itself is now the largest single source of false claims in the repository

`AGENTS.md` is the operating contract — the file every agent and every human reads before touching anything. I verified these against code and the gates today:

| `AGENTS.md` line | Claim | Measured reality |
|---|---|---|
| `:54` | root **573 passed** (46 files) | **656 passed** (53 files). Understated by 83. |
| `:54` | desktop **153** (24 files) | **142** (24 files). Overstated by 11. |
| `:54` | `cargo test` **27** | **48**. Understated by 21. |
| `:55` | `ipc.token`/`serve.pass` "come from an xorshift64\* seeded with `nanos ^ pid`, not a CSPRNG" | **Fixed** in `2529fc3`. `Cargo.toml:20` `getrandom = "0.3"`, `main.rs:537` `restrict_to_owner`. A *resolved* finding is presented as an open one. |
| `:58-69` | "**No stage typechecks the test files** … `typecheck:tests` … **not** in `test:vantrilex` … currently reports **62 errors**" | `package.json:24` includes `typecheck:tests` as the **second** stage. It reports **0 errors** (measured). Both halves of the paragraph are stale, in opposite directions. |
| `:70-73` | "`vitest.config.ts` declares `thresholds: { lines: 80 }`" | `vitest.config.ts` has **no `coverage` block at all**. It was deleted; the doc describes the deletion target, not the file. |
| `:92-100` | `DEAD production modules: 0` / `dead source lines: 0` | **7 dead**, all `src/runtime/laya/*`. |

That is **seven** stale-or-false load-bearing claims in the one file that defines the contract. One of them (`:55`) tells the next agent that a fixed vulnerability is live. One of them (`:58`) tells the next agent not to trust the gate's own typecheck stage.

### The verdict: the documentation net is a liability, and I say that without hedging

Not because the prose is stylistically wrong. It is unusually good prose — the "gotchas that cost real time" section is the most useful thing in the repo, and the release runbook is correct. **It is a liability because its failure mode is invisible and it is being used as the primary decision input.**

The specific harm, stated plainly:

1. **It is confidently wrong at a rate that makes "check the doc" an unsafe shortcut.** Every one of the seven `AGENTS.md` claims above reads as authoritative and is wrong. A reader who spot-checks two claims and gets two wrong has no signal about the third.
2. **The error is systematic, not random: it always errs toward "we are further along than we are."** Fixed defects presented as open (`:55`), `typecheck:tests` presented as absent when it is in the gate (`:58`), coverage presented as configured when it is deleted (`:70`), dead code presented as zero (`:92`), test counts presented as higher than measured (desktop 153 vs 142). Only the root count errs low, and that is because 83 tests were *added* and nobody re-read the file. **A reader calibrates "this project says it's done" as "probably not done."** That is the worst possible calibration for a team whose history is green gates hiding broken releases.
3. **The artefacts it warns about are still live.** `assets/benchmark-matrix.svg` still holds fifteen invented numbers. The withdrawal note at `README.md:313-320` documents the fix and does not apply it.
4. **The product ships the false claims.** `src/knowledge/shared/architecture.ts:83` and `:71` are in the daemon's knowledge bus, retrievable by `node dist/cli.js knowledge`. A documentation-integrity defect has become a shipped-content defect.

The mitigating fact, and it is a real one: **this audit swarm exists precisely because the docs were caught.** `.opencode/_audit/07-doc-reconciliation.md` enumerates 180+ claims with verdicts, and its arithmetic is sound; `AGENTS.md:53` was itself corrected by an earlier wave; `README.md:341-348` is an honest, self-critical explanation of the fake coverage floor. The team has the right instinct and the wrong maintenance mechanism — corrections land in a report rather than in the document, so the document stays wrong while the report becomes the thing nobody reads.

**One process closes this.** A `npm run docs:verify` that mechanically re-derives every number in `AGENTS.md` and `README.md` from the repo — test counts by running the runners, dead-code by walking imports, version by reading all nine files, gate composition by parsing `package.json:24` — and exits non-zero on a mismatch. The numbers are already machine-derivable; only the *assertion* is human-entered. This is the highest-leverage item in the entire roadmap and it is an afternoon of work.

---

# PART 2 — INDUSTRY PRACTICES FOR LOCAL DESKTOP AI SIDECARS

## 2.1 What production tools actually do

### Crash reporting

- **Windows Error Reporting `LocalDumps`** — the OS-native mechanism. Per-executable registry keys under `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\<app>.exe` with `DumpType`, `DumpFolder`, `DumpCount`. Works even when WER reporting is disabled or the user cancels. Defaults: count 10, mini dump. Microsoft's own docs: [Collecting User-Mode Dumps](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps). Off by default; enabling requires admin. Secondary walkthrough with the `ForceQueue` / `Consent\DontShowUI` / `ConfigureArchive` keys for fully non-interactive local capture: [Creating an Application Crash Dump](https://helgeklein.com/blog/creating-an-application-crash-dump).
- **Electron `crashReporter`** with `uploadToServer: false` — the pattern the closest comparable product uses. Comfy Desktop runs the reporter **local-only**, keeps minidumps (1–5 MB each) plus `app.log` in `crashDumps/`, sweeps on startup to bound the folder, and detects "a new minidump newer than the last clean shutdown" on the next launch to prompt the user. Their own issue states the telemetry channel **cannot** carry multi-MB payloads and *"is not something we can quietly auto-submit"*, so they designed a per-incident opt-in modal with a **"Save report…"** fallback that writes the bundle to a file the user attaches manually: [Comfy-Org/Comfy-Desktop#1199](https://github.com/Comfy-Org/Comfy-Desktop/issues/1199).
- **Tauri has no first-party crash reporter.** The official plugin table lists autostart, barcode-scanner, biometric, cli, clipboard-manager, deep-link, dialog, fs, geolocation, global-shortcut, haptics, http, localhost, **log**, nfc, notification, opener, os, persisted-scope, positioner, process, shell, single-instance, sql, store, stronghold, updater, upload, websocket, window-state. No crash, no sentry: [tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace). Any Sentry integration is third-party.

### Local telemetry with consent, opt-out analytics

- **VS Code's four-level model** is the reference taxonomy — `telemetry.telemetryLevel` ∈ `{all, error, crash, off}`, with the levels decomposed into three independent columns (crash reports / error telemetry / usage data): [VS Code telemetry](https://code.visualstudio.com/docs/configure/telemetry) and [enterprise policy](https://code.visualstudio.com/docs/enterprise/telemetry). Note the failure mode people actually object to: opt-out by default with silent re-enrolment, which drew sustained criticism — [HN discussion](https://news.ycombinator.com/item?id=28812486). The *taxonomy* is good. The *default* is contested.
- **Ollama — zero telemetry.** Privacy policy: *"We do not collect, store, transmit, or have access to your prompts, responses, model interactions, or other content you process locally"* and *"We collect basic account info and limited usage metadata that does not include prompt or response content"*: [ollama.com/privacy](https://ollama.com/privacy). An independent audit confirmed no analytics code paths in the source: [local-llm.net privacy audit](https://www.local-llm.net/blog/local-ai-privacy-audit).
- **LM Studio — no telemetry in the app, a second policy for the Hub.** *"the application does not include telemetry or user-specific tracking, we are unable to fulfill data subject requests … there's no way for us to identify or retrieve your specific data"*, with anonymous analytics **off** in Settings → Privacy: [lmstudio.ai/app-privacy](https://lmstudio.ai/app-privacy). The useful discipline here is the two-policy split: the desktop binary and the web platform are governed separately.
- The same audit's conclusion is the governing principle for this repo: *"Telemetry should always be opt-in. No exceptions. If your tool's value proposition is privacy, defaulting to data collection — even innocuous data — undermines your own message"*, and it rates default-on anonymous analytics a *"philosophical mismatch"*: [local-llm.net](https://www.local-llm.net/blog/local-ai-privacy-audit).

### Structured logging

- **Rust:** `tracing` + `tracing-subscriber` + `tracing-appender`, with a non-blocking writer and rolling-file support, is the de facto standard. [`tracing` docs](https://docs.rs/tracing) — `tracing-appender` "provides utilities for outputting tracing data, including a file appender and non blocking writer". The per-layer filtering pattern (verbose console in dev, structured file in production) is the recommended shape: [tokio-rs/tracing#3488](https://github.com/tokio-rs/tracing).
- **Tauri:** `tauri-plugin-log` exists, supports `LogDir` / `Folder` targets, `max_file_size`, `rotation_strategy: KeepAll`, `level` + `level_for(module)`, a `filter` closure, and per-target formats: [v2.tauri.app/plugin/logging](https://v2.tauri.app/plugin/logging/). Caveat for Voxaura: on Windows the `LogDir` target writes to `%LOCALAPPDATA%\{bundleIdentifier}\logs`, which is a **different directory** from the `~/.opencode-voice-runtime` convention the supervisor and daemon already use.

### Distributed tracing

- **OpenTelemetry Node** is the standard, and every documented setup path terminates in an OTLP exporter pointed at a collector: [opentelemetry.io Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs), [Inngest guide](https://www.inngest.com/blog/opentelemetry-nodejs-tracing-express-inngest), [Better Stack guide](https://betterstack.com/community/guides/observability/opentelemetry-nodejs-tracing). The `ConsoleSpanExporter` appears only as a debugging step.
- The **value** the standard delivers that Voxaura lacks is not the exporter. It is the *identity model*: a `traceId` that is minted once per user action and propagated, so spans emitted by three different processes and three different log files can be joined after the fact.

### Scrubbing as a boundary control

- Sentry's model is the industry reference for fail-closed scrubbing at the single egress point: `beforeSend` / `beforeSendTransaction` / `beforeSendSpan` / `beforeSendLog` / `beforeSendMetric` / `beforeBreadcrumb`. A practitioner write-up makes the point sharply — *"I wrote the privacy rule, enforced it in a beforeSend hook, I unit tested it"* — and it still shipped a leak: [dev.to](https://dev.to/arqamwd/i-wrote-the-privacy-rule-enforced-it-commented-it-and-shipped-the-leak-anyway-500g). The supporting analysis enumerates what the deny list must cover: credentials, authorization headers, cookies, signed URLs, private files, payment data, secret-bearing env values, plus raw prompts/completions/tool arguments/UPLOADS/request bodies/console output: [Sentry + PostHog privacy launch gate](https://vibeshiplab.com/sentry-posthog-ai-apps-privacy-launch-gate).
- The cross-platform lesson: even a purely local app leaks secrets through snapshots, clipboard, keyboard cache and OS backups — nine surfaces, none of which the app controls: [Sensitive data in a mobile app: the 9 places it ends up on the device](https://www.nathanhallouin.dev/en/blog/sensitive-data-mobile-app-nine-places).

## 2.2 Verdicts for Voxaura

Framing: a **local-first Windows app that promises nothing leaves the machine and holds three live API keys** (Groq, Fish, OpenRouter — `src/voice/vault.ts:11` `KEY_POOLS`) in an encrypted vault. Anything that assumes a server is **explicitly rejected**, and the rejection is the finding.

### ADOPT

| Practice | Verdict | Why, specifically here |
|---|---|---|
| **User-initiated "Save diagnostics…" export** — a Settings button writing a **redacted** bundle (`supervisor.log`, `daemon.log`, `daemon-stdout.log`, `opencode.log`, `voice-runtime.jsonl`, version table, key *counts*) to a file the user attaches manually. | **ADOPT, first.** | Zero egress by construction. It is the pattern Comfy Desktop converged on after discovering their telemetry channel could not carry the payload and that auto-submission was not acceptable to them ([#1199](https://github.com/Comfy-Org/Comfy-Desktop/issues/1199)), and it is the long-standing browser pattern. It converts "nothing leaves the machine" from a promise into a *workflow*. It is also the only practice on this list that gives the maintainer a bug report with a session id in it. |
| **WER `LocalDumps`, per-executable, local-only** | **ADOPT.** | OS-native, Windows-only (which is the constraint anyway), zero egress, no dependency, and it works when WER reporting is disabled — [MS Learn](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps). Voxaura currently captures **nothing** on a supervisor panic because `main.rs` has no `panic::set_hook` and no `catch_unwind`. This is the cheapest possible fix for that hole. Note the admin requirement and that it is per-`HKLM`, so it needs a documented manual step, not a silent installer action. |
| **Rust `tracing` + `tracing-subscriber` + `tracing-appender`** | **ADOPT for `main.rs`.** | Replaces `log_line` (`main.rs:525-539`), which is a read-modify-write of the entire file on every one of its 30 call sites — O(n) per line and lossy under concurrency. `tracing-appender`'s non-blocking appender is the standard answer ([docs.rs/tracing](https://docs.rs/tracing)). Keep writing to `~/.opencode-voice-runtime/supervisor.log`; do **not** adopt `tauri-plugin-log`'s `LogDir` target, because on Windows it writes to `%LOCALAPPDATA%\{bundleId}\logs` and would split the logs across two directories ([plugin docs](https://v2.tauri.app/plugin/logging/)). |
| **Wire the existing `createLogger` into the daemon** | **ADOPT.** | `src/common/logger.ts:266` has exactly one production caller (`writer.ts:101`). `daemon.log` and `daemon-stdout.log` are unstructured today. Zero new dependencies — the JSONL logger already exists and is already unit-tested. |
| **Run the redaction scrubber on every local sink, not just the telemetry bus** | **ADOPT immediately.** | `src/ipc/ui-server.ts:210-211` `notice()` does no redaction, and `src/daemon.ts:584/738/789` interpolate raw provider `err.message` into it. `src/daemon.ts:257` `console.error`s one raw. The scrubber exists (`src/common/logger.ts:70`); it is simply not called at those boundaries. Whether a provider ever echoes an `Authorization` header in an error body is **UNVERIFIED**, but the Sentry reference implementation exists precisely because this class of leak is routine, not exotic. |

### ADAPT (keep the idea, refuse the machinery)

| Practice | Verdict | Why, specifically here |
|---|---|---|
| **OpenTelemetry** | **ADAPT: take the data model, refuse the SDK.** | Every documented Node setup ends at an OTLP exporter pointing at a collector ([Inngest](https://www.inngest.com/blog/opentelemetry-nodejs-tracing-express-inngest), [Better Stack](https://betterstack.com/community/guides/observability/opentelemetry-nodejs-tracing), [OTel Node](https://opentelemetry.io/docs/languages/js/getting-started/nodejs)). Adopting `@opentelemetry/sdk-node` buys a network client, a batch processor and a dependency tree, in exchange for something `src/telemetry/writer.ts:64-70` already encodes. **Take instead:** a `traceId` minted once per utterance and carried on every telemetry row *and* every logger line *and* the `notice` frame. That is the only part of OTel that pays here, and it is ~30 lines. |
| **VS Code's four-level taxonomy** (`all`/`error`/`crash`/`off`) | **ADAPT.** | The taxonomy is right and the default is wrong for this product. Map it onto *local verbosity*, not egress: `off` = no JSONL rows, `crash` = rows only for non-OK status, `error` = + sanitized error classes, `all` = + every latency sample. Ship it as a local setting. Do **not** ship an "opt-out analytics" toggle — see below. |
| **`tauri-plugin-log` for the renderer** | **DEFER / probably reject.** | Bridging renderer `console.*` into the supervisor log is genuinely useful (the docs' `forwardConsole` snippet is exactly right), but the `LogDir` path split above is a real migration cost, and the renderer already talks to the daemon over WS-4097. Cheaper: forward renderer errors as `notice` frames with a `traceId`, which the daemon can record. |
| **Sentry-style `beforeSend` boundary scrubbing** | **ADAPT the concept, reject the service.** | Voxaura has no egress, so there is no `beforeSend`. But the *idea* — one fail-closed scrubber at every sink boundary, unit-tested — is right, and Voxaura has already built the scrubber. It just needs to be called at `ui-server.ts:210` and `daemon.ts:257` instead of only at `writer.ts:113`. |

### REJECT — explicitly, with reasons

| Practice | Verdict | Reason |
|---|---|---|
| **Hosted crash reporting — Sentry, Bugsnag, Honeycomb, or any Tauri Sentry plugin** | **REJECT.** | Three independent reasons. (1) It requires egress, and *nothing leaving the machine* is the product's differentiator — [LM Studio's own policy](https://lmstudio.ai/app-privacy) and [Ollama's](https://ollama.com/privacy) both sell on exactly this. (2) The Node daemon holds decrypted Groq, Fish and OpenRouter keys in memory for the whole session. Putting a third-party SDK in that process means the key material is one SDK bug away from a remote endpoint. (3) Even the vendor's own scrubbing guidance is a best-effort deny list that practitioners report leaking anyway ([dev.to](https://dev.to/arqamwd/i-wrote-the-privacy-rule-enforced-it-commented-it-and-shipped-the-leak-anyway-500g)) — so you would be accepting a *known, recurring* leak class in exchange for crash reports you can collect locally for free via WER. |
| **Opt-out anonymous analytics (the LM Studio / PostHog default-on model)** | **REJECT.** | The independent audit of local-AI privacy tools calls default-on analytics a *"philosophical mismatch"* for a product whose value proposition is privacy, and states the rule without exception: *"Telemetry should always be opt-in. No exceptions"* ([local-llm.net](https://www.local-llm.net/blog/local-ai-privacy-audit)). Voxaura should go further: **do not ship the toggle at all.** A "disable telemetry" switch implies a network path exists. It does not. Shipping the switch teaches users to look for one. |
| **OpenTelemetry Collector, Jaeger, Grafana, or any OTLP exporter** | **REJECT.** | Every one of these is a server. Voxaura's `telemetry-wired.test.ts:8-12` records that this exact subsystem was "fully built, schema-validated and unit tested, and then never called by anything" — adding a collector-facing exporter to a sidecar holding API keys would rebuild that class of defect with a network dependency attached. |
| **Auto-upload with a consent modal (the Comfy Desktop #1199 shape)** | **PARTIAL REJECT.** | Adopt the *modal* and the *"Save report…"* fallback. Reject the *upload*. A modal that ships your crash dump and provider error text to a server breaks the product's one hard promise, and a consent dialog does not repair a promise — it re-litigates it on the worst possible occasion. |
| **`tracing-opentelemetry` / any bridge from the Rust supervisor** | **REJECT.** | The supervisor spawns `opencode serve` with `OPENCODE_SERVER_PASSWORD` and writes `serve.pass` to disk. Any bridge from that process toward a collector is a bridge over credential material. The supervisor's log needs to be *well-formed*, not *exported*. |
| **Electron `crashReporter` / `sentry-electron`** | **REJECT (wrong runtime).** | Voxaura is Tauri. The Tauri plugin table has no first-party crash reporter ([plugins-workspace](https://github.com/tauri-apps/plugins-workspace)), so the only path is WER plus a `panic::set_hook`, both local. |
| **Linux/macOS `LocalDumps`, App Store crash reporting, `ReportCrash`** | **REJECT (out of scope).** | Windows-only is a stated product constraint. Adding cross-platform crash plumbing now is scope for a product that does not exist. |

**One-line summary of Part 2:** the appropriate practice for a local-first Windows sidecar holding real keys is **local capture (WER + a panic hook), local structured logs with a correlation id, and a user-initiated export** — and an explicit refusal of every hosted service, every collector, and the opt-out-analytics toggle itself. The Comfy Desktop issue is the single most useful artefact found: a local-first AI desktop app independently arrived at "local-only reporter, per-incident opt-in, and a save-to-disk fallback," and explicitly noted it could not send the payload through its telemetry channel and should not quietly auto-submit. Voxaura should copy that shape and delete the upload.

---

# PART 3 — ROADMAP v0.8.0 → v1.0.0

## 3.0 Constraints (stated, not negotiated)

1. **Fish Audio's free tier expires 2026-11-30. Sixty-three days from today.** `src/voice/tts.ts:14-17`: *"the free tier is a PROMOTION with a hard end date … runs THROUGH 2026-11-30, with no SLA, no TTFA guarantee."* Also stated as shipped product content in `src/knowledge/shared/capabilities.ts` chunk `cap-tts-free-tier`. **There is no SLA and no notice.** On 2026-12-01 the narration path and the spoken confirmations have no free provider. This is the only hard external deadline in the plan and it is 8.5 weeks out. Everything in M1 is subordinate to it.
2. **Everything is free tier, permanently.** `AGENTS.md:85` — *"every slug is `:free`; the 100%-free constraint is a product decision, not an accident."* A paid fallback is not a permitted answer.
3. **Windows-only.** No macOS/Linux work. NSIS is the only installer target.
4. **No CI.** None of this plan depends on adding one; see the trap list for why.
5. **The test count must never drop.** Noted with the correct caveat: the count *did* legitimately fall 153 → 141 during Wave 2 (W6 deleted dead modules and their tests). The rule that actually works is **"every deletion is itemised in the commit"**, which this team already does. A bare numeric floor will be satisfied by deleting tests, which is worse than no floor.

## 3.1 Milestones

### M0 — v0.7.3 · "Make the docs true" · 1 week · **P(lands) = 95 %**

The highest value-per-hour work in this entire plan, because **every subsequent decision is made by reading `AGENTS.md`, and `AGENTS.md` currently contains seven false load-bearing claims** (Part 1 §6, table above). A roadmap executed against a contract that is 7/17 wrong is a roadmap executed against fiction.

- Fix the counts in `AGENTS.md:54` to 656 / 53, 142 / 24, 48 / 18 / 14.
- Rewrite `AGENTS.md:55` — S2 is **fixed**; describe `getrandom = "0.3"` and `restrict_to_owner`, and keep the "no test runner covers `main.rs`" warning, which is still true and is why the fix needed an audit to find.
- Rewrite `AGENTS.md:58-69` — `typecheck:tests` **is** stage 2 and reports **0**.
- Rewrite `AGENTS.md:70-73` — the coverage block was **deleted**; state that the number has never been measured and give the three commands.
- Rewrite `AGENTS.md:92-100` — 51 live / **7 deliberately quarantined** `src/runtime/laya/*` / and name the enforcing test.
- Fix `src/knowledge/shared/architecture.ts:83` (`arch-gates`) and `:71` (`arch-reachability`).
- **Delete `assets/benchmark-matrix.svg`.** Not regenerate — there is no harness. And strip the five re-publicised figures from `README.md:313-320`.
- Remove `pino` from `package-lock.json:15` and let the lock prune the 12 pino-family entries.
- Fix the unredacted notice path: run `redactSecrets` on `detail` at `src/ipc/ui-server.ts:210`, add a test that feeds `sk-or-v1-…` through a synthetic `err.message`, and do the same for `src/daemon.ts:257`.
- Delete `apps/desktop/src/components/brand/Crest.tsx` **and** `Crest.test.tsx` — the last of the three dead-with-passing-tests components, per the precedent W6 already set at `portals.test.tsx:52-58`.
- **Add `npm run docs:verify`** and put it in `test:vantrilex`: mechanically re-derive test counts by running the runners, dead code by walking imports, the version from all nine files, gate composition from `package.json:24`. Exit non-zero on mismatch. This is the item that stops the recurrence, and it is the reason M0 is not just a typo sweep.

**Risk:** low, and contained. **The real risk is skipping it**, because every later milestone will be planned against the current false `AGENTS.md`.

---

### M1 — v0.8.0 · "Fish contingency" · **starts immediately, decision by 2026-10-15** · **P(deadline met) = 55 % · P(a working second TTS ships) = 30 %**

**Goal:** on 2026-12-01 the product does not silently lose its voice.

**Work, in order:**
1. **By 2026-10-15, a measured answer**, not an opinion. Use `scripts/live_console_test.ts` — already the gate-exempt live harness — to call at least two candidate free TTS paths and record success rate, p50, max, and first-chunk latency in `docs/10-CHECKPOINT.md`. Anything not measured goes in the report as UNVERIFIED.
2. **Make TTS failure degrade honestly in-product.** Today a Fish failure produces a `tts-failed` notice (`src/daemon.ts:789`) and the assistant goes silent while the HUD still claims voice. The honest post-2026-11-30 state must be a *stated* degraded mode, not a silent one. This is achievable without any new provider and should ship regardless of the measurement.
3. **Only then** integrate whatever measured best.

**Risk, stated honestly:** the only free-after-2026-11-30 option that preserves the no-egress promise is a **local** TTS (Piper / Kokoro class, via ONNX or GGUF). That collides head-on with the sidecar constraint — `src/policy/sidecar-safety.test.ts:8-12` documents that the sidecar does not bundle native binaries and that a static native import is precisely the v0.6.0 boot failure. Shipping a local TTS means either a large model in the installer (the 294 MB Laya precedent, and Laya is quarantined *because* nobody wants that cost) or a new native dependency in the sidecar. That is a genuine architectural fork, not a task.

A paid or metered tier is **not** a permitted resolution under constraint 2.

**Honest probability the 2026-11-30 cliff is survived with voice intact: 30 %.** **Probability the cliff is *survived honestly* — the app says it has no voice rather than pretending: 85 %**, and that second number is the one worth optimising, because it is fully within reach and depends on nothing external.

---

### M2 — v0.8.1 · "One command that decides releaseable" · 1–2 weeks · **P(lands and is trusted) = 70 % · P(ever runs in CI) = 25 %**

**Goal:** close the single biggest process risk — **the verification gate and the shipped artefact are different systems, and only a human's memory connects them.**

**Work:**
- `npm run release:verify` — `test:vantrilex` → `node scripts/provision-sidecar.mjs` → `npm run build:tauri` → verify `src-tauri/target/release/bundle/nsis/Voxaura_<v>_x64-setup.exe` exists → SHA-256 it → `/S` silent install → launch → **assert 4096 and 4097 are bound and `daemon.log` is 0 bytes** → uninstall → exit non-zero on any failure. That assertion set is verbatim `AGENTS.md:166` step 6, which is already correct; the change is that a machine does it every time instead of a human remembering to.
- Make `scripts/packaging-preflight.mjs` **exit non-zero** when a row is `MISS`, and add it to the script chain. Today it prints a readiness matrix and its last statement is a `console.log` — it is a diagnostic wearing a gate's name.
- Replace the hand-run version bump with `scripts/bump-version.mjs`, asserting the **exact expected occurrence count per file** — which for `apps/desktop/package-lock.json` is **2** (`package-lock.json:3` and `:9`), not 1. The current instruction at `AGENTS.md:157` specifies 1 against a file that has 2, so the guard cannot be satisfied and will be weakened the first time someone hits it. Derive the count per file from a table; do not assert 1 uniformly.
- Add a port preflight to the E2E stage so an `EADDRINUSE` from a running installed build produces *"stop Voxaura"* rather than a Playwright stack trace (`playwright.config.ts:28,31` `reuseExistingServer: false`).

**Risk:** silent install needs admin and writes to a real user profile; NSIS `/S` is not transactional. It will be flaky on a dirty machine. That is acceptable — it is *diagnostic* flakiness, which is what you want, rather than a gate that quietly passes.

**The 25 % is on CI, not on the script.** A Windows self-hosted runner that can do NSIS + silent install + WebView2 is its own project, and starting it mid-milestone is how M2 slips.

---

### M3 — v0.8.2 · "Observability that survives a crash" · 1 week · **P(lands) = 80 %**

**Goal:** when a user's app dies, there is a durable, joinable record of why.

**Work, one commit each, each independently gated — this touches the daemon boot path, which is exactly where v0.6.0 broke:**
1. `src/daemon.ts`: `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that record a structured telemetry row, flush, then exit. **Zero such handlers exist today** (verified by grep across `src/**/*.ts`).
2. `main.rs`: `std::panic::set_hook` that appends the payload to `supervisor.log` before the process dies. **No panic hook exists today.** Use the existing append-only convention.
3. `main.rs`: replace `log_line` (`:525-539`, read-modify-write of the whole file, 30 call sites) with an append-mode handle, or adopt `tracing` + `tracing-appender` per Part 2. Keep writing to `~/.opencode-voice-runtime/supervisor.log`.
4. `src/daemon.ts`: route `createLogger` in so `daemon.log` / `daemon-stdout.log` become structured JSONL. It has **one** production caller today (`writer.ts:101`); this makes it the daemon's logger. Zero new dependencies.
5. Mint a `traceId` per utterance; carry it on every telemetry row, every logger line, and the `notice` frame. Add it to `RecordInputSchema` in `writer.ts`. This is the ~30 lines from the OTel ADAPT verdict — the model, not the SDK.
6. Raise telemetry rotation from single-generation (`writer.ts:161-170`, keeps `.1` only) to keep the last *N* generations, so a crash cannot destroy the earlier evidence.

**Risk:** every one of these edits is in the module graph that failed to load in v0.6.0. Mitigation: one commit each, `npm run test:vantrilex` green after each, and `sidecar-safety.test.ts` left untouched and passing — it is the tripwire.

---

### M4 — v0.9.0 · "Diagnostics bundle export" · 1 week · **P(lands) = 75 %**

**Goal:** turn "nothing leaves the machine" from a promise into a workflow.

**Work:** a **Save diagnostics** button in Settings that writes a single redacted `.zip` containing `supervisor.log`, `daemon.log`, `daemon-stdout.log`, `opencode.log`, `voice-runtime.jsonl`, a version table (app, daemon, `opencode serve`, contract version), and key **counts** — never values. Every field passes through `redactSecrets` (`src/common/logger.ts:70`) on the way in, so the bundle cannot contain key material even if a future log line does. **No upload path. No network code. No "send" button.** Pattern: Comfy Desktop's *"Save report…"* fallback ([#1199](https://github.com/Comfy-Org/Comfy-Desktop/issues/1199)).

**Risk:** a zip writer is a new dependency, or hand-rolled, and a hand-rolled one that mishandles a path can write outside the intended directory. Use Node's built-in and test traversal. Secondary risk: users will not find the button. Mitigate with a one-line pointer in the keyless notice (`src/daemon.ts:816`), which is the exact moment a user is most likely to need it.

---

### M5 — v0.9.1 · "The Rust supervisor gets a crash path" · 3–4 days · **P(lands) = 65 %**

**Goal:** the 2026-11-30 cliff does not arrive as a mystery.

**Work:** document and add a **WER `LocalDumps` recipe** — per-executable key under `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\voxaura.exe`, `DumpType 2`, `DumpFolder` under `~/.opencode-voice-runtime/dumps`, `DumpCount 10` ([MS Learn](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)). Shipped as **documented manual steps, not as an installer action**, because the key requires admin and silently writing HKLM during an install is exactly the kind of surprise this project does not need. Combine with M3's `panic::set_hook` and the WER dump appears with no third-party dependency and no egress.

**Risk:** low technically; the risk is scope creep into "a proper diagnostics subsystem." Ship the recipe and move on.

---

### M6 — v1.0.0 · "Reconciliation, not new surface" · 3–4 weeks · **P(lands with no new functional surface) = 60 %**

**Goal:** a 1.0 whose documentation is all true.

**Work:**
- **Decide the 7 `src/runtime/laya/` modules.** Either wire them behind an explicit opt-in flag (with the 294 MB model cost stated in the UI) or move them to `.opencode/_archive/` with the reason recorded. "Neither" is not an option — right now `AGENTS.md` says they do not exist, which is the exact `documented as shipped while unreachable` defect the repo's own knowledge layer is written to prevent (`src/knowledge/index.ts:6-7`).
- **Decide `src/knowledge/`.** It is live, tested, and reachable from exactly one place: `node dist/cli.js knowledge "<query>"` (`src/cli.ts:17, 241-242`). Its own index says it is *"NOT wired into the live narration path yet."* Either wire it into the narrator — **after 1.0, not before** (see traps) — or state plainly in the README that Voxaura ships a CLI-queryable knowledge base and no in-product retrieval. Do not let v1.0 imply a feature the narration path does not have.
- **Reconcile `docs/00`–`docs/28` against reality** with `docs:verify` extended to the claims that are mechanically checkable (port numbers, model slugs, wire shapes, gate composition, file paths).
- **Close or explicitly re-open L17** (a present-but-invalid key is indistinguishable from a healthy one until first use) and **F5** (`.gitignore` has no rule for `ipc.token` / `serve.pass`). Both are one-line fixes that have been open for two releases.
- Add the **last** coverage measurement: install `@vitest/coverage-v8`, run it, commit the **number and the command** in the same commit, and only then set a threshold. In that order, in that commit.

---

## 3.2 What we are NOT doing, and why

1. **No hosted crash reporting.** No Sentry, Bugsnag, Honeycomb, or third-party Tauri Sentry plugin. Rejected in Part 2 on three independent grounds. WER + a panic hook covers it locally at zero egress and zero dependency.
2. **No opt-out analytics toggle.** There is no telemetry to toggle. `voice-runtime.jsonl` is local and rotating. Shipping a "disable telemetry" switch implies a network path exists, which would teach users to hunt for one.
3. **No OpenTelemetry SDK, Collector, or exporter.** Take the `traceId` data model (M3.5). Refuse the network client. `telemetry-wired.test.ts:8-12` records that this subsystem was once "fully built, schema-validated and unit tested, and then never called by anything" — an exporter is that defect with a socket attached.
4. **No CI before v1.0.** Not because it is undesirable — it is the correct destination — but because a Windows self-hosted runner capable of NSIS + silent install + WebView2 is a separate project, and starting it mid-milestone is how M2 slips. Revisit at v1.0 with M2 already trusted. **Be honest that "no CI" is why M2 is a script a human runs, not a machine.**
5. **No coverage floor before the number is measured.** The repo already shipped a fake `thresholds: { lines: 80 }` that enforced nothing because `coverage.enabled` was never set. Any threshold written before the measurement is the same lie in new clothing.
6. **No wiring of `src/knowledge/` into the narration path before 1.0.** It is a prompt-shaping change to `narrator.ts`, whose model requires `reasoning: {effort:'none'}` and a strict `json_schema` to return usable output at all (`AGENTS.md:96-98`). Changing narrator prompts risks the measured 0/5 → 5/5 collapse, and no runner in the gate can see that collapse — it is only visible on a live call, which no gate makes. Defer past v1.0 and measure separately.
7. **No mobile pairing, no agent launcher, no Laya ONNX heads in the sidecar.** `docs/19-MOBILE-PAIRING.md` and `docs/26-AGENT-LAUNCHER.md` both carry supersession banners and describe code that does not exist. Laya stays quarantined with `laya-sidecar-safety.test.ts` as its enforcer.
8. **No second TTS provider until M1 has measured one.** A speculative provider integration is a silent-failure generator, and this repo already knows the three ways a free provider fails silently (UA, `effort:none`, `json_schema`). A fourth would fail the same way, undetected.
9. **No new WS-4097 frame without a renderer consumer.** `mute` returned `{ok: true}` from `src/orchestrator/command-router.ts:227-230` while muting nothing, and the HUD displayed a muted state at full volume. That is the shape. A frame contract with no consumer is a promise with no implementation.

## 3.3 Traps, specific to this team's history

**The ones that have already worked here:**

- **A green suite plus a confident changelog is not evidence that a feature ships.** Proven three times: `mentions.ts` / `slash.ts` / `prompt-optimizer.ts` had passing tests and zero importers; `TelemetryWriter` was built, tested, and never called; `botMuted` acked `ok:true` and muted nothing. **Every new feature must come with a reachability check, not a test count.**
- **A test name is not a test.** `ws.test.ts:75` was named *"resumes seq"* and asserted that no resume param was sent. Read the assertion.
- **A comment is not a control.** `main.rs` had `(0600)` comments over `fs::write` calls with no permission API at all. The W3 worker's finding is the general rule: *a claim of security that no API call implements is worse than no claim, because it stops the next reader from looking.*
- **Coverage thresholds must follow measurement, never precede it.**
- **Verify a guard test by breaking the guard.** `ws.test.ts:108-109` records doing exactly this. Several guards here were vacuous until checked.

**The ones that are still armed:**

- **A gate that reports but cannot fail.** `scripts/packaging-preflight.mjs` prints a readiness matrix and always exits 0, and is in no npm script. This is finding F-02's shape, in a *new* file, after F-02 was fixed.
- **Adding a stage to `test:vantrilex` and then excluding it because it turns the gate red.** That is literally the decision that created the 62-error type hole — and `AGENTS.md:65-69` still describes it as current.
- **A telemetry union member with no producer.** `LAYA` and `LAUNCHER` (`writer.ts:37`) have never been produced by anything, and `telemetry-wired.test.ts:28` only checks `STT`/`BRAIN`/`TTS`, so the schema can grow members forever. Worse: `probeHealth` **is** live (`daemon.ts:183`, `cli.ts:35`) and records nothing.
- **A free-tier provider assumption.** The three silent failures in `AGENTS.md:94-98` were found by live calls and are covered by **zero** runners. A fourth provider will fail the same way.
- **Assuming the last release is the current code.** `AGENTS.md:173` — *"the installed app tracks the last release, not local HEAD."* Reproduce against the running process; do not fix live failures by editing docs (`AGENTS.md:186`).
- **Committing and then tagging.** `gh release create` auto-tags at whatever HEAD is at that moment; commit first, then verify with `git rev-list -n 1 <tag>` against `git rev-parse HEAD` (`AGENTS.md:164`).
- **Believing a withdrawal note means the withdrawal happened.** `README.md:313-320` withdrew ten figures and `assets/benchmark-matrix.svg` still contains fifteen. The fix was documented and not applied.

---

# APPENDIX A — Measured numbers, this session, 2026-09-28

| Quantity | Claimed | **Measured** | Where |
|---|---|---|---|
| Root vitest | 573 / 46 (`AGENTS.md:54`) | **656 / 53** | `npx vitest run` |
| Desktop vitest | 153 / 24 (`AGENTS.md:54`) | **142 / 24** | `cd apps/desktop && npx vitest run` |
| `cargo test` | 27 (`AGENTS.md:54`) | **48 / 0 failed** | `cargo test --no-default-features` |
| E2E | 18 / 14 | **18 declared / 14** — run **not** verified | static `test(` count |
| `typecheck:tests` | 62 errors, not in gate (`AGENTS.md:62-67`) | **0 errors, IS stage 2** | `package.json:24` |
| oxlint | 8 | **8** | `scripts/lint-baseline.json` |
| Live production modules | 51 | **51** | independent walk |
| **Dead production modules** | **0** (`AGENTS.md:94`) | **7** | all `src/runtime/laya/*` |
| Coverage | floor 80 (`AGENTS.md:71`) | **no `coverage` block at all** | `vitest.config.ts` |
| CI | none | **none** (no root `.github/`) | `Get-ChildItem .github` |
| `pino` | removed | **extraneous, 12 pkgs in lock** | `npm ls pino`, `package-lock.json:15` |
| Desktop dead w/ passing tests | 3 (`03-desktop.md:597`) | **1** (`Crest.tsx` + `Crest.test.tsx`) | grep over `apps/desktop/src` + `e2e` |
| Telemetry subsystems live | 6 | **4** (`LAYA`, `LAUNCHER` have no producer) | `writer.ts:37` |
| Uncaught-exception handlers | — | **0** | grep `src/**/*.ts` |
| Rust panic hook / tracing | — | **0 / 0** | `main.rs` (2,903 lines) |
| `createLogger` production callers | — | **1** (`writer.ts:101`) | grep `src/**/*.ts` |

# APPENDIX B — Sources

**Repo:** `AGENTS.md:51-186`; `package.json:3,16-31,32-37`; `vitest.config.ts:5-28`;
`scripts/lint-baseline.mjs:17,37-63,106-127`; `scripts/lint-baseline.json`;
`scripts/provision-sidecar.mjs:44-62`; `scripts/packaging-preflight.mjs` (whole file);
`apps/desktop/package.json`; `apps/desktop/playwright.config.ts:26-32`;
`apps/desktop/e2e/stub-daemon.mjs:4-5,17-27,29-42,58-144`;
`apps/desktop/src/bridge/ws.ts:271-283`; `apps/desktop/src/bridge/ws.test.ts:75-125`;
`apps/desktop/src/components/portals/portals.test.tsx:52-58`;
`src/telemetry/writer.ts:37,64-70,100-101,106-113,140-155,161-170`;
`src/common/logger.ts:1-30,70,266-306`; `src/common/index.ts:7`; `src/cli.ts:7,17,35,71,241-242`;
`src/daemon.ts:22,183,257,447-461,566-624,709-816,869,914`;
`src/ipc/ui-server.ts:200-211,382-389`; `src/knowledge/index.ts:1-7`;
`src/knowledge/shared/architecture.ts:67-84`; `src/knowledge/shared/capabilities.ts` (`cap-tts-free-tier`);
`src/voice/tts.ts:14-17,31`; `src/voice/keyring.ts:176`;
`src/policy/sidecar-safety.test.ts:9-14,26-32,40`; `src/policy/telemetry-wired.test.ts:8-12,28`;
`src/policy/laya-sidecar-safety.test.ts:8-12,16-23,226,261`;
`apps/desktop/src-tauri/src/main.rs:515-539,537,549-559,1696`; `apps/desktop/src-tauri/Cargo.toml:20`;
`package-lock.json:3,9,15,3343`; `apps/desktop/package-lock.json:3,9`;
`README.md:12,257,313-320,324-336,341-348`; `assets/benchmark-matrix.svg`;
`dossier/PROJECT_MASTER_DOSSIER.md:689-716`; `docs/10-CHECKPOINT.md:744-745`;
`.opencode/_audit/03-desktop.md:597-613`; `.opencode/_audit/05-tests.md:140-147,726-841`;
`.opencode/_audit/06-security-build.md:14-27`; `.opencode/_audit/07-doc-reconciliation.md:39-209`;
`.opencode/_audit/20-w3-csprng.md`; `.opencode/_audit/30-w7-deadcode-docs.md:308`;
`.opencode/_audit/40-w2b-redaction.md`; `.opencode/_audit/50-w5-laya.md`; `.opencode/_audit/70-w6-phantom-ui.md`.

**Web:**
- [VS Code telemetry levels](https://code.visualstudio.com/docs/configure/telemetry) · [enterprise TelemetryLevel policy](https://code.visualstudio.com/docs/enterprise/telemetry) · [opt-out criticism (HN)](https://news.ycombinator.com/item?id=28812486)
- [Ollama privacy policy](https://ollama.com/privacy) · [LM Studio app privacy policy](https://lmstudio.ai/app-privacy) · [local-AI privacy audit (no-telemetry / opt-in principle)](https://www.local-llm.net/blog/local-ai-privacy-audit) · [local LLM privacy checklist (LM Studio analytics off)](https://www.promptquorum.com/local-llms/local-llm-security-privacy-checklist)
- [Comfy Desktop #1199 — local-only crash reporter, per-incident opt-in, "Save report…" fallback](https://github.com/Comfy-Org/Comfy-Desktop/issues/1199)
- [Microsoft — Collecting User-Mode Dumps (WER LocalDumps)](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps) · [Creating an Application Crash Dump](https://helgeklein.com/blog/creating-an-application-crash-dump)
- [tauri-apps/plugins-workspace — no crash-report plugin](https://github.com/tauri-apps/plugins-workspace) · [Tauri logging plugin](https://v2.tauri.app/plugin/logging/)
- [`tracing` crate (tracing-appender, non-blocking writer)](https://docs.rs/tracing) · [per-layer filtering example](https://github.com/tokio-rs/tracing)
- [OpenTelemetry Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs) · [Inngest OTLP guide](https://www.inngest.com/blog/opentelemetry-nodejs-tracing-express-inngest) · [Better Stack OTLP guide](https://betterstack.com/community/guides/observability/opentelemetry-nodejs-tracing)
- [Sentry/PostHog privacy launch gate — `beforeSend` family and deny-list scope](https://vibeshiplab.com/sentry-posthog-ai-apps-privacy-launch-gate) · ["enforced it and shipped the leak anyway"](https://dev.to/arqamwd/i-wrote-the-privacy-rule-enforced-it-commented-it-and-shipped-the-leak-anyway-500g) · [nine places sensitive data lands on-device](https://www.nathanhallouin.dev/en/blog/sensitive-data-mobile-app-nine-places)

**UNVERIFIED, explicitly:** Playwright run result (ports owned by the orchestrator); whether any provider echoes an `Authorization` header in an error body; whether `npm ci` hard-fails or silently installs on the `package-lock.json:15` skew (running it would delete the `node_modules` the gate depends on); live free-tier latency for any provider (no keys burned in this session).
