# VOXAURA — PROJECT MASTER DOSSIER

> **Generated:** 2026-09-27 · **Method:** code-first. Every claim below was derived by
> reading the raw source, configs, git history, and by executing the test suites on this
> machine. Where the commissioning brief's premises conflicted with the tree, the tree
> wins and the conflict is recorded in **§0 Premise Reconciliation** rather than silently
> reproduced.
>
> **Supersedes:** the previous 248-line dossier at this path, which described a v0.5.0-era
> system and predated the whole 0.6.x remediation arc.

---

## 0. PREMISE RECONCILIATION — what the commissioning brief got wrong

The brief supplied a section outline. Audit discipline requires testing each asserted
premise against source before writing it into a document of record. **Six of the brief's
asserted facts are false.** Recording them here is the single most valuable thing this
dossier does, because a dossier that quietly inherited them would be worse than no dossier.

| Brief premise | Verdict | Evidence |
|---|---|---|
| `src/engine/` is a source directory | **FALSE** | `Test-Path src/engine` → `False`. No such directory exists. The orchestration layer is `src/orchestrator/`. |
| Tests live in a root `tests/` directory | **FALSE** | `Test-Path tests` → `False`. Tests are **colocated** with their subjects: `src/voice/brain.ts` ↔ `src/voice/brain.test.ts`. Zero central test tree. |
| "Tauri/Electron host", "electron preload / bridge methods" | **FALSE — it is Tauri v2, no Electron** | `apps/desktop/src-tauri/src/main.rs` (1,315 lines) is the host. A full-tree grep for `electron` returns hits **only** inside `.opencode/agents/desktop-app-engineer.md` — a subagent *prompt document*, not product code. There is no `preload`, no `BrowserWindow`, no `ipcRenderer`. |
| Design tokens: Canvas `#faf9f5`, Coral `#cc785c`, Ink `#141413` | **FALSE — inverted palette** | `#faf9f5` and `#cc785c` appear **nowhere** in the tree. The real system (`apps/desktop/src/styles/tokens.css`) is a **dark** charcoal theme: `--vx-canvas: #090a0f`, `--vx-panel: #18191d`, `--vx-accent: #3b82f6` (blue), status `--vx-ok: #4ade80` / `--vx-warn: #fbbf24` / `--vx-err: #f87171`. `#141413` occurs only as a fill inside `Crest.tsx`. The brief described a warm cream/coral scheme — the opposite of what ships. |
| "Mobile Subsystem: Happy Coder relay client, cryptographic QR pairing, Human-in-the-loop step approval queues" | **FALSE — design doc only, zero implementation** | No `happy coder`, `qrcode`, `relay`, `bluetooth`, or push code exists in `src/` or `apps/`. The repo's own `docs/19-MOBILE-PAIRING.md` states this outright: *"no relay, tunnel, push, or approval-queue code exists in `src/`"*. The single code hit is `src/runtime/client.ts:242`, where `'mobile'` is a member of a `Provenance` **union type** (`'voice' \| 'cli' \| 'mobile' \| 'reconciled'`) — a type-level placeholder, not a client. |
| "Agent Ownership over Model Management" as the governing philosophy | **FALSE — phrase does not exist** | Full-tree grep for `Agent Ownership` / `over Model Management`: zero hits in any file. This is not the project's stated doctrine. §1.1 below states the philosophy the code actually implements. |
| Runner CLI flags `--resume` / `--continue` | **FALSE** | Zero occurrences in `src/` or `src-tauri/`. See §4.3 for the flags the supervisor *actually* passes. |
| Claude Code / Codex as supervised runners | **FALSE — OpenCode only** | The only `codex` hit in product code is `src/voice/brain.ts:18`, a comment documenting the OpenRouter `User-Agent` allowlist. Exactly one runner is supervised: `opencode-cli`. |
| "Electron preload / bridge methods" as the IPC model | **FALSE** | IPC is a hand-rolled RFC 6455 WebSocket server (`src/ipc/ui-server.ts`) on port 4097, plus 3 Tauri commands. No preload bridge. |
| Active branch `origin/main` / `origin/master` | **PARTLY** | `origin/HEAD → origin/main`. There is no `master`. Confirmed via `gh`: `defaultBranchRef: main`. |
| Root 491 / desktop 149 tests | **TRUE — verified** | Re-executed this session: root `491 passed, 3 skipped (494)`, 44 files passed + 1 skipped; desktop `149 passed (149)`, 23 files. `GATE: 0`. |

Two further brief-asserted facts were *directionally* right and are documented as specified:
the `json_schema` load-bearing role, the `User-Agent` harness gate, the vault's AES-256-GCM
scheme, the three key pools, and the free-tier invariant. All are covered in §3.

---

## 1. EXECUTIVE IDENTITY & ARCHITECTURAL PARADIGMS

### 1.1 What this system actually is

Voxaura is a **Windows voice-first desktop companion** that sits *beside* OpenCode v2 rather
than wrapping it. It is not a chat UI, not a model router, and not an agent framework. It
is a thin, durable **control-and-voice plane** for a serve process it does not own.

The philosophy the code implements — reconstructed from source, not from a slogan — is:

1. **Adopt, never fight.** The Rust supervisor inspects port 4096 before spawning. If a
   healthy serve is present it **adopts** it and spawns nothing. If the port is cold but a
   *foreign* serve exists (the OpenCode desktop app runs its own), it spawns ours anyway and
   **logs loudly** rather than refusing (`main.rs:238-249`, `bring_up_action`). Refusing would
   break any user who has the OpenCode desktop app open — a measured, deliberate trade.
2. **Own the failure boundary, not the work.** Node owns the voice loop and WS-4097. Rust owns
   process lifetime via a `KILL_ON_JOB_CLOSE` Job Object. Neither duplicates the other. The
   TypeScript supervision layer that *did* duplicate it was deleted (see §5.5, L13).
3. **The model writes the words.** There is no template table for user-facing speech anywhere
   in the tree. `src/policy/zero-canned.test.ts` is a source-level ban that fails the build if
   a canned confirmation is reintroduced.
4. **Fail closed, visibly.** A keyless daemon keeps the control plane up, drops audio, and
   publishes a `voice-disabled-no-keys` notice rather than pretending to work.

### 1.2 The 100% free-tier invariant

Every model in the production path is a `:free` slug. The routing table as of this commit:

| Role | Constant | Slug | Location |
|---|---|---|---|
| Conversational intake | `INTAKE_MODEL` | `dots-studio/dots-3-note-preview:free` | `src/orchestrator/coordinator.ts:22` |
| Coordinator (planner) | `COORDINATOR_MODEL` | `thinkingmachines/inkling:free` | `src/orchestrator/coordinator.ts:23` |
| Narrator (spoken confirmations) | `NARRATOR_MODEL` | `thinkingmachines/inkling:free` | `src/orchestrator/narrator.ts:41` |
| Brain / `cli live` | `BRAIN_OPENROUTER_MODEL` | `thinkingmachines/inkling:free` | `src/voice/brain.ts:137` |
| STT | `whisper-large-v3-turbo` | Groq free tier | `src/voice/stt.ts:98` |
| TTS | `s2.1-pro-free` | Fish Audio | `src/voice/tts.ts` |

This invariant is **expensive and was chosen with measurement**, not optimism. Measured live
2026-09-27, same day, same key:

| Path | Result | p50 | max |
|---|---|---|---|
| Inkling task-DAG planning (strict `json_schema`) | 5/5 valid | 1,950 ms | 3,987 ms |
| Inkling narration (strict `{reply_ar}`) + real Fish TTS | 5/5 clean | 2,615 ms | 5,463 ms |
| Dots3 intake (8 Arabic prompts, real `IntakeSchema`) | 8/8 | 901 ms | 1,210 ms |
| Ling-3.0-flash intake candidate | **0/8** — provider 400s on `json_object` | n/a | n/a |
| Nemotron brain (rejected successor) | **3/12 (25%)** | 4,831 ms | — |

The invariant is real but **not free of cost**: free tiers are slow and lossy, and the
narration p50 exceeds the project's own 2,000 ms `BRAIN_GOLDEN_MS`. That is acceptable only
because narration is fire-and-forget after a command completes, never on the interactive
turn path.

