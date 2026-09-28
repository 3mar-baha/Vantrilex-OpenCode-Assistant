# Remediation & Swarm Orchestration Plan

**Status: PROPOSAL. No code modified.** Authored against `824a441`, v0.7.2.
Evidence base: `dossier/PROJECT_MASTER_DOSSIER.md` Part II (§7.1–7.11) and the
seven reports in `.opencode/_audit/01-07` (494 KB).

---

## 0. What the catalog actually is — read this before assigning anything

I extracted the full inventory from `O:\vantrilex-registry\VANTRILEX_CATALOG.md`
(430,181 bytes, 2,727 lines) and cross-checked every count against the
filesystem.

| Section | Catalog claim | Files on disk | Verdict |
|---|---|---|---|
| Skills | 1485 | 1486 | **accurate** (1485 + a `README.md`) |
| MCP servers | 902 | 903 | **accurate** (902 + `README.md`) |
| Plugins | 12 | 13 | **accurate** (12 + `README.md`) |
| Hooks | 18 | 19 | **accurate** (18 + `README.md`) |
| Agents | 282 | 283 | **accurate** (282 + `README.md`) |

The catalog's own arithmetic is clean. I nearly reported five mismatches before
checking for the per-folder `README.md`; the counts were right and my first read
was wrong.

**The problem is fitness, not accuracy.** 2,699 components, and the great majority
have nothing to do with a local Windows voice daemon. Sampling by keyword:

- **Offensive security, not remediation.** `abusing-dpapi-for-credential-access`,
  `abusing-shadow-credentials-for-privesc`, `Brute Force: Credential Stuffing`,
  `Account Takeover: Exposed API Key`, `deceiving-llms-with-guardrails` siblings,
  `detecting-exfiltration-over-dns-with-zeek`. These are attacker playbooks.
  Assigning one to "fix our secret handling" is a category error.
- **NVIDIA/TensorRT LLM serving.** `perf-torch-cuda-graphs`,
  `trtllm-moe-develop`, `nemoclaw-user-configure-inference`, `ptq`, `deployment`.
  Relevant only to the Laya lane, and only `ptq` and `AI-Research-SKILLs`.
- **Unrelated verticals.** Drupal, WordPress, Unreal, Godot, Blender, KiCad,
  Unity, HR onboarding, HIPAA, legal review, blockchain, CISA zero-trust maturity,
  Palo Alto, Tailscale.
- **Duplicate frameworks.** `cypress-skill`, `testcafe-skill`,
  `webdriverio-skill` — this project uses Playwright and has 18 passing E2E
  tests. Adopting a second E2E framework to fix phantom UI controls would be a
  regression dressed as a remedy.

**Consequence, stated plainly: the plan below assigns from a small, identified
subset. Every component named is one I read in the catalog. I have not padded
any lane to look thorough.** Where nothing in the catalog fits, I say so rather
than forcing a name — see §1.3 (no Rust specialist) and §1.4 (tmux hooks are
useless on Windows).

Separately: four MCP servers are **already wired into this session and are not in
the catalog at all** — `context7`, `opencode`, `browser`, `obsidian-vault`.
Catalog membership is not a prerequisite for use.

---

## 1. Swarm architecture

### 1.1 Sizing: 8 workers, 3 serialized lanes, 3 waves

Not one wide wave. Three reasons, each grounded in evidence:

1. **Windows makes several work items mutually exclusive.** `test:e2e` binds
   ports 4096, 4097 and 4197 and fails with `EADDRINUSE` if two agents run it
   at once. `cargo` needs the MSVC environment loaded via `VsDevCmd.bat`. Two
   Rust agents cannot compile concurrently in this setup.
2. **The gate is a single shared resource.** `npm run test:vantrilex` rebuilds
   root `dist/` and runs E2E. Two agents editing `src/**` and running the gate
   concurrently will produce results neither can trust.
