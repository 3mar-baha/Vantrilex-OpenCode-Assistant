# PLAN.md — Master Plan: GATE 2 → Completion

**Status:** Active execution (GATE 2 in progress). Ratified taxonomy + O1–O6
recorded in ADR-010 (`docs/09-DECISIONS.md`).
**Taxonomy (normative):** `Voxaura` = desktop shell (`apps/desktop/`);
`A.R.E.E.B. (أَرِيب)` = Type-1 foundational model (`src/runtime/laya/` is its
current engine); `Kareem (كريم)` / `Nour (نور)` = dual voice personas.
**Author lane:** Lead Systems Architect / Orchestrator.
**Baseline commit:** `52ba876` (`chore(arm): GATE 1 …`), tree clean except untracked
`vantrilex-registry/`.
**Supersedes:** ad-hoc gate lists in `LAYA-EVALUATION-AND-ROADMAP.md` and the
six-step ordering sketched in `LAYA-FINAL-SYNTHESIS-AND-FUTURE-ROADMAP.md` (both
retained for provenance).

---

## 0. Verified State Reconciliation (read this before the gate list)

The gate names supplied for this mission — *Floating Dialog Portals*, *Crest &
Sidebar Icon Cluster*, *Ambient Agent & Watcher Loop*, *Production Build* —
describe a **desktop application**. This repository does not currently contain
one. That is not an opinion; it is measured.

| Claim implied by the gate names | Verified evidence (2026-09-24, HEAD `52ba876`) |
|---|---|
| Tauri/Rust shell exists | `src-tauri/` = False · `Cargo.toml` = False · `tauri.conf.json` = False |
| React/Vite/Tailwind renderer exists | no `.tsx`/`.jsx`/`.html`/`.css` outside `.venv` · `vite.config.*`, `tailwind.config.*`, `index.html` all False |
| UI components / portals / sidebar / crest exist | grep for `crest|sidebar|portal|FloatingDialog|watcher` in `src/**/*.ts` → **1 comment hit only** (`src/ui/modal.ts:5`) |
| A UI defect backlog exists to remediate | none recorded in `docs/`; no UI exists |
| `oxlint` is the linter | False (`eslint.config.js` is the real gate) |
| `test:vantrilex` script exists | False — `package.json` scripts are `build/typecheck/lint/test/bench/stress/doctor` |
| `bench/` and `test/stress/` exist | False — the scripts are **stale stubs** pointing at absent dirs |

What *does* exist and is real:

- Headless Node 22 ESM service: `src/{common,voice,orchestrator,runtime,launcher,ui,guidance}`.
- `src/ui/{mic,settings,modal,index}.ts` — **headless view-models**, explicitly
  "No DOM here — the native theme layer renders this model" (`modal.ts:6`).
- Laya System-1 INT8 ONNX (p50 24.86 ms @32), vault/keyring, ledger, launcher, sweeper.
- `.opencode/` armed in GATE 1: 9 new skills, 7 new agents, 3 hook references, 5 MCP servers.
- `pnpm-workspace.yaml` exists but declares **only `allowBuilds`** — no `packages:` globs.

**Consequence for this plan.** "UI Defect Remediation" cannot mean fixing a
non-existent UI. It is re-scoped to mean: *remediate the contract drift between
the headless view-models and the approved desktop/renderer specification* (e.g.
`modal.ts` exposes 3 sections while the approved spec calls for a 5-tab settings
suite). Building the missing shell is itself a gate. These are stated as
assumptions to confirm, not as facts.

**Open decisions requiring sign-off before GATE 2 executes** (see §5).

---

## 1. Invariants & Method (non-negotiable for every gate)

1. **Single Supervisor.** Node (`src/launcher/launcher.ts`, `sweeper.ts`) is the
   sole sovereign of `opencode serve --port 4096`. Tauri is window/tray/hotkey only.
   Exactly one `boot()` path.
2. **Advisory-only model + FR-12.** No model output executes destructive acts
   without confirmation (`src/orchestrator/orchestrator.ts`, band `[0.35,0.70)`).
3. **Measure, never assume.** Every gate exits on a committed artifact or a
   command's real output — never on a narrative.
4. **Atomic commits.** Conventional Commits, one concern per commit, author
   `3mar-baha <omarbaha224@gmail.com>`, push to `origin/main`.
5. **CPU-only.** No CUDA paths anywhere.
6. **Authorization boundary.** No `ml/` or `src/` production behavior changes
   without an explicit gate prompt; this plan itself changes no code.

---

## 2. Gate Map

