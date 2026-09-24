# 08 — Roadmap: v1.0.0 MVP through v2.0.0 Fleets, Release Criteria & Deprecation Policy

> **Canonical status:** Governance. Milestone sequencing truth.
> Phase detail: `07-IMPLEMENTATION-PLAN.md` · Lifecycle: `16-WORKFLOWS.md`.

## 8.1 — Release Train Overview

| Release | Theme | Phases (`07`) | Entry gate |
|---------|-------|---------------|------------|
| v0.1.0 docs-foundation | 28-file canonical suite (this work) | — (docs) | 5-gate docs checks green |
| v0.2.0 adapter-skeleton | P0–P2: scaffold, launcher, runtime, orchestrator | P0→P2 | v0.1.0 shipped |
| v0.3.0 trust-layer | P3 keyring + P5 guidance | P3, P5 | P2 green |
| v1.0.0 MVP | P4 voice loop + P6 mobile + P7 hardening; all FR/NFR evidenced | P4, P6, P7 | P2+P3 green |
| v1.1.0 polish | Latency tuning, earcon set, showcase dashboard | — | v1.0.0 shipped |
| v2.0.0 fleets | Multi-agent fleet supervision (deferred non-goal NG2) | TBD | v1.1.0 + fleet RFC |

## 8.2 — Milestone Detail

### M1 — Docs foundation (v0.1.0, in progress)

- **Batch 1 (done, commits `eabc157`–`73141b8`):** `01`–`07` + `16` (this file's suite).
- **Batch 2 (this batch):** `08`–`14` — roadmap, ADRs, checkpoint, testing, security, deployment, runbook.
- **Batch 3:** `15`–`20` — distribution, workflows (done early), catalog ingestion, voice pipeline, mobile pairing, keyring.
- **Batch 4:** `21`–`28` — design system, showcase, stress, immunology, RPC, launcher, credentials, owner guide.
- **Exit:** 28 files on disk, placeholder grep clean, cross-refs resolve, tree clean.

### M2 — Adapter skeleton (v0.2.0)

Deliverables: supervised `opencode serve` boot (≤ 10 s), typed client
(create/prompt/status), SSE subscription with reconnect + ledger, speech-queue stub
logging to console instead of audio. Acceptance: 100 create→prompt→complete cycles;
kill-restart loses zero terminal events (E-4 exercised).

### M3 — Trust layer (v0.3.0)

Deliverables: DPAPI vault + 10-request rotation under lock-free slots (25-request exactness
proof; the mutex mechanism in early drafts was superseded by ADR-005 — the shipped
`src/voice/keyring.ts` uses a wait-free atomic counter), AGENTS.md injection + 3-Case classifier + BLUF formatter on fixture repos.
Acceptance: rollover exactly on requests #11/#21 under concurrency; all 3 cases
classify correctly.

### M4 — Voice loop MVP (v1.0.0)

Deliverables: Whisper STT streaming, `gpt-oss-120b` brain under 2.0 s/5.0 s budgets,
Fish Audio streaming + 50-LRU, mobile approval queue over relay stub, full Gate-4
table green, chaos suite (E-1–E-12) passing. Acceptance: `07` §7.4.2 release gate,
every box checked with pasted evidence.

### M5 — Polish (v1.1.0)

Latency tuning log (p50/p99 before/after per subsystem), final earcon set (`21`),
automated showcase dashboard (`22`), owner-guide fresh-machine walkthrough (`28`).

### M6 — Fleets (v2.0.0, scoped later)

Multi-session fleet supervision, fleet-wide digest briefings, per-fleet speech
arbitration. Requires a fleet RFC and new ADRs; explicitly out of MVP scope.

## 8.3 — Release Criteria (normative, all releases)

1. All 5 gates evidenced with exit artifacts (`16`).
2. Atomic commits only; `git log --stat` review shows one concern per commit.
3. Checkpoint ledger (`10`) current through the release commit.
4. No placeholders; contract probe recorded (code releases).
5. v1.0.0 additionally requires the full `07` §7.4.2 gate.

## 8.4 — Deprecation Policy

1. Any public interface (config key, internal event, voice ID, CLI flag) is deprecated
   with a **one-minor-version notice**: announce in release notes + `28-OWNER-GUIDE.md`,
   emit a runtime warning, remove no earlier than the next minor.
2. Voice IDs and model strings are configuration, never code constants outside
   `05` §5.1/`05` §5.7 — rotation never requires a release.
3. Upstream OpenCode upgrades never force a major of this project unless the adapter
   zone (`04` §4.5) requires a breaking internal-event change; such changes ship with
   a migration note and a dual-read compatibility window of one release.

---

*End of `08-ROADMAP.md`. Next: `09-DECISIONS.md`.*