3. **Context is a hard budget.** Seven 400–990-line reports were already close to
   the limit. Reports are written to files with ≤20-line returns.

Lane A (TypeScript and the gate) → Lane B (Rust and native) → Lane C
(frontend, dependencies, docs) run concurrently *with each other*, sequenced
*within* themselves.

### 1.2 Model allocation: 4 native / 4 OpenRouter

Verified available via the models tool: `opencode/space-bunny-free` and
`openrouter/stealth/space-bunny-alpha` (no `:free` suffix — a guess with the
suffix 404s). Assignment is by workload fit, not by quota.

| Lane | Workers | Model | Rationale |
|---|---|---|---|
| A | W1, W2 | `opencode/space-bunny-free` | TypeScript-heavy, benefits from the tighter edit loop on 62 errors in 9 files |
| B | W3, W4, W5 | `openrouter/stealth/space-bunny-alpha` | Rust, native modules and ML export are longer-horizon reasoning tasks |
| C | W6, W7 | `opencode/space-bunny-free` | React/TypeScript edits, same profile as Lane A |

Balance is 4 / 4. W2 (secrets) is owner-gated and is not dispatched as a worker —
see §4.

### 1.3 Catalog gap: no Rust specialist

I sampled all 282 agent rows against `rust|cargo|systems|systems programmer` and
found no dedicated Rust/ systems-programming agent. The nearest fit is
`Senior SecOps Engineer` (defensive application security, scans code
submissions), which is appropriate for W3 and W4 but a poor fit for W5's ONNX
export work. **Recommendation: use the harness-native `rust-refactoring-specialist`
for W5's Rust surface, and say so in the plan rather than pretend a catalog agent
covers it.** This is the one place I am departing from catalog-only selection,
and the reason is that the catalog does not contain the role.

### 1.4 Catalog gap: tmux hooks are inert on Windows

`block-dev-servers-outside-tmux` (default-selected) and
`reminder-to-use-tmux-for-long-running-commands` both assume tmux. This project
builds on Windows with PowerShell, where tmux does not exist. These hooks will
either no-op or emit a false instruction during W3/W4/W5, which run long `cargo`
builds. **Neither is assigned.** Substituting a PowerShell-aware long-run
reminder is a reasonable follow-up, not part of this remediation.

---

## 2. Per-agent missions

Every objective below cites the physical evidence that justifies it. Every
worker writes exactly one report file and returns ≤20 lines. **No worker
commits, pushes, or edits a file outside its declared write set.**

---

### Lane A — TypeScript and the gate

### W1 · Eliminate the 62 latent test type errors

**Evidence:** `dossier` §7.8. Root `tsconfig.json` sets
`exclude: ["**/*.test.ts"]` and Vitest transpiles without checking types, so all
46 root test files and the whole desktop renderer compile under no type checker.
A probe config exits 2 with **62 errors across 9 files**: 20 × `TS2554` in
`narrator.test.ts`, 19 × `TS18047` in `opencode-bridge.test.ts`, 4 each in
`brain.test.ts` / `tts.test.ts` / `command-router.test.ts`, and singles in
`client.test.ts`, `stt.test.ts`, `audio-pipeline-reset.test.ts`,
`fr12-route.test.ts`.

- **Agent persona:** `build-error-resolver` — *"Build and TypeScript error
  resolution specialist. Use PROACTIVELY when build f…"* (catalog, agents).
  The most precisely matched role in the entire catalog for this lane.
- **Skills:** `coding-standards`; `migrate-to-shoehorn` (*"Migrate test files
  from `as` type assertions to @total-typescript/…"* — several errors are
  assertion-shaped, so this is the correct lever); `ponytail` ✅.
- **Plugins:** `typescript-lsp` ✅ (default-selected; the right tool for the
  job); `commit-commands` ✅.