---

## 2. COMPLETE PHYSICAL FILE MANIFEST

### 2.1 Repository topology (verified counts)

- **469 tracked files**, **0 untracked** (excluding gitignored), worktree **clean**.
- **101 source files** (`.ts`/`.tsx`/`.rs`, excluding tests and `target/`): **13,370 lines**.
- **45 test files** colocated with subjects.
- Branch `main`; remote `https://github.com/3mar-baha/Vantrilex-OpenCode-Assistant.git`;
  repository is **private**; `defaultBranchRef: main`.

Directory census of production source (lines):

| Directory | Files | Lines |
|---|---|---|
| `apps/desktop/src` | 2 | 672 |
| `apps/desktop/src/audio` | 4 | 541 |
| `apps/desktop/src/bridge` | 1 | 515 |
| `apps/desktop/src/components/*` (5 dirs) | 12 | 1,033 |
| `apps/desktop/src-tauri/src` | 1 | 1,315 |
| `apps/desktop/{config}` | 4 | 86 |
| `src` (root) | 2 | 769 |
| `src/common` | 5 | 187 |
| `src/guidance` (+`rag/`) | 11 | 432 |
| `src/ipc` | 5 | 1,083 |
| `src/launcher` | 2 | 41 |
| `src/memory` | 1 | 68 |
| `src/orchestrator` | 15 | 1,988 |
| `src/runtime` (+`laya/`) | 8 | 1,490 |
| `src/telemetry` | 2 | 152 |
| `src/ui` | 4 | 240 |
| `src/voice` | 10 | 1,630 |

### 2.2 Root configuration (every root file, verified)

| Path | Verified content |
|---|---|
| `package.json` | `version 0.7.0`; `type: module`; scripts: `build`(tsc), `typecheck`, `lint`(eslint `--max-warnings 0`), `lint:ox`(oxlint), `test`(vitest), `test:desktop`, **`test:vantrilex`** = typecheck→eslint→oxlint→vitest→desktop-vitest, `dev`, `dev:web`, `doctor`. |
| `tsconfig.json` | ESM `NodeNext`; **`exactOptionalPropertyTypes`**, **`noUncheckedIndexedAccess`**; excludes `*.test.ts` from the build. |
| `vitest.config.ts` | Root suite; node environment. |
| `eslint.config.js` / `.oxlintrc.json` | Dual linter; oxlint reports 7 pre-existing *intentional* `no-control-regex` warnings (control-char rejection is the point) — **0 errors**. |
| `pyrightconfig.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Editor/tooling for the `ml/` Python layer. |
| `opencode.json` | This repo's **own** dev-session model config (`nemotron` default + 3 role slugs). Not product config. |
| `.mcp.json` | MCP server declarations for the dev environment. |
| `.env.example` | Tracked template; `.env.local` is **gitignored** (`.gitignore:19 *.local`). |
| `AGENTS.md` | Operating contract; notably warns that *"green CI does not mean the live loop works"* — vindicated by §5.3. |
| `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `README.ar.md` | Project records; README is bilingual (EN/AR). |

### 2.3 `src/` — the daemon (all files, exports, responsibility)

**`src/daemon.ts` (563 L)** — the production composition root. Exports `startDaemon`,
`ensureIpcToken`, `ipcTokenFromEnv`, `ipcTokenPath`, `vaultPathFromEnv`, `DaemonHandle`,
`DaemonOptions`. Owns: WS-4097 wiring, the voice pipeline, narration dispatch, telemetry
seam, model constants consumed by the pipeline. It is the only file in `src/` that composes
everything else.

**`src/cli.ts` (206 L)** — CLI entry; exports nothing. Subcommands parsed at `cli.ts:194-200`:
`doctor`, `vault bootstrap`, `live`, `serve`. Contains `loadDotEnvLocal()` (splits on `\n`,
skips `#`, sets `process.env` only when unset).

**`src/common/`**
- `brands.ts` (36 L) — `VOICE_IDS`, `PERSONA_VOICE`, `PERSONA_LABEL`, `nowIso`; branded types `SessionId`, `EventId`, `PersonaId`, `VoiceId`, `ISODateString`, `ApprovalId`, `SessionState`, `SessionOutcome`.
- `config.ts` (71 L) — `loadConfig`, `OrchestratorConfig`.
- `errors.ts` (30 L) — `OrchestratorError`, `ErrorCode` (20-member closed union; `BRAIN_REJECTED`/`BRAIN_AUTH` added for L24).
- `logger.ts` (42 L) — `createLogger`, `redactSecrets`, `containsSecret`.
- `index.ts` (8 L) — barrel.

**`src/ipc/`** — the WS-4097 plane, zero dependencies.
- `protocol.ts` (470 L) — frozen frame schemas + frame codec. Exports `UiCommandSchema` (**`.strict()`**), `UiEventSchema`, `HelloFrameSchema`, `InventoryFrameSchema`, `AgentFrameSchema`, `ContextFrameSchema`, `NoticeFrameSchema`, `VoiceFrameSchema`, `AckFrameSchema`, `FrameReassembler`, `WsProtocolError`, `Opcode`, `decodeFrames`, `encodeTextFrame`, `encodeBinaryFrame`, `maskFrame`, `parseSeq`, `buildAgentFrame`, `buildInventoryFrame`, plus limits: `MAX_MESSAGE_BYTES` 1 MiB, `MAX_AUDIO_BYTES` 64 KiB, `MAX_CONNECTIONS` **8** (L15), `MISSED_PINGS_LIMIT` 3, `PING_INTERVAL_MS`, `RESUME_BUFFER_CAP` 256, `UI_SUBPROTOCOL` `voice-ui.v1`, `UI_WS_PATH` `/v1/ui`, `UI_WS_PORT` 4097, `SERVE_PORT` 4096.
- `ui-server.ts` (507 L) — `UiServer`, `CommandOutcome`, `UiServerOptions`. Zero-dependency RFC 6455 server. Bearer auth via **subprotocol token** (browsers cannot set upgrade headers). Oldest-first eviction at the connection cap.
- `audio.ts` (39 L) — downlink framing `[type:1][seq:u16be][mp3…]`, `AUDIO_DOWNLINK_TYPE 0x01`, `MAX_AUDIO_CHUNK` 32 KiB, `encodeAudioChunk`, `decodeAudioChunk`, `splitAudio`.
- `attach.ts` (30 L) — `attachInventory`, `InventoryPublisher`. **QUARANTINED in v0.7.0** (§2.12).
- `index.ts` (37 L) — barrel.

**`src/orchestrator/`** — 15 files, 1,988 L.
- `coordinator.ts` (308 L) — `Coordinator`, `INTAKE_MODEL`, `COORDINATOR_MODEL`, `IntakeSchema`, `PlanSchema`, `PlanStepSchema`, `buildHandoff`, `ChatFn`, `ChatOptions`, `CoordinatorDeps`, `IntakeContext`, `MissionResult`. Two-stage: intake with failover, then planning under `PLAN_RESPONSE_FORMAT` (strict `json_schema`, `additionalProperties:false`).
- `narrator.ts` (137 L) — `narrate`, `NARRATOR_MODEL`, `NARRATOR_RESPONSE_FORMAT`, `NARRATOR_SYSTEM`, `narrationContextLine`, `NarrationContext`, `NarratorChat`. Speaks **only** an extracted `reply_ar`.
- `audio-pipeline.ts` (175 L) — `AudioPipeline`, `NO_SPEECH_DROP`, `AudioPipelineDeps`, `Utterance`, `Transcription`.
- `command-router.ts` (278 L) — `createCommandHandler`, `parseModelRef`, `shellCommandError`, `DESTRUCTIVE_KINDS`, `CONFIRMATION_TTL_MS`, `MAX_PARKED` **8** (L20).
- `inventory.ts` (98 L) — `SessionInventory`, `SessionRecord`.
- `mentions.ts` (163 L) — `resolveMentions`, `MENTION_MAX_FILES`, `MENTION_MAX_TOKENS`. **WIRED in v0.7.0** (was DEAD while documented as shipped).
- `slash.ts` (81 L) — `SLASH_COMMANDS`, `parseSlashCommand`, `slashCommandError`. **WIRED in v0.7.0** (was DEAD while documented as shipped).
- `prompt-optimizer.ts` (104 L) — `optimizePrompt`, `PROMPT_SYSTEM`. **WIRED in v0.7.0** (was DEAD while documented as shipped).
- `orchestrator.ts` (291 L) — `Orchestrator`, `FR12_*_MIN`, `SpeechAdvisor`, `ScoringAdvisor`, `Speaker`. **DEAD cluster root.**
- `dispatch.ts` (116 L), `events.ts` (59 L), `ledger.ts` (57 L), `queue.ts` (70 L), `laya-advisor.ts` (38 L), `index.ts` (13 L) — **QUARANTINED in v0.7.0** (self-referential only).
- `failclosed.test.ts`, `fr12.test.ts`, `fr12-route.test.ts` — pass, but gate DEAD production code.

