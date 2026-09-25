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

## Performance & observability

<table>
  <tr>
    <td align="center" width="50%">
      <img src="assets/latency-benchmark.svg" alt="Fish TTS TTFB 644ms under the 800ms budget" width="100%" />
    </td>
    <td align="center" width="50%">
      <img src="assets/test-suite-dashboard.svg" alt="211 unit tests and 8/8 E2E green" width="100%" />
    </td>
  </tr>
</table>
<p align="center">
  <img src="assets/system-health.svg" alt="System health: optimal — serve, bridge, vault" width="320" />
</p>

Measured on the live control plane: serve boot 447 ms, bridge hello 16 ms,
Fish TTS first-chunk TTFB 644 ms against an 800 ms budget. Gates hold at
211 unit tests green plus 8/8 Playwright E2E.

## Architecture & data flow

<p align="center">
  <img src="assets/architecture-flow.svg" alt="CLI to WS-4097 to orchestrator to serve pipeline" width="100%" />
</p>

Packets travel CLI → WS-4097 bridge (hello / inventory / ack, `?lastSeq=`
resume) → Node orchestrator (queue, backpressure, sibling-serve protection) →
`opencode serve` 2.0.12 on the shared DB (Basic auth, `{data}` envelopes,
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

## Platform capabilities & desktop shell

<p align="center">
  <img src="assets/desktop-portal.svg" alt="Tauri shell with live matrix sync" width="480" />
</p>

<table>
  <tr>
    <td align="center" width="33%">
      <img src="assets/feature-orchestrator.svg" alt="Queue balancing across workers" width="100%" />
    </td>
    <td align="center" width="33%">
      <img src="assets/feature-vault.svg" alt="Zero-secret AES-256-GCM vault" width="100%" />
    </td>
    <td align="center" width="33%">
      <img src="assets/feature-e2e.svg" alt="E2E harness steps going green" width="100%" />
    </td>
  </tr>
</table>

## 60-second quick start

```bash
npm install
npm run build
node dist/cli.js doctor        # pre-flight: env, serve health (values hidden)
node dist/cli.js vault bootstrap  # migrate key pools into the encrypted vault
node dist/cli.js live          # full TTS → STT → brain → TTS round-trip
```

```bash
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
- `CONTRIBUTING.md` — gates, TDD, FR-12, branch hygiene.

<p align="center">
  <img src="assets/footer-wave.svg" alt="" width="100%" />
</p>