- **Hooks:** `typescript-check-after-editing-ts-tsx-files` — *this hook would
  have caught the `corpus.test.ts` error I shipped the same day*. Assigning it
  here is the cheapest possible fix for a whole class of defect;
  `reminder-before-git-push-to-review-changes`.
- **MCP:** `sequential-thinking` ✅ (decompose 62 errors by root cause before
  editing); `filesystem` ✅ (read/write the report).
- **Model:** `opencode/space-bunny-free`.

**In-scope:** `src/**/*.test.ts`, `tsconfig.tests.json`, `package.json`
(`typecheck:tests` wiring decision), `AGENTS.md` test-gate section.

**Out of scope:** production `.ts` sources (Lane B owns Rust; nothing else owns
production TS in this lane).

---

### W2 · Secret handling: S1 owner-gated, S3 by decision

Split deliberately, because the two halves have different authority.

**W2a — S1, the plaintext keys. NOT a worker.** `.env.local:3-5` holds three
live provider keys. Verified containment: `.gitignore:19` (`*.local`), zero
tracked files, **zero objects across all git history**. Exposure is local disk
only. Rotation requires invalidating and reissuing credentials at Groq, Fish
Audio and OpenRouter, and a human must paste the replacements. **No agent may
handle these values.** Task for the owner; tracked in §4.

**W2b — S3, the dead redacting logger.**

- **Evidence:** `dossier` §7.3 S3. `createLogger` / `redactSecrets` have zero
  production callers; the only `containsSecret` consumer is a quarantined
  `ledger.ts`. `pino` is declared, bundled into the sidecar and never
  instantiated. Every real diagnostic path — `console.log`, the telemetry
  writer, Rust `log_line` — bypasses redaction. The patterns omit any
  `sk-or-v1-` case and skip non-string arguments.
- **Agent persona:** `Senior SecOps Engineer` — *"Defensive application security
  specialist who scans every code submissio…"*.
- **Skills:** `defending-llms-with-guardrails` (for the Tier-D guard
  interaction); `implementing-api-key-security-controls` (*"Implements secure API
  key generation with sufficient entropy, server-side storage…"* — directly
  relevant to the redaction surface); `ponytail` ✅.
- **Plugins:** `security-guidance`; `code-review` ✅.
- **Hooks:** `warn-about-console-log-statements-after-edits`;
  `check-for-console-log-in-modified-files-after-each-response` — both target the
  exact bypass path this lane must close.
- **MCP:** `filesystem` ✅; `memory` ✅.
- **Model:** `opencode/space-bunny-free`.

**Deliverable is a DECISION, not a guess:** wire redaction into every diagnostic
path, or delete the module and the `pino` dependency. Leaving a
security control that the project believes it has and does not is the worst of
the three outcomes. If wiring, non-string arguments and `sk-or-v1-` must be
covered by tests that fail when the wiring is removed.

---

### Lane B — Rust, native modules, ML

### W3 · S2: real CSPRNG for `ipc.token` and `serve.pass`

- **Evidence:** `dossier` §7.3 S2 and `AGENTS.md` Gates. `main.rs:460-476` and
  `:501-517` derive both secrets from **xorshift64\* seeded `nanos ^ pid`**. The
  `fs::write` calls at `:478` and `:519` set no restrictive mode, so the `(0600)`
  comments at `:444` and `:482` are false. The daemon's own `randomBytes(32)`
  (`daemon.ts:746`) is stronger than the generator that actually runs. **No test
  runner executes `main.rs`.**
- **Agent persona:** `security-reviewer` — *"Security vulnerability detection
  and remediation specialist."*
- **Skills:** `implementing-api-key-security-controls` (entropy and
  server-side storage — the precise skill for this defect); `ponytail` ✅.
- **Plugins:** `security-guidance`; `commit-commands` ✅.
- **Hooks:** `reminder-before-git-push-to-review-changes`;
  `save-state-before-context-compaction` (long `cargo` cycles).
  **Not** the tmux hooks (§1.4).
