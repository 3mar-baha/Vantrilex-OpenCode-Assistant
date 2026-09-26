# Changelog — opencode-voice-runtime / Voxaura

## v0.4.1 — Barge-in, sentence-streamed TTS, Dots3 fast primary (2026-09-26)

**Voice interaction (new in the installer)**
- Barge-in & echo suppression: renderer ducks quiet mic frames while TTS
  plays (RMS energy gate); voice bursts stop playback and send a silent
  `abort`; daemon trips a speech gate so stale sentences never synthesize.
  E2E `bargein.spec.ts` proves abort delivery over the real bridge.
- Sentence-level TTS: first clause synthesizes and broadcasts immediately.
  Live cold-synthesis TTFB 977–4029 ms across 3 runs (Fish server variance);
  cache hits start at 0 ms. Client-side paragraph buffering eliminated.
- Dots3 fast primary: reasoning-suppressed intake answers in ~1.5 s with no
  failover; Nemotron plans under strict JSON schema + one bounded retry.

## v0.4.0 — Voice capture loop + 3-agent orchestration (2026-09-26)

**P4 voice capture (renderer mic → daemon pipeline)**
- Binary PCM uplink (`UiServer.onAudio`, 64 KB cap), exact 5 s windowing
  (`AudioIngest`), transcribe → think → dispatch-if-active pipeline.
- Daemon wires keyring pools → Whisper/OpenRouter → active-session dispatch;
  silence spends nothing, keyless daemons drop audio safely.
- Renderer `AudioCapture` (AudioWorklet + fallback), 16 kHz mono Int16;
  mic starts muted; `sendPcm` fire-and-forget. E2E with fake mic device.

**P5 3-agent runtime orchestration**
- `Coordinator`: Dots3 intake (`{reply_ar, task_en}`) → Nemotron plan →
  Inkling `mission-handoff` dispatch with receipt. Fast TTS reply first.
- Measured: Dots3 returns null-content on this route → automatic one-shot
  failover to Nemotron intake (verified live, 9.8 s wall).
- Destructive plans held for `approve:true`; no implicit raw dispatch, ever.

**Housekeeping:** deleted 5 coral drafts + `vantrilex-registry/` staging;
tree fully clean.

## v0.3.0 — Zero-click desktop release (2026-09-25)

**Repairs (audit response)**
- **H2/H3**: production daemon composition (`src/daemon.ts`) + `serve` CLI; UI key
  intake persists to the encrypted vault via `src/voice/key-store.ts`.
- **H1**: FR-12 execution gate — destructive commands (`execSessionShell`) are
  parked until an explicit `confirm` (60 s TTL, cancel path).
- **H4**: per-install IPC token (`~/.opencode-voice-runtime/ipc.token`, 0600)
  fetched at runtime by the webview; nothing baked into the bundle.
- **M3**: hardened CSP (`object-src`/`base-uri`/`frame-ancestors`/`form-action`
  `'none'`, explicit `script-src`/`img-src`).
- **M4**: 1 MiB inbound frame cap, rejected before allocation.
- **M6**: truthful `setPersona` state + 45 s bridge staleness watchdog.

**Desktop**
- Zero-click 3-tier bring-up: the shell probes 4096/4097 and starts what is
  missing (opencode serve, then the Node daemon), sharing one per-install serve
  password; adopts healthy services instead of double-spawning.
- Win32 Job Object with `KILL_ON_JOB_CLOSE`: children die even on a force-kill.
- Self-contained installer: bundled Node sidecar (`node.exe` + pruned runtime
  deps, 100.4 MB) declared as Tauri resources — no end-user prerequisites.
- HUD decluttered (no raw model ids), `إيقاف/إعادة التوليد` toggle, auto-sized
  windows with a 16 px bottom buffer, hidden scrollbar chrome, dark canvas to
  prevent white flashes, dedicated Settings and API-keys windows.

**Deferred to v0.4.0:** renderer audio capture (L1) and runtime 3-agent
orchestration (P5).

## Hierarchical Multi-Agent Governance (2026-09-25)

- Nemotron (`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`) promoted to
  coordinator default after live smoke (HTTP 200, `msg_…` receipt, identity reply).
- Role slugs registered: Dots3 intake, Nemotron coordinator, Inkling driver,
  stealth standby. Six MCP servers incl. new `obsidian-vault`; project-relative paths.
- `docs/RAG-ORCHESTRATOR-NEMOTRON.md` + `docs/RAG-INKLING-OPENCODE-DRIVER.md`
  (LangGraph/CrewAI/AutoGen/agent-loop harvest).
- Inkling persistent subagent (`.opencode/agents/inkling-driver.md`).
- Self-bootstrapping Obsidian vault (`src/memory/vault.ts`, TDD) + CLI bootstrap.
- Bridge skills: mission-handoff, prompt-synthesis, vault-sync.
- Gates: root 157 + desktop 54 green; E2E 8/8.

## Final Polish: Agents + Router + Preflight (2026-09-24)

- `ServeClient.listAgents(directory)` (2.0.x `?directory=`); 17 live agents.
- `createCommandHandler` daemon-side WS execution with structured error acks.
- WS `agents` frame + live desktop agent selector; async `onCommand` in UiServer.
- NSIS installed via winget; packaging preflight 14/15 (MSVC linker pending).

## Runtime Unification (2026-09-24)

- Canonical runtime = desktop-bundled 2.0.12 CLI on the shared DB; version-aware
  `promptEnvelope` (flat 2.0.x / nested 1.18.x). Live: 29 sessions, full CRUD +
  controls green, Fish TTFB under budget.

## Control-Plane Migration (2026-09-24)

- HTTP Basic `opencode:<password>`; sessions at `/api/session`; SSE `/api/event`.
- 204 controls; model switch via POST `ModelRef`; client-id omission on create.

## Phases 1–3 Orchestration

- SessionInventory poller, sibling-serve protection, dispatchPrompt +
  backpressure, switchSession bridge, per-session controls.

## Gates 1–5: Voxaura Shell + WS-4097 Bridge

- Tauri v2 + React shell, WS-4097 bridge, portals, matrix, telemetry, VAD, RAG,
  E2E suite, icons, release checklist. Monorepo `apps/desktop/` (O1–O6).

## Gate 1: Agentic Runtime (`/arm`)

- 9 skills + 7 agents + hook references + MCP servers wired.
