# Changelog — opencode-voice-runtime / Voxaura

## v0.6.0 — voice honesty, process hygiene, OpenCode 360° control (2026-09-27)

Five remediation phases closed against a code-first forensic audit
(`dossier/COMPREHENSIVE_AUDIT_REPORT.md`). Installer:
`Voxaura_0.6.0_x64-setup.exe`, 26,162,843 B,
sha256 `87CDF8AFD1B7BDF0128A70C75B198DAE384F6BDEC1B79BF59501230D1D0FA3C3`.

**The assistant was answering itself (D1).** `src/runtime/vad.ts` already
contained a complete, tested `SileroVad` and `models/silero-vad.onnx` was already
on disk — nothing in production called it. Every 5 s window of room tone went to
Whisper, which hallucinated, and the assistant then reasoned about and spoke the
invented text. The defect was the missing connection, not a missing feature. Now
wired, plus two further layers: `no_speech_prob` (a `verbose_json` field we were
already paying for and discarding) and a last-5 repeat dedupe. Threshold chosen by
measurement over **1067 real frames** of Fish TTS speech: p05 0.0051 / p50 0.9387
against 0.0006–0.134 for tone and noise, at 1.5 ms per 5 s window.

**Calm, non-robotic speech (D2, D3).** A sanitiser adapted from pipecat strips
markdown, emoji, bidi controls, Arabic tashkīl and URLs before synthesis, with an
alphanumeric-preserving contract pinned by test. Against the verified Fish
`TTSRequest` schema: `latency: normal` (was `balanced`), `chunk_length: 300`,
`prosody {speed 0.95, volume −2 dB}`, `temperature 0.5`, `repetition_penalty 1.3`.

**Every reply was synthesized twice (D4).** The `speak` hook wrote an MP3 to
`%TEMP%` that nothing ever played, and the coordinator awaited that dead work
before planning. Hook removed.

**The thread is a thread (D6–D8).** Five chunky pill bars deleted, top-curve
`lineWidth` 2.5 → 1.5, amplitude now driven by live mic RMS with asymmetric
attack/release, and a per-speaker two-stop gradient (user blue→yellow, kareem
green→yellow, nour purple→pink).

**Process hygiene (D10–D12, L11, L12).** The discarded `AssignProcessToJobObject`
BOOL now decides whether a child is kept or killed; both child stdout and stderr
land in append-only files that never degrade silently to `/dev/null`; a
second-supervisor condition is detected and logged; bring-up returns a typed
status and the shell retries `in-flight` instead of hanging.

**Latent hardening (L1–L3, L7, L9, D5, L21, L23).** Bounded audio queue with
drop-oldest and a counter, a 2 MB cache ceiling, a 15-minute `%TEMP%` sweep, a
truthful `bufferedBytes`, raced timeouts on both provider calls, and a hardened
command trust boundary (`.strict()` envelope, opaque `ses_` ids, bounded fields).

**Zero canned replies.** Nine literal success strings like `تم تبديل النموذج` were
passed at the HUD call sites. `send()` no longer has a success slot at all: the
outcome goes to the conversational model with the full situation — session title,
model, context percent, target, failure reason — and the model writes the line
that is both spoken and displayed. If the brain is unavailable the narration is
skipped; there is deliberately no fallback sentence. Enforced by a source-level
scan, and the voice-only invariant (no text inputs) is asserted too.

**OpenCode 360°.** Session telemetry distinguishing *window fill* (from
`/api/session/{id}/context`) from *lifetime spend* (the session row) — confusing
them makes a gauge climb forever after a compaction. Fuzzy model/agent switching
where every match tier requires uniqueness, so a heavy task is never switched to
the wrong model by a guess. A native slash interpreter, an `@` mention resolver
that validates against `realpath`, and a prompt-optimization seam that falls back
to the user's own words rather than a template.

### Corrections to earlier claims
- The Fish `TTSRequest` schema has no `emotion`/`pitch` in `prosody`, and
  `normalize: true` is a **text** normaliser, not a loudness control. An earlier
  audit blamed the wrong field.
- `SileroVad` already existed; the audit missed it, and a Phase 0 recommendation to
  defer it on dependency grounds was therefore wrong.