| Gate | Title | Primary deliverable | Depends on |
|---|---|---|---|
| G1 ✅ | `/arm` — Self-preparation | Toolchain armed & recorded | — |
| **G2** | **Desktop Shell Scaffold, Floating Dialog Portals & UI Defect Remediation** | Build the missing shell + WS bridge + portals + contract remediation + lint/test harness parity | G1; Open Decisions O1–O3 |
| **G3** | **Crest & Sidebar Icon Cluster** | Brand crest, Lucide sidebar/action cluster, 48×48 matrix worker, earcons | G2 |
| **G4** | **Ambient Agent & Watcher Loop** | Backend runtime hardening + ambient loop + telemetry + persona RAG, surfaced in the shell | G2 (bridge), G3 (states) |
| **G5** | **Production Build & E2E Validation** | Tauri bundles, Playwright E2E, 3 GB budget proof, release gates | G3, G4 |

> The previously sketched "six-step runtime roadmap" (abort+purge, fail-closed
> Laya+VAD, idempotency, WS 4097, telemetry, worker canvas) is **absorbed** here:
> WS-4097 → G2; worker canvas → G3; abort/fail-closed/idempotency/telemetry/RAG → G4.

---

## 3. Per-Gate Specification

Each gate follows the same contract shape. `NEW` marks a path that does not exist
today and will be created by the gate.

### GATE 2 — Desktop Shell Scaffold, Floating Dialog Portals & UI Defect Remediation

**Objective.** Create the desktop shell that the approved architecture assumes,
connect it to the daemon over the authenticated WS-4097 bridge, implement the
floating dialog portals, and remediate the view-model↔spec contract drift. Leave
a working lint/test harness that includes `oxlint` and a `test:vantrilex` aggregate.

**Target subagents & skills**
- `desktop-app-engineer` (Tauri v2 shell, IPC isolation, capabilities)
- `frontend-developer` (React/Vite/Tailwind scaffolding)
- `ui-designer` (tokens, glass surfaces, portal motion)
- `test-automation-engineer` (Playwright harness skeleton)
- `architect` (freeze the WS contract + repo-shape decision record)
- Guards: `clean-code-guard`, `test-guard`, `tdd`, `typescript-esm-strict` skill.
- MCP: `context7` for Tauri v2 / React 18 / Vite / Tailwind current API.

**Precise file targets**
- `NEW` `packages:` block in `pnpm-workspace.yaml` (add `apps/*`) and `NEW` `apps/desktop/`.
- `NEW` `apps/desktop/package.json`, `apps/desktop/vite.config.ts`,
  `apps/desktop/tailwind.config.ts`, `apps/desktop/index.html`,
  `apps/desktop/src/main.tsx`, `apps/desktop/src/App.tsx`.
- `NEW` `apps/desktop/src-tauri/Cargo.toml`, `tauri.conf.json`,
  `src/main.rs`, `capabilities/default.json`.
- `NEW` `src/ipc/ui-server.ts` (WS `127.0.0.1:4097`, subprotocol `voice-ui.v1`,
  bearer = `VOICE_RUNTIME_IPC_TOKEN` from spawn env, hello frame
  `{contractVersion,nodePid,servePort,layaReady}`, `Last-Seq` resume).
- `NEW` `src/ipc/protocol.ts` (typed frames shared by daemon + renderer).
- `NEW` `apps/desktop/src/bridge/ws.ts` (reconnect 50 ms ±30 ms → 2.5 s cap).
- `NEW` `apps/desktop/src/components/portals/{SettingsPortal,ConfirmPortal,CredentialPortal}.tsx`.
- Modify (view-model remediation, headless-first): `src/ui/modal.ts` (3 sections
  → 5-tab model), `src/ui/settings.ts` (persona/tab fields), `src/ui/index.ts`.
- Tooling: `NEW` `.oxlintrc.json`, `NEW` `apps/desktop/playwright.config.ts`,
  modify `package.json` (`oxlint` dev dep, `lint:ox`, `test:vantrilex` aggregate).

**TDD contract (write tests first, red → green)**
- `src/ipc/ui-server.test.ts` (NEW): rejects missing/incorrect bearer; refuses
  version mismatch with explicit error frame; resumes from `Last-Seq` with
  `eventId` dedupe; 3 missed pings → reconnect.
- `src/ui/modal.test.ts` (extend `ui.test.ts`): the 5-tab model exposes
  Identity/Audio/Bridge/Keyring/System; credentials are counts-only, never material.
- `apps/desktop/src/bridge/ws.test.ts` (NEW): reconnect backoff sequence and
  resume-cursor correctness with mocked socket.
