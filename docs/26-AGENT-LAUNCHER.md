# 26 — Agent Launcher: Process Supervisor, Health Probes, Zombie Reaping & Shutdown

> **Canonical status:** Design/immunity/owner batch. Supervision truth for FR-1 (`01`).
> Boot sequence: `04` §4.4.1 · Port policy: `13` §13.5 · I-4: `12` §12.3.

## 26.1 — Supervisor Responsibilities (normative)

`src/launcher/` owns the `opencode serve` child process end-to-end: resolve port →
spawn (password via `env` only, never `argv` — I-4) → readiness probe → contract
probe → handoff to `orchestrator/` → watch (restart on unexpected exit) → graceful
shutdown on daemon stop. On Windows the child is assigned to a **Job Object** at spawn
so tree termination is guaranteed by the OS (no ConPTY orphan can escape the job).
Children are fingerprinted by command-line + start-time, never by PID alone (PIDs get
recycled). No other module may spawn `serve` or signal it directly;
all control flows through `launcher/` so restarts, probes, and password hygiene have
exactly one implementation.

```ts
// src/launcher/launcher.ts — public surface (only surface allowed to touch the child)
export interface Launcher {
  boot(cfg: OrchestratorConfig): Promise<ServeHandle>;
  shutdown(handle: ServeHandle, opts?: { timeoutMs: number }): Promise<void>;
  health(handle: ServeHandle): Promise<HealthStatus>;
  hotRestart(handle: ServeHandle, newPassword: string): Promise<ServeHandle>;
}
export interface ServeHandle {
  readonly pid: number;
  readonly port: number;
  readonly contractVersion: string;   // recorded from openapi.json info.version
  readonly adopted: boolean;          // true if pre-existing healthy owner adopted
}
export type HealthStatus = 'starting' | 'ready' | 'degraded' | 'unreachable';
```

## 26.2 — Health Check Probes (normative)

| Probe | Target | Interval | Thresholds |
|-------|--------|----------|------------|
| Readiness | `GET /health` → `ready` | 250 ms during boot (≤ 10 s budget) | 40 misses → boot fails (F-04) |
| Liveness | `GET /health` | 10 s steady-state | 3 misses → `degraded`; 6 → restart path |
| Contract | `GET /openapi.json` major version | once per boot + on `CONTRACT_DRIFT` suspicion | major drift → read-only-safe (E-12) |
| Zombie | PID alive but `/health` unreachable post-SIGTERM | 1 s during shutdown | 5 s → SIGKILL/`taskkill`, ledger F-06 |

Probe traffic carries the Bearer header via the redacting HTTP wrapper — probe logs
record status codes only, never headers.

## 26.3 — Restart Policy (normative)

Unexpected exit → classify: clean exit (code 0, no sessions running) = do not restart,
ledger note; crash (non-zero, or zero with live sessions) = backoff restart
(1 s → 2 s → 4 s … cap 30 s, jitter ±25%), max 5 attempts, then S1 briefing + halt
(F-05). Each restart re-runs readiness + reconcile (`10` §10.2) before resuming SSE.

## 26.4 — Zombie Process Reaping (normative)

Shutdown sequence: SIGTERM (POSIX) / service-stop + job-close (Windows, kills the whole
tree via the Job Object) → wait 5 s → verify PID gone AND port released → else
force-kill (`SIGKILL` / `taskkill /PID /F`) → verify again → ledger `shutdown-clean`
or `F-06-reaped`. A launcher that exits leaving a live child fails its own shutdown
test (`11` integration: child inventory before/after).

**Orphan sweeper (normative, T2):** a background pass every 60 s fingerprints live
processes by command-line + start-time; any decoupled `opencode serve` instance that is
not the supervised child (or an adopted healthy owner) is terminated to prevent port
4096 squatting. Budget: < 5 ms CPU per pass; every sweep outcome (clean or reaped) is
ledger-marked.

## 26.5 — Graceful Shutdown Handling (normative)

On SIGINT/SIGTERM/service-stop: freeze intake (no new sessions/prompts) → flush
speech queue (finish current utterance, park the rest as ledger-queued) → snapshot
(`10` §10.1) → terminate `serve` child per §26.4 → close vault buffers (zero key
material) → exit 0. Total budget 15 s; exceeding it force-kills the child but never
skips the snapshot (state survival outranks speed).

## 26.6 — Password Hot-Restart (normative, T6)

On password rotation without session loss: signal active sessions to commit state to
the checkpoint ledger (`10`) → graceful shutdown of the old child per §26.4 →
bootstrap a fresh `opencode serve` with the updated `OPENCODE_SERVER_PASSWORD` →
readiness + contract probe → re-attach client sessions using existing session IDs →
resume SSE from stored cursors → reconcile. Sessions observe a pause, never a reset;
briefings queued during the window replay deduped after re-attach.

---

*End of `26-AGENT-LAUNCHER.md`. Next: `27-CREDENTIALS.md`.*