- Skills, models and their context windows **are** exposed over the serve API
  (`/api/skill`, `/api/model`); a claim that they were not was wrong and had made
  the context gauge inert until fixed.

Gates: tsc 0 · eslint 0 · root vitest 448 · desktop vitest 135 · `cargo test` 26 ·
E2E 18/18 · `cargo build --release` 0.

Known gaps: live TTS/STT re-benchmark blocked on OpenRouter quota; WebView2
microphone permission unverified in a packaged build; the orphan gate was run for
3 force-kill cycles rather than the 30 the audit specified.

## v0.5.0 — UX/security overhaul, registry provisioning, live-hardened (2026-09-27)

**Connection truthfulness (UX-1).** The status pill is now driven by the
WebSocket's own `readyState`, not a 45 s timer. Any inbound frame promotes the
HUD back to `متصل`; an idle-but-open socket never reads as disconnected. The
permanent one-way latch is gone.

**Voice feedback (UX-2, UX-3, UX-4).** Live mic RMS flows from the capture
worklet into the 5-bar visualizer, so the bars breathe with real speech. The
pill now shows real phases — `جارٍ الاستماع…`, `جارٍ التفكير…`, `يتحدث الآن…` —
driven by a new additive `voice` frame from the daemon. The last transcript is
shown in the HUD.

**Error transparency (UX-5).** STT/brain/TTS failures and first-run keyless
state broadcast an additive `notice` frame rendered as a dismissible Arabic
banner; the keyless banner carries an "أدخل المفاتيح" call to action (UX-6).

**Keys activate without restart (UX-8).** `buildVoicePipeline()` is extracted
and re-invoked on `saveApiKeys`, so newly saved keys enable the voice loop
immediately. The install vault root is created and seeded on first run.

**FR-12 confirm surface (SEC-1).** `ConfirmPortal` is mounted in the HUD: a
`confirmation-required` ack opens the modal with the parked action and emits
`{kind:'confirm', confirmId, approve}`. Shell commands with injection
metacharacters are rejected before parking, and session ids are validated as
opaque `ses_…` tokens (SEC-2).

**Session state (UX-7).** `/api/session` carries no `state`; the client now
derives it from real fields (`outcome` → label) instead of rendering `unknown`.

**Registry toolkit.** 7 default skills, 3 agents, 4 hooks and 5 MCP servers
provisioned from the Vantrilex registry.

## v0.4.4 — Compact session dropdown + balanced HUD (2026-09-26)

**Session UI.** The historical session list rendered as one row per `ses_…`,
which grew the auto-sized window and pushed the mic and 5-bar visualizer off
screen. `SessionChip` is now a single fixed-height row (`max-height: 48px`)
showing only the active session, with the full history in a dropdown that
opens on demand, closes on select / outside-click / Escape, and is absolutely
positioned so it never affects the measured layout. With 30 sessions the HUD
stays compact and the mic remains centered and visible.

## v0.4.3 — Fix cold-start daemon connection (2026-09-26)

**Root cause.** The shell read its per-install IPC token (`ipc.token`) when the
webview mounted, but the token was first written by the daemon *after* serve
bring-up. On a cold install the read raced the write, returned undefined, and
the HUD latched a permanent "غير متصل" with no retry — even though the daemon
came up seconds later on 4097.

**Fix.**
- The Rust supervisor now writes the IPC token synchronously in `setup()`,
  before the webview loads, and passes it to the daemon via
  `VOICE_RUNTIME_IPC_TOKEN`.
- The renderer resolves the token with a bounded retry
  (`resolveIpcTokenWithRetry`), so a slow bring-up converges instead of
  giving up.

**Verified live:** cold launch with the token file deleted → 4096 + 4097
listening and an ESTABLISHED webview connection within seconds; HUD shows
"● متصل وبانتظار الأوامر".

## v0.4.2 — Production rebuild: emblem icon + sketch HUD in the installer (2026-09-26)

**Why a rebuild:** the v0.4.1 installer predates the icon regeneration, so it
embedded stale orange rasters and the pre-bars HUD. v0.4.2 bakes the current
tree into a fresh NSIS setup: regenerated blue-emblem `icon.ico` (6-image,
pixel-verified `#2563EB`), the 5-bar reactive voiceprint visualizer, and the
whiteboard sketch HUD — no IPC, vault, or orchestration changes.

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
