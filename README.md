<p align="center">
  <img src="assets/icon.svg" alt="Voxaura application icon" width="128" />
</p>
<p align="center">
  <img src="assets/hero-banner.svg" alt="Voxaura — ambient desktop companion over OpenCode v2" width="100%" />
</p>

<p align="center">
  <a href="docs/10-CHECKPOINT.md"><img src="https://img.shields.io/badge/tests-847%20unit%20%2B%2052%20rust-brightgreen" alt="Tests" /></a>
  <a href="apps/desktop/e2e"><img src="https://img.shields.io/badge/e2e-18%2F18-brightgreen" alt="E2E" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="apps/desktop/src-tauri/Cargo.toml"><img src="https://img.shields.io/badge/version-0.7.2-blueviolet" alt="Version" /></a>
  <a href="apps/desktop/src-tauri/Cargo.toml"><img src="https://img.shields.io/badge/tauri-v2%20%7C%20rust-stable-orange" alt="Tauri" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node" /></a>
  <a href="docs/PROJECT_MASTER_DOSSIER.md"><img src="https://img.shields.io/badge/audit-code--first%20dossier-7c3aed" alt="Dossier" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/العربية-README.ar.md-red" alt="Arabic" /></a>
</p>

**Trust code, not prose.** The audit of record is `docs/PROJECT_MASTER_DOSSIER.md`
(baseline `6be0363`, code-first, zero-trust). Every number below is re-derived by
`npm run docs:verify` (31 claims, exits 1 on any mismatch) or labelled as session
history where no tree artifact exists. `docs/01–28` are a frozen, partly-wrong spec set.

## Table of contents

- [1. What Voxaura is](#1-what-voxaura-is)
- [2. Quickstart & CLI reference](#2-quickstart--cli-reference)
- [3. Architecture deep-dive](#3-architecture-deep-dive)
- [4. Voice loop: geometry & providers](#4-voice-loop-geometry--providers)
- [5. Models: all free tier, three silent breakers](#5-models-all-free-tier-three-silent-breakers)
- [6. Personas, dialect & knowledge](#6-personas-dialect--knowledge)
- [7. Security, vault & redaction](#7-security-vault--redaction)
- [8. Verification: gates, guards & blind spots](#8-verification-gates-guards--blind-spots)
- [9. Known defects (documented, not fixed)](#9-known-defects-documented-not-fixed)
- [10. Diagnostics & introspection readiness](#10-diagnostics--introspection-readiness)
- [11. Release, conventions & footer](#11-release-conventions--footer)

---

## 1. What Voxaura is

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

Four fixed ports, all loopback-only: **4096** OpenCode serve, **4097** WS-4097 UI
bridge, **1420** Vite dev, **4197** E2E stub control. Upstream cloud dependencies
(all outbound, loopback otherwise): Groq Whisper `whisper-large-v3-turbo`
(`language: 'ar'`), OpenRouter `dots-studio/dots-3-note-preview:free` (intake) and
`thinkingmachines/inkling:free` (plan + narrate + brain), Fish Audio
`s2.1-pro-free` (TTS). **No ONNX ships at all** — `models/*.onnx` is gitignored and
the bundle carries only the sidecar, so installed builds always use the RMS energy
fallback; Silero has never run in a shipped build. Laya heads
(`src/runtime/laya/*`, 7 modules) are dead by decision: the 294 MB model never loads.

Core mandates (product decisions, not accidents): **100%-free models** (every slug
is `:free`); **Fish-only TTS** (credit banner triggers on observed 402/429, never on
an invented countdown); **Arabic-first Ammani dialect** (newsreader MSA and Beiruti
banned); **fail-closed credentials** (missing/weak secret ⇒ file deleted + error, or
keyless degraded mode — never silent adoption); **no canned speech** (only the
daemon's `assistant-said` narration speaks; the shell announces nothing); **additive
WS contract** (old shells ignore unknown frame types); **fix the document, not the
script** (`docs:verify` re-derives; prose is corrected to match code).

---

## 2. Quickstart & CLI reference

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

The operator CLI (`src/cli.ts`) is a five-branch argv ladder:

| Command | Function | Contract |
|---|---|---|
| `doctor` | env presence (values hidden) + vault counts + serve probe | 0 healthy, 1 otherwise |
| `vault bootstrap` | migrate comma key pools into the encrypted vault | 0 on success, 1 if pools missing |
| `live` | full STT → brain → TTS round-trip with latency JSON | 0 on success, 1 with partial report (burns quota, never in gate) |
| `serve` | adopt serve, host the WS-4097 plane; fail-closed on empty password; SIGINT/SIGTERM → stop | long-running; only production importer of `startDaemon` |
| `knowledge ["<q>"]` | corpus parity + optional search | 0 / usage exit 2 |

Environment: `OPENCODE_SERVER_PASSWORD` (serve auth), `GROQ_API_KEYS` /
`FISH_AUDIO_KEYS` / `OPENROUTER_API_KEY` (comma pools, unset after bootstrap),
`VOXAURA_VAULT_DIR` (vault override), `VOICE_RUNTIME_DIR` (runtime-dir override).
A `.env.local` file is honored only for unset variables. Keys enter the encrypted
vault **only** via the API-keys window → `saveApiKeys` (or `vault bootstrap` from
env pools); a keyless daemon keeps the control plane up, drops audio, and emits
`voice-disabled-no-keys` until keys are saved (which rebuilds the pipeline live).

---

## 3. Architecture deep-dive

<p align="center">
  <img src="assets/architecture-flow.svg" alt="CLI to WS-4097 gateway to orchestrator to client pipeline" width="100%" />
</p>

### Process topology (cold launch)

`voxaura.exe` writes `~/.opencode-voice-runtime/ipc.token` in `setup()` **before the
webview loads**, spawns `opencode serve --port 4096 --hostname 127.0.0.1` (if 4096
cold — adopt-if-answering, never double-spawn), then `node sidecar/dist/cli.js
serve`. Both children go into a `KILL_ON_JOB_CLOSE` Job Object. A daemon that never
opens 4097 is killed, not left running. Child logs (`daemon.log`,
`opencode.log` + stdout twins) are **append-only** — a restart never truncates the
previous failure. Teardown today is exit-driven (`Supervisor::reap()`); the
`shutdown_all_services` Tauri command is registered but uninvoked from the shell
(known defect A.1).

### Daemon identity — who holds 4097

The `daemon.owner` marker file (`{v, pid, owner_key}`, version 1, 1500 ms settle)
decides: cold → spawn, ours → adopt, foreign → refuse-to-adopt-or-double-spawn.
Identity outranks liveness (owner key checked before pid); pid 0 is explicitly
foreign. The shell pre-creates the marker EMPTY only if absent; **the daemon must
overwrite it in place — a rename would reset the security descriptor.** The old
port-open-alone shortcut once declared "daemon already on 4097" for any squatter
(leftover stub, dead daemon); the marker + identity check is the fix.

### Two IPC planes (do not confuse)

**Plane A — Tauri invoke** (shell → supervisor, 4 commands): `ipc_token` (reads the
token file, trim
...[truncated 15865 chars]