- `apps/desktop/src/components/portals/portals.test.tsx` (NEW): portal mounts
  outside app root; focus trap; Esc closes; reduced-motion honored.

**Quality criteria (all must pass)**
- `npx tsc --noEmit` → 0.
- `npx eslint . --max-warnings 0` → 0 (retained).
- `npx oxlint` → 0 (newly added; `.oxlintrc.json` scoped to `apps/` + `src/`).
- `npx vitest run` → green (existing 54 + new).
- `npm run test:vantrilex` → green (new aggregate: vitest at minimum; Playwright
  wired but allowed to be empty-suite in G2).
- Renderer budgets: initial JS ≤ 250 KB gzip; no `any`; strict TS in `apps/desktop`.
- Design tokens only (no pixel literals in components).

**Git commit spec** (atomic, in order)
- `docs(arch): record repo-shape + WS-4097 contract decision` → ADR in `docs/09`.
- `chore(desktop): scaffold tauri v2 + react 18 + vite + tailwind workspace`
- `feat(ipc): authenticated ws 4097 ui bridge with Last-Seq resume`
- `feat(ui): floating dialog portals (settings, confirm, credential)`
- `refactor(ui): align headless view-models with 5-tab settings spec`
- `chore(tooling): add oxlint + test:vantrilex aggregate gate`

**Auto-transition to GATE 3 when:** every quality criterion passes on a clean
tree, all six commits are pushed, and the bridge round-trips a hello frame
against a live daemon in a recorded test.

---

### GATE 3 — Crest & Sidebar Icon Cluster

**Objective.** Establish the visual identity: a brand crest, a Lucide-based
sidebar/action icon cluster, the 48×48 OffscreenCanvas matrix with its five
states, and the procedural/CC0 earcon layer.

**Target subagents & skills**
- `ui-designer` (crest, tokens, iconography, contrast)
- `frontend-developer` (React components + worker)
- `voice-ai-integration-engineer` (earcon routing through the abort contract)
- `test-automation-engineer` (visual budget + a11y checks)
- Guards: `frontend-design`, `design-taste-frontend`, `canvas-design`,
  `clean-code-guard`, `test-guard`.

**Precise file targets**
- `NEW` `apps/desktop/src/components/brand/Crest.tsx` (+ inline SVG asset).
- `NEW` `apps/desktop/src/components/sidebar/IconCluster.tsx` (Lucide, tree-shaken).
- `NEW` `apps/desktop/src/components/actionbar/ActionBar.tsx`
  (mute presets, hard abort, mic deafen, settings gear).
- `NEW` `apps/desktop/src/workers/matrix.worker.ts` (OffscreenCanvas, LUT,
  `simplex-noise`) + `apps/desktop/src/components/matrix/PixelMatrix.tsx`.
- `NEW` `apps/desktop/src/audio/earcons.ts` (uisfx cues + abort hook).
- `NEW` `apps/desktop/src/styles/tokens.css` (obsidian `#141413`, glass tokens).
- Modify `src/ui/mic.ts` only if the cluster needs a derived selector (advisory).

**TDD contract**
- `matrix.test.ts` (NEW, pure): state reducer maps
  `0 IDLE | 1 USER | 2 THINKING | 3 KAREEM | 4 NOOR` deterministically; palette
  lerp completes in ≤ 250 ms; reduced-motion → static frames.
- `earcons.test.ts` (NEW): each cue builds an `AudioBuffer` once (cached); abort
  cuts scheduled earcons.
- `IconCluster.test.tsx` (NEW): every action renders an accessible name; icons
  are stroke-geometric and inherit `currentColor`.
- `crest.snapshot` (NEW): crest renders at 24/48/96 px without rasterization blur.

**Quality criteria**
- Quality commands as G2 (tsc, eslint, oxlint, vitest, test:vantrilex).
- Contrast: amber `#f59e0b` on `#141413` ≥ 4.5:1; green/purple distinguishable
  under deuteranopia (documented check, not assumed).
- Worker Renders 2,304 px at 60 fps with zero dropped frames in a 10 s capture.
- Earcon assets ≤ ~5.2 MB total; runtime ≤ ~12 KB.

**Git commit spec**
- `feat(ui): brand crest + lucide sidebar/action icon cluster`
- `feat(matrix): offscreen canvas 48x48 matrix with five states`
- `feat(audio): uisfx earcons wired through the abort contract`
- `style(tokens): obsidian glass design tokens`

**Auto-transition to GATE 4 when:** all quality criteria pass, matrix capture is
committed as an artifact, and the action-bar actions emit the correct WS frames
against the G2 bridge.

