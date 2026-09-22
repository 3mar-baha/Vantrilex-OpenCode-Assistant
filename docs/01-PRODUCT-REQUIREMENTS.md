# 01 — Product Requirements Document (PRD): OpenCode Ambient Voice & Runtime Orchestrator

> **Canonical status:** Foundation. Product truth for `opencode-voice-runtime`.
> All downstream specs (`02`–`07`) trace to requirements defined here.
> Package: `opencode-voice-runtime` · Target MVP: `v1.0.0` (see `08-ROADMAP.md`).

## 1.1 — Problem Statement

Developers who run long-horizon AI coding agents face a supervision paradox: the agent
works best when left alone for minutes at a time, but the developer must remain tethered
to the terminal to notice completion, failures, or approval requests. Existing approaches
fail in three concrete ways:

1. **Terminal scraping is brittle.** PTY/ANSI parsing breaks on every renderer change,
   color-scheme tweak, or upstream release. Any orchestrator built on scraping inherits
   upstream's churn.
2. **Notifications are mute and context-free.** OS toasts say "task done" without saying
   *what* was done, in which session, with what outcome — forcing a context switch back
   to the terminal to reconstruct meaning.
3. **Voice tooling is monolingual and cloud-slow.** Generic English TTS/STT pipelines
   with multi-second round trips cannot serve an Arabic-speaking developer who thinks in
   Ammani dialect while reading technical English.

**Product thesis:** a decoupled outer-host daemon that (a) drives OpenCode v2 exclusively
through its official `opencode serve` OpenAPI 3.1 + SSE surface, (b) narrates lifecycle
events in authentic Ammani Jordanian Arabic without stealing OS focus, and (c) survives
upstream upgrades untouched — because it never patches OpenCode internals.

## 1.2 — User Personas

### P1 — Omar, the solo Arabic-speaking builder (primary)

- Runs multi-minute agent sessions (refactors, test suites, scaffolds) while doing other work.
- Thinks and speaks Ammani Jordanian Arabic (العامية الأردنية العمانية); reads/writes
  code, logs, and paths in technical English.
- Wants: start a session by voice, walk away, hear a crisp Arabic briefing when it
  completes, approve or redirect by voice without touching the keyboard.
- Anti-want: focus theft, English-robot narration of Arabic, plaintext API keys.

### P2 — Salma, the tech lead supervising parallel sessions (secondary)

- Runs 3–5 concurrent sessions across repos; needs per-session identity in every briefing.
- Wants: briefings that open with session identity and outcome (BLUF), mobile step-approval
  when away from desk (see `19-MOBILE-PAIRING.md`).
- Anti-want: interleaved/overlapping speech from concurrent completions; ambiguous "it finished".

### P3 — Karim, the security-conscious operator (constraining)

- Audits credential handling and network exposure on Windows-first environments.
- Wants: DPAPI-encrypted vault, zero plaintext secrets on disk/logs/memory dumps,
  localhost-only daemon binding, auditable key rotation.
- Anti-want: `.env` files with live keys, keys echoed in logs, wildcard binds.

## 1.3 — Product Goals and Non-Goals

**Goals (MVP v1.0.0):**

- G1. Bootstrapping and supervising `opencode serve` as a managed child process.
- G2. Programmatic session lifecycle via official client surface only.
- G3. Typed SSE event subscription replacing all terminal scraping.
- G4. Background completion detection → non-intrusive Arabic spoken briefing.
- G5. Voice loop: Groq Whisper STT → `gpt-oss-120b` brain → Fish Audio TTS with LRU cache.
- G6. DPAPI vault + 10-request rotating keyring for Groq and Fish Audio pools.
- G7. `AGENTS.md` / `.opencode/skills/` guidance injection (Reasons-Not-Rules, 3-Case
  context awareness, BLUF briefings).

**Non-goals (MVP):**

- NG1. No fork/patch of OpenCode internals — hard architectural boundary (`04`).
- NG2. No multi-agent fleets (deferred to v2.0.0, `08-ROADMAP.md`).
- NG3. No mobile app binary — remote relay + approval queue only (`19`).
- NG4. No custom ASR/TTS model training — managed APIs only.

## 1.4 — Functional Requirements (FR-1 to FR-10)

### FR-1 — Daemon bootstrap and supervision

The system SHALL launch `opencode serve --port <port> --hostname 127.0.0.1` as a managed
child process, inject `OPENCODE_SERVER_PASSWORD` exclusively via the child environment
(never CLI args, never logs), perform a readiness probe against the OpenAPI health
endpoint, and restart with backoff on unexpected exit. Full spec: `26-AGENT-LAUNCHER.md`.

