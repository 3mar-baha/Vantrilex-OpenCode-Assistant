# Voxaura — Project Master Dossier

> Baseline: commit `6be0363` (`fix(security): create the vault secrets in the Rust supervisor, not in Node`),
> on `origin/main`. Gates at baseline: `cargo test` **52/52**, `test:vantrilex` **EXIT 0**
> (root **705/60**, desktop **142/24**, e2e **18/14**), `docs:verify` green.
> Method: **code-first, zero-trust**. Every fact below was read from raw source, build
> manifests, or passing tests. Anything not provable from the tree is marked
> **UNVERIFIED**. Prose (including prior docs and this file's own predecessors in
> `dossier/`) was treated as untrusted until re-derived. Figures that only exist as
> prose with no log/bench artifact are labelled **PROSE-ONLY**.

---

## 1. Executive Overview, System Boundaries & Core Mandates

### 1.1 What Voxaura is

Voxaura is a Windows-first **Tauri v2 desktop companion + Node daemon** that drives
**OpenCode v2** (`opencode serve`) by voice. The user speaks Arabic (Ammani / White
Jordanian dialect); the system transcribes (Groq Whisper), plans via free-tier
OpenRouter models (Dots3 intake, Inkling planner + narrator), speaks back via
**Fish Audio TTS only**, and renders state in a 440×600 Arabic RTL HUD.

```
                  +-------------------+      voice      +-------------------+
                  |  Tauri shell      |<---------------->  human (Arabic)  |
                  |  (HUD, 440x600)   |      mic/spk      |  Ammani dialect |
                  +--------+----------+                 +-------------------+
                           | Tauri invoke (4 commands) + WS-4097 subprotocol bearer
              +------------+------------+
              | Rust supervisor         |  main.rs — process owner, Job Object,
              | (voxaura.exe)           |  secrets, ports, C2 identity
              +------------+------------+
                           | spawn: opencode serve (:4096) + node sidecar dist/cli.js serve (:4097)
              +------------+------------+
              | Node daemon             |  daemon.ts — UI bridge, voice pipeline,
              | (sidecar)               |  OpenCode bridge, vault, telemetry
              +------------+------------+
                           | HTTP 127.0.0.1:4096 (OPENCODE_SERVER_PASSWORD)
              +------------+------------+
              | opencode serve          |  sessions, agents, ACP tools (external binary)
              +-------------------------+
```

Upstream cloud dependencies (all outbound, loopback otherwise):

| Dependency | Used for | Client | Free-tier identity |
|---|---|---|---|
| Groq Whisper `whisper-large-v3-turbo`, `language:'ar'` | STT | `src/voice/stt.ts:93-100` | key pool `groq` |
| OpenRouter `dots-studio/dots-3-note-preview:free` | intake | `src/orchestrator/coordinator.ts:22,210` | key pool `openrouter` |
| OpenRouter `thinkingmachines/inkling:free` | plan + narrate + brain | `coordinator.ts:23`, `narrator.ts:52`, `brain.ts:177` | same pool |
| Fish Audio `s2.1-pro-free` | TTS | `src/voice/tts.ts:31` | key pool `fish` |

### 1.2 System boundaries (what is / is not Voxaura)

- **IN:** Tauri shell (`apps/desktop/src`), Rust supervisor (`main.rs`), Node daemon
  (`src/`), WS-4097 contract (`/v1/ui`, `voice-ui.v1`), vault/keyring crypto,
  E2E stub harness (`stub-daemon.mjs`), verification scripts (`scripts/`).
- **OUT (external, adopted not owned):** `opencode serve` binary (resolved
  `%APPDATA%\ai.opencode.desktop\cli\<ver>\opencode-cli.exe` numeric-max else
  `PATH`, `main.rs:1216-1253`), Groq/OpenRouter/Fish APIs, system `node.exe`
  copied into the sidecar payload.
- **NOT SHIPPED:** any ONNX (`models/*.onnx` gitignored; `tauri.conf.json`
  bundles only `sidecar/**/*`), Silero VAD at runtime (RMS fallback is the real
  path), Laya heads (`src/runtime/laya/*` dead by decision, 294 MB model never
  bundled), `edge-tts` (0 hits in `src/`, banned by policy).

### 1.3 Core mandates (product decisions, not accidents)

1. **100%-free constraint.** Every model slug is `:free`. A paid `s2.1-pro`
   fallback exists only as an owner decision, never an agent decision.
2. **Fish-only TTS.** `edge-tts` absent (verified 0 hits); Fish publishes no
   renewal date for the API tier, so the credit banner triggers on *observed*
   402/429, never on an invented countdown.
3. **Arabic-first, Ammani dialect.** STT pinned `language:'ar'`; narrator +
   brain lock Ammani/White-Jordanian with English technical terms preserved;
   newsreader MSA and Beiruti explicitly banned (`brain.ts:108`).
4. **Fail-closed credentials.** Missing/weak secret ⇒ file deleted + error, or
   keyless degraded mode (`voice-disabled-no-keys`), never silent adoption.
5. **No canned speech.** The shell announces nothing on command success; only
   the daemon's `assistant-said` narration speaks (`App.tsx:294-326`).
6. **Additive WS contract.** Old shells ignore unknown frame types; new frames
   are added, never renamed.
7. **Fix the document, not the script.** `docs:verify` re-derives; prose is
   corrected to match code, never the reverse.

---

## 2. Architecture Topology, IPC Contracts & Port Allocations

### 2.1 Port map (all loopback-only — verified)

| Port | Holder | Constant | Bind proof |
|---|---|---|---|
| 4096 | `opencode serve` | `OPENCODE_PORT: u16 = 4096` (`main.rs:44`) | spawn `--hostname 127.0.0.1` (`main.rs:1434`); probe `Ipv4Addr::LOCALHOST` (`main.rs:1199`) |
| 4097 | Node daemon WS-4097 UI bridge | `DAEMON_PORT: u16 = 4097` (`main.rs:45`) | `UiServer.listen(port,'127.0.0.1')` (`ui-server.ts:151`); C2 probe same (`main.rs:1199`) |
| 4197 | E2E stub control plane (fake HTTP) | `CONTROL_PORT = 4197` (`stub-daemon.mjs:57`) | `control.listen(4197,'127.0.0.1')` (`stub-daemon.mjs:169`) |
| 1420 | Vite dev server | `apps/desktop` dev config | `devUrl :1420`, `strictPort` (`vite.config.ts:11-14`) |

`0.0.0.0` has **zero matches** in `main.rs`; every bind/probe is loopback.
`4197`/`1420` have zero matches in `main.rs` (they belong to the E2E/dev layer,
not the supervisor). CSP pins the browser: `connect-src 'self'
ws://127.0.0.1:4097` (`tauri.conf.json:27`). Hello guard pins
`servePort===4096` (`bridge/ws.ts:166`).

### 2.2 Process topology (cold launch)

```
voxaura.exe (Rust supervisor, main.rs:3262 main, setup closure :3271-3287)
 ├─ setup(): ensure_ipc_token() SYNC (webview reads it immediately)
 ├─ thread: ensure_all_services() → token → ensure_opencode() → ensure_daemon()
 ├─ children adopted into KILL_ON_JOB_CLOSE Job Object (CreateJobObjectW :62-80,
 │   AssignProcessToJobObject :85-90; kill-on-refuse :436-464)
 ├─ child 1: opencode serve --port 4096 --hostname 127.0.0.1
 │            stdout→opencode-stdout.log stderr→opencode.log (append-only)
 └─ child 2: <node> sidecar/dist/cli.js serve
              stdout→daemon-stdout.log stderr→daemon.log (append-only)
              env: OPENCODE_SERVER_PASSWORD, VOICE_RUNTIME_IPC_TOKEN,
                   VOXAURA_OWNER_KEY, VOXAURA_MACHINE_KEY (hex), VOXAURA_VAULT_DIR
Exit / ExitRequested → Supervisor::reap() (:3291-3294)
```

`\\?\`-prefix stripping: `plain_path()` (`main.rs:1296-1305`) strips `\\?\` /
`\\?\UNC\` because Node's resolver rejects extended-length paths; applied to
node bin + daemon entry (`:1398,1527,1530`).

### 2.3 IPC contracts (two planes — do not confuse)

**Plane A — Tauri invoke (shell → supervisor, 4 commands):**

| Rust `#[tauri::command]` | Behaviour | JS call site |
|---|---|---|
| `ipc_token` (`:1185`) | reads `ipc.token`, trims, fail-closed Err if missing/empty | `settings/ipc-token.ts:22`, retry 20×500 ms (`:46`); used by `App.tsx:106`, `KeysView.tsx:27`, `SettingsView.tsx:71` |
| `ensure_all_services` (`:1595`) | returns `BringUpStatus{ready\|in-flight\|failed}`; `BRINGUP_INFLIGHT` atomic guard; errors as `Ok(failed)` not `Err` | `settings/services.ts:44`, once at HUD mount (`App.tsx:103`); in-flight retried 3×400 ms |
| `shutdown_all_services` (`:1637`) | `Supervisor::reap()`, returns `"children stopped"` | **ZERO call sites in `src/` — registered but unreachable from shell (Triad A.1)** |
| `restrict_vault_file` (`:907`) | re-applies owner-only DACL to `keyring.dat`; fail-closed deletes on error; non-Windows `Ok(false)` | **ZERO call sites in `src/` — the post-save re-lock never fires from the app (Triad A.2)** |

Registered: `generate_handler![ipc_token, ensure_all_services,
shutdown_all_services, restrict_vault_file]` (`main.rs:3265-3270`).
Capability surface (`capabilities/default.json:6-12`): only window/webview
allow-list; **no fs/shell/http/process plugin reaches the webview**.

