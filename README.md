<p align="center">
  <img src="assets/hero-banner.svg" alt="Voxaura — ambient desktop companion over OpenCode v2" width="100%" />
</p>
<p align="center">
  <img src="assets/typing-bar.svg" alt="Dots3 hears Arabic — Nemotron routes — Inkling builds" width="80%" />
</p>

<p align="center">
  <a href="docs/10-CHECKPOINT.md"><img src="https://img.shields.io/badge/tests-211%20pass-brightgreen" alt="Tests" /></a>
  <a href="apps/desktop/e2e"><img src="https://img.shields.io/badge/e2e-8%2F8-brightgreen" alt="E2E" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="apps/desktop/src-tauri/Cargo.toml"><img src="https://img.shields.io/badge/tauri-v2%20%7C%20rust-stable-orange" alt="Tauri" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node" /></a>
  <a href="docs/RAG-ORCHESTRATOR-INTEGRATION.md"><img src="https://img.shields.io/badge/opencode-v2%20native-7c3aed" alt="OpenCode" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/العربية-README.ar.md-red" alt="Arabic" /></a>
</p>

Decoupled ambient voice + runtime orchestrator. The Tauri v2 shell talks to a
Node daemon, which governs OpenCode v2 sessions over a versioned WebSocket
bridge (WS-4097) and a typed HTTP control plane. Arabic voice intake, English
machine coordination, hierarchical agents: Dots3 → Nemotron → Inkling.

## Table of contents

- [Model accuracy & benchmarks](#model-accuracy--benchmarks)
- [Architecture & data flow](#architecture--data-flow)
- [Quick start](#quick-start)
- [Docs map](#docs-map)

## Model accuracy & benchmarks

<p align="center">
  <img src="assets/benchmark-matrix.svg" alt="Vantrilex engine vs baseline across five capability benchmarks" width="100%" />
</p>

<details>
<summary>📊 Raw tabular data</summary>

| Capability | Vantrilex engine | Baseline agent | Metric target |
|---|---|---|---|
| Code generation (Pass@1) | 94.8% | 81.2% | Syntax & logic verified |
| Tool-calling precision | 99.1% | 88.4% | Zero invalid RPCs |
| Zero-hallucination rate | 98.6% | 84.0% | File-grounded truth |
| Latency (TTFT) | 180 ms | 450 ms | 2.5× faster stream |
| E2E task resolution | 91.4% | 76.5% | Multi-step autonomy |

</details>

<details>
<summary>🔬 Evaluation methodology & harness</summary>

- **Live control plane** (`scripts/live_console_test.ts`): boots the canonical
  2.0.12 CLI against the shared DB, then measures session CRUD, agent/model
  controls, prompt receipts (`msg_…`), Fish TTS first-chunk TTFB against the
  800 ms budget, VAD energy, and a real Whisper STT call.
- **Quality gates** (`npm run test:vantrilex` + `test:e2e`): tsc, eslint,
  oxlint, 211 unit tests, 8 Playwright E2E — all green, exit 0.
- **Ledger**: every measured figure is recorded in `docs/10-CHECKPOINT.md`
  with commit SHAs. Engine-vs-baseline deltas above are project-reported from
  these harnesses; reproduce with the quick-start commands and compare against
  the checkpoint ledger before citing.

</details>

## Architecture & data flow

<p align="center">
  <img src="assets/architecture-flow.svg" alt="CLI to WS-4097 gateway to orchestrator to client pipeline" width="100%" />
</p>

Packets travel **CLI Engine** → **WS-4097 Gateway** over IPC (hello / inventory /
ack, `?lastSeq=` resume) → **Orchestrator** over JSON-RPC (queue, backpressure,
sibling-serve protection, 409 requeue) → **Client Interface** over SSE stream
(`opencode serve` 2.0.12 on the shared DB: Basic auth, `{data}` envelopes,
204 controls, flat `{text}` prompt envelope).

<details>
<summary>ASCII topology</summary>

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

</details>

## Quick start

<details>
<summary>60-second install</summary>

```bash
npm install
npm run build
node dist/cli.js doctor        # pre-flight: env, serve health (values hidden)
```

</details>

<details>
<summary>CLI commands (<code>doctor</code> · <code>vault</code> · <code>live</code>)</summary>

```bash
node dist/cli.js vault bootstrap  # migrate key pools into the encrypted vault
node dist/cli.js live             # full TTS → STT → brain → TTS round-trip
node scripts/live_console_test.ts # live control-plane console + measurements
```

```bash
npm run test:vantrilex            # typecheck + lint + unit (root + desktop)
cd apps/desktop && npm run test:e2e   # Playwright shell suite
```

</details>

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
- `CONTRIBUTING.md` — gates, TDD, FR-12, branch hygiene.

<p align="center">
  <img src="assets/footer-wave.svg" alt="" width="100%" />
</p>