**Acceptance:** cold boot to ready in ≤ 10 s on reference hardware; password absent from
`ps` output, logs, and crash dumps.

### FR-2 — Programmatic session management

The system SHALL create, prompt, and track sessions exclusively through `@opencode/client`
(or equivalent typed HTTP calls against the OpenAPI 3.1 contract): `session.create`,
`session.prompt`, plus status queries. No PTY interaction. Full spec: `06-API-SPECIFICATION.md`.

**Acceptance:** 100 consecutive create→prompt→complete cycles with zero PTY fallback;
every session carries a stable `sessionId` traceable across logs, events, and briefings.

### FR-3 — Typed event-stream subscription

The system SHALL subscribe to the typed lifecycle stream (`session:start`,
`agent:action`, `subagent:complete`, `session:complete`, `session:idle`) over SSE with
reconnection (exponential backoff + jitter + replay cursor). Full spec: `25-CLIENT-SERVER-RPC.md`.

**Acceptance:** survives a forced `serve` restart with ≤ 1 duplicated event and zero
lost terminal events (`session:complete` never dropped — see edge matrix E-4).

### FR-4 — Background completion detection and briefing trigger

The system SHALL detect `session:complete` / `session:idle` in the background and enqueue
a briefing job containing session identity, outcome, and BLUF summary — without moving OS
focus, raising windows, or requiring acknowledgment. Full spec: `02-PRODUCT-SPECIFICATION.md`.

**Acceptance:** 50/50 completion injections produce 50 briefing jobs, zero foreground
window activations (verified via focus-log harness, `11-TESTING.md`).

### FR-5 — Speech-to-text (Groq Whisper)

The system SHALL transcribe microphone input via Groq Whisper (`whisper-large-v3-turbo`),
chunked for streaming, with round-trip latency p50 < 500 ms on reference network.
Full spec: `18-VOICE-PIPELINE.md`.

**Acceptance:** benchmark harness (§11) reports p50 < 500 ms over 200 utterances;
mixed Arabic/English utterances transcribe code tokens verbatim (English preserved).

### FR-6 — Cognitive brain (Ammani Arabic, latency-budgeted)

The system SHALL route transcribed intent through `openai/gpt-oss-120b` on Groq LPU under
a strict budget — **2.0 s golden (p50), 5.0 s maximum ceiling (p99)** — and produce spoken
output exclusively in authentic Ammani Jordanian Arabic, while code identifiers, terminal
logs, and system paths remain in technical English. Full spec: `18-VOICE-PIPELINE.md`.

**Acceptance:** 200-prompt benchmark: p50 ≤ 2.0 s, p99 ≤ 5.0 s; language audit: zero
non-technical English words in spoken track; zero Arabic transliteration inside code spans.

### FR-7 — Text-to-speech (Fish Audio streaming + cache)

The system SHALL synthesize speech via Fish Audio API (`s1.1-pro-free`… corrected:
`s2.1-pro-free` model) with a dual voice selector — male default
(`5b90451e0cd34b2788841744af7c55c3`), female toggle (`88c0375e46fa4e3b929755fa077ca5ad`) —
streaming first-chunk < 800 ms, backed by a 50-clip LRU cache for instant replay of
repeated phrases. Full spec: `18-VOICE-PIPELINE.md`, `05-DATA-MODEL.md`.

**Acceptance:** cache-hit playback starts in < 50 ms; voice toggle switches within one
utterance boundary; first-chunk p50 < 800 ms.

### FR-8 — Keyring rotation engine

The system SHALL hold independent key pools for Fish Audio and Groq in an OS-encrypted
vault (Windows DPAPI `safeStorage` / persistent secure vault), with an atomic per-pool
request counter and a strict invariant: **after exactly 10 requests on the active key,
request #11 rolls over to the next key in the pool**. Zero plaintext secrets in memory
dumps, logs, or disk files. Full spec: `20-KEYRING.md`, `12-SECURITY.md`.

**Acceptance:** 25-request sequence uses keys K1×10 → K2×10 → K3×5 with rollover
exactly on requests #11 and #21 under concurrent load (mutex-verified, `11-TESTING.md`).

### FR-9 — Project guidance injection

The system SHALL inject behavioral guidance via standard `AGENTS.md` and
`.opencode/skills/` (never global mutation, never OpenCode patching), implementing the
Reasons-Not-Rules paradigm, 3-Case project context awareness (Case 1 Greenfield, Case 2
Undocumented Legacy, Case 3 Outdated Docs Refresh), and BLUF executive summaries shaped
for audio clarity. Full spec: `17-CATALOG-INGESTION.md`, `02-PRODUCT-SPECIFICATION.md`.

