# 24 — Immunology: Failure-Mode Immune Ledger (60 Patterns), Auto-Remediation & Guard Hooks

> **Canonical status:** Design/immunity/owner batch. Resilience truth.
> Recovery recipes: `14` · Chaos proof: `23` · Guards run inside `orchestrator/` + `launcher/`.

## 24.1 — How Immunity Works (normative)

Every cataloged pattern has: a **detector** (log signature or probe), an
**auto-remediation** (executed without operator input), and a **ledger mark** (so
automation is auditable). Remediation is bounded: max 3 automatic attempts, then
escalate to a T1 briefing ("X failed 3 times, here's the safe state") — automation
never loops forever. Guard hooks evaluate pre-dispatch (keyring acquire, SSE send,
TTS speak, serve spawn); a failing guard blocks the action and routes to remediation.

## 24.2 — Immune Ledger: 60 Cataloged Failure Patterns

### G1 — Serve process (F-01–F-06)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-01 | `serve` binary missing on PATH | Halt boot with install hint; no retry loop |
| F-02 | Port bound by healthy foreign owner | Adopt-if-password-matches else escalate port (`13` §13.5) |
| F-03 | Port bound by dead listener | Wait 5 s, re-probe once, then escalate |
| F-04 | `/health` never ready in 10 s | Kill child, backoff restart ×3, then S1 briefing |
| F-05 | Unexpected child exit (code ≠ 0) | Backoff restart + session reconcile (`10` §10.2) |
| F-06 | Zombie child after shutdown | Reap by PID + `taskkill` fallback; ledger mark |

### G2 — HTTP adapter (F-07–F-12)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-07 | 401 bad server password | Halt; refuse retry (credential fix is manual) |
| F-08 | 404 unknown session | Reconcile list; mark `reconciled` or drop with note |
| F-09 | 409 duplicate idempotency key | Treat as success; adopt returned receipt |
| F-10 | 5xx from serve | Backoff retry ×3, then degraded read-only |
| F-11 | Contract major drift | `CONTRACT_DRIFT` + read-only-safe mode (E-12) |
| F-12 | Response schema-invalid | Strip unknowns; hard-fail missing-required with typed error |

### G3 — SSE stream (F-13–F-18)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-13 | Heartbeat gap ×3 | Reconnect with backoff + jitter + cursor |
| F-14 | Duplicate delivery | Ledger `duplicate: true`, enqueue nothing |
| F-15 | Gap with lost terminal event | Replay cursor; reconcile; exactly-once briefing |
| F-16 | Cursor rejected by server | Full reconcile (`GET /session`) + fresh subscribe |
| F-17 | 100k burst backpressure | Shed routine-only; terminal never shed (`23` §23.2) |
| F-18 | Stream 403 mid-life (password rotated) | Pause subscriptions; operator re-auth prompt |

### G4 — Groq provider (F-19–F-24)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-19 | 429 on active key | Forced rollover + jittered retry (max 3) |
| F-20 | 401 key revoked | Forced rollover + `auth-failed` mark; briefing if pool drains |
| F-21 | STT chunk > 25 MB | Re-chunk smaller; never send oversize |
| F-22 | STT empty transcript | One retry; then "didn't catch that" + text fallback |
| F-23 | Brain exceeds 5.0 s | Abort → fallback briefing + `BRAIN_TIMEOUT` flag |
| F-24 | Brain output schema-invalid | Fallback briefing; log schema diff (no raw speech) |

### G5 — Fish provider (F-25–F-30)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-25 | 429 on active key | Forced rollover + retry; cache shields repeats |
| F-26 | Voice ID rejected (404) | Fall back to other voice + operator notice; never silent |
| F-27 | First-chunk stall > 2 s | Abort stream; log-first briefing + cached phrases |
| F-28 | Oversize clip | Play-only, skip cache (never evict good entries for it) |
| F-29 | Mid-stream abort | Re-queue text; resume at utterance boundary |
| F-30 | Full pool exhausted | Degraded mode: log-first + cache-only speech |

### G6 — Keyring/vault (F-31–F-36)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-31 | Vault checksum mismatch | Refuse pool, operator error; other pool unaffected |
| F-32 | DPAPI unavailable at runtime | Refuse vault features; documented fallback chain (`12`) |
| F-33 | Single-key pool under load | Wrap-reset + `pool-size-1` warning urging more keys |
| F-34 | Mutex acquisition timeout (30 s) | Typed error + ledger flag; never silent skip |
| F-35 | Counter desync after crash | Restore persisted counters; resume mid-cycle (`20` §20.5) |
| F-36 | Secret pattern near log path | Throw before write (fail-closed, `10` §10.3) |

### G7 — Audio devices (F-37–F-42)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-37 | No microphone at boot | Text-prompt mode; one spoken notice via speakers |
| F-38 | Mic vanishes mid-capture | Abort chunk set; text fallback; re-detect on return |
| F-39 | No output device | Log-first briefings; queue for device return |
| F-40 | Device fails mid-briefing | Re-queue text; resume on return (E-6) |
| F-41 | Overlapping speech detected | Serialize; collapse per digest policy (`02` §2.3.2) |
| F-42 | Earcon blob missing | Regenerate once; speech proceeds regardless |

### G8 — Approvals/mobile (F-43–F-48)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-43 | Approval TTL expiry | Safe default (pause) + expiry briefing |
| F-44 | Duplicate decision delivery | Idempotency key dedupes; second verdict notified as loser |
| F-45 | Relay unreachable | Queue locally; flush on reconnect; voice/CLI still resolve |
| F-46 | Pairing code expired (120 s) | Invalidate; operator re-issues (never extend silently) |
| F-47 | Token replay detected | Reject + revoke token family; ledger incident |
| F-48 | Stale push opened | Read-only expired view; no live buttons |

### G9 — Guidance injection (F-49–F-54)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-49 | Low-confidence Case (< 0.6) | Pause for operator confirm; inject nothing |
| F-50 | Deny-listed skill scored high | Veto stands; record veto reason |
| F-51 | Catalog checksum drift mid-session | Defer injection to session boundary |
| F-52 | Target `.opencode/` unwritable | Error with path + ACL hint; session continues unguided |
| F-53 | Global config write attempted | Block + fail the operation (boundary, `17` §17.1) |
| F-54 | BLUF lead > 15 words | Truncate at clause boundary + ledger style flag |

### G10 — Daemon/meta (F-55–F-60)

| ID | Pattern | Auto-remediation |
|----|---------|------------------|
| F-55 | Kill -9 mid-session | Restart reconstruction within one event (`10` §10.2) |
| F-56 | Snapshot corrupt | Fall back to `.bak`, then ledger-only rebuild |
| F-57 | Ledger disk full | Emergency compact (digests) + S1 briefing; refuse new voice sessions |
| F-58 | Second daemon starts | `ALREADY_RUNNING` exit; incumbent untouched (`13` §13.3) |
| F-59 | Config schema-invalid | Boot with last-known-good + operator diff notice |
| F-60 | Showcase stale (commit ahead) | `stale` badge until CI regenerates (`22` §22.2) |

## 24.3 — Runtime Guard Hooks (normative)

Guards evaluate in this order before each protected action: `secret-scan` (blocks
secret-bearing payloads to logs/ledger) → `quota-check` (keyring slot available) →
`budget-check` (latency budget still feasible) → `focus-check` (no foreground calls
on the audio path). First failing guard blocks + remediates per its pattern row.

---

*End of `24-IMMUNOLOGY.md`. Next: `25-CLIENT-SERVER-RPC.md`.*