- **MCP:** `filesystem` ✅; `memory` ✅.
- **Model:** `openrouter/stealth/space-bunny-alpha`.

**Required:** a `getrandom`/`rand` dependency OR a documented OS-source path;
restrictive permissions on both files on Windows; and at least one test that
fails if the xorshift is reinstated. `packaging-preflight.mjs` currently reports
14/15 with MSVC missing, so the Rust half may be unverifiable here — if so,
say UNVERIFIED rather than claiming a fix.

---

### W4 · Lifecycle correctness: C2, C4, C7

- **Evidence:** `dossier` §7.5.
  - **C2** — a second launch **silently adopts** an existing 4097 holder and
    reports `ready`. `port_open()` is a bare TCP connect (`main.rs:540-543`),
    so `EADDRINUSE` is unreachable from the shell path (`:796-798`).
  - **C7** — `Supervisor::own` uses `is_none_or` (`main.rs:360`), so a
    job-creation failure yields `ok: true`, the child is recorded as supervised,
    `unadopted` stays 0, and only the graceful reap is left. This contradicts
    `main.rs:89-93` "There is no safe 'ignore' here."
  - **C4** — only `switchSession` bumps `AudioPipeline.generation`; `abort` trips
    `SpeechGate` only, so an in-flight `think()` is never abandoned
    (`audio-pipeline.ts:64-71`).
  - Also **C9**, `daemon.ts:508` re-admitting the raw `@`-bearing transcript that
    `:474-477` intends to strip.
- **Agent persona:** `Senior SecOps Engineer` (C2 and C7 are supervision
  failures, not style).
- **Skills:** `coding-standards`; `tdd-workflow`; `ponytail` ✅.
- **Plugins:** `typescript-lsp` ✅ (C4 and C9 are TypeScript);
  `code-review` ✅.
- **Hooks:** `typescript-check-after-editing-ts-tsx-files`;
  `reminder-before-git-push-to-review-changes`.
- **MCP:** `filesystem` ✅; `sequential-thinking` ✅.
- **Model:** `openrouter/stealth/space-bunny-alpha`.

**Required for C2:** decide adopt-or-refuse and make the decision visible to the
user. Silent adoption is the defect; either behaviour is acceptable if it is
stated. A test must distinguish "our daemon owns 4097" from "something else does".

---

### W5 · Laya System-1 reflex engine — the highest-risk item

**Read this before approving W5.** This is the one work stream that can break a
released product.

- **Evidence.** From the forensic search: `.opencode/_archive/dead-code-phase1/
  src/runtime/laya/` (`index.ts`, `laya-engine.ts`), `ml/train_laya.py`,
  `ml/export_onnx.py`, and `models/laya-m7-int8.onnx`. A `LAYA` value exists in
  the telemetry `SubsystemSchema` (`writer.ts:36`) with **no producer**. The
  catalog-independent skills `laya-ml-gates` and `laya-ml-engineer` already
  describe the intended train → export → parity → latency → quantization
  workflow, which means the design exists and the wiring does not.
- **The risk, stated up front:** `laya-engine.ts` depends on `onnxruntime-node`,
  a **native module**. The identical class of dependency is what made v0.6.0
  ship a daemon that could not boot — every gate green, product dead. Adding a
  second native import to the sidecar is exactly how that recurs.
- **Agent persona:** `AI Engineer` — *"Expert AI/ML engineer specializing in
  machine development, depl…"*; with the harness-native
  `rust-refactoring-specialist` for any Rust surface (§1.3).
- **Skills:** `ptq` — the model is `int8`, and quantization parity is the gate
  that matters; `AI-Research-SKILLs` (MLOps); `ponytail` ✅.
  **Rejected from the catalog:** every `perf-torch-*`, `trtllm-*`, `nemoclaw-*`
  and CUDA entry — this is CPU-only ONNX, and those assume GPUs this box may not
  have.
