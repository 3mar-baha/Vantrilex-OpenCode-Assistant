# Voxaura — ambient desktop companion over OpenCode v2

[![Tests](https://img.shields.io/badge/tests-211%20pass-brightgreen)](docs/10-CHECKPOINT.md)
[![E2E](https://img.shields.io/badge/e2e-8%2F8-brightgreen)](apps/desktop/e2e)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](apps/desktop/src-tauri/Cargo.toml)
[![OpenCode](https://img.shields.io/badge/opencode-v2%20native-7c3aed)](docs/RAG-ORCHESTRATOR-INTEGRATION.md)
[![العربية](https://img.shields.io/badge/العربية-README.ar.md-red)](README.ar.md)

Decoupled ambient voice + runtime orchestrator. The Tauri v2 shell talks to a
Node daemon, which governs OpenCode v2 sessions over a versioned WebSocket
bridge (WS-4097) and a typed HTTP control plane. Arabic voice intake, English
machine coordination, hierarchical agents: Dots3 → Nemotron → Inkling.

## System architecture

```text
┌──────────────┐   WS-4097    ┌──────────────────┐   HTTP/Basic   ┌────────────────┐
│ Voxaura shell│◄────────────►│  Node daemon     │◄──────────────►│ opencode serve │
│ Tauri+React  │ hello/inv/ack│ orchestrator     │ /api/session   │ 2.0.12 CLI     │
└──────────────┘              │ queue/backpress. │                │ shared DB      │
                              └────────┬─────────┘                └────────────────┘
                                       │ skills / vault / RAG
                              ┌────────▼─────────┐
                              │ Dots3 → Nemotron │  Obsidian vault/
                              │     → Inkling    │  .opencode/agents/
                              └──────────────────┘  docs/RAG-*.md
```

## 60-second quick start

```bash
npm install
npm run build
node dist/cli.js doctor        # pre-flight: env, serve health (values hidden)
npm run test:vantrilex         # typecheck + lint + unit (root + desktop)
cd apps/desktop && npm run test:e2e   # Playwright shell suite
```

Live console against the real control plane:

```bash
node scripts/live_console_test.ts
```

First boot scaffolds the Obsidian memory vault automatically
(`vault/projects/voxaura/`); missing notes are templated, existing files are
never overwritten. Override location with `VOXAURA_VAULT_DIR`.

## Docs map

- `docs/10-CHECKPOINT.md` — gate ledger and live verification history.
- `docs/RAG-ORCHESTRATOR-NEMOTRON.md` — coordinator decomposition/governance.
- `docs/RAG-INKLING-OPENCODE-DRIVER.md` — in-session driver rules.
- `docs/RAG-ORCHESTRATOR-INTEGRATION.md` — bridge topology and lifecycle.
- `.opencode/agents/inkling-driver.md` — confined subagent definition.
- `README.ar.md` — النسخة العربية الكاملة.