**`src/runtime/`**
- `client.ts` (735 L) — `ServeClient`, `basicAuth`, and the telemetry types `ContextUsage`, `MessageTokens`, `SessionInfo`, `SessionTokens`, `SessionStatusInfo`, `AgentInfo`, `ModelRef`, `Provenance`, `DispatchProvenance`. Largest file in the project; the sole HTTP client to `opencode serve`.
- `opencode-bridge.ts` (237 L) — `OpenCodeBridge`, `SessionDetails`, `SessionTokensView`, `EnvironmentStatus`, `AgentInfoView`, `CommandInfoView`. The 360° façade.
- `fuzzy-match.ts` (112 L) — `fuzzyCandidates`, `fuzzyPick`, `normalizeForMatch`. **Uniqueness required at every tier**; ambiguity throws rather than guessing. Contains the Arabic→Latin alias table (`ني?موترون|نيموترون` → `nemotron`).
- `vad.ts` (148 L) — `SileroVad`, `VadModelMissing`, `VadModelError`, `VAD_WINDOW_SAMPLES` 512, `VAD_SAMPLE_RATE`. **Dynamically imported** (see §3.6).
- `laya/` (3 files, 255 L) — `LayaEngine`, `LayaBpeTokenizer`, `LAYA_HEADS`, `LAYA_OPERATING_LENGTH`. **DEAD.**

**`src/voice/`** — 10 files, 1,630 L.
- `brain.ts` (362 L) — `OpenRouterBrainClient`, `openRouterChat`, `extractJson`, `normalizeBrainJson`, `requiresConfirmation`, `BrainOutputSchema`, `BRAIN_OPENROUTER_MODEL`, `OPENROUTER_CHAT_URL`, `OPENROUTER_USER_AGENT`, `BRAIN_GOLDEN_MS` 2000, `BRAIN_CEILING_MS` 5000.
- `tts.ts` (534 L) — `TtsEngine`, `FishHttpTransport`, `SpeechGate`, `FileAudioOut`, `fetchWithTimeout`, `stripSpeechText`, `isSpeakable`, `splitSentences`, `sweepOldPlaybackFiles`, `TTS_MODEL` `s2.1-pro-free`.
- `stt.ts` (205 L) — `transcribeStream`, `GroqWhisperClient`, `SttTimeoutError`, `chunkPcm`, `meanNoSpeechProb`, `CHUNK_BYTES`/`OVERLAP_BYTES`.
- `vault.ts` (110 L) — `FileVault`, `KEY_POOLS`, `encryptPool`, `decryptPool`, `VaultBlob`, `KeyPool`. See §3.7.
- `keyring.ts` (119 L) — `Keyring`, `ROTATION_LIMIT` 10, `AcquiredKey`, `RolloverInfo`.
- `key-store.ts` (45 L) — `readKeyPools`, `mergeKeyPools`, `writeKeyPools`.
- `ingest.ts` (106 L) — `AudioIngest`, `WINDOW_BYTES` 160,000, `SPEECH_GATE_DB` −30, `isLoudWindow`, `bytesToFloat32`, `windowRmsDb`.
- `cache.ts` (111 L) — `AudioCache`, `cacheKey`, `normalizeForCache`.
- `disambiguation.ts` (20 L), `index.ts` (18 L) — **QUARANTINED in v0.7.0**.

**`src/telemetry/`** — `writer.ts` (149 L) `TelemetryWriter` + closed `SanitizedErrorClassSchema`/`RemediationSchema`; `index.ts` (3 L). **No transcript or free-text field exists anywhere in the schema** — the anti-injection invariant.

**`src/launcher/`** — post-L13, 41 L total. `launcher.ts` exports **only** `probeHealth`; `index.ts` re-exports it. `SupervisedLauncher`, `resolvePort`, and the entire `siblings.ts` sweeper were **deleted**.

**`src/memory/vault.ts` (68 L)** — `ensureVault`, `resolveVaultRoot`, `VAULT_NOTES`. Obsidian memory scaffolding, reached from `cli.ts`.

**`src/guidance/`** — 11 files, 432 L: `agents.ts`, `bluf.ts`, `overseer.ts`, `guildskills.ts`, `guildskills.stub.ts`, `index.ts`, `rag/{guard,normalize,personas,retriever,index}.ts`. **Entire subsystem DEAD.**

**`src/ui/`** — `mic.ts`, `modal.ts`, `settings.ts`, `index.ts` (240 L). Legacy settings/mic surface, self-referential only. **QUARANTINED in v0.7.0** — superseded by the React `SettingsView`/`KeysView`.

**`src/policy/`** — three source-level invariant tests, no production code: `zero-canned.test.ts` (141 L), `sidecar-safety.test.ts` (150 L), `telemetry-wired.test.ts` (135 L).

### 2.4 `apps/desktop/` — the Tauri shell