- **Plugins:** `pyright-lsp` (for `ml/*.py`); `code-review` ✅.
- **Hooks:** `reminder-before-git-push-to-review-changes`;
  `save-state-before-context-compaction` (export and parity runs are long).
- **MCP:** `filesystem` ✅; `sequential-thinking` ✅.
- **Model:** `openrouter/stealth/space-bunny-alpha`.

**Recommended sequencing — do NOT do this in one step.** Stage 1: restore
`src/runtime/laya/` from quarantine **behind the same dynamic-import guard as
`runtime/vad.ts`** (dynamic, never static — `sidecar-safety.test.ts` enforces
that pattern for exactly this reason) and light the `LAYA` telemetry producer.
Stage 2, only after Stage 1 is green: decide whether the reflex gate is on the
speech path at all. **Recommend against Stage 2 in this cycle.** Laya adds a
native dependency to a shipped Windows sidecar for a latency benefit that has not
been measured on this hardware.

---

### Lane C — frontend, dependencies, documentation

### W6 · Phantom UI controls and dead renderer modules

- **Evidence:** `dossier` §7.6. `mute`, `deafen` and `arm` are unconditional
  no-ops server-side (`command-router.ts:227-230`) yet still cost an Inkling
  narration call describing silencing a microphone that was never silenced.
  `botMuted` never gates playback (`App.tsx:141-156`) — **the assistant-mute
  button mutes nothing and acknowledges `ok: true`**. Dead production modules
  with *passing* tests: `audio/earcons.ts` (5 recipes, 5 tests, zero importers),
  `brand/Crest.tsx`, `portals/CredentialPortal.tsx`; `matrix-state.ts` ~85 % dead.
  The 48×48 matrix is never drawn, so `docs/RELEASE-CHECKLIST.md:18`'s "worker
  chunk 2.78 kB" cannot exist. The uncancelled 1.5 s `onEnd` latch
  (`App.tsx:148`) mis-drives `waveSpeaker` on re-entry. `notice` is single-slot,
  so `assistant-said` can evict the `voice-disabled-no-keys` CTA. Optimistic
  writes (`agentModel`, `persona`, `matrix`) are never reconciled.
- **Agent persona:** `Frontend Developer` — *"Expert frontend developer
  specializing in modern web technologies, React/Vue/A…"*.
- **Skills:** `frontend-patterns` (React state management — the 11-axis state
  problem is a state-architecture problem); `ponytail` ✅.
- **Plugins:** `typescript-lsp` ✅; `code-simplifier` (for the dead modules);
  `code-review` ✅.
  **Rejected:** `frontend-design` — this is remediation, not design, and the
  instruction is not to restyle the HUD.
- **Hooks:** `typescript-check-after-editing-ts-tsx-files`;
  `check-for-console-log-in-modified-files-after-each-response`.
- **MCP:** `filesystem` ✅; `memory` ✅.
- **Model:** `opencode/space-bunny-free`.

**Required decision, stated the same way as W2b:** a control that acknowledges
`ok: true` and does nothing is the worst outcome. Either make `mute` gate
playback, or remove the control and say so. Also: delete the dead modules or
wire them, and if deleting, delete their passing tests too — a correct test on
unreachable code is a green lie.

---

### W7 · Dead code, unused dependencies, dead coverage config, doc truth

