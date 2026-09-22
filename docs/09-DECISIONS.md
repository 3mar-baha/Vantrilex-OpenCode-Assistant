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

## Decision Log (subsequent ADRs)

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-005+ | *Reserved — fleet supervision (v2.0.0 RFC will extend this table)* | Proposed | — |

---

*End of `09-DECISIONS.md`. Next: `10-CHECKPOINT.md`.*