**Plane B — WS-4097 (shell ↔ daemon, `ws://127.0.0.1:4097/v1/ui`):**

- Subprotocol `voice-ui.v1` (`protocol.ts:8`); bearer travels as **extra
  subprotocol token** `[voice-ui.v1, <token>]` (`bridge/ws.ts:283`) because
  browsers cannot set upgrade headers. Server `bearerOk()` (`ui-server.ts:306`):
  `Authorization: Bearer` timingSafeEqual **or** subprotocol token (`:316-322`),
  enforced pre-upgrade (`:355`) before any frame is parsed.
- `contractVersion '3.1.0'` on all three surfaces (`App.tsx:113`,
  `SettingsView.tsx:75`, `KeysView.tsx:31`); mismatch → `refused`, socket closed.
- Frame types (zod, additive): `hello` (`protocol.ts:386`), `event` (`:403`),
  `inventory` (`:485`), `agents` (`:506`), `notice` (`:520`), `voice` (`:535`),
  `context` (`:547`), `ack` (`:470`, built inline `:505-511` without schema
  parse), `error` (no schema — three inline literals `:471,485,490`).
  Inbound `UiCommandSchema.strict()` (`:425-467`) with bounded `ses_` regex.
- `CommandKind` (`bridge/ws.ts:73-87`): `abort mute deafen arm setPersona
  switchSession setSessionAgent setSessionModel toggleSessionSkill
  execSessionShell saveApiKeys confirm sessionContext createSession`. Actually
  sent by shell: `setPersona switchSession setSessionAgent setSessionModel
  deafen abort arm confirm sessionContext saveApiKeys`; `mute` is renderer-local
  only (daemon acks `mute/deafen/arm` as no-op); `createSession
  toggleSessionSkill execSessionShell` exist in type + E2E stub only.
- Resume: `?lastSeq=max(0,lastSeq)` on **every** connect (`ws.ts:281`; `-1`
  sentinel kept locally). Without the floor, server `lastSeqOf→NaN` skips
  replay (measured: cold launch sat hello-only 25 s). Cursor advances on
  event/inventory/agents/context; backward `hello.seq` = daemon restart →
  reset + `onGap`. Reconnect backoff 50 ms doubling + 30 jitter, cap 2500
  (`ws.ts:175-184`); ack ledger 5 s timeout (`:311-316`).
- Downlink audio: binary `[0x01|u16be seq|MP3]` (`ws.ts:374-379`,
  `binaryType='arraybuffer'`); strict FIFO player, corrupt chunk skipped,
  `PLAYBACK_QUEUE_CAP=32` drop-oldest, `PLAYBACK_GAIN=0.9`
  (`playback.ts:28,83-89,130-136,171`).

### 2.4 Data-flow summary

```
mic → capture.ts (16 kHz mono Int16, 100 ms/3200 B frames, RMS VAD -30 dB)
 → sendBinary (fire-and-forget, bypasses ack ledger, ws.ts:327-340)
 → UiServer.onAudio → AudioPipeline.pushChunk → ingest 5 s windows (160000 B, cap 6)
 → vadGate (Silero dynamic import :523 | RMS fallback isLoudWindow :532)
 → Groq Whisper (ar) → no_speech>0.6 drop → repeat dedupe
 → think: slash gate → mentions → optimizer → coordinator.run
 → Inkling plan → OpenCode ACP promptSession → onUtterance
 → stripSpeechText → splitSentences → Fish synthesize per sentence (persona voice)
 → broadcastAudio (≤32 KiB chunks) → shell FIFO player → speaker
Confirmations: narrator (Inkling, persona-prepended, 20 words) → assistant-said
```

---

## 3. Repository Tree, Module Ownership & Import Graph Hygiene

### 3.1 Tree (abridged; generated from `6be0363`)

```
O:\opencode-Vantrilex\
├─ src/cli.ts, daemon.ts (+ daemon×4, cli-doctor-keys tests)
├─ src/common/{brands,config,errors,index,logger}.ts
├─ src/ipc/{index,protocol,audio,ui-server}.ts (+4 tests)
├─ src/orchestrator/{audio-pipeline,command-router,coordinator,inventory,
│   mentions,narrator,prompt-optimizer,slash}.ts (+11 tests)
├─ src/voice/{brain,stt,tts,tts-credit,ingest,cache,keyring,key-store,
│   vault,win-acl}.ts (+10 tests)
├─ src/runtime/{client,opencode-bridge,vad,fuzzy-match,index}.ts (+4 tests)
│   + laya/{index,types,constants,loader,tokenizer,laya-engine,telemetry}.ts
│     (+3 tests; DEAD by decision)
├─ src/knowledge/{index,types,build,retriever,guard,normalize,personas}.ts
│   (+4 tests) + shared/{architecture,capabilities,commands,failures,lexicon}.ts
│   + styles/{kareem,nour}.ts
├─ src/policy/{claim-matcher}.ts (+6 policy tests) + sidecar/telemetry guards
├─ src/{telemetry/{writer,index},memory/vault,launcher/{launcher,index}}.ts
├─ apps/desktop/src/{App.tsx (716 lines),main.tsx,index.css}
│   ├─ audio/{vad,playback,capture}.ts (+6 tests) │ bridge/ws.ts (+ws.test.ts)
│   ├─ sessions/store.ts │ matrix/matrix-state.ts │ settings/* │ window/*
│   └─ components/{icons,brand,waveform,session,settings,portals} (incl. Crest.tsx
│       — 0 production importers, inert scaffold)
├─ apps/desktop/src-tauri/{main.rs (single src file),build.rs,tauri.conf.json,
│   Cargo.toml (v0.7.2, windows-sys 0.61),Cargo.lock}; sidecar/ = GENERATED
├─ apps/desktop/e2e/{stub-daemon.mjs + 14 specs (18 tests)}
├─ scripts/*.mjs (11: docs-verify, docs-verify-self-test, test-blindspots,
│   provision-sidecar, packaging-preflight, release-verify, lint-baseline,
│   key-report, generate-whiteboard-assets + live_console_test.ts)
├─ docs/{00..28 (29 files)} + {ARCHIVE,CREDENTIAL-OPERATIONS,LAYA-EVAL,
│   LAYA-SYNTHESIS,PLAN,RAG-*,RELEASE-CHECKLIST,ROADMAP-v0.8.0,SPRINT_3_PLAN,
│   SYSTEM_STRESS,UI_REDESIGN,UX-AUDIT} + personas/{kareem,nour,WIRING}.md
├─ dossier/{8 audit/proposal docs incl. a prior PROJECT_MASTER_DOSSIER}
├─ assets/*.svg (18 diagrams) ├─ vault/keyring.dat (gitignored)
└─ dist/ (built) │ models/ (gitignored onnx) │ .opencode/_archive/ (quarantine ~45)
```

Stale-doc flags (supersession banners present, still useful as history):
`docs/19-MOBILE-PAIRING.md` (no relay/QR exists — only a `'mobile'` union member
in `runtime/client.ts`), `docs/26-AGENT-LAUNCHER.md` (false `src/launcher/`
ownership claim). `opencode.json` is the repo's own dev-session config, not
product config. `pnpm-lock.yaml` vestigial (npm is real). iOS/Android icon sets
inert scaffold.

### 3.2 Reachability (resolved from `daemon.ts` + `cli.ts`, static AND dynamic)

| Bucket | Count | Members |
|---|---|---|
| LIVE | **53** | 2 root + 5 common + 4 ipc + 4 runtime + 8 orchestrator + 10 voice + 14 knowledge + 2 launcher + 1 memory + 2 telemetry (+`vad.ts` via dynamic edge only) |
| DEAD (by decision) | **7** | all of `src/runtime/laya/*`; `layaLoad` has zero consumers; 294 MB model never loads; `ui-server` reports `layaReady:false` honestly |
| TEST-ONLY scaffolding | **1** | `src/policy/claim-matcher.ts` (ships nowhere) |
| Live source lines | **9122** (docs:verify-derived at `6be0363`; PROSE-ONLY as a re-derivation, not hand-counted here) | — |

Quarantine (not deletion): 28 ex-live modules + tests moved to
`.opencode/_archive/dead-code-phase1/` (~45 files). `vitest.config.ts` includes
only `src/**`, `test/**`, `bench/**` — the archive is outside runner and `tsc`.

### 3.3 Import-graph hygiene rules (all enforced by tests)

1. **Dynamic-seam rule.** `daemon.ts:523` loads `./runtime/vad.js` via
   `import()` because it pulls `onnxruntime-node`; a static import would make a
   missing native package fatal in the sidecar. Pinned by
   `src/policy/sidecar-safety.test.ts:27-34` (+ native-reachability BFS
   `:36-122`, RMS fallback `:125-167`).
2. **Barrel-bypass rule.** `daemon.ts:22` imports `PERSONA_DIRECTIVES` deep from
   `./knowledge/personas.js` so the daemon never drags the BM25 retriever +
   43-chunk corpus into its graph. `cli.ts:17` is the single barrel
   (`knowledge/index.js`) importer. Pinned by `daemon-persona-wiring.test.ts`.
   Barrel census: `common/index.ts` (importer: `cli.ts:7` only), `ipc/index.ts`
   (`daemon.ts:9`), `runtime/index.ts` (`daemon.ts:10`), `launcher/index.ts`
   (`cli.ts:8`, `daemon.ts:28`), `telemetry/index.ts` (`daemon.ts:47-48`),
   `runtime/laya/index.ts` (dead, zero importers, enforced).
3. **No-cycle rule.** `command-router.ts` imports only leaf modules (brands
   type, errors, protocol type); `protocol.ts` imports only `zod`; `daemon.ts`
   is a sink. No cycle exists; any future `knowledge/* → daemon` or
   `router → daemon` edge would create one.