**Acceptance:** all three cases produce correctly classified guidance in fixture repos;
every briefing summary leads with outcome in ≤ 15 spoken words.

### FR-10 — Observability and recovery surface

The system SHALL expose structured logs, health probes, incident runbook hooks
(`14-RUNBOOK.md`), and a deterministic checkpoint ledger (`10-CHECKPOINT.md`) so that any
daemon restart reconstructs session state without operator archaeology.

**Acceptance:** kill -9 mid-session → restart → state reconstruction matches ledger
within one event (verified by chaos test, `23-STRESS-TESTING.md`).

## 1.5 — Non-Functional Requirements

| ID | Category | Requirement | Verification |
|----|----------|-------------|--------------|
| NFR-1 | Latency (STT) | p50 round-trip < 500 ms | Benchmark harness, `11` |
| NFR-2 | Latency (brain) | p50 ≤ 2.0 s golden; p99 ≤ 5.0 s ceiling | Benchmark harness, `11` |
| NFR-3 | Latency (TTS) | Streaming first-chunk p50 < 800 ms; cache-hit start < 50 ms | Harness, `11` |
| NFR-4 | Concurrency | ≥ 5 parallel sessions with isolated briefings, no speech overlap | Stress suite, `23` |
| NFR-5 | Memory | Daemon RSS ≤ 512 MB steady-state; audio cache bounded (50 clips, size-capped blobs) | Leak analysis, `23` |
| NFR-6 | Security | Zero plaintext secrets at rest/in-log/in-dump; localhost-only bind; 10-request rotation invariant | Audit + tests, `12`/`20` |
| NFR-7 | Reliability | `session:complete` never dropped; SSE reconnect ≤ 5 s; restart reconstruction within one event | Chaos tests, `23` |
| NFR-8 | Update immunity | Upstream OpenCode minor+major upgrades require zero changes to voice/brain/keyring layers | Boundary test, `04` |
| NFR-9 | Accessibility | Zero-focus-steal verified; briefings ≤ 45 s spoken; earcon signaling (`21`) | UX harness, `02` |
| NFR-10 | Operability | Cold boot ≤ 10 s; clean `git` tree after `/sync`; checkpoint ledger current | `10`/`16`/`26` |

## 1.6 — Edge-Case Matrix

| ID | Edge case | Expected behavior | Owner doc |
|----|-----------|-------------------|-----------|
| E-1 | `opencode serve` port already bound | Probe, adopt-if-healthy else escalate port and record; never kill unknown owners blindly | `26` |
| E-2 | SSE disconnect mid-session | Backoff reconnect with replay cursor; mark gap in ledger; no duplicate briefings | `25` |
| E-3 | Groq HTTP 429 rate limit | Keyring forced-rollover + jittered retry; briefing notes degraded mode once | `14`, `20` |
| E-4 | `session:complete` arrives during reconnect gap | Replay cursor recovers it; briefing enqueued exactly once (idempotency key = event id) | `10`, `25` |
| E-5 | Microphone unavailable | Fallback to text-prompt mode; spoken notice once; no crash loop | `14` |
| E-6 | Audio device failure mid-briefing | Re-queue briefing text; visual log fallback; retry on device return | `14` |
| E-7 | Fish Audio 429 / key exhausted | Pool rollover; LRU cache serves repeated phrases during outage | `20` |
| E-8 | Brain exceeds 5.0 s ceiling | Timeout → concise fallback briefing ("completed, details in log") + ledger flag | `18` |
| E-9 | Concurrent completions (P2) | Serialize speech queue; identity-prefixed briefings; never overlap audio | `02` |
| E-10 | Daemon kill -9 mid-briefing | Restart replays ledger; briefing re-enqueued once (dedupe by session + event id) | `10` |
| E-11 | Secret file missing/corrupt | Refuse voice features requiring that pool; clear operator error; no plaintext fallback | `12` |
| E-12 | Upstream OpenCode upgrades schema | Contract-version probe; adapterFuture log; voice/brain/keyring untouched | `04` |

## 1.7 — Requirements Traceability

Each FR maps to owning specs: FR-1→`26`, FR-2→`06`, FR-3→`25`, FR-4→`02`, FR-5/6/7→`18`,
FR-8→`20`+`12`, FR-9→`17`+`02`, FR-10→`10`+`14`. ADRs in `09-DECISIONS.md` record *why*
each requirement took its current shape (OpenAPI over PTY, Groq LPU, DPAPI keyring,
Fish Audio dual voice).

---

*End of `01-PRODUCT-REQUIREMENTS.md`. Next: `02-PRODUCT-SPECIFICATION.md`.*