- **Evidence:** `dossier` §7.6–7.8 and auditor 6/7.
  - Unused production deps: `pino` (see W2b), `@opencode/client` (zero imports),
    `eventsource` (zero imports, and bundled into the sidecar), plus
    `lucide-react` and `simplex-noise` in the desktop app.
  - `vitest.config.ts` declares `thresholds: { lines: 80 }` but nothing sets
    `coverage.enabled`, no manifest passes `--coverage`, and there is no CI. **The
    threshold has never executed and reads like a floor.**
  - Six mutually exclusive root totals asserted repo-wide (220, 309, 498, 509,
    568, 572); `README.md` contradicts itself (572/153 at :332 vs 220+89 at
    :366/:443) and its badge claims `583 unit + 26 rust` (27 on disk).
  - `README.md:320-326` fabricated metrics were withdrawn in `e7cc239`; the SVG
    they generated still needs withdrawing.
  - `docs/11-TESTING.md` is largely phantom: `test/integration/`, `test/mocks/*`,
    `bench/latency.ts`, `pnpm bench`, `pnpm stress`, `.github/workflows/ci.yml`.
  - `docs/25:8` says `Authorization: Bearer`; `client.ts:11` says Bearer is
    rejected and uses Basic.
- **Agent persona:** `code-simplifier` is a plugin, so use the agent
  **`Technical Writer`** paired with the harness `explore` capability for
  dependency mapping.
- **Skills:** `setup-ts-deep-modules` — *"Wire dependency-cruiser into a
  TypeScript repo…"* — this is the correct instrument for establishing which
  modules are genuinely reachable before deleting anything;
  `detecting-malicious-npm-packages` (triage before removing packages);
  `ponytail` ✅.
- **Plugins:** `mgrep` (*"Enhanced search (better than ripgrep)"* — the right tool
  for establishing an import graph across 51 live modules); `code-simplifier`;
  `context7` (for the coverage option syntax under Vitest 4).
- **Hooks:** `block-creation-of-random-md-files-keeps-docs-consolidated` — the
  audit found twelve documents that should carry supersession banners and do not,
  which is exactly the sprawl this hook prevents.
- **MCP:** `aos-standard/mcp-blast-radius` (*"static blast radius extraction"* —
  directly applicable to "what breaks if I delete this module", and the correct
  guard against W6-style deletion that removes a live path);
  `appcreationsca/bumpguard-mcp` (dependency-upgrade impact);
  `filesystem` ✅.
- **Model:** `opencode/space-bunny-free`.

**Required:** coverage must either be enabled and the threshold enforced, or the
threshold deleted. A configured floor that never runs is worse than no floor,
because it is read as a guarantee. Every test count in `README.md`, `CHANGELOG.md`
and the badge must resolve to the same number, measured, with the command shown.

---

## 3. Sequencing and the shared-resource lock

| Wave | Lane A | Lane B | Lane C | Gate free? |
|---|---|---|---|---|
| 1 | W1 (62 type errors) | W3 (CSPRNG) | W7 (dead code/docs) | Lane A owns `dist/` + E2E |
| 2 | W2b (S3 decision) | W4 (lifecycle) | W6 (phantom UI) | Lane A owns E2E |
| 3 | — | W5 stage 1 only | — | full gate |

**Hard rules, all derived from documented Windows behaviour:**

1. **E2E port lock.** Only one lane runs `npm run test:e2e` at a time. Ports
   4096/4097/4197 must be free; a running installed `voxaura.exe` causes
   `EADDRINUSE`. Lane A holds the lock in waves 1 and 2.
2. **Cargo lock.** Only Lane B runs `cargo`. MSVC must be loaded first:
   `cmd /c '"…\VsDevCmd.bat" -no_logo >nul 2>&1 && cargo test'`. Verify
   `$LASTEXITCODE` **unpiped** — a piped command reports a false failure.
3. **W5 is gated on W3 completing.** Do not add a second native dependency while
   the token generation one is in flight.
4. **W6 is gated on W1 completing**, because `narrator.test.ts` holds 20 of the
   latent type errors and touching the narrator without them fixed is how the
   20th one becomes a runtime failure.

---

## 4. Not a worker — owner actions