4. **Test reachability (blindspots, NOT coverage).** 58 of 61 production modules
   reached by ≥1 test; the 3 unreached are `cli.ts` (247 L, process entry —
   E2E drives the stub, not `cli.js`), `common/index.ts` (8 L),
   `knowledge/index.ts` (37 L); + `laya/index.ts` in the neither-set.
   `@vitest/coverage-v8` is NOT installed; no gate passes `--coverage`; the old
   `lines: 80` threshold never evaluated. Percentage is the wrong instrument
   (adding an isolated untested module *raised* it); the module list is the
   instrument.

### 3.4 CLI dispatch (`cli.ts:233-246`) and daemon composition

| argv | Function | Notes |
|---|---|---|
| `doctor` | `doctor()` (`:21`) | env presence (never values) + vault counts + `probeHealth(serve)` |
| `vault bootstrap` | `vaultBootstrap()` (`:60`) | env pools → encrypted `vault/keyring.dat` |
| `live` | `liveLoop()` (`:76`) | REAL provider round-trip (burns quota; never in gate) |
| `serve` | `serveDaemon()` (`:143-176`) | dynamic `import('./daemon.js')`, fail-closed on empty password, SIGINT/SIGTERM → `stop()`; **only production importer of `startDaemon`** |
| `knowledge ["<q>"]` | `knowledgeReport()` (`:205`) | `assertParity/buildIndex/verifyKnowledge` + optional search |
| else | usage, exit 2 | — |

Operator-only pre-dispatch `ensureVault('voxaura', resolveVaultRoot())`
(`:185-195`) runs for doctor/vault/live only — never `serve`.
`startDaemon()` (`daemon.ts:190`) is the composition root: guards → ServeClient
→ OpenCodeBridge → memoised `envCache` (fail-degraded) → UiServer → owner
marker → voice pipeline → inventory → sessions publish → `DaemonHandle`
(`:905-922`). `think` is the inline closure in `buildVoicePipeline`
(`:616-768`): slash → mentions → optimizer → `coordinator.run()`; brain failure
→ telemetry + `ui.notice('brain-failed')` (`:765`) + rethrow. Keyless daemon:
control plane up, audio dropped, `voice-disabled-no-keys`.

## 4. Complete Lifecycles: Cold Boot, C2 Resolution, Request-to-Speech, Teardown

### 4.1 Cold boot (supervisor side, `main.rs`)

```
power / launch voxaura.exe
 ├─ setup() closure (:3271-3287)
 │    ├─ ensure_ipc_token() SYNC → ~/.opencode-voice-runtime/ipc.token
 │    │   (pre-existing read as-is; else generate_secret() 32 B → 64 hex,
 │    │    write_protected_secret → restrict_to_owner, fail-closed delete)
 │    └─ spawn thread: ensure_all_services(handle)  [off UI thread]
 │         ├─ ensure_ipc_token()            → "ipc token: ready"
 │         ├─ ensure_opencode(app)          → resolve bin → spawn serve :4096
 │         │    adopt-if-answering (never double-spawn; foreign check)
 │         └─ ensure_daemon(app, token)     → C2 classify :4097 → spawn|adopt|refuse
 └─ build() webview (token already on disk; shell reads via ipc_token command)
```

`ensure_opencode` (`:1405`): bundled CLI numeric-max else PATH; spawn
`serve --port 4096 --hostname 127.0.0.1`; `spawn_and_wait_for_port` budget
(`:313`, `BindOutcome`). L12: a daemon that never opens 4097 is killed, not
left running (`:1566`). D12: BOTH child streams captured (a swallowed
`File::create` error once degraded to `Stdio::null()` and left zero-byte
`daemon-stderr.log` across spawns — fixed, `:1542-1562`).

### 4.2 C2 — who holds 4097 (`main.rs:977-1179,1490-1517`)

Identity primitive: `daemon.owner` marker file,
`struct DaemonOwnerFile { v, pid, owner_key }` (`:1058-1063`, camelCase, extras
ignored), `DAEMON_OWNER_VERSION = 1` (`:1002`), `OWNER_SETTLE 1500 ms`
(`:1004`). The shell pre-creates it EMPTY via `write_protected_secret` only if
absent (`:1047-1050`); **the daemon must overwrite it IN PLACE — a rename
would reset the security descriptor** (`:1024-1026`).

`holder_from_probe(port_open, raw, owner_key, alive)` (`:1083-1135`), in order:

1. `!port_open → Cold` (`:1089-1091`; stale marker on cold port still Cold)
2. `raw=None → Foreign("no daemon.owner file…")`
3. JSON parse fail → `Foreign("daemon.owner is unreadable…")`
4. `v != 1 → Foreign(version…)`
5. `owner_key != expected → Foreign("different install identity…")`
   (checked BEFORE pid — identity outranks liveness)
6. `pid == 0 → Foreign("pid 0")` (load-bearing: `tasklist` reports pid 0 alive)
7. `!alive(pid) → Foreign("…not running…")`
8. else `Ours { pid }`

`classify_daemon_holder` (`:1159-1179`): cold returns immediately (no settle);
else polls every 100 ms until the settle deadline (`Ours` returns early) —
covers the bind-before-publish window. `ensure_daemon` (`:1500-1517`):
`Cold → spawn`; `Ours{pid} → Ok("adopted…")`; `Foreign{reason} →
Err(refuse-to-adopt-or-double-spawn)` + log. The `port_open`-alone shortcut
once declared "daemon already on 4097" for ANY squatter (leftover stub, dead
daemon); the marker + identity check is the fix, with tests (`:1818-1929`).

### 4.3 Request-to-speech (one utterance, daemon side)

```
pushChunk (100 ms / 3200 B) → AudioIngest windows → vadGate → STT window
 → no_speech_prob ≤ 0.6 → dedupe → think() → coordinator.run()
 → intake (Dots3, effort:none, 200 tok, temp 0.2, 10 s)
 → fast speak fire-and-forget (:243) → plan (Inkling, strict json_schema, 25 s)
 → FR-12 flagged → needsConfirmation (parks; ConfirmPortal; confirm{confirmId})
 → dispatch → client.promptSession → onUtterance → stripSpeechText
 → splitSentences → Fish synthesize per sentence (persona voice id)
 → SpeechGate capture/isCurrent (barge-in abort) → broadcastAudio (≤32 KiB)
 → shell FIFO player → speaker
Confirmations only: narratorChat → narrate(ctx, chat, MODEL, 20, {directive})
 → assistant-said notice → spoken + rendered (shell announces nothing itself)
```

Failures per stage: STT timeout → drop window, loop continues (`stt-timeout`
notice `:781`); brain failure → `brain-failed` + rethrow (`:765`); TTS
402/429 → credit path (`:820-834`), generic → `tts-failed` (`:836`); all three
raw `err.message` interpolations are sink-redacted by `UiServer.notice()`
(`ui-server.ts:227-231`).

### 4.4 Teardown