---

### GATE 4 — Ambient Agent & Watcher Loop

**Objective.** Harden and complete the daemon runtime and connect the ambient
loop to the shell. Sub-phases (each its own commit set):

- **4A Runtime hardening (the absorbed six-step steps 1–3):**
  - `NEW`/modify `src/voice/tts.ts` → `AudioOut.abort(): Promise<void>` +
  PCM graph replacement path (kept behind a flag; `FileAudioOut` fallback).
  - `src/orchestrator/queue.ts` → `purge(): void`.
  - `src/orchestrator/orchestrator.ts` → check purge after every `await`;
  fail-closed on `LAYA_CONCURRENCY_LIMIT` for destructive/high-stakes.
  - `src/runtime/client.ts:78` → stable idempotency key per logical prompt.
  - `NEW` Silero VAD on the existing `onnxruntime-node` (removes fixed 5 s chunk).
- **4B Ambient loop & watcher:** orchestrator SSE intake → tiered queue →
  briefings; `src/launcher/sweeper.ts` orphan loop surfaced as a health state;
  session reconcile. "Watcher loop" = supervised serve + orphan sweep + SSE
  reconnect, exposed to the UI state machine.
- **4C Telemetry:** `NEW` `src/telemetry/writer.ts` — closed unions
  (`SanitizedErrorClass`, `RemediationAttempted`), shared atomic `seq` with
  `src/orchestrator/ledger.ts`, 500 ms batched flush, 10 MB rotation,
  no transcripts. Wire the tx/Rx channel to the shell.
- **4D Persona RAG:** `NEW` `src/guidance/rag/` — Arabic normalizer (tashkeel
  codepoints re-derived, GPL-safe), `minisearch` BM25 index, Kareem/Noor
  overlays, Tier D guard; eval gate via `arabic-agent-eval` Levantine.

**Target subagents & skills**
- `voice-ai-integration-engineer`, `backend`/`architect`, `ts-reviewer`
  (read-only verdict), `test-automation-engineer`, `laya-ml-engineer` (VAD metrics).
- Guards: `clean-code-guard`, `test-guard`, `tdd`, `security-review`,
  `vitest-live-gating`, `typescript-esm-strict`, `laya-ml-gates`.

**Precise file targets** (all real): `src/orchestrator/{orchestrator,queue}.ts`,
`src/runtime/client.ts`, `src/voice/{tts,stt}.ts`, `src/launcher/sweeper.ts`,
plus `NEW` `src/telemetry/writer.ts`, `NEW` `src/guidance/rag/*`,
`NEW` `src/runtime/vad.ts`, and `NEW` tests beside each.

**TDD contract**
- `orchestrator.abort.test.ts`: abort during TTS tee stops output; `purge()`
  empties the queue; digest-collapse path unaffected.
- `fr12.failclosed.test.ts`: `LAYA_CONCURRENCY_LIMIT` on a destructive input →
  T2 confirmation briefing (never T1).
- `client.idempotency.test.ts`: retry reuses the same key; two different prompts
  get different keys.
- `telemetry.writer.test.ts`: unknown free-text rejected; `seq` monotonic and
  matches ledger; rotation at 10 MB; transcripts never serialize.
- `rag.retrieval.test.ts`: Levantine gold retrieval top-K; Tier D refusal string
  returned for a blocked input.

**Quality criteria**
- Quality commands as G2.
- New guard tests green; `LAYA_LIVE=1` integration 3/3 still green.
- VAD latency report committed (p50 utterance boundary improvement measured).
- Telemetry injection test: adversarial transcript yields no free-text row.

**Git commit spec**
- `fix(runtime): add abort/purge contract and fail-closed laya gate`
- `fix(runtime): stable idempotency key for prompt retries`
- `feat(audio): silero vad replaces fixed 5s chunking`
- `feat(telemetry): closed-union machine diagnostics bus`
- `feat(rag): levantine persona retrieval + tier-d guard`
- `test(runtime): ambient loop + watcher regression suite`

**Auto-transition to GATE 5 when:** all quality criteria pass, guard tests and
live integration are green, telemetry + VAD artifacts are committed.

---

### GATE 5 — Production Build & E2E Validation

**Objective.** Ship and prove it: Tauri bundles, E2E flows, the 3 GB memory
budget, and the release gates.

**Target subagents & skills**
- `desktop-app-engineer` (bundling, signing/notarization discipline),
- `test-automation-engineer` (Playwright E2E, flake elimination),
- `code-reviewer` + `ts-reviewer` (final verdict), `architect` (release ADR).
- Guards: `security-review`, `clean-code-guard`, `test-guard`, `docs-guard`.

