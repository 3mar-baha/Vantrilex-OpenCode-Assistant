# 09 — Decisions: Architectural Decision Records (ADR-001 to ADR-004)

> **Canonical status:** Governance. Decision truth — *why* the architecture is shaped
> as specified in `04-ARCHITECTURE.md`. Each ADR: context → options → decision →
> consequences → compliance test.

## ADR-001 — OpenCode OpenAPI serve surface vs PTY/ANSI scraping

- **Status:** Accepted. **Date:** 2026-09-22. **Deciders:** Principal Architect + operator.
- **Context:** The orchestrator must observe session lifecycle and dispatch prompts.
  Two mechanisms exist: (a) drive the official `opencode serve` HTTP/SSE contract via
  `@opencode/client`; (b) spawn the interactive TUI and scrape PTY/ANSI output.
- **Options considered:**
  1. *PTY scraping* — zero new processes, but couples us to renderer escape codes,
     color schemes, and every upstream TUI change. Breaks silently (mis-parsed states).
  2. *OpenAPI + SSE* — typed contracts (`session.create/prompt`, lifecycle envelopes),
     replay cursors, explicit versioning. Requires supervising a daemon process.
- **Decision:** Option 2 exclusively. PTY interaction is forbidden in production paths
  (test fixtures may emulate a TTY only to prove the negative: no production code
  reads it).
- **Consequences:** `launcher/` + `runtime/` + `orchestrator/` exist as the adapter
  zone (`04` §4.5); readiness probes and reconnect FSMs are mandatory complexity we own.
- **Compliance test:** `grep -rnE 'node-pty|ansi-regex|strip-ansi' src/` returns zero
  matches in CI; 100 create→prompt→complete cycles run with stdout of `serve` piped
  to `/dev/null` and still pass.

## ADR-002 — Groq LPU (`gpt-oss-120b`) vs general cloud LLM APIs for the 2 s budget

- **Status:** Accepted. **Date:** 2026-09-22.
- **Context:** The cognitive brain must respond within a 2.0 s golden budget (p50) and
  a 5.0 s ceiling (p99) while emitting Ammani Arabic + English technical spans (`01`
  FR-6). General cloud APIs add multi-region routing and queueing variance that blows
  p99 past 8 s in benchmarks on the reference network.
- **Options considered:**
  1. *General cloud LLM API* — broad model choice, but p50 ≈ 2.5–4 s, p99 unbounded.
  2. *Groq LPU (`openai/gpt-oss-120b`)* — deterministic low-latency inference fabric;
     single vendor for STT + brain simplifies the keyring to one Groq pool.
- **Decision:** Option 2. Brain calls use `openai/gpt-oss-120b` on Groq with
  client-side timeout at 5.0 s and a fallback briefing on `BRAIN_TIMEOUT`.
- **Consequences:** Groq key pool is load-bearing — rotation (ADR-003) and 429 handling
  are release-blocking; model string is config (`05` §5.7), swappable without release.
- **Compliance test:** 200-prompt benchmark harness (`11`): p50 ≤ 2.0 s, p99 ≤ 5.0 s,
  else release gate fails.

## ADR-003 — DPAPI vault with 10-request rotating keyring

- **Status:** Accepted. **Date:** 2026-09-22.
- **Context:** Fish Audio and Groq enforce per-key rate limits/quotas. A single static
  key per provider fails under concurrent sessions; plaintext `.env` keys fail the
  security audit (persona P3, `01`).
