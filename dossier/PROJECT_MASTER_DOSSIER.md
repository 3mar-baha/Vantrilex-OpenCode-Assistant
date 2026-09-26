# VOXAURA — PROJECT MASTER DOSSIER

**Forensic, code-first audit. Repository:** `O:\opencode-Vantrilex`
**Audited commit:** `f2c075a149fae5543263f85abb37c5b0e981663f` (tag `v0.4.4`)
**Method:** raw source, configs, binaries, and live OS/process reality only. No documentation claim, comment, README, or prior summary is treated as evidence.
**Audit host snapshot (live):** `voxaura.exe` PID 10980 (v0.4.4, `C:\Users\omarb\AppData\Local\Voxaura\voxaura.exe`); `opencode-cli.exe` PID 6068 listening `127.0.0.1:4096`; bundled sidecar `node.exe` PID 33688 listening `127.0.0.1:4097` with one **ESTABLISHED** webview connection. At the instant of audit the socket is healthy — the reported failures are *conditional*, not universal, and are fully explained below.

---

## 1. Executive Truth Summary

The project is a genuinely non-trivial Tauri v2 + Node system with a real, zero-dependency WebSocket control plane and a real encrypted vault. However, **the automated gates overstate live capability**. Three structural gaps separate the green test suite from the user's desktop experience:

1. **The connection indicator is self-defeating.** The HUD latches a permanent `غير متصل` / `انقطع الاتصال بالخادم` state ~45 s after any idle period *even while the WebSocket remains open and healthy*, because the staleness watchdog has no recovery path and only one frame type refreshes its timer. There is **no test** for the watchdog. This is the mechanical cause of "continuously shows انقطع الاتصال".

2. **The installed application is cryptographically keyless.** The supervisor forces the daemon's vault root to `%LOCALAPPDATA%\Voxaura\vault`, which **does not exist**; the only real `keyring.dat` lives in the repo. `Keyring.load` therefore throws, the daemon swallows the exception, and the **entire voice pipeline (STT + brain + TTS) is disabled** on a real install. The control plane stays up (hence "connected"), but the product's core feature is dead. No live test covers the keyless path — every test hands the daemon a populated vault.

3. **The FR-12 confirmation gate is unreachable from the UI, and session state is fake.** `ConfirmPortal` is rendered nowhere; the renderer never emits a `confirm` command, so any parked destructive action can never be released through the shell. Separately, every session in the inventory is labelled `unknown` because the client maps a missing `state` field to the literal string `'unknown'` — a serve-contract mismatch that makes the session state column meaningless.

The test suites are overwhelmingly hermetic: network clients are injected mocks, and the E2E suite drives a **stub daemon** (`e2e/stub-daemon.mjs`) over a fake control port, never the production daemon + providers. Green gates prove *wiring contracts*, not *live provider behaviour*.

---

## 2. Root Cause Analysis of the Live Defects

### 2.1 "انقطع الاتصال بالخادم" on double-click (persistent disconnect)

**Verdict: real renderer defect (deterministic). Not a spawn failure in the current build.**

The daemon actually starts. Live proof — `~/.opencode-voice-runtime/supervisor.log` (raw) shows, for every launch, the full success path:

```
[ts] ensure_all_services: begin
[ts] ipc token: ready
[ts] opencode: opencode serve started on 4096
[ts] resolve: resource_dir=Some("\\?\C:\Users\omarb\AppData\Local\Voxaura")
[ts] resolve: node=...\Voxaura\sidecar\node.exe entry=...\Voxaura\sidecar\dist\cli.js
[ts] daemon: daemon started on 4097
```

and `netstat` shows `127.0.0.1:4097 LISTENING` plus an `ESTABLISHED` pair. So WS-4097 is up.

The disconnect is **manufactured by the renderer**. Exact chain:

- `apps/desktop/src/App.tsx:53` — `lastFrameAt` is initialised to `Date.now()`.
- `apps/desktop/src/App.tsx:86` — **only** `onEvent` refreshes it: `lastFrameAt.current = Date.now();`.
- `apps/desktop/src/App.tsx:82` — **only** `onHello` restores `'live'`: `onHello: () => setBridge('live')`.
- `apps/desktop/src/App.tsx:122-128` — a 5 s interval trips a 45 s staleness watchdog:
  `if (Date.now() - lastFrameAt.current > 45_000) setBridge((s) => (s === 'live' ? 'degraded' : s));`
