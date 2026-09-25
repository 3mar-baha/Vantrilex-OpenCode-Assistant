# voxaura — overview

> Atomic note. One fact per section; link, do not duplicate.

Voxaura is the ambient desktop companion (Tauri v2 + React shell) over the
Node daemon `opencode-voice-runtime`, which orchestrates OpenCode v2
(`opencode serve`) sessions. Arabic voice intake via Kareem (كريم) and
Nour (نور); inter-model coordination in English.

- Shell: `apps/desktop/` (Tauri v2 + React 18 + Vite + Tailwind).
- Daemon: `src/` (orchestrator, WS-4097 bridge, launcher, voice, RAG).
- Canonical runtime: desktop-bundled OpenCode 2.0.12 CLI on the shared DB.
- Governance: Dots3 (intake, Arabic) → Nemotron (coordinator, English) →
  Inkling (in-session driver, English).

See [[projects/voxaura/02-architecture]], [[indexes/MOC-master]].