| ID | Action | Why an agent cannot do it |
|---|---|---|
| S1 | **Rotate `GROQ_API_KEYS`, `FISH_AUDIO_KEYS`, `OPENROUTER_API_KEYS`.** Containment already verified: gitignored, never committed, local-disk exposure only. | Requires invalidating and reissuing live credentials at three vendors. |
| SEC-7 / L18 | Verify the packaged microphone grant on hardware with a mic. | Physical hardware. The only non-closed ledger row. |
| W2b-choice | Choose wire-redaction vs delete-redaction. | A product decision with a security trade-off. The agent delivers the analysis and a recommendation. |
| W5-stage2 | Whether the Laya reflex gate goes on the speech path. | Recommend **no** this cycle: a new native sidecar dependency, unmeasured latency benefit, and a v0.6.0 precedent of shipping a daemon that could not boot. |
| Debt-policy | Wire `typecheck:tests` into the gate, or baseline it as the linter was baselined. | A permanently red gate stops being read. The agent proposes; the owner decides. |
| Fish migration | Decide before **2026-11-30**, when the free tier expires. | Product/finance. |

---

## 5. Circuit breakers

### 5.1 Entry criteria (all workers, before any edit)

- `npm run test:vantrilex` exits **0** on a clean `main`. If not, the worker
  stops and reports; it does not fix unrelated breakage.
- The worker's scope is disjoint from every other active lane's write set.
- The worker's report file path is writable and no other file is open for edit.

### 5.2 In-flight invariants

| Invariant | Value | Enforced by |
|---|---|---|
| Root tests | **572 / 46 files**, never fewer | AGENTS.md: *"keep these moving up, never down"* |
| Desktop tests | **153 / 24 files**, never fewer | as above |
| E2E | **18 / 14 specs** | as above |
| Rust tests | **27** | as above |
| oxlint | **exactly 8** warnings, 0 errors | `scripts/lint-baseline.mjs` ratchet |
| Dead code in `src/` | **0** of 51 live modules | transitive walk, **dynamic imports included** |
| Tier 1 persona key | **0** | `SHARED_HAS_NO_PERSONA` (compile-time) + `assertSharedChunks` (runtime) |
| Gate | exit **0** | `npm run test:vantrilex` |

**A falling test count is not automatically a regression** — check `git log`
first. The count has legitimately fallen before (491 → 498 while 70 tests were
deleted). What is not negotiable is a fall with no corresponding deletion
justified in the report.

### 5.3 Non-vacuous test requirement

Every guard a worker adds must be verified by **breaking it** before the work is
accepted. The project's rule, and the reason several tests here were previously
vacuous:

- Add the guard. Confirm it passes.
- Disable the fix. Confirm the test **fails**, with a message naming the guard.
- Restore. Confirm green.

A guard that has never been observed failing is not a guard; it is a comment. No
worker may report a guard as verified on the strength of a passing run alone.

### 5.4 Exit conditions per worker

A worker is **done** only when all hold:

1. Its report file exists at its declared path, with `file:line` for every claim.
2. `npm run test:vantrilex` exits 0, with counts at or above §5.2.
3. Every new guard has a recorded break-the-guard transcript in the report.
4. Every number is either measured (with the command) or marked **UNVERIFIED**.
   No number may be recalled, estimated, or copied from a document.
5. No file outside its declared write set is modified: `git status --porcelain`
   shows only intended paths.
6. It has **not** committed or pushed. Commits are the orchestrator's decision.

### 5.5 Circuit breakers — stop conditions

Any worker halts immediately, reports, and changes nothing further if:

- `npm run test:vantrilex` exits non-zero **twice** for reasons outside its scope.
- It discovers a **secret** in tracked or untracked content. It reports the
  location and a SHA-256 prefix, never the value, and stops.
- It cannot typecheck or build its target and the blocker is environmental
  (MSVC, `makensis`, port contention). It reports UNVERIFIED — it does not
  proceed on assumption.
- Its change would make the oxlint ratchet exceed 8, or dead code exceed 0.
- It discovers a work item materially larger than its lane (for example, W7
  finding that a documented subsystem is entirely absent). It reports scope
  instead of expanding.

---

## 6. Component selection summary