- `apps/desktop/src/App.tsx:107` — `onClose` also only demotes from `live`; it never promotes.
- `apps/desktop/src/bridge/ws.ts:336-347` — `inventory` frames are dispatched to `onInventory` but **never touch `lastFrameAt`**; `agents` (`:349-358`) likewise.
- The daemon's keepalive is a **protocol-level ping** (`src/ipc/ui-server.ts:430`, `Buffer.from([0x89,0x00])`), which the browser answers at the transport layer and which **never surfaces to JS `onmessage`** — so it cannot refresh the watchdog.

**Consequence:** on any system where sessions are idle, no `event` frames arrive, the watchdog trips after ~45 s, the HUD flips to `degraded` → `statusPill` (`App.tsx:242-251`) renders `● غير متصل` and the banner at `App.tsx:289-297` renders `انقطع الاتصال بالخادم — تتم إعادة المحاولة تلقائياً…`. Because the socket never closed, no reconnect occurs, so `onHello` never fires again and the state is **latched permanently** until the app is restarted or a real socket drop happens to occur. This exactly reproduces the user's screenshot.

There is **no unit or E2E test targeting this watchdog** (no test file references `lastFrameAt` or the 45 s interval). It is untested live behaviour.

**Secondary spawn-quality issues (non-fatal but real):**
- The daemon's `stdout` is `Stdio::null()` (`main.rs:450`) while it logs with `console.log`; `stderr` is redirected to `daemon-stderr.log`, which is **0 bytes** — so a running daemon is almost entirely unobservable from disk.
- `BRINGUP_INFLIGHT` (`main.rs:89,487`) is logged as `already in flight — skipping duplicate` on the *second* caller, but the first caller's log line `begin` is written by the same thread; the log ordering interleaves the setup-thread call and the frontend call. Harmless, but it means the frontend's `ensureServices()` result is `["bring-up already in flight"]` and carries no diagnosis.
- `ensure_opencode` spawns `opencode serve` with `OPENCODE_SERVER_PASSWORD` but **without** any `cwd`, on **no retry**, with a 20 s port budget (`main.rs:407-428`). A machine where the bundled CLI is slow to bind will surface `opencode serve did not open 4096 in time`.

### 2.2 Persistent legacy orange taskbar icon

**Verdict: Windows Explorer icon cache is stale. The binaries are unambiguously blue.**

Binary evidence (every sub-image decoded from the container, not visually inspected):

```
=== apps/desktop/src-tauri/icons/icon.ico (6 images) ===
  [0] dir=32x32   PNG mean RGB [38,100,235]
  [1] dir=16x16   PNG mean RGB [38,100,235]
  [2] dir=24x24   PNG mean RGB [38,100,235]
  [3] dir=48x48   PNG mean RGB [38,100,235]
  [4] dir=64x64   PNG mean RGB [38,100,235]
  [5] dir=256x256 PNG mean RGB [37,99,235]
```

`#2563EB` = `(37,99,235)`. **All six sizes are the blue emblem.** The installed PE was independently probed: `ExtractAssociatedIcon` on `C:\Users\omarb\AppData\Local\Voxaura\voxaura.exe` returns a `32x32` bitmap with mean paint RGB `(38,100,235)` — blue. The legacy orange art was removed by history: `36d242a feat(branding): Voxaura sound-and-aura icon set` → `63700dd refactor(branding): simplify icon to pure blue waveform emblem` → `321e963 feat(branding): regenerate icon set from canonical 5-bar emblem`.

Therefore the orange cannot originate from `icon.ico`, the compiled exe, or the installer. It originates from the **Explorer icon cache**, keyed by exe path, which still holds bitmaps created before the icon change:

```
iconcache_32.db    2097152   9/24/2026 8:07:48 PM
iconcache_256.db   2097152   9/25/2026 11:07:44 AM
iconcache_16.db    1048576   9/22/2026 5:34:17 PM
iconcache_48.db    1048576   9/22/2026 5:34:17 PM
```

These timestamps **predate** the 9/26/2026 blue-icon work. `ie4uinit.exe -show` does **not** rebuild these DBs (timestamps unchanged after running it), which is why the taskbar still shows the old bitmap for the same command path. There is no pinned `Voxaura.lnk` in `…\User Pinned\TaskBar` (only a Start-Menu shortcut at `…\Start Menu\Programs\Voxaura.lnk`, created 6:59:01 PM, i.e. post-install), so a stale *shortcut* is ruled out; the stale *icon-cache* is the cause.