- Shell close / `ExitRequested` → `Supervisor::reap()` (`:3291-3294`);
  Job-Object `KILL_ON_JOB_CLOSE` reaps orphans (the "child outlived us holding
  4096" class, `:114`).
- Daemon SIGINT/SIGTERM → `daemon.stop()` (`cli.ts:165-170`).
- `shutdown_all_services` → `reap()`; **currently uninvoked from shell
  (Triad A.1)** — teardown today is process-exit-driven only.
- Child logs are append-only (`open_append`, `:201-203`); a restart never
  truncates the previous failure (`plan_child_logs` falls back to
  `<stem>-<pid>-<seq>.log`, `:185-195`).

---

## 5. Persona System & Dialect Conditioning

### 5.1 Wiring (prepend, never substitute)

`narrate(ctx, chat, model, maxWords=20, persona?)` (`narrator.ts:123-129`).
System prompt = `persona.directive + "\n" +
NARRATOR_SYSTEM.replace('{max}', maxWords)`; `undefined` → base only
(`:136-139`). The directive **cannot delete** the 20-word cap, the JSON-only
contract, or the canned-confirmation ban — pinned by comment (`:130-135`) and
`docs/personas/WIRING.md §4` guards. The narrator receives the directive
**string**, never the `PersonaId` (`NarratorPersona{id,directive}`,
`narrator.ts:28-32`) — rewording a dossier cannot silently change speech.
Daemon call site (`daemon.ts:376-392`) passes
`{id: activePersona, directive: PERSONA_DIRECTIVES[activePersona]}` with
`PERSONA_DIRECTIVES` imported deep from `./knowledge/personas.js` (`:22`).

Persona surface (three items, not four — earcon pitch was deleted with
`earcons.ts` and never reimplemented; 0 `earcon*` files, 0 occurrences of
`659.25/987.77/1318.5`, both re-derived by `docs:verify`):

| # | Surface | Kareem | Nour |
|---|---|---|---|
| 1 | Narration directive | `personas.ts:38-54` | `personas.ts:56-72` |
| 2 | TTS voice id | `male-default` (`brands.ts:22`) | `female-toggle` (`brands.ts:23`) via `PERSONA_VOICE` (`brands.ts:12-15`); snapshotted per utterance (`daemon.ts:794-796`) |
| 3 | Wave colour | `#16A34A/#EAB308` | `#9333EA/#EC4899` (`SiriWaveCanvas.tsx:20-24`; `user` `#2563EB/#EAB308`) |

### 5.2 Directives (verbatim, Arabic-only, style-not-safety)

- `PersonaId = 'kareem'|'nour'` (`brands.ts:10`).
  `PersonaProfile{id,nameAr,label,role,toneMarkers,shieldLexicon,directive}`
  (`personas.ts:12-36`); `PERSONA_DIRECTIVES` is `satisfies
  Record<PersonaId,string>` — a missing persona is a compile error (`:79-82`).
- **Kareem** (`:38-54`), markers `يا غالي، يا كبير، ولا يهمك، هسا بنرتب(ها)`:
  `أنت كريم، زميل أردني مباشر. اذكر النتيجة أولاً ثم ما تعني منها. لو في غموض
  بسيط، افترض أشيع احتمال، اذكر افتراضك في الجملة نفسها، وبعدين كمّل. اسأل قبل
  أي عملية خطرة وما تنفذها قبل التأكيد. استخدم أمثلة أردنية بيضاء مثل «يا
  غالي» و«هسا بنرتبها». خليك طبيعي ومباشر كزميل، لا كموظف خدمة.`
- **Nour** (`:56-72`), markers `تمام، بس للتأكيد، من عيوني، ولا تشيل هم`:
  `أنت نور، زميل أردنية هادئة. ابدأ بما يعني الأمر للمستخدم، وبعدين التفاصيل.
  لو في غموض حقيقي، اسأل سؤالاً واحداً واضحاً، وبعدها تصرف بدون ما تعيد
  السؤال. اسأل قبل أي عملية خطرة وما تنفذها قبل التأكيد. استخدم أمثلة أردنية
  بيضاء مثل «تمام، بس للتأكيد». خليك هادئة دقيقة كزميلة، لا كموظفة خدمة.`
- Shield: a first-person reply must contain the persona lexicon, else fail;
  vacuously true without `أنا` (`:91-94`).

### 5.3 Prompt chain constants

| Constant | Location | Value |
|---|---|---|
| `INTAKE_MODEL` | `coordinator.ts:22` | `dots-studio/dots-3-note-preview:free` |
| `COORDINATOR_MODEL` | `coordinator.ts:23` | `thinkingmachines/inkling:free` |
| `NARRATOR_MODEL` | `narrator.ts:52` | `thinkingmachines/inkling:free` |
| `BRAIN_OPENROUTER_MODEL` | `brain.ts:177` | `thinkingmachines/inkling:free` |
| `TTS_MODEL` | `tts.ts:31` | `s2.1-pro-free` (Fish only) |
| `OPENROUTER_USER_AGENT` | `brain.ts:23` | `opencode/1.0 (Voxaura)` — **mandatory**; Inkling answers 403 "only available on agentic harnesses" without an agentic UA (allowlist is an `opencode/<v>` prefix; `claude-cli/ codex-cli/ cursor/` pass; bare `voxaura/ aider/ continue/` + browser UAs 403) |
| `reasoning:{effort:'none'}` | intake (`coordinator.ts:215`), narrator (`daemon.ts:347-350`), optimizer (`daemon.ts:724`) | **required** — without it Inkling burns the budget reasoning and returns `finish=length`, `content:null` (measured 0/5 → 5/5) |
| `response_format` strict `json_schema` | narrator (`narrator.ts:55-67`), plan (`coordinator.ts:99-127`) | **load-bearing** — prompt-only Inkling emits raw tool-call syntax (`<\|message_model\|>shell…`), 0/5 → 5/5 |
| `NARRATOR_SYSTEM` | `narrator.ts:84-94` | 9-line AR peer-engineer prompt; `({max} كلمة)` placeholder; canned-ban (`تم تنفيذ الأمر بنجاح` forbidden); never-repeat; JSON-only `{"reply_ar":"…"}` |
| Caps | `narrator.ts:108,127`; `daemon.ts:327,341-346` | `MAX_CHARS=240` (`…` truncation), `maxWords=20`, 120 maxTokens, temp 0.8, 12 s timeout (raised from 8 s on 3×5010 ms measurements) |
| Persona ref counts (lines) | docs:verify-derived | `narrator.ts` **11**, `coordinator.ts` **0**, `prompt-optimizer.ts` **0**, `brain.ts` **0**; sole interpolation `'{max}'` |
| Dialect lock | `brain.ts:105-109`, `personas.ts:8-11` | Ammani/White-Jordanian, EN tech terms preserved; MSA-newsreader + Beiruti banned |

Handoff envelope (`coordinator.ts:168-179`): `[HANDOFF from=Nemotron
to=Inkling task=…]` + objective/session/steps/acceptance/constraints, English
only. "Nemotron" is a role name per the skill contract, not a model (`:20-21`).
Optimizer (`prompt-optimizer.ts:66-73`): 6-line AR editor; failure falls back to
the user's own words (`:82-99`). Optimizer prompt is gated by
`isActionableInstruction` (`daemon.ts:716-745`).

Live divergence (PROSE-ONLY, no tree artifact): a 2026-09-29 Inkling probe over
the real `narrate()→openRouterChat` path produced audio-ready Arabic 6/6 with
per-persona tone markers 3/3 each (p50 3.9/4.3 s); within-persona pairs also
differed 3/3 at temp 0.8 — non-interchangeable output, **not** statistical
causation. `WIRING.md §6` still says the retrieval half is undone and calls for
a decided live call — the two documents disagree on status; the measurement
claim is honest only as session history, not as re-derivable fact.

### 5.4 Knowledge corpus (half-connected by design)

- 43 shared chunks (8 arch + 11 caps + 8 cmd + 8 fail + 8 lex; `build.ts:24-30`)
  + 16 stylistic (8 kareem + 8 nour, selected by `when`, never retrieved).
  `SharedChunk` has **no** `persona` member — type-level
  (`SHARED_HAS_NO_PERSONA=false`, `types.ts:57`) + runtime `assertSharedChunks`
  (`types.ts:76-80`). One index, no per-persona index (`types.ts:88-93`).
- BM25 hand-rolled, zero-dep, K1=1.2 B=0.75 (`retriever.ts:30-31`); retrieval
  p99 PROSE-ONLY (0.0128 ms vs 10 ms budget — no bench artifact in tree).
- `normalizeArabic`: NFKC + strip `[\u064B-\u065F\u066A\u066D-\u0672]` (NOT
  digits) + tatweel + alef variants + maksura (`normalize.ts:23-45`). The old
  class `U+064B-U+0672` swallowed Arabic-Indic digits `U+0660-U+0669`
  (`المنفذ ٤٠٩٦ مشغول` lost its port); guarded by `normalize.test.ts:72-80`.
- Connection state: **2** production importers of `knowledge/` (CLI via barrel,
  daemon via `personas.js` only); **1** barrel importer. The RAG layer is NOT on
  the narration path — no chunk is retrieved/ranked/interpolated into any
  prompt. Real gap is corpus coverage (`إيش سويت` returns nothing because the
  fact is absent), not retriever speed.

---

## 6. Audio, WebSocket Streaming & TTS Credit Interceptor

### 6.1 Geometry (exact numbers)

| Constant | Location | Value |
|---|---|---|
| Uplink frame | `capture.ts:7-8,37-42` | 16 kHz mono Int16, 100 ms = **3200 B** (asserted `capture.test.ts:40-43`) |
| Capture | `capture.ts:85-87,100` | `getUserMedia{16 kHz, EC, NS}`; `AudioContext{48 kHz}`; AudioWorklet + ScriptProcessor(4096) fallback; 80 ms energy throttle |
| Renderer VAD | `audio/vad.ts:7-27` | RMS only (`frameEnergyDb`, floor −100; `isSpeechFrame(th=-30 dB)`); zero `onnx\|silero` hits in renderer |
| `MAX_AUDIO_CHUNK` (downlink) | `ipc/audio.ts:7` | **32 KiB** (`splitAudio :31`); downlink `[0x01\|seq\|mp3]` (`audio.ts:9`) |
| `MAX_AUDIO_BYTES` | `protocol.ts:28` | **64 KiB**, checked on the **reassembled** binary (`ui-server.ts:470` → `error` frame, socket kept) |
| Ingest window | `ingest.ts:6` | **160000 B / 5 s**, cap 6 windows, shed-oldest (960 KB bound) |
| `MAX_MESSAGE_BYTES` | `protocol.ts:22` | **1 MiB per-MESSAGE cumulative**, checked BEFORE storing (`accountFor :294`); overflow resets + throws; `discardPending :307`; orphan-fragment discard on new data frame (`:364`); same rule in `decodeFrames` (`:177-183`, cap `:154`) |
| `MAX_CONNECTIONS` / `RESUME_CAP` | `protocol.ts:19-20` | 8 (evict-oldest `:378`) / 256 |
| `PING` / `MISSED` | `protocol.ts:11-12` | 5000 ms / 3 (`pingAll :531`) |
| VAD window | `daemon.ts:41,533` | 512 samples → 156 frames/window; serial `await isSpeech` (**no gate timeout — Triad B.4**) |
| Gates | `audio-pipeline.ts:27,168,172` | `no_speech_prob>0.6` drop; repeat dedupe; STT timeout drops (loop continues) |

History: the cap was per-FRAME until the audit found `FrameReassembler`
accumulating `pendingParts` unbounded then one `Buffer.concat` — N
just-under-1-MiB continuations grew the message to their sum while the comment
claimed "fail-closed, no unbounded buffering". Now cumulative, pre-store.

### 6.2 Provider contracts

| Stage | Contract |
|---|---|
| STT | `GroqWhisperClient.transcribe` (`stt.ts:93`); `whisper-large-v3-turbo`, `language:'ar'`, `verbose_json` (`:98-100`); `STT_TIMEOUT_MS=15000` (`:135`, `SttTimeoutError :142`); `transcribeStream` (`:164`) |
| Brain/intake/plan | `openRouterChat(apiKey,model,system,user,fetchImpl,{reasoning,maxTokens,temperature,timeoutMs,responseFormat})` (`brain.ts:187`); intake opts (effort none, 200 tok, temp 0.2, 10 s, `coordinator.ts:215`); plan (strict schema, 25 s, `:257`); `BRAIN_GOLDEN/CEILING` 2000/5000 ms (`brain.ts:8-9`) |
| Narrator | `narrate(ctx,chat,model,maxWords,persona?)` (`narrator.ts:123`); `NarratorChat` (`:35`); daemon wrapper 12 s, temp 0.8 (`daemon.ts:327,341-350`) |
| TTS | `FishTransport.synthesize(text,fishVoiceId)` (`tts.ts:237`); `synthesizeStream` (`:239`); `FISH_TIMEOUT_MS=20000` (`:441`, raced abort `:501`); headers `model:` (`:287-293`); `stripSpeechText` (`:64`), `splitSentences` (`:157`), `SpeechGate.capture/isCurrent` (`:189-203`, barge-in abort) |
| Keys | `Keyring.release(key,ok,status)` (`keyring.ts:89`) advances **only** on 429/401/403; `ROTATION_LIMIT` 10 reqs/key (`keyring.ts:9`); `httpStatusOf` (`errors.ts:51`) maps BRAIN_AUTH→401, RATE_LIMITED→429 |

Free-tier latencies (PROSE-ONLY unless noted): intake p50 901 ms
(`daemon.ts:289` comment), inkling plan p50 1950/max 3987
(`coordinator.ts:14` comment), narration 5010-5015 (`daemon.ts:310-311`
comment), Fish balanced 426-556 vs normal 1405-1432 (`tts.ts:417-420`
comment). STT 726 ms / TTS 3196+1267 ms: UNVERIFIED (not in tree).

### 6.3 TTS credit interceptor (402/429 are credit, not auth)

`FishCreditError(status: 402|429)` (`tts.ts:326`; `isCreditFault :336`;
`remediation :341` — `402→'TTS out of credit - top up'`,
`429→'TTS rate limited…'`). Thrown only for 402/429 (`:579-581`).
`fishErrorMessage` taxonomy (`:348`): 401/403→rotate key (`:358`); 402→top-up,
key fine (`:362`); 422→only bounded 120-ch body (`:363-368`); 429→backoff
(`:370`); 404 voice (`:372`); 5xx retryable (`:375`). 401/402 bodies never
echoed (account metadata, `:306-309`).

Daemon branch (`daemon.ts:816-834`): `err instanceof FishCreditError` →
`ttsCredit.recordFault(err)` (`:821`) → second telemetry row
`TTS_CREDIT_${status}` (`:828`) → `ui.notice(credit.noticeCode,
credit.noticeDetailAr,'warn')` (`:832`) → return (generic `tts-failed` at
`:836` skipped). `TtsCreditMonitor` (`tts-credit.ts:41`): first-fault clock
starts once, repeats never reset (`:60`); `status()` (`:72`) →
`topup-required` + `tts-credit-exhausted` (<7 d) vs
`tts-credit-exhausted-overdue` (≥7 d, `TOPUP_ADVISORY_DAYS=7`, `:23`);
`noRenewalGuarantee:true` always; `setRenewalAt(ts|null)` (`:68`) is the hook
for an owner-known date (Fish publishes none). Arabic wording at `:109-111`.

Renderer gap: **no dedicated TTS-credit banner exists** (`credit|tts-credit` =
0 hits in `apps/desktop/src`); the daemon's warn notice renders through the
generic notice pipe. Triad C.3 proposes the overdue-escalating banner.

## 7. Security Architecture, Key Storage, Scrubbing & BOM Prevention

### 7.1 Credential set (all under `runtime_dir()` = `~/.opencode-voice-runtime`, or `VOICE_RUNTIME_DIR` override, `main.rs:514-528`)

| File | Content | DACL | Fail mode |
|---|---|---|---|
| `ipc.token` | 64-char lower hex (`generate_secret`, `:940-943`) | `write_protected_secret` (`:942`): owner+LocalSystem, 2 ACEs, `PROTECTED_DACL` (`:662-815`) | DACL fail → delete + Err (`:623-629`); pre-existing read as-is |
| `serve.pass` | same shape (`:970-973`) | same (`:972`) | same; daemon fail-closed without it |
| `owner.key` | same shape (`:1041-1043`) | same (`:1043`) | same (non-credential per `:1016-1018`, same treatment) |
| `daemon.owner` | JSON `{v,pid,ownerKey}` published by daemon; shell pre-creates EMPTY only if absent (`:1047-1050`) | same at creation; daemon must overwrite IN PLACE | identity, not auth |
| `machine.key` (**6be0363**) | 32 RAW bytes (`fs::write(&key)`, `:881`); hex only for env handoff (`:868,:886`) | `restrict_to_owner` on **create** (`:882-884`) **and adopt** (`:864-866`) | wrong length → delete + Err (`:873-877`); DACL fail → delete + Err |
| `keyring.dat` (`<vault>/keyring.dat`, AES-256-GCM via `machine.key`) | encrypted provider pools (Node `Keyring.save` rename-over) | `restrict_to_owner` in `resolve_vault_dir` (`:1373-1376`) + `restrict_vault_file` (`:917-922`) | NOT fail-closed at resolve (WARN, launch continues — keys already encrypted); cmd variant deletes on DACL fail |

Why Rust, not Node: `std::fs::set_permissions(0o600)` on Windows is
`SetFileAttributes` — toggles READONLY, returns Ok, changes no ACL
(`:624-629` comment). `icacls /inheritance:r /grant:r <user>:(F)` returns
"Successfully processed 1 files" then yields EPERM for the named account —
`icacls` grants a NAME and cannot name the owner SID (implemented, measured,
REMOVED; reproduction lives in `src/voice/win-acl.ts`,
`ownerOnlyAclAvailable()` returns `{supported:false, reason}`). The load-bearing
flag is `PROTECTED_DACL_SECURITY_INFORMATION` (`:662`), blocking parent
inheritance; asserted at `main.rs:2482,2488` (docs:verify anchors).
`SetNamedSecurityInfoW` with NULL `oldacl` preserves the owner SID by
construction — unreachable from Node without a native addon, hence the move.

History that must not repeat: `ipc.token`/`serve.pass` once derived from
xorshift64\* seeded `nanos ^ pid`; now `getrandom` (`:587`,
`secure_random_bytes<const N>()` at `:594`, no fallback path).

### 7.2 Vault cipher (Node side)

`machineKey()` (`vault.ts:45`): prefers `VOXAURA_MACHINE_KEY` (hex → 32 B;
wrong length throws `VAULT_CORRUPT` naming the real problem, `:48-57`);
fallback reads/creates `machine.key` with warn-once
(`warnedAboutAcl`, `:25,60-65`) — the fallback is NOT equivalent and says so.
`appKey()` = `scryptSync(machineKey(), 'opencode-voice-runtime:vault:v1',
32)` (`:78`); pools AES-256-GCM + SHA-256 checksum (`encryptPool :85`,
`decryptPool :95` — checksum mismatch and decrypt failure both
`VAULT_CORRUPT`). `FileVault.save` writes temp + rename (`:129-140`) — the
rename REPLACES the file, which is why the startup DACL is silently undone by
the first save and `restrict_vault_file` must re-apply it. Verified live at
`6be0363`: env key round-trips encrypt/decrypt 3/3 (same-key OK, foreign-key
`VAULT_CORRUPT`, bad-length rejected).

### 7.3 Scrubbing (sink, not call sites)

`UiServer.notice()` (`ui-server.ts:227-231`) applies `redactString(detail)`
then schema-parses — covering the three raw `err.message` interpolations
(`daemon.ts:611` STT, `:765` brain, `:836` TTS). Do NOT move redaction outward:
a new call site cannot leak. `encodeTextFrame` is imported only inside
`ui-server.ts` (single sink file = auditable surface). Telemetry writer and
logger also redact (`writer-redaction.test.ts`, `cli-doctor-keys.test.ts:56`).
`doctor` reports key presence/counts only; rotation is manual via
`writeKeyPools` verified by SHA-256 fingerprint, never echo.

Coincidence-coverage (currently safe, NOT guaranteed — Triad B.5): `voice()`
(`:233-237`, user's own transcript), `ack` (`:505-511`, router literals),
`event`/`inventory`/`agents` (`:161,177,189`, local OpenCode state) are
unredacted. `ack.detail` is an open `string` (`command-router.ts:12-15`), NOT a
closed union as older prose claimed — the invariant "locally generated, never
provider text" holds by inspection of `dispatch` (`:151-234`) plus the catch
mapping (`:273-275`), but it is convention, not type-enforced. The
`dispatchCommand` catch (`ui-server.ts:503`) forwards raw `err.message` into
`ack.detail`; reachable only if `onCommand` throws, which the router never does
today (`:237-276`). Stale comment: `ui-server.ts:213-222` cites
`daemon.ts:584/738/789`; true lines are `611/765/836`.

### 7.4 BOM prevention

13 of 299 commits carried a UTF-8 BOM (`Out-File -Encoding utf8` /
`Set-Content -Encoding utf8` emit U+FEFF; `git commit -F` copies it verbatim;
type parses as `﻿fix`, invisible to `^(feat|fix|…)`). History NOT rewritten
(all on `origin/main`, SHAs cited). Rule: write message files with the
file-write tool (or `utf8NoBOM` / `[IO.File]::WriteAllText`) and check
`charCodeAt(0) === 0xFEFF`. Verification pitfall (measured 2026-09-29):
`git log | node -e` REPORTS a phantom BOM (65279) from PowerShell's own pipe
encoding — verify via variable capture (`$m = git log -1 --format=%B`), never
via pipes.

---

## 8. Verification Infrastructure, 7-Stage Release Gate & Mutation Guards

### 8.1 `test:vantrilex` — 7 stages (`package.json:28`), all EXIT 0 at baseline

| # | Stage | Command | Baseline |
|---|---|---|---|
| 1 | typecheck prod | `tsc --noEmit` (excludes `**/*.test.ts`) | 0 |
| 2 | typecheck tests | `tsc -p tsconfig.tests.json` (re-includes, `noEmit`) — added v0.7.2 after 62 latent errors in 9 files | 0 |
| 3 | eslint | `eslint . --max-warnings 0` | 0 |
| 4 | oxlint baseline | `node scripts/lint-baseline.mjs` (pins **8**, fails on EITHER drift) | 8/8 |
| 5 | root vitest (node) | `vitest run` | **705 / 60 files** |
| 6 | desktop vitest (happy-dom) | `npm --prefix apps/desktop run test` | **142 / 24 files** |
| 7 | e2e (Playwright, chromium, workers:1, retries:0) | rebuilds root `dist/` first, then `playwright test` | **18 / 14 specs** |

Needs 4096/4097/4197/1420 free — stop installed `voxaura.exe` /
`Voxaura\sidecar\node.exe` or the stub fails `EADDRINUSE`. Single-file:
`npx vitest run src/ipc/ui-server.test.ts`; name filter `-t 'FR-12'`;
desktop: `cd apps/desktop && npx vitest run src/audio/vad.test.ts`;
e2e single: `npx playwright test e2e/bargein.spec.ts`. Cargo (Windows MSVC):
`cmd /c '"…VsDevCmd.bat" -no_logo >nul 2>&1 && cargo test …'` → **52**.
Pipelines lie about exit codes (`| Select-Object` returns 1 on success) —
check `$LASTEXITCODE` unpiped or redirect to a log file. Long builds:
`background:true`, wait for notification, never poll.

### 8.2 `release:verify` — 7 stages (`scripts/release-verify.mjs:12-18,48`)

gate (full `test:vantrilex`) → preflight (`packaging-preflight.mjs`, exit NOT
load-bearing — exits 0 unconditionally, numbers reported) → build (root tsc →
`provision-sidecar.mjs` → `build:tauri`, with stale-artefact guard: only an
installer newer than build start, version-matched, may be installed) →
install (cold `/S`, prior dir removed) → boot (launch installed exe, poll 60 s
for BOTH ports) → assert (4096+4097 on 127.0.0.1 ONLY; `daemon.log` did not
grow) → cleanup (`taskkill` + reap, always). `--stage=X`, `--skip-gate`.
This closes the v0.6.0 class: every gate green, daemon could not boot.

Release flow (no improvisation): bump version in **all** of `package.json`,
`apps/desktop/package.json`, `package-lock.json`, `tauri.conf.json`,
`Cargo.toml`, `provision-sidecar.mjs`, READMEs, `docs/00-PROJECT-GUIDE.md`,
hero banner, CHANGELOG — edits in Node with exact-occurrence assertions
(PowerShell once rewrote `badge`→`aadge` across eight files). Build →
provision → `build:tauri` → verify NSIS + SHA-256 → stop running app → commit
→ tag → push main + tag → `gh release create` (**commit before tagging**:
release auto-creates the tag at current HEAD). Only an installed build proves
anything (`/S`, confirm 4096+4097 bound, `daemon.log` 0 bytes).

### 8.3 `docs:verify` — 31 claims, no expected values (`scripts/docs-verify.mjs`)

Documented figures parsed from `AGENTS.md`; derived figures from tree, live
test runs, `package.json`. EXIT 1 on any mismatch. **UNVERIFIED is an error,
not a warning** (deleting a figure used to no-op green). Claim census:
vitest root tests/files, desktop tests/files, cargo count (`#[test]` grep),
e2e static count/specs, live/dead/scaffolding modules + live lines
(reachability BFS over EVERY quoted `./x.js`, static+dynamic), 7 gate stages +
stage count, persona refs per file (lines matching, backticked slots),
earcon files + pitch constants (TWO checks so rename alone fails), knowledge
importers + barrel importers, test-reachable/blind/total modules (denominator
checked; ALL-prod basis), cited `file.ts:NNN` anchors (aggregate: unique
basename, in range, line is CODE — comments/blank/delimiters FAIL).

`--self-test` (4 behavioural, `docs-verify-self-test.mjs`, via
`__agentsOverride`, ~1 s, not vitest): real code line passes; comment line
rejected (the `daemon.ts:509`-as-comment drift class); past-EOF rejected;
`vault.ts:1` rejected as AMBIGUOUS (4 colliding basenames: `index.ts`×7,
`vault.ts`×2, `types.ts`×2, `vad.ts`×2 — first-match-wins once validated a
keyring claim against the wrong vault). It exists because source-shape guards
were proven no-op-satisfiable (deleting the check / ambiguity rejection /
stubbing classifiers stayed green). **Re-anchor by content, never arithmetic**:
the TTS interceptor shifted six `daemon.ts` anchors and only the behavioural
self-test caught it. `src/policy/docs-verify-coverage.test.ts` pins the claim
set itself (8 narrative + 11 numeric labels via extensible `hasClaim`
shape-test in test-only `claim-matcher.ts`).

Editor recipe: change code → update doc first (counts, reachability, persona,
earcon, knowledge, blindspots, anchors — unique basenames only) → `npm run
docs:verify` + `--self-test` + policy tests + `test:blindspots`
(informational, EXIT 0). New number without a script claim → UNVERIFIED-fatal.
Fix the DOCUMENT, not the script.

### 8.4 Guard catalog (break-tested — a guard never observed failing is a comment)

- **Sidecar safety** (`sidecar-safety.test.ts:27-167`): no static
  `runtime/vad.js` edge, dynamic `import()` required; no
  `onnxruntime-node`/`better-sqlite3` statically reachable (two-pass BFS;
  old queue-scan OOM'd at 4 GB on cycles); RMS fallback separates
  speech/silence. Pins the v0.6.0 regression (4097 never opened).
- **Machine key** (`main.rs:2760+`): `env_lock()` static Mutex (tests raced on
  process-wide `VOICE_RUNTIME_DIR` — passed `--test-threads=1`, failed
  normally); `dacl_is_protected()` reads the REAL descriptor via
  `GetFileSecurityW` (`Control & 0x1000`); `icacls_reset()` stages the
  pre-fix inheritable DACL so the adopt path is tested in isolation;
  wrong-length refused+deleted; CSPRNG provenance (`secure_random_bytes`
  present, `nanos`/`SystemTime` absent); fail-closed ACL.
- **Reassembly cap** (`protocol-reassembly-cap.test.ts:46-178`, 8 tests):
  cumulative pre-store cap; per-message not per-connection (first version was
  vacuous until sized up); reset-between-messages (found by break-testing);
  orphan accounting; doc-claim honesty (`no unbounded buffering` removed).
- **WS resume** (`ws.test.ts:75-168`): first connect MUST carry `?lastSeq=0`;
  the old assertion pinned the NaN-replay bug; history in comments.
- **TTS credit** (`tts-credit.test.ts`): 402/429 typed, distinct remediation,
  first-fault idempotent, 7-day escalation, `reset()` semantics, renewal hook
  honest about no published date.
- **Zero-canned / telemetry-wired / redaction / claim-matcher / coverage**:
  present (see §8.3); capture-permission SEC-7 partially proven (idempotency
  guard real with leak rationale; L19 re-entry reliance UNVERIFIED).
- **Known vacuous-test patterns** (hunted explicitly): break-the-guard with a
  no-op injection (`let _ = existing;` compiles, changes nothing, reports
  MISSED — indistinguishable from a dead guard); tests pinning bugs as
  features (name contradicts assertion); anchor strings missing from file
  (injection silently no-ops — always print the landed confirmation).

---

## 9. Environment Matrix, Local Configuration & Runtime Commands

### 9.1 Runtime state (`~/.opencode-voice-runtime/`)

`ipc.token`, `serve.pass`, `machine.key`, `daemon.owner`, `supervisor.log`,
`daemon.log` + `daemon-stdout.log`, `opencode.log` + `opencode-stdout.log`,
`voice-runtime.jsonl` (daemon telemetry). Child logs append-only.

### 9.2 Vault resolution (`main.rs:1313-1336`)

`VOXAURA_VAULT_DIR` env → ancestor `vault/` (repo run) →
`%LOCALAPPDATA%\Voxaura\vault` (installed; created + seeded once, never
overwrite). Repo `vault/keyring.dat` gitignored. Keys enter ONLY via API-keys
window → `saveApiKeys` (encrypted merge path `writeKeyPools`). Keyless daemon:
control plane up, audio dropped, `voice-disabled-no-keys` until saved (live
pipeline rebuild). Present-but-invalid key ≡ healthy until first utterance
(L17 open): 401/403 advances the pool silently — when STT/TTS/brain suddenly
fails, check key validity first. `STT language:'ar'` feeds English audio →
Arabic gibberish by design (not a bug, not a key problem).

### 9.3 Commands

```bash
npm install && npm run build            # tsc → dist/ (daemon)
npm run test:vantrilex                  # full gate (ports 4096/4097/4197 free)
node dist/cli.js live                   # REAL providers (vault keys; quota)
node dist/cli.js doctor                 # env presence + serve health
node dist/cli.js knowledge ["<query>"]  # corpus parity + optional search
cd apps/desktop
npm run dev                             # tauri dev      npm run dev:web  # vite :1420
npm run test:e2e                        # rebuilds root dist + Playwright
npm run build:tauri                     # NSIS + AppImage (needs MSVC env + makensis)
```

Silent install: `Voxaura_<v>_x64-setup.exe /S`. Taskbar icon cached by Explorer
(keyed on exe path — stop explorer, delete `iconcache_*.db` to refresh).

### 9.4 Gotchas that cost real time (measured, all)

- PowerShell pipelines lie about exit codes; `git commit -F` takes a FILE not
  a message; non-ASCII quotes/Arabic break `git commit -m` (write file, `-F`).
- `provision-sidecar.mjs` OWNS its manifest — removing a root dep does not
  remove it from the installer (`pino`, `eventsource` kept shipping).
- A helper that prints AND returns captures diagnostics as return value
  (once reported "30/30 ORPHAN" from an unmeasured number).
- `include_str!("main.rs")` + `copyFileSync`: cargo does NOT recompile after
  restore — `touch` the file.
- `/inheritance:r` DACLs need `takeown /F <dir> /R /D Y` for removal.
- Free OpenRouter models are lossy, not just 429 (Nemotron 3/12 at p50 4.8 s);
  narrator + intake coerce/validate so schema drift degrades a line, not the
  reply. Always measure before blaming code.
- Binary WS frame > 64 KiB rejected with `error`, never reaches pipeline
  (silent unless collecting `error` frames); send ≤32 KiB like the renderer.
- Minisearch-class libs ship no Arabic handling — the normalizer must be
  passed at index AND query time or Arabic recall goes to zero silently.

## 10. Comparative Benchmark & Frontier Roadmap

Source: two external-intelligence briefings (2026-09-29), every pattern
sourced by URL in the agents' reports. Verdicts: ADOPT / ADAPT / REJECT /
SPECULATIVE (needs measurement).

### 10.1 QwenAudio/qwen-audio-agent (harness, Apache-2.0 — NOT the model weights)

The repo (`QwenAudio/qwen-audio-agent`, ~2.8 k stars) is a **realtime voice
harness/runtime**, distinct from `QwenLM/Qwen2-Audio` (foundation model).
Transferable value is in the harness: Frontend Agent (realtime model) +
Orchestration Runtime (tasks/permissions/sessions, no separate reasoner) +
Backend Agent (one action agent); Gateway hosts, clients own I/O. Their mixed
routing (adaptive direct-vs-delegated) measured 91.04% success vs 72.39%
direct-only / 80.60% all-delegated, −26–31% mean latency (in-house cockpit
bench, 134 cases — directional, not a Voxaura projection).

| # | Pattern → Voxaura application | Verdict |
|---|---|---|
| 1 | `spawn_thinking` split: intake returns immediate ack + task-id; planner runs async as a Task (`queued→running→completed/failed/cancelled`, owner FIFO); narrator speaks in a safe window. Hides Inkling plan p50 ~1.95 s + narrate ~2.6 s behind conversation | ADAPT now |
| 2 | Barge-in cancels *speech only* (`response.cancel`); NEVER cancels the backend ACP turn — "stop talking" must not kill a 40 s coding job | ADAPT (fixes a real bug class) |
| 3 | Completion ≠ delivery: hold results while user speaks/TTS plays; coalesce per window; retry delivery without re-running the plan; client `playback.started` ack on WS-4097 `ack`/`event` | ADAPT |
| 4 | 16 kHz in / 24 kHz out, ≤32 KiB chunks, single WS — Voxaura already mirrors this; add ASR-delta partials so Ammani partials render before final STT (hides 726 ms) | ADOPT |
| 5 | Client-side `smart_turn` emulation: energy gate + min-speech-duration + semantic gate (Dots3 classifies backchannel vs intent). Keep WS shape; RMS→Silero later without protocol change (their Provider-seam argument) | ADAPT |
| 6 | Speculative narration: Dots3 ≤20-word Ammani ack immediately ("هسا بنرتبها، ثانية") while Inkling plans; stream narration tokens → Fish sentence-by-sentence; route short ops to intake-direct tools (their shorts 1.5 s vs 4.3 s all-delegated). Guard: never assert results speculatively | ADAPT, bounded |
| 7 | VAD-gated tool calls: gate OpenCode invocation on (committed turn + silence ≥ threshold + intake confidence); expose permission narration only on real pending ACP `session/request_permission` | ADAPT |
| 8 | Self-contained objectives (resolve "that file"/"port 4096" before delegating; never forward raw transcript+history); `contextOnly` knowledge injection that never triggers a reply; fixed `voxaura:<owner>:backend` session key + double-serialize (kills "new turn = lost context" + prompt races) | ADAPT |
| 9 | Progress as UI cards from ACP `session/update` (tool + bounded detail + running/done; secrets redacted); never spoken, never queued | ADAPT |
| 10 | Cloud duplex model (Qwen Audio 3.0 Realtime, DashScope key/quota/region), Qwen2-Audio 8.2 B weights (GPU-bound; per-HF-repo license, NOT Apache), MiniCPM-o (no tool calls), vision/customer-service tracks | REJECT — structural mismatch with free-tier loopback |

### 10.2 Frontier OSS voice patterns (32-pattern survey, condensed)

- **VAD:** Silero 512-sample/16 kHz windows, LSTM state reset per turn; hysteresis (release = trigger−0.15); hangover `min_speech 0.05 s / min_silence 0.55 s / prefix 0.5 s`, prewarm at start; RMS is a gate never a decision (100% recall, 66.7% FPR on noise — justifies the fallback posture); **TEN-VAD** (306 KB vs 2.2 MB, RTF 0.0086–0.015) is the shippable candidate that resolves the 294 MB-Laya lesson (validate Arabic pauses first); sherpa-onnx template (`num_threads=1`, cpu, `max_speech 10 s`); barge-in skeleton (450 ms silence, 80 ms debounce, duck-then-cancel).
- **WS framing:** 20–100 ms cadence standard (Voxaura's ≤32 KiB ≈ ≤1 s is 50× coarser — shrink toward 4–8 KiB / move VAD windowing to 20–32 ms in-daemon); binary-PCM + JSON-control split already matches field standard (add explicit stream_start/end); `?lastSeq=` resume = external confirmation (bound the replay buffer); versioned hello handshake on top of ignore-unknown-types; backpressure watermarks (256 KB pause / 32 KB resume — per-message cap does NOT bound queue depth); count-based reassembler limits (N small frames under a byte cap — same class as the fixed bug); Wyoming-style per-chunk audio headers (rate/width/channels) so resampling bugs become impossible.
- **Loopback security:** subprotocol-bearer is the standard workaround (RFC 6455 §1.9; do NOT move token to query = log leakage); per-launch 32-B token via env + app-command handoff independently converged (tauri-plugin-sidecar); PROTECTED_DACL confirmed load-bearing, `icacls` confirmed NOT equivalent; long-term: DPAPI-bound storage / Windows Credential Manager backend (tauri-plugin-keyring-store) over snapshot files — SPECULATIVE, evaluate against supervisor-DACL first (smaller change).
- **Latency:** LocalAgreement-2 partial stabilization (commit on 2-agree, grey the tail); endpointing metrics over WER for Arabic STT; TTS SENTENCE vs TOKEN two-mode switch (20-word confirmations fit TOKEN); **Fish specifics: `latency=balanced` + FlushEvent per sentence + warm connection + `chunk_length 100`** (same vendor — directly applicable); LiveKit turn-taking skeleton (500 ms/3 s/2 s); barge-in kill chain (VAD-live-during-playback → cancel TTS → abort LLM → truncate context + epoch IDs so late narration can't speak over the interrupting turn); Moonshine-Arabic as cloud-STT fallback, Piper as offline TTS fallback behind the credit-interceptor seam (both SPECULATIVE, quality unmeasured).

### 10.3 Sequenced roadmap (smallest safe steps first)

1. Wire `restrict_vault_file` into the key-save path (Triad A.2) + dedicated TTS-credit banner (Triad C.3) — both close shipped-but-inert work.
2. Fix the five HIGH findings (Triad A.3–A.7): 429 rotation, 402 retry, credit-clock reset, key lifetime, monitor states.
3. Bound the three unbounded growths (Triad B.1–B.3): WS pre-header buffer, replay buffer, ingest queue watermarks.
4. Latency program: Fish `balanced`+FlushEvent+warm (vendor-native) → speculative Ammani ack → partial TTS → VAD windowing 20–32 ms → TEN-VAD evaluation (Arabic pauses).
5. Duplex program: speech-only barge-in + epoch invalidation → completion/delivery split + `playback.started` → `spawn_thinking`-style async tasks → fixed backend session + double-serialize.
6. Long-term: DPAPI/Credential-Manager evaluation; Moonshine/Piper fallbacks; larger-sample persona probe (≥10/arm, owner-approved quota).

---

## 11. Comprehensive Triad Audit

### A. Existing & latent defects (proven from code; fix each)

**A.1 `shutdown_all_services` unreachable.** Registered (`main.rs:3268`) with
zero `invoke()` in `src/`. Teardown is exit-driven only. *Fix:* wire to a
settings/system control or remove the command (a registered-but-dead command
is a false affordance).

**A.2 `restrict_vault_file` never invoked — half of `6be0363` is inert.**
`KeysView` saves keys without calling it; the startup DACL is undone by the
first save (rename replaces ACL), so `keyring.dat` runs inheritable in every
installed app until something calls the command. *Fix:* `invoke('restrict_vault_file')`
after every successful `saveApiKeys` (+ surface `false`/`Err` in the
settings UI, not console).

**A.3 Fish 429 rotates the pool despite the no-rotation contract.**
`synthesizeStream` calls `release(key,false,status)` BEFORE branching
(`tts.ts:570-580`); `release` advances on 429/401/403 (`keyring.ts:89-94`) —
a 429 burns a good key per fault. *Fix:* release credit faults as
success-or-neutral (`release(key,true)` + `throw new FishCreditError…`);
keep 401/403 rotating.

**A.4 OpenRouter 402 retried 3× as transient.** `!res.ok →
BRAIN_REJECTED(retryable:true)` catches 402 (`brain.ts:235-236,288-289`);
`respond()` retries. Exhausted balance ⇒ 3 paid/quota calls per turn, intake
failover doubles it. *Fix:* `402 → OrchestratorError('RATE_LIMITED',false)`
in both `openRouterChat` and `respondOnce`, so `httpStatusOf` never rotates.

**A.5 `ttsCredit` clock resets on every key-save.** The monitor lives inside
`buildVoicePipeline()` (`daemon.ts:552-556`), rebuilt by `rebuildVoice()`
(`:848-849`) on `saveKeys` (`:454-456`) — `firstFaultAt` restarts, the 7-day
overdue escalation slips another week. *Fix:* hoist to daemon scope next to
`speechGate` (`:295`).

**A.6 Key material lives for daemon lifetime.** `poolMaterial` caches per-pool
Buffers (`keyring.ts:61-73`); `release()` zeroes only the returned copy;
no `ring.destroy()` on the daemon path (only `cli.ts:130`). Steady-state
heap holds 3 pool keys indefinitely. *Fix:* `destroy()` on `stop()` or
no-cache acquire (copy per call, zero on release).

**A.7 `TtsCreditMonitor` false `topup-required` + stale renewal.**
`setRenewalAt(past)` with zero faults falls through to a 0-day
`topup-required` (`tts-credit.ts:84-101`); `reset()` clears faults but not
`renewalAt` (`:121-125`). *Fix:* return `ok` when no fault and renewal is past;
clear `renewalAt` in `reset()`.

**A.8 Intake error-class reset masks transport outage.**
`catch{intakeTransportFailed=true;continue}` then parse-fail resets it to
`false` (`coordinator.ts:206-229`): primary 500 + fallback 200-garbage ⇒
`intake-invalid` instead of `intake-failed`. *Fix:* separate
`transportFailed ||= / parseFailed ||=` flags.

**A.9 Daemon TTS duplicates `TtsEngine.speakSentences` and drops the cache.**
`daemon.ts:797-806` loops `splitSentences→synthesize→broadcast` with zero
`AudioCache`; repeated narrations re-synthesize on the hot path (Fish quota).
*Fix:* shared `synthesizeSentences(text,voiceId,synth)` helper or a daemon
`AudioCache`.

**A.10 `AudioCache.get` throws on missing blob.** `readFile(hit.blobPath)`
uncaught (`cache.ts:66-77`); an external tmp-cleaner wedges the turn with
ENOENT. *Fix:* catch → evict + miss + `null`.

**A.11 `classify` misses `SttTimeoutError`.** `daemon.ts:498-499` checks
`AbortError|TimeoutError`; `stt.ts:142-146` sets `SttTimeoutError` — every STT
stall logs `Unknown`. *Fix:* regex or `instanceof`.

**A.12 `decodeFrames` orphan asymmetry.** The exported helper resets without
the `FrameReassembler`'s throw-guard symmetry (`protocol.ts:193-208`);
live path (`ui-server.ts:434`) is safe; one import away from mattering.
*Fix:* route both through one helper or delete the export.

**A.13 Stale `daemon.ts` refs in `ui-server.ts:213-222`** (`584/738/789` →
`611/765/836`): comment drift, zero behavioural effect, next-auditor trap.
*Fix:* correct the comment (and let `docs:verify` anchors keep it honest).

**A.14 `Crest.tsx` (0 importers) + `mute`/`createSession`-family (type+stub
only)** — inert surface that reads as live. *Fix:* delete or wire; do not
carry.

### B. Potential & edge-case failure modes

**B.1 WS pre-header buffer unbounded** (`protocol.ts:313-314`): 1 byte × N
with no complete header grows `this.buffer` to N; `accountFor` never runs —
same class as the fixed `pendingParts` bug, loopback-reachable. Cap at
`2×MAX_MESSAGE_BYTES`, reset + throw.

**B.2 Replay buffer unbounded.** `?lastSeq=` replay has no documented bound;
a long-disconnected shell could demand OOM replay. Bound + document.

**B.3 Queue depth unbounded.** Per-message caps bound one message, not the
ingest queue — add 256 KB/32 KB pause/resume watermarks on the control
channel (field standard).

**B.4 `vadGate` serial 156× `await` with no timeout** (`daemon.ts:530-540`):
a hung `onnxruntime-node` stalls `pushChunk` (only STT has a timeout).
`Promise.race` 1–2 s → RMS fallback.

**B.5 Redaction by coincidence** (§7.3): `voice/ack/event/inventory` unredacted
by construction-today. One `onCommand` returning provider text leaks silently.
Redact `ack.detail` + `voice.transcript` at the sink; route `console.error`
(`coordinator.ts:243-250`, `daemon.ts:271`) through the redacting logger.

**B.6 Fixed-rate hammering:** `SessionInventory` 15 s no-jitter
(`:28-88`), single-shot `probeHealth` (`:197`). Bursty serve flaps ⇒
exponential backoff + jitter.

**B.7 Silent-without-notice paths:** oversized binary frames rejected with an
`error` frame the shell must collect; `voice-disabled-no-keys` is the only
degraded banner while TTS-credit has none (§6.3); present-but-invalid keys
look healthy until first utterance (L17) — consider a background validity
probe with redacted results.

**B.8 Concurrency:** `envCache` memoised fail-degraded (stale agents after
permission changes until rebuild); `nextCmdId` UUID per command (no
ordering guarantee across reconnect — `onGap` reset covers, replay bound B.2
completes it); parallel Rust tests mutating `VOICE_RUNTIME_DIR` needed
`env_lock` — any future env-mutating test must take it too.

### C. Target-audience enhancements & additions

**C.1 Key-save → DACL confirmation (closes A.2 for the user):** after
`saveApiKeys`, invoke `restrict_vault_file` and show "المفاتيح محمية
بصلاحيات المالك فقط" vs a warning when `false`/Err. The user currently has no
signal the second half of the fix ran.

**C.2 Shutdown control (closes A.1):** expose graceful shutdown in settings
or delete the command — a voice companion for developers must not require
Task Manager to stop cleanly.

**C.3 Dedicated TTS-credit banner:** `tts-credit-exhausted` vs `-overdue`
with day count, top-up CTA, and the no-renewal-guarantee line — distinct from
the generic notice pipe, non-dismissible while overdue.

**C.4 Audible degraded states:** keyless / credit-exhausted / STT-down should
speak (or attempt TTS-fallback speech) instead of banner-only — a voice-first
user may not be looking at 440×600.

**C.5 Turn receipts:** surface task state (`queued→running→done`, per Qwen
pattern 1) in the HUD matrix so multi-second Inkling plans read as progress,
not hangs; pair with the speculative Ammani ack (pattern 6).

**C.6 First-run calibration:** 10-second mic/VAD walkthrough (threshold
preview, energy meter already exists `micEnergy`) — kills "it doesn't hear
me" support threads; feeds B.4/B.8 tuning with real-room data.

**C.7 Arabic-aware diagnostics:** `doctor` output already presence-only;
extend the notice copy so Arabic STT gibberish-from-English-audio and
quota-vs-auth failures explain themselves in-dialect instead of log-English.

---

## 12. Diagnostic Infrastructure & OpenCode Introspection Readiness

### 12.1 What exists today (verified)

- **`doctor` (`cli.ts:21` + `doctor()`):** env presence (never values) +
  vault key counts + `probeHealth(serve)`. Presence/length/truncated-SHA256
  per provider via `scripts/key-report.mjs` — values never printed, logged,
  committed, or diffed (secret scan at baseline: only deliberate `AAAA…` fake
  in `ui-server.test.ts:161`, which is what makes the redaction test
  meaningful).
- **Telemetry:** `voice-runtime.jsonl` in the runtime dir (daemon-written);
  second telemetry row for credit faults (`TTS_CREDIT_${status}`,
  `daemon.ts:828`); `sanitizedErrorClass` taxonomy (`daemon.ts:498-499`,
  with the `SttTimeoutError` miss — A.11); writer redaction tests green.
- **Supervisor logs:** `supervisor.log` (diagnostics only, deliberately no
  DACL), append-only child logs (`daemon.log`, `opencode.log` + stdout twins)
  that survive restarts — the previous failure is always on disk.
- **Structured bring-up:** `BringUpStatus{state,detail,retriable,steps}`
  (`main.rs:1594+`); C2 refusal names the port AND the reason
  (`Foreign{reason}` asserted to contain "4097"); version-mismatch hello →
  `refused` with cause.
- **E2E observability:** stub control plane (`:4197`) exposes
  `/fire /commands /shells /audio /audio-down /notice /voice /inventory
  /agents /kill /revive` — any failure reproducible without providers.

### 12.2 Readiness verdict: PARTIAL — machine-usable, not yet automatic

What an OpenCode introspection agent CAN do today without the user: run
`doctor`, read the four logs + `voice-runtime.jsonl`, query `:4197` in dev,
re-derive every doc figure via `docs:verify`, bisect via `release:verify
--stage=X`, and break-test any guard. What it CANNOT do: single-command
bundle collection (no `doctor --bundle` emitting ports/processes/memory/
last-N-logs as one JSON artifact), no background key-validity signal (B.7),
no redacted config dump (effective ports, model slugs, timeout table in one
place). **Recommended:** add `node dist/cli.js doctor --bundle` producing a
redacted JSON bundle (ports table, process liveness, `BringUpStatus`-shaped
health, log tails, `docs:verify` summary) — that single artifact is what turns
"readable" into "automatically diagnosable". Until then, root-cause analysis
is possible but manual-assembly, and this section must not claim otherwise.

---

*End of dossier. Baseline `6be0363`. Method: code-first; UNVERIFIED and
PROSE-ONLY labels are load-bearing content, not hedging — removing one
requires a tree artifact, not an edit. Fix the document, not the script.*