**Precise file targets**
- `NEW` `apps/desktop/e2e/{boot,bridge,portals,matrix,abort}.spec.ts`.
- `NEW` `apps/desktop/src-tauri/tauri.conf.json` production targets
  (Windows NSIS + portable; Linux AppImage + deb).
- Modify `docs/{13,14,15}` for the real build/run/distribution surface.
- `NEW` `docs/RELEASE-CHECKLIST.md`.

**TDD contract (E2E, Playwright)**
- Boot E2E: app launches, adopts/creates daemon, hello frame observed.
- Escalation E2E: ambiguous/destructive intent produces a T2 confirmation
  portal before any destructive effect.
- Abort E2E: hard abort initiates < 10 ms, silence < 50 ms target, matrix → IDLE.
- Disconnect E2E: kill daemon → renderer shows degraded → recovery on restart.
- Memory E2E: sustained load stays < 3.0 GB (sampled, logged artifact).

**Quality criteria**
- `tsc 0`, `eslint 0`, `oxlint 0`, `vitest run` green, `test:vantrilex` green
  (vitest + Playwright), all bundles build on Windows.
- 3 GB budget verified by an exported memory trace (not arithmetic).
- Zero-focus-steal verified; abort budget measured, not asserted.

**Git commit spec**
- `test(e2e): playwright end-to-end suite for shell + daemon`
- `build(desktop): tauri production bundles for windows + linux`
- `docs(release): build, run, distribution, and release checklist`
- `chore(release): v0.x.0` (tag)

**Exit:** release candidate tagged; ledger + ADR updated; tree clean.

---

## 4. Execution Guardrails (auto-transition rules)

A gate advances **without human intervention** only when *all* hold:

1. Every command in the gate's **Quality criteria** returned success on a clean tree.
2. Every NEW/Modified path in the gate's **file targets** exists with non-zero
   size and is either committed or explicitly listed as deferred with a reason.
3. Every **TDD contract** test exists and is green (red before green, evidence kept).
4. The gate's commits are pushed to `origin/main` with the specified messages.
5. No invariant in §1 was violated (single supervisor, FR-12, no CUDA, no
   unauthorized `ml/`/`src/` behavior change outside the gate scope).

**Immediate halt (do not auto-advance) if any of:**
- A quality command fails and the fix would change a documented contract.
- A required file target cannot be created because an open decision (§5) is unresolved.
- A new dependency must be added that is not in this plan's file targets.
- A secret would be written to logs, ledger, telemetry, or the repo.
- The 3 GB budget is exceeded in G5.

---

## 5. Risk Register & Open Decisions (need sign-off before G2)

| ID | Decision needed | Why it blocks |
|---|---|---|
| **O1** | Repo shape: monorepo `apps/desktop/` in this repo (add `packages:` to `pnpm-workspace.yaml`) vs. a sibling repository. | Determines every G2 path and the single-supervisor packaging story. |
| **O2** | Confirm the desktop stack: **Tauri v2** + React 18 + Vite + Tailwind (as previously approved) — confirm versions and that Rust ≥ 1.77.2 is available. | G2 cannot scaffold without a frozen stack. |
| **O3** | Linter/test naming: adopt **`oxlint`** and add a **`test:vantrilex`** aggregate script (the repo currently uses `eslint` + `vitest`)? | The mission's "quality criteria" name tools that do not exist yet. |
| **O4** | "UI Defect Remediation" scope: confirm it means *view-model↔spec contract remediation* (5-tab modal, persona fields) since no UI defects can exist. | Reframes a whole gate. |
| **O5** | Mobile pairing (`docs/19`) and relay remain out of scope? | Avoids scope bleed into G4. |
| **O6** | Corpus licensing: JODA/MADAR personal-use authorization recorded? | Blocks G4D RAG ingestion sign-off. |

**Stale-artifact note:** `package.json` scripts `bench` and `stress` point at
absent `bench/` and `test/stress/`. Decide in G2 whether to create them or drop
them (a `docs-guard` drift item).

---

## 6. Halt Protocol

- This document and `docs/16-WORKFLOWS.md` §16.11 are the frozen plan surface.
- **No code, refactor, or build executes until G2 is explicitly started** and
  O1–O4 are answered.
- When a gate auto-transition (§4) fires, the orchestrator records the gate in
  `docs/10-CHECKPOINT.md`, commits per the gate's Git spec, and proceeds.
- On any hard-halt trigger (§4), stop and present; do not improvise scope.

*End of `docs/PLAN.md`.*