**Definitive fix (host-side, not code):** stop Explorer, delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` (and `%LOCALAPPDATA%\IconCache.db` if present), restart Explorer. This is momentarily disruptive (the shell restarts) and is the only reliable cache purge.

---

## 3. Complete Physical File Manifest

Roles are the **actual** behaviour read from source, not aspirations. Grouped for density; every tracked source file is covered.

### 3.1 Root / config

| Path | Actual function |
|---|---|
| `package.json` | Root package `opencode-voice-runtime@0.4.4`; scripts `build`, `typecheck`, `lint`, `lint:ox`, `test`, `test:desktop`, `test:vantrilex`, `doctor`. |
| `tsconfig.json` | Strict NodeNext ESM compile of `src/` → `dist/`. |
| `vitest.config.ts` | Root unit test runner (node env). |
| `eslint.config.js`, `.oxlintrc.json` | Lint gates; `test:vantrilex` runs eslint + oxlint with zero-warning policy. |
| `opencode.json` | OpenCode engine config: default model + provider slugs + MCP servers. |
| `.mcp.json` | MCP server wiring. |
| `.env.example` | Documents env var names; contains no secrets. |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | **Present but unused by the build** — the repo is npm-driven (no root `package-lock.json`; only `apps/desktop/package-lock.json`). Dead weight / drift risk. |
| `pyrightconfig.json` | Python type config; **no Python source exists** — orphaned. |
| `CHANGELOG.md`, `README.md`, `README.ar.md`, `CONTRIBUTING.md`, `LICENSE` | Documentation (explicitly **not** used as evidence in this audit). |

### 3.2 `src/` — Node daemon (the real backend)

| Path | Actual function |
|---|---|
| `src/cli.ts` | Entry for `doctor | vault bootstrap | live | serve`. `serve` builds the daemon; `live` runs a real TTS→STT→brain→TTS round-trip. |
| `src/daemon.ts` | **Composition root.** Validates serve password/ipc token; probes serve health; builds `UiServer`, `ServeClient`, `SessionInventory`, `Coordinator`, `TtsEngine`, `AudioPipeline`, keyring. **Voice pipeline is wrapped in `try/catch` → `audio = null` on any keyring failure** (`:108-190`). Expo: `vaultPathFromEnv`, `ipcTokenFromEnv`, `ipcTokenPath`, `ensureIpcToken`. |
| `src/common/{brands,config,errors,logger,index}.ts` | Branded IDs (`SessionId`), config loader, `OrchestratorError` codes, structured logger, barrel. |
| `src/ipc/protocol.ts` | Frozen WS-4097 frames: `hello`/`inventory`/`agents`/`event`/`ack`/`error`; `UiCommandSchema` (12 kinds incl. `confirm`, `saveApiKeys`); 1 MiB `MAX_MESSAGE_BYTES`; `UI_WS_PATH=/v1/ui`, `UI_SUBPROTOCOL=voice-ui.v1`. |
| `src/ipc/ui-server.ts` | Zero-dep RFC 6455 server on 127.0.0.1:4097. Bearer via header **or** subprotocol; `?lastSeq=` resume; level-triggered `publishInventory`/`publishAgents`; `broadcastAudio` binary fan-out; protocol ping `0x89 0x00` (`:430`). |
| `src/ipc/audio.ts` | Binary downlink codec `[type:1][seq:u16be][mp3…]`, `splitAudio` chunking. |
| `src/ipc/attach.ts` | Attach helper for the server. |
| `src/runtime/client.ts` | Typed HTTP `ServeClient` (Basic auth). **`listSessions` maps a missing `state` to `'unknown'` (`:47`).** `promptSession`, `createSession`, agent/model/skill/shell controls (204). |
| `src/runtime/vad.ts` | Server-side VAD utilities. |
| `src/runtime/laya/*` | Laya engine + tokenizer + golden fixture + integration test. |
| `src/launcher/*` | `launcher.ts` (boot/supervision), `siblings.ts` (single-supervisor sweeper), `sweeper.ts`, health probes (`probeHealth`). |
| `src/orchestrator/orchestrator.ts`, `queue.ts`, `dispatch.ts`, `events.ts`, `ledger.ts` | Event inbox → FIFO → workers; dedupe/backpressure; append-only ledger. |
| `src/orchestrator/inventory.ts` | Polls `listSessions`, diffs, emits add/update events; snapshot publisher. |
| `src/orchestrator/command-router.ts` | Maps `UiCommand` → `ServeClient`; FR-12 parks `execSessionShell` for 60 s until `confirm`; `onAbort` trips the speech gate. |
| `src/orchestrator/coordinator.ts` | 3-agent chain: Dots3 intake (`reasoning: none`) → Nemotron strict-schema plan (+1 retry) → Inkling handoff; `buildHandoff` envelope. |
| `src/orchestrator/audio-pipeline.ts` | PCM windows → `transcribe` → `think` → dispatch-if-active; silence is free; no active session ⇒ no dispatch. |
| `src/orchestrator/laya-advisor.ts` | Laya advisory scoring (advisory-only). |
| `src/voice/vault.ts` | AES-256-GCM `FileVault`; `load()` returns `null` when the file is absent; `encryptPool`/`decryptPool` with checksum-then-decrypt; `bootstrapFromEnv` enforces the 3-key mandate. |
| `src/voice/keyring.ts` | `Keyring.load` **throws** on empty vault / empty pool (`:32-45`); shared-counter rotation every 10 acquires; zeroing on release. |
| `src/voice/key-store.ts` | `writeKeyPools` merges pools into the vault (UI key intake path). |
| `src/voice/brain.ts` | `openRouterChat` (Bearer, `json_object`/`json_schema`, per-call reasoning/tokens/timeout), `extractJson`, `requiresConfirmation`. |
| `src/voice/tts.ts` | `TtsEngine`, `speakSentences`, `splitSentences`, `SpeechGate`, `FishHttpTransport` (Fish Audio `s2.1-pro-free`), `FileAudioOut`. |
| `src/voice/stt.ts` | `GroqWhisperClient` + `transcribeStream` (Groq Whisper). |
| `src/voice/ingest.ts` | 100 ms chunk accumulation → exact 5 s windows, overflow shedding. |
| `src/voice/cache.ts` | Disk MP3 cache keyed by hash(text+voice). |
| `src/voice/disambiguation.ts` | Intent disambiguation helpers. |
| `src/memory/vault.ts` | Self-bootstrapping Obsidian notes + MOC under `VOXAURA_VAULT_DIR` / `<cwd>/vault`. |
| `src/guidance/*` | Agents catalog, BLUF, RAG (normalize/retriever/personas/guard), corpora manifest, overseer, guild-skills (+ `.stub.ts`). |
| `src/telemetry/*` | Telemetry writer. |
| `src/ui/*` | `mic.ts`, `modal.ts`, `settings.ts` — **legacy non-Tauri UI helpers**; the live UI is `apps/desktop`. |

### 3.3 `apps/desktop/` — Tauri shell + React renderer

| Path | Actual function |
|---|---|
| `src-tauri/src/main.rs` | Process supervisor: Job Object (`KILL_ON_JOB_CLOSE`), `ensure_ipc_token` (written in `setup()` before webview), `ensure_serve_password`, `ensure_opencode`, `ensure_daemon` (passes `VOICE_RUNTIME_IPC_TOKEN`), `ensure_all_services` single-flight, `ipc_token` command, `resolve_vault_dir` (**forces `%LOCALAPPDATA%\Voxaura\vault`**), `resolve_node_bin`, `resolve_daemon_entry`. |
| `src-tauri/tauri.conf.json` | Product `Voxaura` `0.4.4`; CSP allows `connect-src ws://127.0.0.1:4097`; bundle `resources: sidecar/**/*`; NSIS target; icon list. |
| `src-tauri/capabilities/default.json` | Least-privilege window/webview perms only. **No mic/media permission; no fs/shell/http plugin.** |
| `src-tauri/Cargo.toml`, `Cargo.lock` | Rust deps (`tauri 2.x`, `windows-sys 0.61`). |
| `src-tauri/icons/*` | All-blue icon set (verified §2.2). |
| `src/App.tsx` | HUD: bridge wiring, **staleness watchdog**, session chip, agent/model badge, persona, mic/bot toggles, abort, barge-in frame policy, portals launchers. |
| `src/bridge/ws.ts` | `VoxauraBridge`: subprotocol bearer, `?lastSeq=` resume, binary audio routing, ack ledger, refusal latch (`refused`), backoff reconnect, hello/inventory/agents/event handling. |
| `src/settings/ipc-token.ts` | `envToken`, `isTauriHost`, `resolveIpcToken`, `resolveIpcTokenWithRetry` (bounded poll). |
| `src/settings/services.ts` | `ensureServices` → `invoke('ensure_all_services')`. |
| `src/settings/chain.ts`, `open-settings.ts` | Persona chain + multi-window launchers. |
| `src/audio/capture.ts` | `AudioCapture`: `getUserMedia` (16 kHz, echo cancelling) + AudioWorklet (ScriptProcessor fallback), 100 ms Int16 frames. |
| `src/audio/playback.ts` | `AudioPlayer`: strict FIFO decode/play, `stop()` generation guard; `createDefaultPlayer` (AudioContext). |
| `src/audio/vad.ts` | `frameEnergyDb`, `isSpeechFrame`, `bargePolicy` (duck/barge/send). |
| `src/audio/earcons.ts` | Earcon tones. |
| `src/components/portals/ConfirmPortal.tsx` | FR-12 T2 surface — **defined and unit-tested, rendered nowhere**. |
| `src/components/portals/{ApiKeysModal,CredentialPortal,PortalShell}.tsx` | 3-key intake portal (rendered in the `api-keys` window). |
| `src/components/session/{SessionChip,AgentModelBadge}.tsx` | Compact session dropdown; agent/model badge + live agent `<select>`. |
| `src/components/waveform/SiriWaveCanvas.tsx` | 5-bar emblem voiceprint + sine backdrop canvas. |
| `src/components/brand/{WaveformEmblem,Crest}.tsx` | Inline emblem / crest SVGs. |
| `src/components/settings/{SettingsView,KeysView}.tsx` | Settings/keys window bodies. |
| `src/components/icons/ControlGlyphs.tsx` | Mic/bot SVG glyphs. |
| `src/matrix/matrix-state.ts` | Daemon-state → HUD wave-mode/matrix mapping. |
| `src/sessions/store.ts` | Sessions reducer (replace/select). |
| `src/window/useAutoSize.ts` | ResizeObserver → Tauri `setSize`; **measures `scrollHeight`, so DOM height == window height**. |
| `src/styles/tokens.css`, `src/index.css` | Design tokens, sketch dialect, `vx-session-bar` max-height. |

### 3.4 `apps/desktop/e2e/` — Playwright

| Path | Actual function |
|---|---|
| `stub-daemon.mjs` | **Fake** control plane: imports the real `UiServer` + `createCommandHandler` from `dist/`, serves a control HTTP API on `:4197`, records commands/shells/audio. **Not the production daemon; no providers, no vault.** |
| `boot|matrix|abort|inventory|controls|portals|apikeys|capture|downlink|fr12|disconnect|bargein|session-compact.spec.ts` | Drive the renderer against the stub. `capture`/`bargein` use Chromium's fake media device. `fr12` drives the socket directly, bypassing the UI. |

### 3.5 `scripts/`

| Path | Actual function |
|---|---|
| `provision-sidecar.mjs` | Copies `node.exe` + `dist/` + a **pruned** dependency manifest into `src-tauri/sidecar/`. |
| `packaging-preflight.mjs` | Read-only readiness matrix (reports MSVC linker missing because it does not load VsDevCmd). |
| `live_console_test.ts` | Real-provider harness (not part of `test:vantrilex`). |
| `key-report.mjs` | Key fingerprint inventory (counts/prefixes, no material). |
| `generate-whiteboard-assets.mjs` | Generates the SVG diagram set. |

### 3.6 `assets/` (19) and `docs/` (41)
SVG diagrams and the frozen `01–28` design suite + operational docs. **Excluded from evidence per audit rules.**

---

## 4. Feature Verification Matrix

Status legend: **Real** = wired to live providers/OS and observed; **Partial** = wired but gated/degraded in real installs; **Stub** = only exercised against fakes; **Broken** = cannot work in the live app.

| # | Feature | Claimed | Code status | Live reality |
|---|---|---|---|---|
| 1 | Supervisor spawns serve + daemon | yes | **Real** (`main.rs:407-481`) | 4096/4097 listening every launch (log+netstat). |
| 2 | WS handshake + inventory/agents/event | yes | **Real** (`ui-server.ts`) | ESTABLISHED socket; inventory frames observed. |
| 3 | Connection pill truthfulness | "متصل" | **Broken** (`App.tsx:82,86,122-128`) | Latches false `غير متصل` after ~45 s idle while socket is alive. |
| 4 | Auto-launch on double-click (v0.4.3) | fixed | **Real** (token written in `setup()`) | Cold launch with token deleted → connected. |
| 5 | Microphone capture | yes | **Partial** (`capture.ts:83`) | `getUserMedia`/AudioWorklet present; **no Tauri mic permission declared** — grant path unverified in WebView2. |
| 6 | PCM uplink to daemon | yes | **Real** (`ws.ts:242`) | Frames transmitted (E2E `capture`). |
| 7 | STT (Whisper/Groq) | yes | **Broken in install** (`daemon.ts:142-150`) | `audio` is `null` on the installed app (no vault) ⇒ `ui.onAudio` unset ⇒ PCM silently dropped. |
| 8 | Brain (Dots3→Nemotron) | yes | **Broken in install** (`daemon.ts:128-141`) | Behind the same `audio` gate; also needs an OpenRouter key. |
| 9 | TTS downlink (Fish) | yes | **Broken in install** (`daemon.ts:157-181`) | Same gate; `broadcastAudio` itself is real and tested. |
| 10 | Renderer speech playback | yes | **Real** (`playback.ts`, `ws.ts:276-281`) | Binary frames route to `AudioPlayer`; E2E `downlink`. |
| 11 | Barge-in / echo duck | yes | **Real** (`vad.ts`, `App.tsx:213-227`, `daemon.ts:165-175`) | Unit + `bargein.spec` (stub). |
| 12 | Sentence-streamed TTS | yes | **Real** (`tts.ts:speakSentences`) | Live `live` harness measured cold TTFB milliseconds; gated off in install by #9. |
| 13 | FR-12 confirmation gate | yes | **Broken in UI** (`ConfirmPortal` unreferenced; no `confirm` sender) | Daemon parks; **no UI can confirm**. `fr12.spec` bypasses the UI. |
| 14 | 3-key intake → vault | yes | **Real** (`key-store.ts`, portal) | Writes pools to the vault path; **does not rebuild the running `audio` pipeline** (restart required). |
| 15 | Encrypted vault | yes | **Real** (`vault.ts`) | Crypto correct; **install resolves a non-existent path** (§2.1/finding 2), so it is empty on disk. |
| 16 | Session inventory states | "running/idle" | **Broken** (`client.ts:47`) | Every session state = `'unknown'` (serve list lacks the expected field). |
| 17 | Session switcher | yes | **Real** (`SessionChip.tsx`, `command-router`) | Compact dropdown + `switchSession` ack. |
| 18 | Agent/model controls | yes | **Partial** (`client.ts:141-200`) | Wired; model switch depends on live serve acceptance. |
| 19 | Job Object teardown | yes | **Real** (`main.rs:54-84`) | Force-kill reaps 4096/4097 (observed zero orphans). |
| 20 | Self-contained installer | yes | **Real** (`provision-sidecar.mjs` + NSIS) | Ships `node.exe` + sidecar; **ships no vault/keys**. |
| 21 | Windows blue taskbar icon | yes | **Real binary / stale cache** | Exe+ICO blue; Explorer cache (9/24–9/25) shows old orange. |
| 22 | Sketch HUD + emblem visualizer | yes | **Real** (`SiriWaveCanvas.tsx`) | Rendered; geometry proven by `session-compact.spec`. |

---

## 5. Runtime Architecture & Process Lifecycle

**Cold launch → ready (observed):**

1. User double-clicks `voxaura.exe`. Tauri builds the webview; `setup()` (`main.rs:522`) **synchronously writes/loads** `~/.opencode-voice-runtime/ipc.token` (`ensure_ipc_token`).
2. `setup()` spawns a background thread → `ensure_all_services` (single-flight `BRINGUP_INFLIGHT`).
3. `ensure_ipc_token` ✓ → `ensure_opencode`: if 4096 cold, spawn `opencode-cli.exe serve --port 4096` with `OPENCODE_SERVER_PASSWORD` (`ensure_serve_password`, persisted `serve.pass`), wait ≤20 s.
4. `ensure_daemon`: resolve sidecar `node.exe` + `dist/cli.js`; spawn with `OPENCODE_SERVER_PASSWORD`, `VOICE_RUNTIME_IPC_TOKEN`, `VOXAURA_VAULT_DIR=%LOCALAPPDATA%\Voxaura\vault`; `stderr` → `daemon-stderr.log`; wait ≤20 s for 4097. Both children adopted into the Job Object.
5. Independently, the renderer mounts: `ensureServices()` (invoke) and `resolveIpcTokenWithRetry()` → `ipc_token` command → token from file.
6. `VoxauraBridge.connect()` opens `ws://127.0.0.1:4097/v1/ui` with subprotocols `[voice-ui.v1, <token>]`. `UiServer` validates subprotocol+token (401 else), replies 101, sends `hello`, then inventory/agents.
7. `onHello` ⇒ `live`. `onInventory` ⇒ session list. `onEvent` ⇒ matrix + `lastFrameAt`.

**Idle → false disconnect (defect):** step 7's `lastFrameAt` stops advancing; at t≈45 s the watchdog (§2.1) flips `degraded`; nothing promotes it back.

**Teardown:** `RunEvent::Exit/ExitRequested` → `Supervisor.reap()`; the Job Object (`KILL_ON_JOB_CLOSE`) is the hard guarantee — observed: after `Stop-Process -Force` both 4096 and 4097 were released.

---

## 6. Detailed Remediation Roadmap

Prioritised; each item cites the exact file/line to change. No item is a placeholder.

### P0 — Correctness of the live experience

1. **Fix the staleness watchdog (connection pill).** `apps/desktop/src/App.tsx`
   - Refresh the liveness timer on **every** inbound frame: set `lastFrameAt.current = Date.now()` in `onHello`, `onInventory`, `onAgents`, and `onAudio` (not just `onEvent`) — or move the stamp into `VoxauraBridge` (`bridge/ws.ts:onMessage`) and expose `lastFrameAt()`.
   - Give the watchdog a **recovery path**: when a frame arrives and the socket is `OPEN`, promote `degraded → live` (e.g. `onEvent/onInventory` call `setBridge((s) => s === 'degraded' ? 'live' : s)`), or drive the pill from `socket.readyState` rather than the last frame.
   - Scope the trip to a genuinely dead socket (readyState !== OPEN) before demoting.
   - Add unit/E2E coverage: assert the pill stays `live` across >60 s of idle with an open socket.

2. **Make the installed app keyful or fail loudly.** Options (choose one, all real):
   - `main.rs:resolve_vault_dir` should fall back to a **user-configurable/seeded** vault and, if absent, the daemon must surface a structured "voice disabled: no keys" state to the UI instead of `audio = null` silently. At minimum, log the resolved vault path and keyless condition to `daemon-stderr.log`.
   - Provide a first-run path that writes the vault to `%LOCALAPPDATA%\Voxaura\vault` (the ApiKeysModal already writes there via `saveApiKeys`) **and rebuild the pipeline after save**: extract the `try { Keyring.load … }` block (`daemon.ts:108-184`) into a `buildVoicePipeline()` that `saveKeys` re-invokes so keys take effect without a restart.
   - Add a daemon test for the **missing-vault** path (currently every test supplies keys — this is the mock that masks the live failure).

3. **Wire the FR-12 confirmation portal.** Render `ConfirmPortal` (`components/portals/ConfirmPortal.tsx`) from `App.tsx`; when a command outcome is `{ok:false, detail:'confirmation-required'}` (or a `confirm` request frame), open it with the parked `confirmId`; on approve send `{kind:'confirm', confirmId, approve:true}`, on reject `approve:false`. Extend `fr12.spec.ts` to drive the **real UI** (button click), not the socket.

4. **Fix session state mapping.** `src/runtime/client.ts:47` — replace the silent `'unknown'` fallback with the actual serve field (inspect a live `/api/session` payload and read the correct key), or fetch per-session status; surface a parse error rather than a fake label.

### P1 — Robustness of bring-up

5. **Observability.** `main.rs:450` — capture the daemon's `stdout` too (it logs via `console.log`); today `daemon-stderr.log` is 0 bytes and stdout is discarded. Add a `server started` line to the daemon log and include the resolved vault path (not the token).
6. **Serve spawn resilience.** `main.rs:407-428` — set an explicit `cwd` for `opencode serve` (the shared DB dir), and retry the port wait once before erroring.
7. **Mic permission.** Declare/handle the WebView2 media permission for `getUserMedia` (`capabilities/default.json` and/or a Rust permission handler); verify capture in a packaged build, not only under Chromium's fake device.

### P2 — Cache & host hygiene (not code)

8. **Purge the Explorer icon cache** for the correct icon: stop `explorer.exe`, delete `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` (+ `IconCache.db`), restart `explorer.exe`. `ie4uinit.exe -show` alone is insufficient (proven: DB timestamps unchanged). Consider also bumping the exe path/version on install so Explorer keys a fresh cache entry.

### P3 — Test honesty

9. Promote a **live smoke** into the gate: a headless test that boots the real daemon against a real `opencode serve` with an ephemeral test vault and asserts STT/brain/TTS round-trip (or a keyless-state assertion). Today `test:vantrilex` + E2E are hermetic and cannot catch #1–#4.
10. Remove drift: `pnpm-lock.yaml`/`pnpm-workspace.yaml` and `pyrightconfig.json` reference toolchains not used by the build.

---

*End of dossier. Compiled from source at `f2c075a`, the decoded icon container, the installed PE, the raw `~/.opencode-voice-runtime` logs, and live process/port state.*

---

## 7. Remediation Status — v0.5.0 (closed findings)

Compiled after the autonomous remediation pipeline. Code + tests are the source of truth.

| Finding | Status | Evidence |
|---|---|---|
| UX-1 false-disconnect watchdog | **Closed** | `bridge/ws.ts` exposes `live` (socket OPEN) + `onFrame`; `App.tsx` promotes on any frame and only demotes a genuinely closed socket. Root unit 222 + desktop 95, E2E 18/18. |
| UX-2 visualizer not RMS-reactive | **Closed** | `capture.ts` emits `onEnergy` (RMS); `SiriWaveCanvas` takes `energy` and scales the bars; `App.tsx` feeds mic energy. |
| UX-3 no voice phase states | **Closed** | Additive `voice` frame (`protocol.ts`) broadcast by `daemon.ts`; HUD pill shows listening/thinking/speaking; E2E `ux.spec.ts`. |
| UX-4 transcript never shown | **Closed** | `voice` frame carries `transcript`; HUD renders `last-transcript`; E2E asserts it. |
| UX-5 silent provider failures | **Closed** | Additive `notice` frame; daemon broadcasts on STT/brain/TTS failure; HUD renders a dismissible `notice-banner`. |
| UX-6 empty-vault no CTA | **Closed** | Daemon broadcasts `voice-disabled-no-keys`; HUD CTA button opens the keys window; E2E asserts banner + CTA. |
| UX-7 multi-window persona desync | **Partial** | Persona still flows HUD → daemon; settings-window → HUD sync not yet broadcast (documented, low risk). |
| UX-8 keys require restart | **Closed** | `buildVoicePipeline()` extracted and re-invoked on `saveApiKeys`; vault root created + seeded on first run (`main.rs`). |
| SEC-1 arbitrary shell exec | **Partial→Closed** | `ConfirmPortal` mounted and wired to `confirmation-required`; injection metacharacters rejected pre-park; session ids validated. No command allowlist by design (FR-12 confirm is the control). |
| SEC-2 path injection via sessionId | **Closed** | `command-router.ts` `SESSION_ID_RE`. |
| SEC-7 WebView2 mic permission | **Open — needs packaged verification** | No Rust media-permission handler exists; capture works under Chromium fake device (E2E). Must be validated in a packaged build. |
| UX-9 stale version strings | **Closed** | `SettingsView` version strings updated. |
| Session `state: unknown` | **Closed** | `client.ts` `sessionState()` derives from real fields. |

### Live verification (v0.5.0)

| Stage | Result |
|---|---|
| Fish TTS (real) | ✅ 2 sentences, total 2161 ms, first-chunk 1105 ms |
| Groq Whisper STT (real) | ✅ 299 ms round-trip |
| OpenRouter Dots3/Nemotron (real) | ⚠️ HTTP 429 — OpenRouter free-tier account limit (upstream, verified not code; Dots3 answered ~1.5 s earlier in the session) |

### Honest residual risks

- The OpenRouter free tier is rate-limited; the live brain path needs account headroom.
- WebView2 microphone permission is unproven in a packaged build.
- UX-7 (persona cross-window sync) remains a documented gap.
