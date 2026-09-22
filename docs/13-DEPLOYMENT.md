# 13 — Deployment: Installation, Daemonization, Auto-Bootstrap & Port Binding

> **Canonical status:** Governance. Deploy truth. Launcher detail: `26-AGENT-LAUNCHER.md`.

## 13.1 — Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Node.js | 22 LTS | `node --version` ≥ 22; Bun path in `03` §3.1 |
| pnpm / npm | pnpm 9 / npm 10 | Lockfile respected |
| OS | Windows 10/11 (first-class), macOS 14, Ubuntu 22.04+ | DPAPI path is Windows-first; keychain equivalents per OS (`12` §12.2) |
| Microphone + speakers | Any OS-default devices | Graceful text fallback without them (E-5) |
| `opencode` binary | v2.x on `PATH` | Pinned minor recorded at install; drift handled by probe (`03` §3.4) |

## 13.2 — Installation (npm global, normative)

```powershell
npm install -g opencode-voice-runtime
opencode-voice init        # writes config skeleton, no secrets
opencode-voice vault set groq --from-prompt   # keys → DPAPI vault, never disk-plaintext
opencode-voice vault set fish --from-prompt
opencode-voice doctor      # env audit (names only), device check, port probe
opencode-voice start
```

`init` never writes secrets; `vault set` reads via hidden prompt and stores ciphertext
only; `doctor` is the pre-flight gate (fails fast on missing keys, no mic, port
conflict with an unhealthy owner).

## 13.3 — Daemonization (per OS, normative)

| OS | Supervisor | Unit shape |
|----|-----------|------------|
| Windows | Windows Service (via `node-windows`) or PM2 + startup | Service `opencode-voice-runtime`, restart on failure, delayed-auto start |
| macOS | `launchd` plist (`~/Library/LaunchAgents/`) | `KeepAlive`, stdout → log file (redacting logger) |
| Linux | `systemd` user unit | `Restart=on-failure`, `RestartSec=5`, sandbox `NoNewPrivileges=yes` |
| Any (dev) | PM2 `ecosystem.config.js` | `instances: 1`, `exec_mode: fork` (never cluster — single keyring owner) |

**Single-owner rule:** exactly one daemon owns the vault + port. A second starter
detects the healthy incumbent via `/health` and exits with `ALREADY_RUNNING` instead
of stealing the port.

## 13.4 — Background Auto-Bootstrapping

On (re)start the daemon: loads config → opens vault → resolves port (§13.5) →
spawns `opencode serve` (password via child env) → polls `/health` (≤ 10 s) →
records contract version → reconciles sessions (`GET /session` vs ledger, `10` §10.2)
→ resumes SSE from cursor → re-enqueues unplayed briefings (deduped). Any step may
retry with backoff; unrecoverable steps halt with a secretSafe operator error.

## 13.5 — Port Binding Policy (normative)

1. Default `4096` on `127.0.0.1` (never wildcard — boot refuses otherwise, `12` §12.5).
2. If bound: probe `/health`. Healthy + password matches → adopt (log `ADOPTED`).
   Healthy + password mismatch → escalate to next free port, log `ESCALATED`, record
   in ledger (E-1). Unhealthy listener → wait 5 s, re-probe once, then escalate.
3. The bound port is written to `<dataDir>/active-port` for CLI/mobile discovery.

## 13.6 — Update & Rollback

- `npm update -g opencode-voice-runtime` → `opencode-voice doctor` → start.
  Config and vault are forward-compatible across minors (deprecation policy, `08` §8.4).
- Rollback: reinstall previous version; snapshots + ledger are version-tolerant
  (unknown fields stripped by validators, `06` §6.1). No data migration has ever
  required more than a restart.

---

*End of `13-DEPLOYMENT.md`. Next: `14-RUNBOOK.md`.*