| Worker | Agent persona | Skills | Plugins | Hooks | MCP | Model |
|---|---|---|---|---|---|---|
| W1 | `build-error-resolver` | `coding-standards`, `migrate-to-shoehorn`, `ponytail` | `typescript-lsp`, `commit-commands` | `typescript-check-after-editing-ts-tsx-files`, `reminder-before-git-push-to-review-changes` | `sequential-thinking`, `filesystem` | native |
| W2b | `Senior SecOps Engineer` | `defending-llms-with-guardrails`, `implementing-api-key-security-controls`, `ponytail` | `security-guidance`, `code-review` | `warn-about-console-log-statements-after-edits`, `check-for-console-log-in-modified-files-after-each-response` | `filesystem`, `memory` | native |
| W3 | `security-reviewer` | `implementing-api-key-security-controls`, `ponytail` | `security-guidance`, `commit-commands` | `reminder-before-git-push-to-review-changes`, `save-state-before-context-compaction` | `filesystem`, `memory` | openrouter |
| W4 | `Senior SecOps Engineer` | `coding-standards`, `tdd-workflow`, `ponytail` | `typescript-lsp`, `code-review` | `typescript-check-after-editing-ts-tsx-files`, `reminder-before-git-push-to-review-changes` | `filesystem`, `sequential-thinking` | openrouter |
| W5 | `AI Engineer` (+ harness `rust-refactoring-specialist`) | `ptq`, `AI-Research-SKILLs`, `ponytail` | `pyright-lsp`, `code-review` | `reminder-before-git-push-to-review-changes`, `save-state-before-context-compaction` | `filesystem`, `sequential-thinking` | openrouter |
| W6 | `Frontend Developer` | `frontend-patterns`, `ponytail` | `typescript-lsp`, `code-simplifier`, `code-review` | `typescript-check-after-editing-ts-tsx-files`, `check-for-console-log-in-modified-files-after-each-response` | `filesystem`, `memory` | native |
| W7 | `Technical Writer` | `setup-ts-deep-modules`, `detecting-malicious-npm-packages`, `ponytail` | `mgrep`, `code-simplifier`, `context7` | `block-creation-of-random-md-files-keeps-docs-consolidated` | `aos-standard/mcp-blast-radius`, `appcreationsca/bumpguard-mcp`, `filesystem` | native |

**Catalog components deliberately not assigned**, each with a reason:
`cypress-skill` / `testcafe-skill` / `webdriverio-skill` (wrong E2E framework —
Playwright already passes 18); `abusing-dpapi-for-credential-access`,
`abusing-shadow-credentials-for-privesc`, `Brute Force: Credential Stuffing` and
the other ~30 offensive-security entries (attacker playbooks, not remediation);
`perf-torch-*` / `trtllm-*` / `nemoclaw-*` (GPU LLM serving; Laya is CPU-only
ONNX); `frontend-design` (remediation, not restyling); `hookify` (no new hooks
needed); `block-dev-servers-outside-tmux` and
`reminder-to-use-tmux-for-long-running-commands` (**inert on Windows** — tmux does
not exist here); the entire Drupal / WordPress / Unreal / Godot / Blender /
KiCad / Unity / healthcare / legal / HR / blockchain verticals.

---

## 7. What this plan does not do

- It does not wire Laya onto the speech path. Stage 1 only, and Stage 2 is
  recommended against this cycle.
- It does not add `typecheck:tests` to the gate. That is the owner's debt-policy
  call; the agent proposes, the owner decides.
- It does not change the Fish Audio model or migrate providers. The free tier
  expires 2026-11-30 and that is a separate decision.
- It does not re-run the seven-auditor audit afterwards. If a second audit is
  wanted, it should be fresh agents with no knowledge of this plan.
- It does not treat a green gate as proof. §5.3 exists because the gate was exit
  0 the entire time three of the four worst defects were live, including one
  committed the same hour they were found.