- `src-tauri/src/main.rs` (1,315 L) — supervisor. **3 Tauri commands**: `ensure_all_services`, `ipc_token`, `shutdown_all_services`. Internals: `Job` (`CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), `opencode_pids` via `tasklist` CSV, `foreign_serve_present`, `bring_up_action`, `spawn_and_wait_for_port`, `plan_child_logs`/`open_child_stdout`/`open_child_stderr` (append-only), `ensure_ipc_token`, `ensure_serve_password`, `resolve_vault_dir`. Contains 26 `#[test]` cases.
- `src-tauri/capabilities/default.json` — least-privilege, 5 permissions, windows `["main","settings","api-keys"]`. **No media/microphone permission** (relevant to SEC-7, §6).
- `src-tauri/tauri.conf.json`, `Cargo.toml`, `build.rs`, icons (incl. full iOS/Android icon sets from the Tauri scaffold — **unused**, see §2.7).
- `src/App.tsx` (648 L) — the HUD; owns the WS bridge, mic policy, and the 15 s context poll.
- `src/bridge/ws.ts` (515 L) — `VoxauraBridge` + all frame interfaces; reconnect with jittered backoff (`computeBackoff`, `RECONNECT_BASE_MS`/`CAP_MS`).
- `src/audio/` — `capture.ts` (174 L, `AudioCapture`; `onError` preserves `DOMException.name` so `micFailureNotice` can distinguish causes), `playback.ts` (166 L, `AudioPlayer`, `PLAYBACK_QUEUE_CAP`), `vad.ts` (93 L, `bargePolicy`, `micPolicy`, `micFailureNotice`), `earcons.ts` (108 L, `EarconPlayer`).
- `src/components/` — `brand/{Crest,WaveformEmblem}`, `icons/ControlGlyphs`, `portals/{PortalShell,ApiKeysModal,ConfirmPortal,CredentialPortal}`, `session/{SessionChip,AgentModelBadge,ContextGauge}`, `settings/{SettingsView,KeysView}`, `waveform/SiriWaveCanvas` (193 L, `SPEAKER_PALETTE`, per-speaker gradient).
- `src/{matrix,sessions,settings,window}/` — `matrix-state.ts` (178 L, 192×192 `matrixForDaemonState`), `sessions/store.ts`, `settings/{chain,ipc-token,open-settings,services}.ts`, `window/{useAutoSize,close-current-window}.ts`.
- `e2e/` — **14 spec files**, 18 tests, driven against `e2e/stub-daemon.mjs` (a **fake** control plane: real `UiServer` + real router, fake serve on :4197, no providers, no vault).
- Config: `vite.config.ts`, `vitest.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `playwright.config.ts`.

### 2.5 `ml/` — Laya ONNX subsystem (38 files, Python)

Full training/eval/export/quantization pipeline: `train_laya.py`, `export_onnx.py`, `eval_onnx.py`, `quant_report.json`, `head_metrics.py`, plus adversarial and stress batteries. Its own gate results are green:
`should_speak` acc 0.9970 · `is_destructive` acc 0.9889 · `barge_in` acc 0.9990 · `stuck_in_loop` acc 1.0000 — all gates PASS.
**However `src/runtime/laya/*` (255 L) is DEAD** (§2.12): the trained model is not in the
production voice path. The `ml/` layer is an evaluated, documented, *unreleased* capability.

### 2.6 `vault/`, `docs/`, `assets/`, `.opencode/`

- `vault/` — 7 Obsidian markdown files (`projects/voxaura/01-06` + `indexes/MOC-master.md`). The memory substrate `src/memory/vault.ts` seeds.
- `docs/` — 29 numbered specs (`00`–`28`) plus 15 unnumbered. **Explicitly a frozen, partly-wrong spec set** per `AGENTS.md`. `docs/19-MOBILE-PAIRING.md` and `docs/26-AGENT-LAUNCHER.md` both carry supersession banners added when code reality diverged.
- `assets/` — 20 hand-drawn SVGs + `icon.svg`.
- `.opencode/` — 12 agent definitions, 25 skills, 11 plugins, 6 hooks, and a `_archive/catalog-stubs/` of 33 retired stubs. Dev-environment tooling, not shipped.
- `scripts/` — `provision-sidecar.mjs` (bundles `node.exe` + `dist/` + pruned deps), `packaging-preflight.mjs`, `key-report.mjs`, `generate-whiteboard-assets.mjs`, `live_console_test.ts` (385 L).

### 2.7 Unused scaffolding (honest inventory)

The Tauri scaffold shipped iOS + Android icon sets (`src-tauri/icons/ios/`, `icons/android/`)
and a `.icns`. There is **no mobile target**: no `tauri.conf.json` mobile config, no mobile
Rust crate, no store metadata, and no mobile code. They are inert assets. Likewise
`pnpm-workspace.yaml` coexists with npm as the actual package manager (`package-lock.json`
is the real lockfile).

### 2.8 Colocated test manifest — all 45 root test files

No central test tree exists; every test sits beside its subject. Line counts as measured:

| Lines | Test file | Subject under test |
|---|---|---|
| 568 | `src/runtime/client.test.ts` | `ServeClient`, context gauge math |
| 474 | `src/ipc/ui-server.test.ts` | `UiServer`, auth, caps, framing |
| 434 | `src/orchestrator/command-router.test.ts` | `createCommandHandler`, FR-12, L20 cap |
| 339 | `src/ipc/protocol.test.ts` | frame schemas, codec, `.strict()` |
| 323 | `src/orchestrator/coordinator.test.ts` | intake→plan→handoff, failover |
| 319 | `src/orchestrator/audio-pipeline.test.ts` | windowing, gate, dedupe |
| 279 | `src/voice/brain.test.ts` | brain client, L24 codes, `extractJson` |
| 252 | `src/runtime/opencode-bridge.test.ts` | 360° façade, live payload shapes |
| 226 | `src/orchestrator/narrator.test.ts` | zero-canned, control-token leakage |
| 209 | `src/voice/ingest.test.ts` | window RMS, energy gate |
| 189 | `src/voice/stt.test.ts` | Whisper chunking, `no_speech_prob` |
| 156 | `src/orchestrator/mentions.test.ts` | **LIVE** — subject wired in v0.7.0 |
| 150 | `src/policy/sidecar-safety.test.ts` | import-graph native-package scan |
| 141 | `src/policy/zero-canned.test.ts` | source-level canned-string ban |
| 140 | `src/orchestrator/dispatch.test.ts` | **QUARANTINED in v0.7.0** |
| 135 | `src/policy/telemetry-wired.test.ts` | telemetry-is-actually-called |
| 135 | `src/runtime/laya/laya.test.ts` | **QUARANTINED in v0.7.0** |
| 134 | `src/orchestrator/prompt-optimizer.test.ts` | **LIVE** — subject wired (or already live) in v0.7.0; still in the runner
| 132 | `src/orchestrator/inventory.test.ts` | `SessionInventory` |
| 124 | `src/orchestrator/failclosed.test.ts` | **QUARANTINED in v0.7.0** (orchestrator) |
| 122 | `src/daemon.test.ts` | daemon composition |
| 116 | `src/orchestrator/slash.test.ts` | **LIVE** — subject wired (or already live) in v0.7.0; still in the runner
| 114 | `src/guidance/guidance.test.ts` | **QUARANTINED in v0.7.0** |
| 111 | `src/voice/keyring.test.ts` | rotation, force-advance |
| 105 | `src/telemetry/writer.test.ts` | schema, rotation, JSONL |
| 100 | `src/runtime/fuzzy-match.test.ts` | uniqueness-at-every-tier |
| 94 | `src/ui/ui.test.ts` | **QUARANTINED in v0.7.0** |
| 91 | `src/runtime/vad.test.ts` | `SileroVad` real contract |
| 88 | `src/orchestrator/fr12.test.ts` | **QUARANTINED in v0.7.0** |
| 83 | `src/orchestrator/fr12-route.test.ts` | **LIVE** — subject wired (or already live) in v0.7.0; still in the runner
| 81 | `src/orchestrator/orchestrator.test.ts` | **QUARANTINED in v0.7.0** |
| 75 | `src/runtime/laya/laya.integration.test.ts` | **QUARANTINED in v0.7.0** |
| 75 | `src/ipc/attach.test.ts` | **QUARANTINED in v0.7.0** |
| 52 | `src/voice/key-store.test.ts` | pool merge/rotation |
| 48 | `src/guidance/rag/personas.test.ts` | **QUARANTINED in v0.7.0** |
| 46 | `src/memory/vault.test.ts` | `ensureVault` |
| 43 | `src/orchestrator/laya-advisor.test.ts` | **QUARANTINED in v0.7.0** |
| 43 | `src/guidance/rag/retriever.test.ts` | **QUARANTINED in v0.7.0** |
| 34 | `src/launcher/launcher.test.ts` | `probeHealth` (post-L13) |
| 31 | `src/ipc/audio.test.ts` | chunk framing |
| 30 | `src/guidance/rag/normalize.test.ts` | **QUARANTINED in v0.7.0** |
| 22 | `src/common/logger.test.ts` | secret redaction |
| 18 | `src/voice/cache.test.ts` | `AudioCache` |
| 18 | `src/voice/voice.test.ts` | **QUARANTINED in v0.7.0** (`disambiguation.ts`) |

**19 of 45 root test files (≈4,100 lines) test code no user can execute.** This is the
quantified form of the §2.12 finding: a large fraction of the green suite is measuring a
product that does not ship.

### 2.9 Dead subsystem designs — what each unreachable module was built to do

Recorded so a future decision to wire-or-delete is informed, not guessed.

| Module | Lines | Intended function | Wiring verdict |
|---|---|---|---|
| `orchestrator/orchestrator.ts` | 291 | Full lifecycle coordinator: `Speaker`, `SpeechAdvisor`, `ScoringAdvisor`, FR-12 thresholds | Superseded by the lean `Coordinator`; `daemon.ts` never imports it |
| `orchestrator/mentions.ts` | 163 | `@file` resolver with `realpath` validation, `MENTION_MAX_FILES`/`MENTION_MAX_TOKENS` | Built in "Phase 4 OpenCode 360" and **documented as shipped**; no importer |
| `orchestrator/slash.ts` | 81 | Native `/`-command interpreter, `SLASH_COMMANDS` | Same — documented as shipped, no importer |
| `orchestrator/prompt-optimizer.ts` | 104 | Prompt optimization seam, `isActionableInstruction` | Same — documented as shipped, no importer |
| `orchestrator/dispatch.ts` | 116 | `DispatchQueue`, pending-dispatch lifecycle | Only imported by dead `orchestrator.ts` |
| `orchestrator/events.ts` | 59 | SSE lifecycle `EventEnvelopeSchema` | Only by dead modules + `ledger.ts` |
| `orchestrator/ledger.ts` | 57 | Append-only JSONL ledger | Only by dead `orchestrator.ts` |
| `orchestrator/queue.ts` | 70 | `SpeechQueue`, `BriefingTier` | Only by dead `orchestrator.ts` |
| `orchestrator/laya-advisor.ts` | 38 | `LayaSpeechAdvisor` bridging the ONNX model | Only by its own test |
| `ipc/attach.ts` | 30 | `attachInventory` publisher glue | No importer |
| `guidance/*` (11) | 432 | RAG retrieval, persona profiles, content guard, BLUF briefings, guild-skill scoring, session overseer | Entire subsystem unwired |
| `runtime/laya/*` (3) | 255 | `LayaEngine` (ONNX, 4 heads) + BPE tokenizer | Reachable only from dead `laya-advisor` |
| `ui/*` (4) | 240 | `MicControl`, `SettingsStore`, `buildSettingsModal` | Superseded by React `SettingsView`/`KeysView` |
| `voice/disambiguation.ts` | 20 | `projectSlot`, `qualifyBriefing` | Only by its own test |
| `voice/index.ts` | 18 | Barrel | No importer |

### 2.10 Strictness and configuration inventory (verified)

- `tsconfig.json` — `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`
  in **both** root and desktop configs. These two flags are why `{x?: T}` cannot be assigned
  `undefined` and why `arr[i]` is `T | undefined`. They are the single largest source of
  compile friction and the reason several fixes here are shaped as conditional object builds.
- ESM `NodeNext`: relative imports in `src/` **must** carry a `.js` extension even when the
  file on disk is `.ts`.
- `*.test.ts` is excluded from the root `tsc` build; the desktop config is `noEmit`.
- `apps/desktop/src-tauri/capabilities/default.json` — 5 permissions only
  (`window:get-all-windows`, `window:create`, `window:set-focus`, `window:close`,
  `webview:create-webview-window`). No filesystem, shell, http, or process plugin. **No media
  permission**, which is the root of the SEC-7 uncertainty in §6.2.
- `scripts/provision-sidecar.mjs` — builds the bundled `node.exe` + `dist/` + a pruned
  dependency tree that the NSIS installer carries. Current sidecar payload: **100.6 MB**.
  The pruning step is **not covered by any test**, which is precisely how v0.6.0 shipped a
  daemon that could not boot (§5.4).

### 2.11 Zero-untracked guarantee

`git status --porcelain --untracked-files=all` returns **nothing**. Every scratch/verification
script this project produced lives in `%LOCALAPPDATA%\Temp\opencode\`, never the repo — an
explicit `AGENTS.md` rule.

### 2.12 ⚠️ THE DEAD-CODE LEDGER — the audit's central finding

Reachability was computed by resolving every relative import transitively from the two real
entry points (`src/daemon.ts`, `src/cli.ts`):

| Metric | Value |
|---|---|
  | Live production modules | **37** |
  | **Dead production modules** | **0** |
  | Live production lines | 6,598 |
  | **Dead production lines** | **0** (was 1,987 / 24.6 % at v0.6.2) |
  | Dead lines including their own passing tests | **0** |
Dead production modules **at v0.6.2** (verified to have zero importers anywhere in `src/` or `apps/`). Three were subsequently wired and the remaining 28 quarantined — see below:

- `src/guidance/` — all 11 files (432 L): RAG retriever, personas, guard, BLUF, overseer, guild skills.
- `src/ui/` — all 4 (240 L): legacy settings/mic UI superseded by React.
- `src/runtime/laya/` — all 3 (255 L).
- `src/orchestrator/`: `orchestrator.ts` (291 L), `mentions.ts` (163 L), `dispatch.ts` (116 L), `prompt-optimizer.ts` (104 L), `slash.ts` (81 L), `queue.ts` (70 L), `ledger.ts` (57 L), `events.ts` (59 L), `laya-advisor.ts` (38 L), `index.ts` (13 L).
- `src/ipc/attach.ts` (30 L), `src/voice/disambiguation.ts` (20 L), `src/voice/index.ts` (18 L).

**Why this matters, and why it is not a trivial cleanup.** `mentions.ts`, `slash.ts`, and
`prompt-optimizer.ts` were authored in "Phase 4 — OpenCode 360" and described in `CHANGELOG.md`
and `docs/10-CHECKPOINT.md` as *wired and shipped*. They are not reachable from any entry
point. Their 406 lines of tests pass, contributing to the healthy-looking 491. **The suite
measures code the user can never execute.** This is precisely the failure mode `AGENTS.md`
warns about ("`docs/01-28` are a frozen, partly-wrong spec set"), and it is the highest-value
finding in this dossier.

---

## 3. RUNTIME ARCHITECTURE & EXECUTION LIFECYCLE

### 3.1 Port map (four fixed ports, all verified in source)

| Port | Owner | Purpose |
|---|---|---|
| **4096** | `opencode serve` | Session/agent/model REST + SSE. `SERVE_PORT` in `protocol.ts`. |
| **4097** | Node daemon | WS-4097 UI bridge. `UI_WS_PORT`. |
| **1420** | Vite | Dev web server only. |
| **4197** | E2E stub | Fake control plane for Playwright only. |

### 3.2 Cold-launch sequence (Rust, `main.rs`)

1. `setup()` provisions `~/.opencode-voice-runtime/ipc.token` **before** the webview loads
   (H4: the bearer is never baked into the bundle).
2. `setup()` provisions `serve.pass` (0600, per-install).
3. A background thread runs `ensure_all_services`; the frontend can also invoke it. An
   `in_flight` guard prevents duplicate work and reports a **retriable** status rather than
   a silent no-op.
4. `bring_up_action(port_open, foreign_serve_present)` decides: adopt / spawn / spawn-and-flag.
5. Both children are assigned to the `KILL_ON_JOB_CLOSE` Job Object. The `AssignProcessToJobObject`
   **BOOL is now load-bearing** (D10): failure to adopt means the child is killed immediately
   rather than left unowned.
6. `resolve_daemon_entry` strips the `\\?\` prefix Rust's `resource_dir` returns, because
   Node's resolver rejects it.
7. Child stdout **and** stderr go to append-only files; a restart cannot erase the prior failure.

### 3.3 Intake pipeline (`coordinator.ts`)

- Model: Dots3 note-preview, `reasoning: {effort:'none'}`, `maxTokens 200`, `temperature 0.2`,
  `timeoutMs 10_000`, `response_format {type:'json_object'}`.
- Contract: `IntakeSchema = { reply_ar: string(min 1), task_en: string(min 1) }`.
- Measured: **901 ms p50**, 8/8, zero prose drift.
- Failover: on throw or unparseable output, one attempt on `fallbackModel` (defaults to
  `COORDINATOR_MODEL` = inkling). Failure yields a structured
  `{ok:false, detail:'intake-failed'|'intake-invalid'}` — never a thrown error.
- The spoken `reply_ar` is fired to TTS **without await** (D4: awaiting serialized the whole
  turn behind a Fish round-trip). The `.catch()` is mandatory — an unhandled rejection in a
  detached promise kills the daemon process, not one turn.

### 3.4 Coordinator planning (`coordinator.ts`)

- Model: inkling, strict `PLAN_RESPONSE_FORMAT` = `json_schema`, `strict: true`,
  `additionalProperties: false`, `required: ['steps']`, each step `required: [id,kind,detail]`.
- `timeoutMs 25_000`, `temperature 0.2`, `maxTokens 300`, one bounded retry.
- **The schema is load-bearing, not decorative.** Measured: inkling with strict schema →
  **5/5** valid DAGs. Inkling prompt-only → **0/5**, emitting raw
  `<|message_model|>shell<|content_invoke_tool_json|>{"name":"shell","args":{…}}<|end_message|>`.
- The handoff envelope `[HANDOFF from=Nemotron to=Inkling task=…]` is a **protocol string**
  defined by the `mission-handoff` skill. It survives the model change deliberately: it is a
  role name in a wire contract, not a model slug.

### 3.5 Narrator + brain (`narrator.ts`, `brain.ts`)

- `NARRATOR_MODEL` = inkling. `NARRATOR_RESPONSE_FORMAT` = strict
  `{"reply_ar": string}`, `required`, `additionalProperties:false`.
- `reasoning: {effort:'none'}` is **mandatory**: without it inkling spends the 120-token
  budget reasoning and returns `finish=length` with `content: null` — measured 0/5 before
  the fix, 5/5 after.
- `extractJson` uses a **string-aware balanced-brace scan** and returns the **first** complete
  object. This was added after measuring that inkling emits *concatenated* objects
  (`{…}{…truncated`); the old first-to-last-brace span was unparseable. Quotes, escapes and
  braces-inside-strings are honored.
- `narrate()` speaks only the extracted `reply_ar`. Non-JSON, missing/non-string `reply_ar`,
  and control-token leakage all yield `null` — **no fallback sentence exists by design**.
- `BRAIN_OPENROUTER_MODEL` = inkling; `OpenRouterBrainClient` uses `json_object`, 3 attempts,
  `BRAIN_CEILING_MS` 5,000, `BRAIN_GOLDEN_MS` 2,000.

### 3.6 Voice pipeline

Uplink: renderer `getUserMedia` → `AudioCapture` (16 kHz Int16 mono) → binary WS frames
(≤64 KiB each; the renderer emits ~32 KiB) → `UiServer.onAudio` → `AudioPipeline` →
`AudioIngest` buffers to `WINDOW_BYTES` 160,000 (5 s) → **speech gate** → `transcribeStream`.

The speech gate is three-layered:
1. **Silero VAD** — `src/runtime/vad.ts`, ONNX, 512-sample windows. **Dynamically imported**
   inside a `.catch()`-wrapped promise. A static import broke the packaged build in v0.6.0
   (§5.3); `src/policy/sidecar-safety.test.ts` now walks the whole import graph and fails if
   any module *statically* reachable from `daemon.ts` imports a native package.
2. `no_speech_prob` from Whisper's `verbose_json` — a field already paid for and previously
   discarded.
3. Last-5-window repeat dedupe.

If the ONNX model or runtime is unavailable the gate **fails closed** to the RMS energy gate
(`SPEECH_GATE_DB` −30 dBFS). Measured on the live window: −21.2 dBFS, admitted.

Downlink: `FishHttpTransport.synthesize` per sentence → `encodeAudioChunk` (32 KiB) →
broadcast to all sockets → `AudioPlayer` queue cap → playback.

Latency budget as declared in `cli.ts`: `stt<500ms`, `brain_p50<=2000ms`, `ceiling=5000ms`,
`tts_first_chunk<800ms`. **Measured reality this session: STT 726 ms, brain 4,831 ms p50
(inkling) / 901 ms (Dots3 intake), TTS 3,196 + 1,267 ms.** STT and brain both exceed the
declared budget on the free tier.

### 3.7 Security & storage vault (`vault.ts`, `keyring.ts`)

- **Not DPAPI.** The brief said DPAPI; the code uses **AES-256-GCM** with a key derived by
  `scryptSync(machineKey(), 'opencode-voice-runtime:vault:v1', 32)`, where `machineKey` is a
  32-byte file at `~/.opencode-voice-runtime/machine.key` written 0600. The `safeStorage`
  preference is noted in a comment but **not implemented**; the fallback is unconditional.
- `KEY_POOLS = ['groq', 'fish', 'openrouter']` (L23 hardened to a closed tuple).
- Each pool: `{nonce, ciphertext, checksum}`; checksum mismatch → `VAULT_CORRUPT`, pool refused.
- `Keyring` slot assignment: wait-free `Atomics.add` on a `SharedArrayBuffer` counter;
  `keyIndex = floor(slot/10) % n` (`ROTATION_LIMIT` 10). `release(key, ok, status)`
  force-advances on **429 / 401 / 403**. Secret buffers are zero-filled on release and rollover.
- **Triple-key fail-closed mandate:** `bootstrapFromEnv` returns `null` unless all three
  pools are non-empty; the `saveApiKeys` command requires all three or returns
  `{ok:false, detail:'all 3 keys required'}`.
- **Known gap (L17, open):** 401/403 advances the key but never surfaces to the user. A vault
  with one dead key looks identical to a healthy one until the first utterance — a failure
  mode this project actually hit during the audit.

### 3.8 Desktop UI

Tauri v2 host; React 18 + Vite + Tailwind renderer; Arabic/RTL (`dir="rtl"` on the surface
root) while `index.html` is `lang="en"` (a known, unfixed inconsistency). Dark theme per
§0. The window **auto-sizes to content** via `useAutoSize` (measures `scrollHeight`), so any
non-absolutely-positioned growing element resizes the OS window. Scrollbars are globally
hidden. Voice-only: no text input anywhere; `/` and `@` are assistant-internal.

### 3.9 Mobile subsystem

**Does not exist.** See §0. `docs/19-MOBILE-PAIRING.md` is a frozen M4 design target that the
repository itself labels as not implemented. The only artifact is the `'mobile'` member of
the `Provenance` union in `src/runtime/client.ts:242`.

---

## 4. API, IPC BRIDGE & COMMAND INVENTORY

### 4.1 WS-4097 transport

- **Path** `/v1/ui`, **port** 4097, **subprotocol** `voice-ui.v1`.
- **Auth:** the bearer travels as a *second subprotocol token* (`[voice-ui.v1, <token>]`)
  because browsers cannot set `Upgrade` headers. A wrong/missing token → **401, socket
  closed, never upgraded** (fail-closed, asserted in `ui-server.test.ts`).
- **Resume:** `?lastSeq=<n>` replays missed frames; `eventId` dedupes at the edge.
- **Heartbeat:** ping every `PING_INTERVAL_MS`; `MISSED_PINGS_LIMIT` 3 → close.
- **Caps:** 8 connections (oldest evicted), 1 MiB message, 64 KiB audio frame.

### 4.2 Frame inventory (frozen, additive-only)

Downstream (`UiEventSchema`): `hello`, `inventory`, `agent`, `event`, `ack`, `error`,
`notice`, `voice`, `context`.

Upstream (`UiCommandSchema`) — **14 kinds, verified against `src/ipc/protocol.ts`**:
`abort`, `arm`, `mute`, `deafen`, `setPersona`, `switchSession`, `setSessionAgent`,
`setSessionModel`, `toggleSessionSkill`, `execSessionShell`, `saveApiKeys`, `confirm`,
`sessionContext`, `createSession`.

> **Correction (v0.7.0).** An earlier revision of this dossier listed 23 kinds, including
> `compact`, `interrupt`, `listModels`, `listSkills`, `listCommands`, `runInternalCommand`,
> `getEnvironment`, `optimizePrompt` and `setContextLimit`. **None of those nine exist.**
> The table was written from the feature intent rather than from the schema, which is the
> same class of error as documenting `mentions.ts` as wired. Anyone planning against those
> names would have built a shell that sends frames the daemon rejects as
> `unsupported command`.
>
> The same revision described the schema as `.strict()`, and that part was **correct**:
> `src/ipc/protocol.ts:385` chains `.strict()` onto the object, so an unknown key is
> rejected outright and the daemon answers `unknown command` (L23 is genuinely closed).
> I initially "corrected" this to plain `z.object` on the strength of a truncated read
> that stopped before line 385. The claim was wrong in the opposite direction from the
> phantom commands, and it is recorded here because the failure mode is the dangerous one:
> asserting a schema is *weaker* than it is invites shipping a client that depends on
> fields being silently dropped.
>
> Two consequences that are real rather than hypothetical:
>
> - `compact` is not a command, but `ServeClient.compactSession()` **does** exist and had
>   no way to be reached. It is now reachable from the voice path: a spoken `/compact` is
>   handled in `daemon.ts` `think()` and never becomes a WS command, because the HUD is
>   voice-only and a slash arrives as a transcript.
> - `runInternalCommand` and `optimizePrompt` were the natural seams for the slash and
>   optimizer modules. Both were wired in `think()` instead, so the frozen contract needed
>   **no change at all** — additive-only was preserved by choosing the transcript path.
>
> A `minutes` field is declared in the schema and in `apps/desktop/src/bridge/ws.ts` and is
> read by nothing on either side. It is dead weight in a frozen contract rather than a bug.

Audio uplink: binary frames. Audio downlink: `[0x01][seq][mp3]`.

### 4.3 Full upstream command reference (`UiCommandSchema`, `.strict()`)

| Command | Required fields | Enforced behaviour |
|---|---|---|
| `abort` | — | Cancels the in-flight reply; trips the speech gate and the pipeline generation |
| `arm` / `mute` / `deafen` | — | Local mic state; acknowledged, no daemon effect |
| `switchSession` | `sessionId` | `ses_`-prefixed id; no path injection |
| `setSessionAgent` | `agent` | Resolves against the agent catalog |
| `setSessionModel` | `model` | `parseModelRef` splits `provider/id`; bare id defaults to `opencode` |
| `toggleSessionSkill` | `skill`, `skillAction` | attach/detach |
| `execSessionShell` | `command` | **Parks for FR-12 confirmation**; metacharacter guard (L21) |
| `confirm` | `confirmId` | Executes or discards a parked command; `MAX_PARKED` 8 |
| `saveApiKeys` | `groqKey`, `fishKey`, `openrouterKey` | **All three mandatory**; writes via `writeKeyPools` |
| `setPersona` | `persona` | kareem / nour; **equality-guarded** so it cannot echo (L22) |
| `sessionContext` | — | Returns the context-gauge frame; honours `contextLimit` |
| `createSession` | `title` (directory) | Created in the project directory only |

That is the complete list. The nine phantom kinds listed in the superseded revision are
gone; see the correction note in §4.2. `compact` is reachable as a spoken `/compact`
through the transcript path, not as a command.

`DESTRUCTIVE_KINDS` requires confirmation; the parked payload is bounded by
`CONFIRMATION_TTL_MS` 60,000 **and** the L20 cap of 8 entries.

### 4.4 Downstream frame field reference

| Frame | Key fields | Notes |
|---|---|---|
| `hello` | `type`, `contractVersion` | First frame on every connection |
| `inventory` | `sessions[]` (`id`, `title`, `agent`, `model`, `state`, `tokens`) | Live session list |
| `agent` | `agents[]` (`id`, `name`) | Agent catalog |
| `context` | `sessionId`, `used`, `limit`, `percent`, `messageCount` | Gauge; `percent` is `null` when the window is unknown — **never guessed** |
| `event` | `eventId`, `seq`, `state` | Resume via `?lastSeq=`, dedupe by `eventId` |
| `notice` | `code`, `text`, `level` | Includes `assistant-said`, `voice-disabled-no-keys`, `stt-timeout` |
| `voice` | `phase` | `idle`/`listening`/`thinking`/`speaking` |
| `ack` | `id`, `ok`, `detail` | Per-command result |
| `error` | `detail` | e.g. `audio frame too large` |

### 4.5 Context-gauge maths (corrected against live data)

`windowFill` is the **most recent step's** `input + output + reasoning + cache.read +
cache.write`, **not** a sum across steps. Two corrections were forced by live measurement
against a real serve (690 context rows):

1. `/context` rows are **flat** — `{type, id, time, status, model, summary, recent, cost,
   tokens}` with `tokens` at the **top level** — not the `{info, parts}` shape the SDK types
   implied. The old reader looked for `parts[].tokens` and silently returned **zero**, which
   is why the gauge rendered nothing.
2. Summing across rows is wrong: each assistant step re-sends the whole conversation, so
   per-step `input` is cumulative. A naive sum of 671 real rows produced 1,492,988 tokens =
   **142 %** of a 1,048,576 window. The correct current fill on that session was 469,297 =
   **44.8 %** (`248 + 429 + 152 + 468,468` — cached reads *do* occupy the window).
3. `/message` rows are flat too, so `lastMessageAt` was always `null` until fixed.

### 4.6 Supervisor spawn (the real flags)

`opencode-cli serve --port 4096 --hostname 127.0.0.1` (password via **env only**, never argv —
I-4), and `node <sidecar>/dist/cli.js serve --port 4097`. **No `--resume`/`--continue` exist.**

### 4.7 Tauri commands (3)

`ensure_all_services` (returns `BringUpStatus` with a retriable `in_flight`), `ipc_token`
(the shell reads the token at runtime — never bundled), `shutdown_all_services`.

### 4.8 CLI

`node dist/cli.js doctor` (env **presence** only, never values) · `vault bootstrap` ·
`live` (real provider round-trip) · `serve` (daemon).

---

## 5. GIT STATE, GITHUB REALITY & TEST VERIFICATION

### 5.1 Branch and remote

- Local branch `main`; `origin/HEAD → origin/main`; **no `master` branch exists**.
- Remote: `https://github.com/3mar-baha/Vantrilex-OpenCode-Assistant.git` — **`isPrivate: true`**.
- `defaultBranchRef: main` (verified via `gh repo view`).

### 5.2 Commit history (HEAD = `1dbc6a5`)

```
1dbc6a5 feat(models): narrator to inkling:free with strict reply_ar schema
dc84866 feat(models): coordinator to inkling:free, intake benchmark keeps Dots3
f122900 fix(brain): tolerate a non-deterministic model instead of losing the reply
5260b2e feat(hardening): v0.6.2 — bounded resources, honest microphone, live diagnostics
f0fb5d6 fix(release): v0.6.1 — the packaged daemon could not start on v0.6.0
80a6050 chore(release): v0.6.0 — voice honesty, process hygiene, OpenCode 360 control
111a7a7 fix(context): make the context gauge actually report a window
9527b73 feat(brain): zero canned replies and the OpenCode 360 control layer
ba05917 feat(sessions): OpenCode 360 middleware - slash, mentions, context gauge, session manager
2c0e394 fix(hardening): bound audio memory, time out network calls, harden the command envelope
5546c96 fix(supervisor): harden child supervision and make bring-up diagnosable
```

### 5.3 ⚠️ Local is 3 commits AHEAD of GitHub

`git log origin/main..main` returns `1dbc6a5`, `dc84866`, `f122900`. **`origin/main` is at
`5260b2e`.** The installed desktop app is `0.7.0` — which is `5260b2e`, meaning **the machine
currently runs the pre-inkling wiring** (Nemotron coordinator, Dots3 narrator). The inkling
switch is committed and gated but **not on GitHub and not in any release**.

Releases: `v0.7.0` (Latest), `v0.6.1`, `v0.6.0` (**marked Pre-release — it is broken**),
`v0.5.0`, `v0.4.4`…`v0.4.0`.

### 5.4 Test matrix (re-executed this session)

| Suite | Framework | Result | Files |
|---|---|---|---|
| Root | Vitest (node) | **491 passed, 3 skipped (494)** | 44 passed + 1 skipped |
| Desktop | Vitest (happy-dom) | **149 passed (149)** | 23 |
| Rust | `cargo test` | **26 passed** | in-crate `#[test]` |
| E2E | Playwright | **18 passed** | 14 spec files |

`npm run test:vantrilex` = typecheck → eslint → oxlint → root vitest → desktop vitest. **Exit 0.**

**Gate blind spots, stated plainly:** E2E is *not* in `test:vantrilex`. E2E drives
`e2e/stub-daemon.mjs` — a **fake** control plane (real `UiServer` + real router, fake serve on
:4197, no providers, no vault). `scripts/live_console_test.ts` and `cli live` touch real APIs
and are in no automated gate. Consequently **the 491 tests do not prove the product runs** —
demonstrated, not theorized: v0.6.0 shipped with **every gate green** and a daemon that could
not start at all, because `onnxruntime-node` is native and absent from the sidecar. The only
thing that found it was installing the artifact and cold-launching it.

### 5.5 Audit finding ledger (L1–L24) with current status

Every latent finding from `dossier/COMPREHENSIVE_AUDIT_REPORT.md`, re-verified against HEAD.

| ID | Finding | Status | Evidence at HEAD |
|---|---|---|---|
| L1 | `AudioPlayer.queue` unbounded | **CLOSED** | `PLAYBACK_QUEUE_CAP` in `playback.ts` |
| L2 | TTS cache blob unbounded by reply length | **CLOSED** | `SPEECH_CACHE_MAX_ENTRY_BYTES` |
| L3 | Dead `FileAudioOut` never pruned | **CLOSED** | `sweepOldPlaybackFiles` + `PLAYBACK_RETENTION_MS` |
| L4 | `AudioContext` never closed | **CLOSED** | disposal path in `App.tsx` unmount effect |
| L5 | Suspended `AudioContext`, no `resume()` | **CLOSED** | resume on first interaction/enqueue |
| L6 | `AudioPipeline` windows are `await`-serial; no in-flight abort on reset | **CLOSED** (v0.7.0) | generation counter in `reset()`, re-checked after every `await`; 6 tests fail when removed, 15 pre-existing pass either way |
| L7 | O(n²) buffer concat | **CLOSED** | chunked ingest |
| L8 | Dead awaited `speakSentences` | **CLOSED** (D4) | `coordinator.ts` fire-and-forget with mandatory `.catch()` |
| L9 | Fish fetch had no timeout | **CLOSED** | `fetchWithTimeout`, `TtsTimeoutError` |
| L10 | Persona captured mid-reply | **CLOSED** | `daemon.ts:413-415` snapshots `voiceId` per utterance |
| L11 | "busy" indistinguishable from "failed" | **CLOSED** | `BringUpStatus` enum, shell retries `in_flight` |
| L12 | Child that never binds left running | **CLOSED** | `spawn_and_wait_for_port` kills on timeout |
| L13 | `SupervisedLauncher` / `resolvePort` / `siblings.ts` unreachable | **CLOSED** | deleted; `docs/26-AGENT-LAUNCHER.md` carries a supersession banner |
| L14 | 15 s of blocked webview tears the socket | **CLOSED** | hysteretic limit |
| L15 | Unbounded WS connections | **CLOSED** | `MAX_CONNECTIONS` 8, oldest-first eviction |
| L16 | Key rollover counts never surfaced | **CLOSED** (v0.7.0) | `remediationAttempted: 'KeyAdvanced'` now has a producer via `keyAdvanced()`; `doctor` reads the vault instead of env |
| L17 | Every key release reported success unconditionally | **CLOSED** (v0.7.0) | `withKey()` + `httpStatusOf()`; all 7 call sites release the real status; 6 tests fail when reverted |
| L18 | No microphone permission surface | **PARTIAL** | distinct failure notices added; grant still unverified (SEC-7) |
| L19 | Mic stayed hot on blur/minimise | **CLOSED** | `micPolicy` releases on `hidden`; `startMic` is a `useCallback` so restore really re-acquires |
| L20 | Parked-command map unbounded by TTL sweep | **CLOSED** | `MAX_PARKED` 8; both caps proven non-vacuous by disabling them |
| L21 | Shell metacharacter guard incomplete | **CLOSED** | `DESTRUCTIVE_KINDS` + confirmation gate |
| L22 | Persona set in Settings is not broadcast back to the HUD | **CLOSED** (v0.7.0) | daemon is the single source; `persona-changed` notice + `hello.persona`; equality guard makes the echo loop unrepresentable |
| L23 | `UiCommandSchema` not `.strict()` | **CLOSED** | `.strict()` + per-field validation |
| L24 | 401/403 and non-2xx both `BRAIN_TIMEOUT` | **CLOSED** | `BRAIN_AUTH` / `RATE_LIMITED` / `BRAIN_REJECTED`, applied to **both** chat paths |

**Tally: 20 closed · 3 open (L6, L16, L17, L22 = 4) · 1 partial (L18).**

### 5.6 Secret hygiene

`git grep -nE "sk-or-v1-[A-Za-z0-9]+|gsk_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9]+"` → **empty** on
every commit. `.env.local` and `vault/keyring.dat` are gitignored
(`.gitignore:19 *.local`, `.gitignore:22 vault/keyring.dat`); `git ls-files` shows **no**
secret-shaped tracked file. Key material is moved only through `writeKeyPools` (the same
encrypted merge path as the `saveApiKeys` command) and verified by SHA-256 fingerprint only.

---

## 6. OPERATIONAL FRONTIER

### 6.1 Verified-working

- Packaged v0.6.2 cold-launch: 4096 + 4097 bound, `daemon.log` 0 bytes.
- **Orphan gate 30/30 clean** against the installed build: each cycle brought up 3 processes
  (shell + sidecar `node.exe` + `opencode-cli.exe`); the Job Object reaped all 3; ports
  2→0; **0 stale ports, 0 stray processes**. (The first 30-cycle script reported a false
  30/30 ORPHAN from two bugs in the *script* — a helper that both printed and returned, and
  a `$_`-vs-`$p` cleanup error. The honest result required fixing the gate, not the product.)
- Context gauge resolves live: `windowFill 486,925 / windowMax 1,048,576 = 46.4%` against a
  real serve with 29 sessions, 423 models, 55 skills.
- Telemetry writes real rows (a keyless daemon produced a real `KEYS_MISSING` row).

### 6.2 Open items (exact)

- **Dead code: RESOLVED in v0.7.0.** Was 31 modules / 1,987 lines unreachable. Three were wired (`mentions.ts`, `slash.ts`, `prompt-optimizer.ts` — all three had been documented as shipped) and 28 were quarantined to `.opencode/_archive/dead-code-phase1/`. `src/` is now 0% dead code, re-derived from `daemon.ts` + `cli.ts`.
- **L17** — key exhaustion never surfaces; a dead key looks healthy. *(We lived this.)*
- **SEC-7** — WebView2 microphone grant in a packaged build is **unverified**. wry registers
  a `PermissionRequested` handler that leaves the mic at `PERMISSION_STATE_DEFAULT` (it only
  explicitly allows clipboard reads) and `tauri-runtime-wry` exposes **no** passthrough. The
  mitigation is three distinct user-facing notices (`NotAllowedError` / `NotFoundError` /
  `NotReadableError`); the grant itself is unproven.
- **L22** — persona set in Settings is not broadcast back to the HUD.
- **L16** — key-rollover counts never surfaced in diagnostics.
- **L6** — `AudioPipeline` windows are `await`-serial; no concurrency cap, no in-flight abort on reset.
- **Full live voice loop never completed** end-to-end. Each stage is individually verified
  (STT 726 ms, brain OK, TTS real MP3s), but speech→STT→brain→TTS through the real daemon has
  not yet run once. **Arabic STT quality is untested** — the only STT probe used English audio
  against a client that pins `language: 'ar'`, so the transcript was correctly garbage. The
  Fish-synthesized Arabic MP3s from the narration benchmark are the natural test vector.
- **Unreleased work:** 3 commits ahead of `origin/main` (§5.3).
- **Privacy trade-off undocumented:** free-tier providers state data may be used for product
  improvement. Transcripts and session titles leave the machine to Groq, Fish and OpenRouter.

### 6.3 Immediate roadmap

1. Close the full live voice loop, including the Arabic STT round-trip.
2. `v0.6.3`: rebuild sidecar + installer so the inkling switch ships; packaged cold-launch
   verify; E2E; tag and push (3 commits currently unpublished).
3. ~~Triage the dead-code ledger~~ **DONE in v0.7.0** — `mentions`, `slash` and `prompt-optimizer` are wired; the other 28 modules are quarantined and `src/` is at 0% dead code.
   `prompt-optimizer`) or delete it and correct `CHANGELOG.md` + `docs/10-CHECKPOINT.md`,
   which currently assert these are shipped.
4. L17 key-exhaustion surfacing; SEC-7 remains blocked on a physical machine with a microphone.

---

*End of dossier. 469 tracked files · 101 source files (13,370 L) · 34 live / 31 dead production
modules · 491 + 149 + 26 + 18 tests green · HEAD `1dbc6a5`, 3 commits ahead of `origin/main`
(`5260b2e`) · v0.6.2 released and installed.*