- **Options considered:**
  1. *Single key in env* — simple, but one 429 halts all voice; plaintext at rest.
  2. *Cloud secret manager* — strong, but adds account setup, network dependency, and
     cost for a localhost-first tool.
  3. *OS-encrypted vault (DPAPI `safeStorage`) + independent pools + deterministic
     rotation (rollover on request #11)* — no new accounts, zero plaintext, quota
     spread evenly, behavior exactly testable.
- **Decision:** Option 3. Two independent pools (`groq`, `fish`); atomic per-pool
  counter; after exactly 10 requests on the active key, request #11 rolls over;
  pool mutex serializes acquire/dispatch/increment; forced rollover on 429/auth-fail.
- **Consequences:** `src/voice/keyring.ts` owns all key material in zeroed buffers;
  every provider call goes through `acquire`/`release`; vault file is `0600`/ACL'd.
- **Compliance test:** 25-request sequence asserts K1×10 → K2×10 → K3×5 with rollover
  exactly on #11 and #21 under 8-way concurrency (`11`, `20`).
- **Supersession note (P-R):** the mutex mechanism is superseded by ADR-005 (lock-free
  slots); the invariant and this compliance shape survive with the proof upgraded to a
  25-way distribution assertion.

## ADR-004 — Fish Audio dual voice selection (`s2.1-pro-free`)

- **Status:** Accepted. **Date:** 2026-09-22.
- **Context:** Briefings must sound authentically Arabic (Ammani ear, `02` §2.3.3) and
  the operator wants a voice choice without re-engineering the pipeline. Generic
  system TTS voices fail the authenticity bar; single-voice lock-in fails the choice bar.
- **Options considered:**
  1. *OS system TTS* — free/offline, but Arabic voice quality is robotic; no voice parity across platforms.
  2. *Fish Audio `s2.1-pro-free` with dual voice IDs* — high-quality Arabic synthesis,
     streaming first-chunk, two pinned voices behind logical IDs.
- **Decision:** Option 2. Logical `male-default` → `5b90451e0cd34b2788841744af7c55c3`
  (default), `female-toggle` → `88c0375e46fa4e3b929755fa077ca5ad`; toggle switches at
  utterance boundaries; 50-clip LRU shields repeated phrases from network variance.
- **Consequences:** Fish key pool is load-bearing alongside Groq; voice IDs live in
  `05` §5.1 config (swappable without release); TTS outage degrades to log-first +
  cached-phrase playback, never silence-without-explanation.
- **Compliance test:** cache-hit playback < 50 ms; first-chunk p50 < 800 ms;
  toggle effective within one utterance boundary (`11`, `18`).

## ADR-005 — Lock-free keyring slots superseding the pool mutex

- **Status:** Accepted. **Date:** 2026-09-22 (P-R revision pass, discovery T3).
- **Context:** ADR-003 specified a pool mutex serializing acquire/dispatch/increment.
  Under 20-way concurrency the mutex becomes a throughput bottleneck on every provider
  call. The invariant (rollover deterministically on request #11) does not require
  mutual exclusion — only unique slot numbering.
- **Options considered:**
  1. *Mutex per pool* — simple proof, but serializes all provider traffic per pool.
  2. *Lock-free atomic sequence counter* (`slot = fetch-and-add; keyIndex =
     floor(slot/10) % n`) — sub-microsecond wait-free acquisition; exactness holds
     structurally via arithmetic, never statistically.
- **Decision:** Option 2. The mutex is removed from the acquisition path; secret
  handling (zeroed buffers, DPAPI persistence) is unchanged — only the counter is
  lock-free, never the secret custody.
- **Consequences:** `20-KEYRING.md` rewritten around slots; `11` §11.4 proof becomes a
  25-way distribution assertion; `05` §5.6 counter shapes migrate in M2.
- **Compliance test:** 25 concurrent acquisitions resolve slots 0–9→K1, 10–19→K2,
  20–24→K3 with zero double-spent slots.

## ADR-006 — Autonomous intelligence over rigid rules

- **Status:** Accepted. **Date:** 2026-09-22 (P-R revision pass, discovery Gates 0–1).
- **Context:** Over-specified deterministic micromanagement makes the agent brittle
  outside scripted paths and contradicts the product thesis (an ambient peer, not a
  notification script). But unbounded autonomy risks destructive acts and leaks.
- **Decision:** Peer-grade autonomous judgment everywhere EXCEPT three non-negotiable
  hard boundaries: (1) secret handling I-1–I-5 (`12`), (2) destructive-action two-way
  confirmation FR-12 (`02` §2.4), (3) ledger durability (`10`). Trust-breakers
  (hallucinated completion, cheerful tone on failure, ambiguous destructive acts,
  briefing lectures) are prohibited outputs, enforced by audit tests (`11` §11.5).
- **Consequences:** `16` Gate invariants rewritten as autonomy doctrine; `04` carries
  the doctrine banner; session-overseer skill (`17` §17.6) exercises away-mode agency.
- **Compliance test:** destructive-intent drill (FR-12 acceptance) + trust-breaker scan
  green on every release.

## ADR-007 — Ring-buffer elimination for terminal audio

- **Status:** Accepted. **Date:** 2026-09-22 (P-R revision pass, discovery T4).
- **Context:** A raw terminal audio ring buffer was hypothesized for massive compiler
  bursts — but no such buffer exists in the architecture, and piping raw bytes into
  audio conflates the log plane with the speech plane.
- **Decision:** The concept is deprecated and SHALL NOT be implemented. The brain
  consumes structured JSON lifecycle events; raw stdout/stderr is observable via
  file-based log tailing with a 40-spoken-word excerpt cap enforced in `bluf()`.
- **Consequences:** `18` §18.6 specifies the event-feed/log-tail split; `11` §11.5A
  asserts the cap.
- **Compliance test:** no `ring` audio-buffer code in `src/voice/`; excerpt-cap drill green.

## ADR-008 — Laya System-1: local CPU speech-intent heads over cloud round-trips

- **Status:** Accepted. **Date:** 2026-09-22. **Deciders:** Principal Architect + operator.
- **Context:** The orchestrator must decide, per lifecycle event, whether a briefing is
  worth speaking (`02` §2.2 tiering, FR-6) and must recognise destructive intent,
  barge-in, and stuck-in-loop conditions *before* the cognitive brain is consulted.
  The brain (ADR-002) is a 0.6–1.25 s cloud call: far too slow and too costly to run as
  a pre-filter on tens of events per minute, and it would ship raw transcript spans
  off-device just to answer a binary gate.
- **Options considered:**
  1. *Cloud LLM classifier per event* — accurate, but adds ≥0.6 s + network variance and
     egress to every gate decision; cost scales with event volume.
  2. *Lexical/heuristic rules* — zero latency, but brittle on Ammani Arabic/English
     code-switching; no dialect robustness — the exact failure the product must avoid.
  3. *Local fine-tuned small model* — frozen multilingual backbone
     (`convaiinnovations/laya-multilingual`, 322M mmBERT) plus four linear heads
     (`should_speak`, `is_destructive`, `barge_in`, `stuck_in_loop`), trained on 5.2k
     Ammani software-engineering samples, exported to INT8 ONNX, executed on CPU through
     `onnxruntime-node`.
- **Decision:** Option 3. The model is **advisory-only**: `Orchestrator` consults a
  `SpeechAdvisor` before enqueueing a T1 briefing, and an absent advisor preserves prior
  behaviour exactly. A positive `is_destructive` never auto-acts — FR-12 two-way
  confirmation remains mandatory (`02` §2.4, ADR-006 boundary 2).
- **Consequences:** CPU-only invariant — no CUDA path exists in `ml/` or
  `src/runtime/laya/` (the reference GTX 750 Ti is deliberately unused). Backbone weights
  are loaded through a single remap helper (`ml/laya_hub.load_backbone`) that hard-aborts
  on any missing key, so a silently random encoder can never train or ship. The four
  heads share one frozen forward pass; the ONNX artifact is large and lives under the
  gitignored `models/` directory.
- **Compliance test:** (a) held-out eval gates — `should_speak` and `is_destructive`
  accuracy ≥ 0.90, `barge_in` and `stuck_in_loop` ≥ 0.85; (b) ONNX parity max logit diff
  < 1e-4 vs torch; (c) CPU latency p50 < 40 ms at the corpus operating length;
  (d) unit + live integration tests green (Gate 4).

## Decision Log (subsequent ADRs)

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-008 | Laya System-1: local CPU speech-intent heads over cloud round-trips | Accepted | 2026-09-22 |
| ADR-009+ | *Reserved — fleet supervision (v2.0.0 RFC will extend this table)* | Proposed | — |

---

*End of `09-DECISIONS.md`. Next: `10-CHECKPOINT.md`.*
