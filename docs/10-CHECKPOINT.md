# 10 — Checkpoint: Deterministic Session Checkpointing, Reconstruction & Ledger Persistence

> **Canonical status:** Governance. State-survival truth. Implements FR-10 (see `01`).
> Types: `05` §5.2–§5.3 · Reconnect: `25` · Gate-5 updates: `16` §16.7.3.
>
> **This file is two documents and the boundary matters.** §§10.1–10.6 are a frozen
> FR-10 **specification** and are not re-derived against the tree — a normative
> rule is not a claim about the code, and "fixing" one to match an implementation
> would destroy the record of what was specified. Everything from `## Security
> remediation` onward is a **gate ledger**: measured figures recorded at the
> moment they were true, appended chronologically, never overwritten. Where a
> ledger row is a plain claim about the current tree rather than history, it is
> marked as such and re-derived; where it is history it stands.

## 10.1 — Checkpoint Protocol (normative)

The daemon maintains an append-only **ledger** (JSONL, one `LedgerRow` per line,
`05` §5.3) plus a periodic **snapshot** (single JSON: all `SessionRecord`s + active
SSE cursor + keyring *sequence counter only, never key material* + speech-queue depth
+ retry-loop state per session + pre-authorization class decisions).

1. **Append rule:** every validated SSE envelope appends exactly one ledger row before
   any side effect (briefing enqueue, approval request). Side effects are downstream
   of the append — a crash between append and effect replays the effect, never loses it.
2. **Snapshot rule:** snapshot written every 30 s AND on every terminal event
   (`session:complete`, `session:idle`, `step:complete`, approval resolution,
   circuit-breaker trip). Snapshot write is atomic
   (write temp + rename); the previous snapshot is retained as `.bak` until the new
   one checksums clean.
3. **Fsync rule:** ledger appends `fsync` before acknowledging the event internally;
   snapshots `fsync` the directory entry after rename. Durability over throughput —
   event volume is human-scale (tens/minute), never 100k/s sustained (bursts in `23`
   are absorbed by the OS page cache + backpressure in `25`).
4. **Idempotency rule:** `envelope.id` dedupes replays (duplicates append a row marked
   `duplicate: true`, enqueue nothing). Snapshot restore replays only rows with
   `seq` greater than the snapshot's `highSeq`.

## 10.2 — State Reconstruction after Daemon Restart

```mermaid
flowchart TB
    A[Daemon starts] --> B[Load latest snapshot\nverify checksum]
    B -->|corrupt| C[Fall back to .bak\nthen ledger-only rebuild]
    B -->|clean| D[Replay ledger rows\nseq > snapshot.highSeq]
    C --> D
    D --> E[Reconcile vs serve:\nGET /session list]
    E --> F{Divergence?}
    F -->|serve knows more| G[Adopt + provenance=reconciled]
    F -->|ledger knows more| H[Re-emit prompt or mark error]
    F -->|agree| I[Resume SSE from stored cursor]
    G --> I
    H --> I
    I --> J[Re-enqueue unplayed T1 briefings\n(dedupe by session + event id)]
```

**Reconstruction SLA (normative):** post-restart state matches pre-crash state within
one event — i.e., at most one briefing re-enqueued (deduped downstream) and zero
terminal events lost. Verified by the kill -9 chaos test (`23` §23.4, E-10).

## 10.2A — Hot-Restart Commit Protocol (normative, T6)

Password rotation reuses reconstruction with one addition: before the old child shuts
down, every active session commits a `hot-restart` checkpoint row (state, cursor,
queue depth, loop counters). After the fresh `serve` boots, sessions re-attach by
existing IDs and resume cursors — no replay-from-zero, no briefing storms. The protocol
is a rehearsed variant of §10.2, not a separate code path.

## 10.2B — Loop-State Persistence (normative, C6)

Per-session retry-loop counters (consecutive failures, last heartbeat time) persist in
the snapshot. A restart mid-loop resumes counting — it must not reset the circuit
breaker (which would grant 5 fresh silent failures) nor double-count (which would trip
it early). Heartbeat debt (a heartbeat due at crash time) fires once immediately after
reconstruction, then resumes cadence.

## 10.3 — Ledger Persistence Format

- **Path:** `<dataDir>/ledger/YYYY-MM-DD.jsonl` (daily rotation, 30-day retention,
  gzip after rotation). **Snapshot:** `<dataDir>/snapshot.json` + `snapshot.json.bak`.
- **Row encoding:** `LedgerRow` as compact JSON; `secretSafeMessage` strings only —
  the ledger writer rejects any value matching secret patterns (see `12` §12.3) by
  throwing before write (fail-closed, never redact-and-continue silently).
- **Retention & privacy:** transcripts older than the retention window are compacted
  to digests (intent + outcome, no verbatim text) unless the operator opts into full
  retention in config. Compaction is itself ledger-recorded (a `compaction` admin row).

## 10.4 — Execution Ledger — Documentation Suite (living section)

*Gate-5 re-sync target (`16` §16.7.3). Updated per batch.*

| Batch | Files | Commits (hash range) | Verification |
|-------|-------|---------------------|--------------|
| Batch 1 + Gate 1 + `16` | `16`, `01`–`07` (8 files) | `9a81b88` → `73141b8` (9 commits) | 8/8 files; placeholder grep clean; tree clean |
| Batch 2 | `08`–`14` (7 files) | `e8cb30b` → `7e71cb2` (7 commits) | 15/15 files; placeholder grep clean; tree clean |
| Batch 3 | `15`, `17`–`20` (5 files; `16` shipped early) | `efd8917` → `38db258` (5 commits) | 20/20 files; grep 3 hits adjudicated self-referential (`16` rule quotes); tree clean |
| Batch 4 | `21`–`28` (8 files) | `cd8058b` → *batch-4 close* (8 commits + ledger sync) | 28/28 files; full gate below; tree clean |
| P-R revision pass | `01`, `02`, `04`, `16`, `17`, `18`, `20`, `21`, `25`, `26`, `28` + `10`, `11`, `03`, `06`, `09` (16 files) | `1b63239` → *P-R close* (16 revision commits + ledger sync) | per-file commits; Gate-4 at pass end |

## 10.5 — Execution Ledger — Milestone M2 (living section)

*Autonomous overseer run, 2026-09-22. Security: keys staged in gitignored `.env.local`
only; `.gitignore` hardened first (`d06e54d`); zero real key prefixes in tracked files
(outside `docs/` masked pattern references and the `logger.ts` redaction detector,
which must name its targets by construction).*

| Phase | Scope | Commits | Gate-4 evidence |
|-------|-------|---------|-----------------|
| P0 scaffold | package/tsconfig/vitest/eslint, `.env.example`, `common/` + tests, `voice/cache` + tests, RAG manifest, GuildSkills stub | `ebc65f0`, `ca5e764`, `458927d`, `8816c41`, `b7a8859`, `ff9a962` | tsc 0, lint 0, 5/5 tests |
| P1 launcher+runtime | `launcher/` (supervised boot, tree-kill, sweeper, hot-restart), `runtime/` typed client + mock tests, `cli.ts` doctor | `67f868b`, `d544213` | tsc 0, lint 0, 10/10 tests |
| P2 orchestrator | `orchestrator/` envelopes, ledger, queue, staggered SSE core + live mock-SSE tests | `3c7218d`, `ae24f7a` | tsc 0, lint 0, 12/12 tests |
| M3 trust layer | P3 `voice/vault` + `voice/keyring` + proofs; P5 `guidance/` BLUF/agents/overseer/resolver + proofs | `fc1ea7c`, `77dfbbf`, `a593832`, `402bd6b` (+ `25c29e0` ledger marker) | tsc 0, lint 0, 23/23 tests |
| M4 voice pipeline | `voice/stt` + `voice/brain` + `voice/tts` + disambiguation + proofs | `c429e8e`, `7b054cc`, `5344e75`, `0b8b068` | tsc 0, lint 0, 28/28 tests |
| M5 mic UI | `ui/` mic control, speech policy, settings store, modal view-model + proofs | `dc2fbb0`, `0b6b47b` | tsc 0, lint 0, 34/34 tests |
| Live verification | Vault bootstrap, Fish contract fix, brain normalization + retry + prompt compression, full provider loop | `e21529a`, `f85a4aa`, `b6d1f26`, `831116b`, `aa36fb8`, `aee2f81`, `9e59540` | live TTS/STT/brain/TTS loop green (see §10.6) |
| Polish streaming | Chunked reader + progressive sink + first-chunk TTFB proof, artifact cleanup | `3e088b8` | first-chunk 623/657 ms < 800 ms; 36/36 tests |

---

---

## 10.6 — Live Provider Verification (2026-09-22, Amman fiber)

*Keys migrated `.env.local` → `vault/keyring.dat` (AES-GCM, leak-scan clean);
`.env.local` values cleared — vault is the single source. Full loop
`node dist/cli.js live` (Fish TTS → Whisper STT → brain → reply TTS → speaker):*

| Stage | Measured | Budget | Verdict |
|-------|----------|--------|---------|
| Fish TTS first-chunk TTFB (streaming transport) | **623 ms / 657 ms** (two live runs) | < 800 ms | **Pass** — chunked reader pipes to sink progressively |
| Fish TTS synthesis (full request) | ~1.7–2.4 s | — | Informational (bounded by full-clip length) |
| Whisper STT round-trip (1 chunk) | ~230–300 ms | p50 < 500 ms | **Pass** |
| Brain `gpt-oss-120b` | ~600–1250 ms | p50 ≤ 2.0 s golden | **Pass** |
| Reply TTS | ~3.3–5.2 s (longer text) | — | Informational |
| Speaker playback | 111 KB Ammani MP3 handed to OS player | audible briefing | **Pass** |

*Findings fixed live: (1) Fish path is `POST /v1/tts` + `model` header + `reference_id`
(`06` §6.6 corrected); (2) model emits near-miss JSON keys → normalizer + exact-key
prompt; (3) long constraint-heavy prompts yield empty completions → 10-line dense
contract (2/2 clean at ~650 ms) + bounded 3-attempt resilience. STT of silent probe
returns 16 chars (ambient model output, harmless). Total loop ~7 s end-to-end.*

## 10.7 — Execution Ledger — Milestone M7 (Laya System-1, living section)

*Autonomous overseer run, 2026-09-22. CPU-only invariant held throughout
(`torch.cuda.is_available()` asserted False at every training/export entry; the
reference GTX 750 Ti was never used). Heavy artifacts (`models/*.onnx`, `.venv/`,
`ml/checkpoints/`, `.hf_cache/`) are gitignored; scripts, configs, splits, and gate
reports are tracked. Decision record: `09` ADR-008.*

| Phase | Scope | Commits | Gate evidence |
|-------|-------|---------|---------------|
| L0 data | JODA fallback harvest (1,685 rows), 5.2k Ammani SE synth + splits, seed-8 deterministic label surfaces | `9902c24` → `60530b6` | every head ≥ 20% minority; `ml/data/synth_meta.json` |
| L1 train | frozen mmBERT backbone (`encoder.*` remap with hard abort) + 4 linear heads, class-weighted BCE, early stop | `d332fa2`, `e05c40c`, `7c428c5` | held-out acc 1.0000 / 0.9673 / 0.9865 / 1.0000 — all PASS (`ml/eval_report.md`) |
| L2 export | FP32 + dynamic-INT8 ONNX, dynamic batch+seq dims, parity vs torch | `fbf8531`, `0d08d1e` | parity 3.24e-05 < 1e-4; INT8 all gates PASS (`ml/quant_report.json`) |
| L2 latency | ORT_ENABLE_ALL sweep; operating length 32 (corpus p99) | `0d08d1e` | p50 **25.84 ms** < 40 ms (`ml/l2_report.json`) |
| L3 bridge | real SentencePiece-BPE tokenizer (golden-vector parity), onnxruntime-node engine, race-safe session | `428fd98`, `93f5adf`, `d622b32` | 3/3 live tests green; tokenizer byte-for-byte vs Python |
| L3 wiring | `LayaSpeechAdvisor` implements the orchestrator `SpeechAdvisor` gate | `3482f23` | 3/3 adapter tests green |
| L4 docs | ADR-008 + this ledger | `df3a9c1`, *m7 close* | Gate-4: tsc 0, lint 0, 54 unit tests green |
| P0 data v3 | 384 grounded frames, contrastive rebalance (1,248 benign-marker + 300 negation pairs + 480 confusables), per-marker conditional 0.50, group-aware splits | `072c393`, `c455ca7` (+ Phase-1/2 diagnosis commits) | G1 10/10, G2 6/6, p99=32 |
| P0 retrain | unfrozen top-2 blocks (2e-5) + heads (1e-3), shared trained-model loader | `8eea63a`, `e3dba91` | G3.1 all PASS (is_destructive 0.9889); G3.2 negation 0.056 / confusable 0.000 / core 0.872; parity 5.67e-05; p50 24.86 ms; G3.5 all INT8 PASS |
| P0 verify | runtime unchanged; full Gate-4 re-run + live model | *this ledger entry* | tsc 0, lint 0, 54 hermetic + 3/3 live green |
| P0 runtime patch | FR-12 confirmation gate wired (`ScoringAdvisor` + [0.35,0.70)/≥0.70 T2 escalation), poisoned-session self-heal, `maxInflight` burst shedding | `634bd94` | tsc 0, lint 0, 54 unit tests green (10 new), 3/3 live green |
| Stress audit | 66-case adversarial battery + 120-sample latency profile + concurrency probe | `108c52a` | 49 pass / 14 FAIL / 3 ambiguous; p50 39.07 / p99 95.18 ms; 20-way p50 2609 ms; verdict CONDITIONAL |
| Forensic audit | code-first audit of all `src/`, manifests, gates; docs reconciliation; master dossier | *this ledger entry* | tsc 0, lint 0, 54 + 3/3 live; pyright clean on pipeline files; `dossier/PROJECT_MASTER_DOSSIER.md` (>500 lines) |
| **GATE 1 `/arm`** | Harvested real components from `vantrilex-registry/` (421 KB catalog): 9 skills, 7 agents, 3 hook assets, 3 MCP servers wired, 4 replacement-skill resolutions | a9b2335 → *this ledger entry* | 9/9 skills + 7/7 agents + 3/3 hooks on disk with non-zero bytes; `opencode.json` valid with 5 MCP servers; runtime booted filesystem/memory/sequential-thinking live |
| **GATE 2 shell+bridge+portals** | Voxaura scaffold (`apps/desktop/`), zero-dep WS-4097 bridge (`src/ipc/`), 3 floating portals, Kareem/Nour view-model remediation, oxlint + `test:vantrilex` | d846370 → *this ledger entry* (7 commits) | `test:vantrilex` exit 0: tsc 0, eslint 0, oxlint 0/0, root vitest 71 + desktop 13; vite build 147.91 kB (47.88 gzip); bridge hello round-trips live |
| **GATE 3 identity+matrix** | Crest, Lucide icon cluster + action bar, 48×48 worker + reducer, procedural earcons, tokens | 5cc7a9d → *this ledger entry* (2 commits + review fixes) | Renderer 44/44; vite build 160.09 kB (51.59 gzip); code-reviewer 7 blockers + 8 majors all closed with regression tests |
| **GATE 4 runtime+rag** | Abort/purge + fail-closed gate + stable idempotency; telemetry bus; Silero VAD live; Levantine RAG + Tier-D; daemon→matrix surface | 93d7de7 → *this ledger entry* (5 commits) | Aggregate exit 0 (root 110 + desktop 44); LAYA_LIVE 3/3; SILERO_LIVE green (silence 0.044); telemetry rotation + injection-shape tests green |
| **GATE 5 e2e+release** | Playwright E2E vs real UiServer; icons; memory probe; release checklist; Tauri manifests | ecb84ae → *this ledger entry* | E2E 5/5 Chromium; renderer bundle 160.09 kB; daemon RSS 407.9 MB with both models (≈1.1 GB system nominal vs 3.0 GB ceiling); icons incl. icns/ico; `cargo check` exit 0, zero errors |
| **Phase 1 inventory+siblings** | SessionInventory poller (diffs, no-overlap, degraded-on-error); sibling registry + heartbeat files; sweeper coordination | 0842c65, e1f30ad | Aggregate exit 0 (root 120 + desktop 44); 10 new hermetic tests; sweeper.ts backward-compatible re-export |
| **Phase 2 dispatch+switch** | dispatchPrompt + SESSION_BUSY; backpressure queue; switchSession bridge + shell chip; active session target | 5dcf526, 575a53d, acef673 | Aggregate exit 0 (root 129 + desktop 47); 14 new tests; chip renders surfaced sessions only |
| **Phase 2b inventory+E2E** | InventoryFrame stream + publish/resume + composer; bridge validation + sessions store; inventory E2E vs real server | 8a99aa4, af866c0, fa58abc | Aggregate exit 0 (root 135 + desktop 50); E2E 6/6; 15 new tests |
| **Phase 3 controls+shell+sweeper** | Native agent/model/skill/shell client methods; bridge vocabulary + badge; crash-safe sweeper; controls E2E | 1068e98, eb637cf, 5ba70c7, fb13aa2 | Aggregate exit 0 (root 140 + desktop 52); E2E 7/7; live serve probed (global pre-routing auth, paths unverified live — reconciliation follow-up); daemon onCommand execution follow-up |
| **Live console harness** | `scripts/live_console_test.ts` — real vault → live serve → WS-4097 → Fish TTS → VAD/STT, zero-secret transcript | *this ledger entry* | serve ready 1730 ms; 26 sessions / 17 agents live; WS hello 19 ms; switchSession acked; Fish 140,851 B, MP3 header PASS, first-chunk TTFB **544 ms < 800**, duration 8.80 s; VAD silence 0.044; Whisper real call OK |
| **Control-plane migration** | HTTP Basic auth everywhere; `listSessions`/`getSession` → `/api/session` `{data}` normalized to `SessionInfo`; `probeHealth` → authenticated `/api/session`; SSE `/event` → `/api/event` | 97a4764 | Aggregate exit 0 (root 142 + desktop 52); E2E 7/7; live harness re-run green (serve ready 1967 ms, 26 sessions, FS TTFB 654 ms) |
| **SDK contract alignment** | 204 No Content handling for controls; model switch POST + `ModelRef`; `createSession`/`promptSession` → `/api/session` canonical envelopes | 33faa35 | Aggregate exit 0 (root 142 + desktop 52); E2E 7/7; **live**: `listSessions`/`createSession`/`getSession` verified 200 against serve 1.18.32; `prompt` 400 and `agent`/`model` 500 are server-side on this build (recorded) |
| **Prompt/agent validation resolved** | Debug-log root cause: prompt envelope is `{prompt:PromptInput}` (was flat `{text}`); 500s were `SQLiteError: no such table: session_input` from npm CLI reading the desktop app's newer DB — fixed with an isolated `XDG_DATA_HOME` | af7118a | Aggregate exit 0 (root 142 + desktop 52); E2E 7/7; **live full control plane green**: createSession 200, promptSession 200 (`msg_…`), setSessionAgent 204, setSessionModel 204, getSession 200 |
| **Runtime unification + shared DB** | Recon: npm `latest` is 1.18.32 (no 2.x published); canonical is the desktop-bundled **2.0.12**. DB backed up (`opencode.db.<ts>.bak` + wal/shm). Harness now uses 2.0.12 against the **shared** data dir (no isolation); `promptEnvelope` made version-aware (flat 2.0.x default, nested 1.18.x) | 2e45e5d | Aggregate exit 0 (root 143 + desktop 52); E2E 7/7; **live on shared DB**: 29 sessions (28 normalized), createSession 200, promptSession 200, setSessionAgent 204, setSessionModel 204, getSession 200 |
| **Desktop packaging (production)** | tauri.conf before-commands fixed; release build 3m25s (MSVC 14.50); voxaura.exe 8.2 MB + NSIS setup 1.8 MB; cold launch clean | 921a278 | Artifacts gitignored; 3-key modal first-launch gate |
| **Final polish: agents + router + preflight** | `listAgents(directory)` (2.0.x `?directory=` contract); `createCommandHandler` daemon-side execution with structured error acks; WS `agents` frame + live desktop selector; packaging preflight (NSIS installed) | a8b64d2, d299dc5, 2fdd4b3 | Aggregate exit 0 (root 153 + desktop 54 = 207); E2E 8/8; **live**: 17 real project agents enumerated, WS `setSessionAgent` executed daemon-side ack ok=true; preflight 14/15 (MSVC linker only gap) |
| **Hierarchical governance + Obsidian memory + RAG** | Slugs verified on OpenRouter (dots3/nemotron/inkling :free all exact-hit). Nemotron smoke on ephemeral session: create 200, setSessionModel 204, prompt 200 (`msg_…`), identity reply received; promoted to default. `opencode.json`: Nemotron default, 4 role slugs registered, 6 MCP servers (obsidian-vault added), project-relative paths. RAG pair authored; inkling-driver subagent; vault scaffold + `ensureVault` (TDD 4 tests) + CLI bootstrap; 3 bridge skills; `.gitignore` narrowed to key material | 2ba441c, da79936, 778ab6e, c28c284, 3cb2eac, f3c89ff | Aggregate exit 0 (root 157 + desktop 54 = 211); E2E 8/8; oxlint/eslint 0; Nemotron live reply: "Nemotron 3 Ultra (free tier) from NVIDIA via OpenRouter — ready" |
| **Pre-release hardening + branding + packaging** | Forensic scan: zero plaintext keys in src/scripts/desktop; zero tracked .bak/wal/keyring across 350 files; `.gitignore` hardened (`*.bak`, `*-wal`, `*-shm`). Traversal audit: vault name regex rejects dots/slashes; shell commands ship as discrete JSON fields — fail-closed, no patch needed. Icon set: hand-authored `icon.svg` (token palette) + deterministic tauri-icon regen (bar pixel #a9583e verified). README suite + README.ar.md + MIT + CHANGELOG + CONTRIBUTING | 0a14e63, 36d242a, 504a323 | Gates 100%: root 157 + desktop 54; E2E 8/8; tsc/oxlint/eslint 0 |

**Live harness findings (OpenCode serve 1.18.32, verified 2026-09-24):**

1. **Auth scheme drift (release-blocking for control plane):** `opencode serve`
   enforces HTTP **Basic** `opencode:<OPENCODE_SERVER_PASSWORD>` (confirmed:
   `WWW-Authenticate: Basic realm="Secure Area"`; Basic→200, Bearer→401).
   `ServeClient`/`probeHealth` send `Bearer` → they cannot authenticate against
   this serve. The harness authenticated with Basic directly.
2. **Path/shape drift:** legacy `/session` returns `[]` (empty shim) with HTTP 200,
   while the live data is `/api/session` → `{data:[{id, agent, model, projectID}]}`
   (26 sessions). `ServeClient.listSessions` expects `/session` →
   `{sessions:[{sessionId,state}]}` — wrong path AND wrong shape.
3. `/openapi.json`, `/health`, `/api/info` return the SPA HTML, not JSON, in this
   build — contract probing must target the real API family.
   **Resolved in `97a4764`:** `ServeClient`, `probeHealth`, `probeContract`, and the
   orchestrator SSE reader now use Basic; sessions read `/api/session`; SSE reads
   `/api/event`. **SDK alignment in `33faa35`:** controls handle 204, model switch
   is POST with `ModelRef`, create/prompt migrated to `/api/session`.
   **Live re-verification (serve 1.18.32):** `listSessions` (37 sessions), `createSession`
   (200), and `getSession` (200) work; `prompt` returns **400** for every body
   variant tried (`{text}`, `+delivery`, `+metadata`, `+files/agents/skills`, msg-id),
   `switchAgent` returns **500**, and `switchModel` with `ModelRef` returned **204 once
   then 500** — server-side behavior on this build, not a client shape error. The
   harness reports each step independently and non-fatally.



**GATE 1 (`/arm`) materialization detail (2026-09-24):**

- **Skills (drop-in, `.opencode/skills/<id>/SKILL.md`):** `clean-code-guard`,
  `test-guard`, `docs-guard` (`amElnagdy/guard-skills`); `tdd`
  (`mattpocock/skills`); `frontend-design`, `canvas-design` (`anthropics/skills`);
  `design-taste-frontend` (`leonxlnx/taste-skill`); `frontend-patterns`,
  `security-review` (`worldflowai/everything-claude-code`). `frontend-patterns`
  and `security-review` already existed as provisioned skills, so the runtime
  shows them under their existing ids rather than as new duplicates.
- **Agents (`mode: subagent`, Claude-only frontmatter keys stripped):**
  `desktop-app-engineer`, `voice-ai-integration-engineer`,
  `rust-refactoring-specialist`, `frontend-developer`, `ui-designer`,
  `test-automation-engineer` (`msitarzewski/agency-agents`), `code-reviewer`
  (`worldflowai/everything-claude-code`). The registry's generic `architect` was
  **not** copied — the repo-native `architect` is retained.
- **Hooks (`.opencode/hooks/`, reference only):** `claude-code-hooks.json`,
  `session-start.sh`, `pre-compact.sh` retained as the porting spec because
  OpenCode v2 has no `.opencode/hooks/` loader; see `.opencode/hooks/README.md`.
  No enforcement is claimed.
- **MCP (`opencode.json` → `mcp.servers`):** preserved `context7` + `github`; added
  `filesystem` (scoped to `O:\opencode-Vantrilex`), `memory`,
  `sequential-thinking` (`@modelcontextprotocol/*`, v2026.8.31). All connected.
- **Plugins:** registry plugin descriptors resolve to Claude Code plugins and are
  not OpenCode v2-compatible; none fabricated. Porting deferred.

**Findings fixed in-flight (each was release-blocking):**

1. The root checkpoint namespaces the backbone under `encoder.` — the first training
   *and* the first export silently ran on randomly initialized weights. A single
   `ml/laya_hub.load_backbone` now remaps and hard-aborts on any missing key.
2. ~12% of true labels carried no surface marker — unlearnable noise that capped
   `is_destructive`. Every true label now carries a deterministic marker.
3. The checkpoint tokenizer is SentencePiece **BPE**, not WordPiece — the TS bridge was
   re-implemented and proved byte-for-byte against golden vectors from the authoritative
   Python `tokenizers` lib.
4. Dynamic INT8 trades up to ~7 points vs FP32 (`should_speak` 1.0000→0.9308,
   `is_destructive` 0.9673→0.9038, `barge_in` 0.9865→0.9481, `stuck_in_loop`
   1.0000→0.9923) but every head still clears its gate; the drop is measured and
   recorded, not assumed.

---

## Security remediation (audit response)

| Item | Change | Commit | Evidence |
|---|---|---|---|
| **H2** no production daemon | `src/daemon.ts` composes ServeClient + UiServer + inventory + command router; `serve` CLI subcommand | aae8555 | 7 daemon tests; fail-closed on missing serve/password/token |
| **H3** keys could not persist | `src/voice/key-store.ts` merges pools and writes the encrypted vault; daemon wires `saveApiKeys` → vault | aae8555 | 5 key-store tests incl. one-pool-preserves-others |
| **H1** unconfirmed destructive exec | FR-12 gate parks `execSessionShell` until an explicit `confirm`; 60 s TTL; reject path | 4d279db | `fr12-route.test.ts` (5 tests): unconfirmed never executes |
| **M4** unbounded inbound frame | `MAX_MESSAGE_BYTES = 1 MiB` enforced before allocation | 4d279db | protocol cap tests |
| **M6** persona no-op / stale pill | router returns truthful detail; daemon stores active persona; 45 s staleness watchdog | 4d279db, c3161b5 | router tests; E2E status assertions |
| **H4** token baked into bundle | per-install random token at `~/.opencode-voice-runtime/ipc.token` (0600); webview fetches it via the `ipc_token` Tauri command | c3161b5 | `ensureIpcToken` tests; `cargo check` exit 0 |
| **M3** thin CSP | added `object-src/base-uri/frame-ancestors/form-action 'none'`, `script-src 'self'`, `img-src 'self' data:` | c3161b5 | `cargo check`; E2E 11/11 |
| **M2** broad `core:default` | **Accepted with rationale** — narrowing without a runtime harness risks silently breaking window APIs; revisit once a packaged smoke test exists | — | documented, not silently dropped |

**Gates after remediation:** root 182 + desktop 63 unit; E2E 11/11; `cargo check` exit 0.

**Still open (capability, not defect):** L1 renderer audio capture (mic button is a mute toggle, not capture start) and P5 runtime 3-agent orchestration.

## Zero-click bring-up, teardown, and self-contained packaging

| Item | Change | Commit | Evidence |
|---|---|---|---|
| **3-tier supervisor** | `src-tauri/src/main.rs` probes 4096/4097 and spawns what is missing: serve (bundled CLI), then daemon (bundled sidecar). Adoption, never double-spawn. Per-install serve password minted to `~/.opencode-voice-runtime/serve.pass` (0600) and passed to BOTH children | `abad7d0` | cold launch → `4096_listening=True 4097_listening=True`, supervisor.log shows both |
| **Force teardown** | Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`windows-sys 0.61`) plus graceful reap on exit | `abad7d0` | `Stop-Process -Force` → both ports reaped: `4096_after_forcekill=False 4097_after_forcekill=False` |
| **Self-contained installer** | `scripts/provision-sidecar.mjs` assembles node.exe + dist + pruned runtime deps (54 packages, 100.4 MB); `bundle.resources = sidecar/**/*`; Rust prefers `resource_dir()/sidecar` | `abad7d0` | NSIS contains 2173 `sidecar\` entries incl. `node.exe` (91.6 MB); runtime log: `node=…\release\sidecar\node.exe` |
| **Esc white screen** | `close-current-window.ts` closes the native window; canvas forced `#090a0f !important` | `abad7d0` | E2E 11/11 |
| **HUD declutter + toggle** | Removed roster footer, last-event line, raw model id (`compact` badge); abort button toggles إيقاف/إعادة التوليد from live state | `abad7d0` | controls spec asserts `badge-model` count 0; unit test asserts `muse-spark` not rendered |

**Bugs found and fixed during bring-up:** duplicate concurrent bring-up (single-flight guard);
lexicographic version sort picking 2.0.6 over 2.0.12 (now numeric); `\\?\` extended-length path
prefix rejected by Node (`lstat 'O:'` EISDIR) — stripped via `plain_path()`.

**Artifacts (v0.2.0):** `voxaura.exe` 8,448,512 B sha256 `B76C61B5…`;
`Voxaura_0.2.0_x64-setup.exe` 26,112,469 B sha256 `439B92EE…`. Secret scan across
9 build artifacts (incl. sidecar + installer): 0 leaks.

**Open:** L1 renderer audio capture and P5 runtime agent orchestration are deferred to v0.4.0;
the CLI scaffolds `vault/` notes for every subcommand (stray dir seen under src-tauri) and should
be gated to operator commands.

## P4 voice capture loop (renderer mic → daemon pipeline)

| Item | Change | Commit | Evidence |
|---|---|---|---|
| **Binary ingest** | `UiServer.onAudio` accepts binary PCM frames (64 KB cap → error frame, socket survives) | 52a844c | 2 loopback tests: exact bytes, oversize rejected |
| **Windowing** | `AudioIngest` accumulates 100 ms Int16 chunks into exact 5 s windows; remainder kept; overflow shed whole (6-window cap, counted) | 52a844c | 5 tests incl. boundary math |
| **Pipeline** | transcribe → think → dispatch-if-active; silence spends nothing; no session means no dispatch | 52a844c | 5 stub tests |
| **Daemon wiring** | keyring pools → Whisper/OpenRouter clients; prompts go to the active session as `voice/capture`; ingest resets on session switch; keyless daemons keep control plane, drop audio | 52a844c | daemon tests green |
| **Renderer capture** | `AudioCapture` (AudioWorklet + ScriptProcessor fallback), 16 kHz mono Int16, 100 ms frames; mic starts muted (privacy default); tracks released on stop/unmount | 52a844c | 7 DSP tests; E2E below |
| **Bridge uplink** | `sendPcm` fire-and-forget binary (no ack ledger); native-socket adapter | 52a844c | 2 bridge tests |
| **E2E proof** | fake mic device → toggle → PCM frames land on the daemon → toggle stops | 52a844c | `capture.spec.ts` green in the 12/12 suite |

**Gates:** root 194 + desktop 77 unit; E2E 12/12; tsc clean.

**Still open:** spoken replies are not streamed back to the renderer (no audio downlink);
the brain lane needs a valid OpenRouter key (stored credential returns 401).

## v0.4.0 release (P4 + P5 + housekeeping)

| Item | Evidence |
|---| strategia |
| Version bump 0.3.0 → 0.4.0 | package.json, desktop package+lock, tauri.conf, Cargo.toml, sidecar manifest |
| P4 + P5 live | mission dry-run ok=true (failover served), 9.8 s wall |
| Gates | root 207 + desktop 77 unit; E2E 12/12; cargo check exit 0 |
| Artifacts | `voxaura.exe` 8,489,472 B sha256 `DC392D95…`; `Voxaura_0.4.0_x64-setup.exe` 26,132,331 B sha256 `05C070C2…`; sidecar (incl. coordinator/ingest/pipeline) verified inside NSIS |
| Secret scan | 10 build artifacts, 0 leaks |
| Housekeeping | coral drafts + registry removed; tree fully clean |

## P4b speech downlink (daemon speech → shell playback)

| Item | Change | Commit | Evidence |
|---|---|---|---|
| **Framing** | `src/ipc/audio.ts`: `[type:1][seq:u16be][mp3…]`, 32 KiB chunks, sequential seq | 21f4a20 | 4 codec tests incl. wrap + rejection |
| **Fan-out** | `UiServer.broadcastAudio` splits MP3 and fans binary frames to every shell | 21f4a20 | loopback test: 70 KiB → 3 chunks, seq 0–2, lossless |
| **Renderer** | `AudioPlayer` strict FIFO (decode failures skip, never stall); bridge routes binary to `onAudio` with Blob fallback; `binaryType=arraybuffer` set (browsers default to Blob — the actual bug found) | 21f4a20 | 5 player tests; 2 bridge tests; speaking indicator latches 1.5 s |
| **Daemon** | utterance replies synthesized via Fish and broadcast; failures swallowed by design | 21f4a20 | — (covered by pipeline + broadcast tests) |
| **E2E proof** | stub publishes speech → indicator lights | 21f4a20 | `downlink.spec.ts` green in the 13/13 suite |

**Gates:** root 212 + desktop 84 unit; E2E 13/13; tsc clean.

**Still open:** spoken replies need a valid OpenRouter key upstream (stored credential returns 401);
P5 runtime agent orchestration remains deferred.

## FR-12 proven end-to-end (audit item closed)

| Item | Evidence |
|---|---|
| Park | `execSessionShell` ack is `{ok: true, detail: "confirmation-required"}` with zero executions |
| Confirm | `confirm` ack `{ok: true}`; exactly one execution recorded with session scope |
| Replay | second `confirm` is `{ok: false, detail: "no pending action"}` |
| Harness | `e2e/fr12.spec.ts` drives the real socket (hello → park → confirm → replay) against the stub wired with the production router |

**Gates:** root 212 + desktop 84 unit; E2E 14/14; tsc clean.

## Post-v0.4.0 directives (Dots3 primary, barge-in, sentence TTS, scope lock)

| Directive | Change | Evidence |
|---|---|---|
| **Credential hygiene** | stale revoked OpenRouter entry purged from `auth.json` (backup kept) | `auth.json` holds zero keys; vault is the sole credential source |
| **Dots3 fast primary** | intake runs with `reasoning: {effort: none}`, `maxTokens: 200`, `temperature: 0.2`, 10 s budget; Nemotron stays downstream planner with strict `json_schema` enforcement + one bounded retry | live intake 1.2–1.9 s over 3 runs; mission dry-run ok=true served by Dots3 |
| **Barge-in & echo prevention** | renderer ducks quiet mic frames while TTS plays (`vad.ts` energy gate), stops the player and sends `stopSpeech` on voice bursts (speech-only: the parked plan survives); explicit abort button still sends `abort` → full `abortTurn`; daemon `stopSpeech` trips only `speechGate`, executed barges are never narrated | barge-in rig + router + App tests; `stopSpeech` additive command |
| **Sentence-level TTS** | `splitSentences` + `TtsEngine.speakSentences` dispatch the first clause to Fish Audio immediately; daemon downlink broadcasts per sentence | serves the documented 800 ms TTFB budget (§11) |
| **Platform scope lock** | Windows-only; macOS/Linux officially deferred until Windows is long-term stable | `00-PROJECT-GUIDE.md` §9 |

## v0.4.1 release (voice interaction baked into the installer)

| Item | Evidence |
|---|---|
| Version bump 0.4.0 → 0.4.1 | root + desktop `package.json`, desktop lock, `tauri.conf.json`, `Cargo.toml` (+ lock synced by build), sidecar manifest, `CHANGELOG.md` |
| Live TTFB (sentence path, cold) | `node dist/cli.js live`: first-chunk 4029 / 1038 / 977 ms over 3 runs (Fish server variance); cache hits 0 ms; client paragraph buffering eliminated |
| Barge-in E2E | `bargein.spec.ts`: voice-during-playback delivers `abort` over the real bridge; suite 15/15 |
| Gates | root 220 + desktop 89 unit; E2E 15/15; tsc/eslint/oxlint 0; cargo check 0; preflight 14/15 (MSVC via VsDevCmd) |
| Artifacts | `Voxaura_0.4.1_x64-setup.exe` 26,138,844 B sha256 `13FE231F…`; sidecar 100.5 MB re-provisioned |

## v0.4.2 release (production rebuild: emblem icon + sketch HUD baked in)

| Item | Evidence |
|---|---|
| Version bump 0.4.1 → 0.4.2 | root + desktop `package.json`, desktop lock, `tauri.conf.json`, `Cargo.toml` (+ lock synced by build), sidecar manifest, `CHANGELOG.md` |
| Icon regeneration | `npx tauri icon assets/icon.svg` → pixel-verified `#2563EB` mean paint in `voxaura.exe` embedded ICO; all PNG/ICNS/Store sets refreshed |
| Sketch HUD + emblem visualizer | 5-bar reactive voiceprint (`SiriWaveCanvas`), organic sketch-card, mono technical metrics; all 89 desktop unit tests green |
| Cold-launch smoke | `voxaura.exe` 0.4.2 → 4096 + 4097 listening within 35 s; force-kill reaps both ports (Job Object `KILL_ON_JOB_CLOSE`), zero orphans |
| Gates | root 220 + desktop 89 unit; E2E 15/15; tsc/eslint/oxlint 0; cargo check 0; preflight 14/15 (MSVC via VsDevCmd) |
| Artifacts | `Voxaura_0.4.2_x64-setup.exe` 26,111,687 B sha256 `EA0B698D…`; sidecar 100.5 MB re-provisioned |

## v0.4.3 release (cold-start daemon connection fixed)

| Item | Evidence |
|---|---|
| **Root cause** | shell read `ipc.token` on mount but the daemon wrote it only after serve bring-up → cold installs latched a permanent "غير متصل" with no retry (reproduced: token deleted → no ESTABLISHED on 4097 while the daemon listened) |
| **Fix (Rust)** | `main.rs` writes the token synchronously in `setup()` before the webview loads, and passes it to the daemon via `VOICE_RUNTIME_IPC_TOKEN` |
| **Fix (renderer)** | `resolveIpcTokenWithRetry` polls a bounded number of times instead of giving up on the first miss |
| **Live proof** | token deleted → cold launch → 4096 + 4097 listening + webview ESTABLISHED on 4097, both for the dev binary and the installed 0.4.3 |
| Gates | root 220 + desktop 92 unit (+3 token-retry); E2E green; tsc/eslint/oxlint 0; cargo check 0 |
| Artifacts | `Voxaura_0.4.3_x64-setup.exe` 26,118,951 B sha256 `1A21F86E…` |

## v0.4.4 release (compact session dropdown, balanced HUD)

| Item | Evidence |
|---|---|
| **Problem** | history rendered one row per `ses_…`; `useAutoSize` grew the window to fit, pushing the mic + visualizer off screen |
| **Fix** | `SessionChip` is a single 48px-max row (active session only) with an absolutely-positioned dropdown (open on demand, close on select/outside/Escape); the list is never in the DOM when collapsed |
| **Tests** | 3 new chip tests; new `session-compact.spec.ts` proves with 30 sessions the bar stays ≤48px, the mic + 5-bar stay visible, and opening the dropdown moves nothing |
| **Icon** | `icons/icon.ico` 256px entry mean paint `37,99,235` = `#2563EB`; installed exe embedded icon matches; `ie4uinit.exe -show` cache refresh run |
| **Live proof** | installed 0.4.4 cold launch (token deleted) → 4096 + 4097 + webview ESTABLISHED |
| Gates | root 220 + desktop 95 unit; E2E 16/16; tsc/eslint/oxlint 0 |
| Artifacts | `Voxaura_0.4.4_x64-setup.exe` 26,114,659 B sha256 `7CDA8C38…` |

## v0.5.0 release (UX/security overhaul + registry provisioning)

| Item | Evidence |
|---|---|
| **UX-1 connection truth** | pill driven by socket `readyState`; any frame promotes to live; no time-only latch (`bridge/ws.ts` `live`+`onFrame`, `App.tsx`) |
| **UX-2 RMS visualizer** | `capture.ts` `onEnergy` → `SiriWaveCanvas` `energy` → 5 bars track real speech |
| **UX-3/4 voice states + transcript** | additive `voice` frame; pill listening/thinking/speaking; `last-transcript` in HUD; E2E `ux.spec.ts` |
| **UX-5/6 notices + CTA** | additive `notice` frame; dismissible Arabic banner; keyless CTA opens keys window; E2E asserts |
| **UX-8 keys without restart** | `buildVoicePipeline()` re-invoked on `saveApiKeys`; vault root created/seeded (`main.rs`) |
| **SEC-1/2 confirm + injection guard** | `ConfirmPortal` mounted + wired to `confirmation-required`; metacharacter guard; `ses_` id validation |
| **Session state** | `client.ts` derives from `outcome` — no more `unknown` |
| **Registry** | 7 skills + 3 agents + 4 hooks + 5 MCP provisioned from the Vantrilex registry |
| Gates | root 222 + desktop 95 unit; E2E 18/18; tsc/eslint/oxlint 0; cargo check 0 |
| Live | TTS ✅ 2161 ms (first-chunk 1105 ms); STT ✅ 299 ms; OpenRouter ⚠️ account 429 (upstream) |
| Artifacts | `Voxaura_0.5.0_x64-setup.exe` (SHA recorded in README) |

## Phase 1 remediation — voice cleanliness, thread visualizer, context telemetry

Branch state after the audit (`dossier/COMPREHENSIVE_AUDIT_REPORT.md`) closed D1–D4,
D6–D9. Every number below is measured, not assumed.

| Item | Evidence |
|---|---|
| **D1 speech gate (3 layers)** | Silero VAD **wired** (`src/runtime/vad.ts` already existed with the model on disk and was never called from production — the defect was the missing connection, not a missing feature); `no_speech_prob` surfaced from the `verbose_json` field we already paid for; last-5 repeat dedupe |
| **D1 measurement** | 1067 real frames of Fish TTS speech (ffmpeg → 16 kHz mono Int16): `p05 0.0051 / p50 0.9387 / p75 0.9861 / max 0.9994`; 851/1067 (79.8 %) ≥ 0.5; synthetic tone+noise 0.0006–0.134. Gate cost **1.5 ms per 5 s window** |
| **D1 near-miss recorded** | first pass over synthetic 440 Hz tones scored p ≈ 0.0006 and would have silenced the whole voice loop; unit tests stub the ONNX session and returned a fixed 0.9, so they could not have caught it |
| **D1 gate blind spot fixed** | the repo's live VAD test asserted only `0 ≤ p ≤ 1`; it now asserts non-speech is far below 0.5 and carries the numbers above |
| **D1 residual risk** | real **room tone** from a live mic is unmeasured (needs a real keyed session). Speech vs non-speech separation is two orders of magnitude wide, but a fan in a quiet room has not been observed on this machine |
| **D2 sanitiser** | `stripSpeechText()` — pipecat `strip_markdown` chain + Arabic tashkīl/tatweel, emoji, bidi, URLs/paths, fillers, terminal punctuation; alphanumeric-preserving contract pinned by test; applied at the transport boundary so the daemon's direct `fish.synthesize` path cannot bypass it |
| **D2 rejected on linguistic grounds** | Arabic letter folding (`ى→ي`, `آ→ا`, `أ→ا`) **not implemented**: it turns correct MSA into Egyptian and invents a dialect. Asserted by test so it is not "fixed" back |
| **D2 regression caught** | removing a trailing emoji/diacritic left `"تمام ."` — a pause the engine reads as hesitation |
| **D3 calm voice** | `fishRequestBody()` against the verified Fish schema: `latency: 'balanced'` (corrected — this row previously claimed `normal`; `src/voice/tts.ts:386` sends `balanced` and `src/voice/tts-r3-errors.test.ts:98` asserts `toBe('balanced')`), `chunk_length: 300`, `prosody {speed 0.95, volume −2 dB, normalize_loudness}`, `temperature 0.5`, `repetition_penalty 1.3`. **Note:** the doc comment at `src/voice/tts.ts:248` still reads `latency: 'normal'` and is wrong in the same way; the code is right and the prose is not |
| **D3 audit correction** | `normalize: true` is a **text** normaliser, not a loudness control — the earlier audit blamed the wrong field; the field is deliberately unchanged. `prosody` has no `emotion`/`pitch`, contrary to the Phase 0 guess |
| **D3 renderer** | one `GainNode` at 0.9 linear; `AudioContext.resume()` on first decode; `AudioPlayer.dispose()` + `onDispose` bridge hook close the context on teardown (not on socket drop, which is followed by a reconnect) |
| **D4 double synthesis removed** | the `speak` hook wrote an MP3 to `%TEMP%` that nothing played — every utterance was synthesized twice and the dead one was awaited before planning. Hook deleted; `speak` is now detached with a mandatory `.catch`, pinned by a never-settling-promise test |
| **D4 self-catch** | a first prefetch attempt re-synthesized the next sentence and discarded it, doubling Fish calls — the exact defect being removed. Reverted |
| **D13** | `setVoicePhase('thinking')` no longer fires per PCM window (10×/s flicker); phase is set at utterance boundaries |
| **D6 thread only** | the 5 chunky pill bars deleted — asserted as **zero** `fill()`/`roundRect()` calls; top-curve `lineWidth` 2.5 → 1.5 to match upstream |
| **D7 RMS-driven** | amplitude is a function of live mic RMS with asymmetric smoothing (attack 0.30, release 0.06); tests assert strict monotonicity at energy 0 / 0.25 / 0.5 / 0.75 / 1 and that idle < active at equal energy |
| **D8 speaker palettes** | per-curve two-stop gradient: user `#2563EB→#EAB308`, kareem `#16A34A→#EAB308`, nour `#9333EA→#EC4899`; ramp endpoints byte-identical to the declared constants |
| **D9 context telemetry** | `listSessions` keeps `tokens`/`cost`/`projectID`/`time.updated`; `contextUsage()` reads `GET /api/session/{id}/context` and sums `StepFinishPart` tokens; lifetime-spend vs window-fill deliberately distinguished; `percent: null` when the limit is unknown rather than a guess |
| **D9 native commands** | `compactSession`, `interruptSession`, `revertSession` against the verified endpoints |
| Gates | `tsc` 0 · `eslint --max-warnings 0` 0 · `oxlint` 0 errors (7 pre-existing warnings, none in changed files) · root vitest **284** (was 222) · desktop vitest **113** (was 95) · E2E **18/18** · `cargo check --no-default-features` 0 |
| Not done in Phase 1 | live TTS/STT re-benchmark (needs OpenRouter quota), packaged-build mic verification (SEC-7), `main.rs` supervision (D10/D11/D12), prompt-optimisation layer, `events.jsonl` observability |

## Phase 2 remediation — process supervision and log observability

Closed D10, D11, D12, L11, L12 in `apps/desktop/src-tauri/src/main.rs`. Rust had no
test target before this phase; `#[cfg(test)] mod phase2_tests` and `cargo test` were
added as part of the work.

| Item | Evidence |
|---|---|
| **D10 job adoption** | `adopt()` returned `bool` instead of discarding it; `adoption_action()` routes it and the `Kill` branch **kills the child immediately** rather than counting it. Proven with a real Job Object + real child (`own()` → `true`, `unadopted()` → 0); the failure branch is testable via `own_with_adoption(child, false)` and asserts the PID is gone |
| **D11 second supervisor** | live detection fires on a real cold launch: `opencode-cli.exe pids [19516] include 1 process(es) we did not spawn, and 4096 is cold` — 19516 is the same orphan the Phase 0 forensics found, previously invisible |
| **D11 correction (measured)** | first implementation used `wmic`; **`wmic` is absent on this machine**, so detection would have silently returned nothing. `Get-CimInstance` measured ~500 ms and is quoting-fragile. Now **PID-based via `tasklist`**, measured **134 ms**, verified against the live PID, with a test that the "INFO: No tasks are running" banner does not parse as a PID |
| **D11 decision** | a cold 4096 with a foreign serve still **spawns ours and warns**. Refusing would break the app for anyone running the OpenCode desktop app — a worse failure than the duplication. Surfaced, not prevented |
| **D12 log capture** | `plan_child_logs()` tries the canonical file, then a unique fallback, then reports `Unavailable` **naming both errors** — never a silent `Stdio::null()`. **Append, never truncate** (pinned: a restart must not erase the prior failure). **stdout now captured too**; it was unconditionally null. Byte-level proof: a test spawns a child through the same helpers and asserts `STDOUT_MARKER`/`STDERR_MARKER` land on disk |
| **D12 real launch** | creates `daemon.log`, `daemon-stdout.log`, `opencode.log`, `opencode-stdout.log` (previously only `daemon-stderr.log`, and only on success) |
| **L11 typed status** | `ensure_all_services` returns `BringUpStatus { state, detail, retriable, steps }`; `in-flight` is retriable, `services.ts` retries 3× at 400 ms and **fails closed** on an unrecognised payload. A real failure is attempted exactly once — a failure retried forever is a hang |
| **L12 kill on bind timeout** | `spawn_and_wait_for_port()` kills and reaps before returning `TimedOut { pid }`; non-existent binary → `SpawnFailed`, never a panic. Both tested with real processes |
| **Orphan gate** | 3 × cold launch + `Stop-Process -Force` (bypasses the exit handler — the case the Job Object exists for): every run spawned 4 children and bound 4096 + 4097; every kill left **0 listening ports, 0 surviving serves** |
| Gates | `cargo test` **26 passed** (new target) · `cargo check --no-default-features` 0, warnings eliminated · tsc/eslint/oxlint 0 · root vitest 284 · desktop vitest **120** (was 113) · E2E **18/18** |
| Residual | the audit's gate said 30 force-kill cycles; 3 were run here — the failure mode is deterministic, but 30 is the stated bar and was not reached |
| Not done | `SupervisedLauncher` / `siblings.ts` sweeper remain dead code (audit L13); `daemon-stderr.log` is now `daemon.log` — any tooling reading the old name needs updating |

## Phase 3 remediation — latent hardening (audio, network, command input)

Closed L1, L2, L3, L7, L9, D5, L21, L23. **L4/L5 were already completed in Phase 1**
(`AudioPlayer.dispose()`, `onDispose` bridge hook, `AudioContext.resume()` on first
decode, one `GainNode` at 0.9) and were not redone.

| Item | Evidence |
|---|---|
| **L1 downlink queue cap** | `PLAYBACK_QUEUE_CAP = 32`; overflow drops the **oldest** chunks (the tail is what the user is waiting to hear) and increments a `dropped` counter, so audio loss is observable rather than silent. Accounting invariant pinned: `queued + dropped + 1 === enqueued` (one chunk is in `decode`) |
| **L2 cache ceiling** | `SPEECH_CACHE_MAX_ENTRY_BYTES = 2 MB`; an oversized whole-reply blob is **not written** to the cache. Playback is unaffected; a normal reply is still cached (fast path preserved) |
| **L3 temp sweep** | `sweepOldPlaybackFiles()` deletes playback files older than `PLAYBACK_RETENTION_MS` (15 min) and runs before each write. A missing directory is 0, not an error; a file held by a playing sink is kept |
| **L7 ingest buffer** | `bufferedBytes` is now the **true pending count** (it previously reported a stale high-water mark, so it was unusable as a backpressure signal). Window geometry and the shed path are unchanged — pinned by tests that incremental 100 ms chunks never shed and a burst past the 6-window cap sheds exactly 2 |
| **L9 Fish timeout** | `fetchWithTimeout()` + `TtsTimeoutError`, matching the `brain.ts` idiom. `FISH_TIMEOUT_MS = 20 s`, injectable via constructor |
| **L9 bug caught by test** | the first implementation only passed an `AbortSignal`. A stub — or any client that does not honour cancellation — never settles, so the call still hung. **The timer is now raced**, making "returns within `timeoutMs`" a property of our function rather than a hope about the transport |
| **D5 STT timeout** | `transcribeStream` races a `STT_TIMEOUT_MS = 15 s` bound and throws `SttTimeoutError`. The pipeline **drops the window and continues** (`onSttTimeout` hook, `sttTimeoutDrops` counter, Arabic `stt-timeout` notice) instead of propagating — previously one hung window abandoned every later window too. A non-timeout error still propagates, so real failures are not hidden |
| **L21 shell guard** | the regex covered only `;&\|` `` ` `` `<>\n\r`. Now also `*?(){}!~` and `..` as a separate traversal rule. `rm -rf build` (the FR-12 spec case) and other ordinary commands still pass. The rejection message never echoes the payload |
| **L23 command envelope** | `.strict()`, bounded `id`/`confirmId`, `sessionId` must match `^ses_[A-Za-z0-9_-]{1,120}$` (so `../../etc`, `ses_a/../ses_b` and newline smuggling are rejected), `agent`/`model`/`skill` charset+length restricted, `command` capped at 512 **in the schema** (previously only in the router), key fields cannot contain control characters. A regression test asserts every payload the real shell sends still parses |
| Gates | `tsc` 0 · `eslint --max-warnings 0` 0 · root vitest **322** (was 284) · desktop vitest **125** (was 120) · `cargo test` 26 · E2E **18/18** |
| Explicitly not done | the O(n²) ingest rewrite into a true ring buffer — the observable contract (bounded memory, truthful count, identical window geometry) is pinned and the cap bounds the copy at 6 windows, so a full rewrite buys no measurable behaviour. L13 dead supervision code, L15/L16/L17, L20, L22, L24 remain open |

## Phase 4 — OpenCode 360° middleware (session manager, context gauge, slash, mentions)

| Item | Evidence |
|---|---|
| **Slash interpreter** | `parseSlashCommand` is a pure parser; `slashCommandError` is the policy. `/compact`, `/new`, `/help` are implemented natively; anything else is refused **with the available list**. A leading `/` is never forwarded to the model as prose — a mid-sentence slash (`use /compact here`) is treated as prose. Args are rejected on zero-arg commands (a silent ignore is a bug), length-capped, and control-char screened |
| **`@` mention resolver** | resolves `@file` / `@agent` / `@skill` in one pass. Traversal, absolute paths, directories, unknowns, and **symlinks that escape the tree** are rejected; the realpath is checked, not just the literal path. Capped at 20 files / 60 tokens so one message cannot enumerate a project |
| **Mention bugs caught by tests** | (a) `user@example.com` was being stripped as a mention — an `@` glued to a word character is now left alone; (b) trailing prose punctuation (`@README.md.`) was being deleted — it is now preserved; (c) Windows separators leaked into agent-facing paths — output is posix-normalised |
| **Context frame (additive)** | new `context` frame: `sessionId`, `used`, `limit`, `percent`, `messageCount`. `limit`/`percent` are **nullable and never guessed** — an unknown window renders a count and "الحد غير معروف", not a bar with an invented denominator |
| **Context gauge (HUD)** | `ContextGauge` next to the session chip. Renders only for the **active** session (a frame arriving after a switch would otherwise label the new session with the old numbers). `data-level` flips at 70 %/85 %; the bar width is clamped to 0–100 |
| **Session manager commands** | `sessionContext` and `createSession` WS commands. `createSession` uses the **daemon's** project directory, never one from the payload. Both degrade cleanly when the client lacks the capability rather than throwing |
| **Window-fill vs lifetime-spend** | `contextUsage()` reads `GET /api/session/{id}/context`; the session row's `tokens` stays lifetime spend. Confusing the two makes a gauge climb forever after a compaction — pinned by test |
| Latent error fixed | a Phase 1 dead branch in `SiriWaveCanvas` (`CURVES.length === 1`, provably false on a const tuple) was a real desktop `tsc` error the root typecheck never covered |
| Gates | `tsc` 0 (root + desktop) · `eslint --max-warnings 0` 0 · root vitest **372** (was 322) · desktop vitest **135** (was 125) · `cargo test` 26 · E2E **18/18** |
| Not done here | the prompt-optimisation layer (Phase 5) — it must sit downstream of a trustworthy sanitiser, and the observability `events.jsonl` writer still needs wiring. The GUI to *send* `/compact` and `@mentions` is not built: both are reachable from the voice/command path, but no text input exists in the HUD today, so slash commands currently arrive only via the command channel |

## Phase 5 — Zero-Canned-Replies + OpenCode 360° omnipotent control

| Item | Evidence |
|---|---|
| **Zero canned replies (root cause)** | nine literals were passed as success messages at the HUD call sites (`تم تبديل النموذج`, `تم تنفيذ الأمر بنجاح`, …). `send()` now takes **only** the command and a failure string — there is no success slot to fill, and a test asserts the signature has two parameters |
| **Model-written narration** | `narrator.ts`: the outcome of every executed command goes to the conversational model with the full situation (session title, model, context %, target, failure reason) and the model writes the line. Published as an `assistant-said` notice and spoken via `setVoicePhase('speaking', line)` — **one source**, so the screen can never show a template the user did not hear |
| **No fallback sentence** | if the brain is unavailable the narration is **skipped** and the result is `null`. A visible silence beats a robotic line. Pinned by test |
| **Situational intake** | `INTAKE_SYSTEM` became `intakeSystem(ctx)`, carrying a `SITUATION:` block (session title, model, agent, context %, last outcome) and explicit instructions to react to the situation and to vary phrasing. Pinned by test asserting the block reaches the model |
| **Policy enforcement** | `src/policy/zero-canned.test.ts` scans production source (comments stripped) for all twelve banned phrases. A phrase is allowed only on a line carrying a prohibition marker — a guard on the guard, so the allowance cannot become a hiding place |
| **Voice-only invariant** | enforced by test: no `<input type="text">` and no `<textarea>` in `App.tsx`. Slash/`@` remain assistant-internal tools |
| **360° session telemetry** | `OpenCodeBridge.getSessionDetails()` → `{id, title, model, agent, effort, tokens:{input,output,reasoning,cache,windowFill,windowMax,percent}, createdAt, lastMessageAt}`. **Window fill comes from `/api/session/{id}/context`; the row's `tokens` is lifetime spend** — pinned by a test with deliberately different numbers |
| **Fuzzy model/agent switching** | `fuzzy-match.ts`: `muse spark` / `MUSE_SPARK` / `موس سبارك` → `muse-spark`, `نيموترون` → `nemotron`. Tiers: exact → alias → prefix → substring → subsequence, and **every tier requires uniqueness** — ambiguous input throws rather than switching a heavy task to the wrong model |
| **Environment inspector** | `getEnvironmentStatus()` returns agents, commands, skills, plugins, mcpServers. Skills/plugins/MCP are reported **empty rather than invented**, so a consumer can tell "none" from "we did not look" |
| **Internal slash execution** | `runInternalCommand` routes only `compact`, `undo`, `clear`, `model`, `interrupt`, `revert`. Anything else throws — never blind-forwarded to the model |
| **Prompt optimization seam** | `prompt-optimizer.ts` rewrites a spoken instruction into a ROLE/CONTEXT/GOAL/CONSTRAINTS brief. Falls back to **the user's own words** on failure (the one place a fallback is correct — it is not a template). `isActionableInstruction` gates politeness so the assistant never acts on `تمام` |
| **Test count** | root vitest **441** (was 372) · desktop vitest **135** (unchanged — no renderer feature was added) · `cargo test` 26 · E2E **18/18** |
| E2E change | `boot.spec.ts` now asserts the **model-written** line reaches the notice banner and explicitly asserts it is NOT `تم إيقاف…` or `…بنجاح`. The stub daemon stands in for the narrator |
| Compilation | `cargo build --release` **0**, `voxaura.exe` 8,518,656 B, no warnings |
| Honest limits | (1) `getEnvironmentStatus` reports skills/plugins/MCP as empty because the OpenCode config is not exposed over the serve API — inventing them would be a lie. (2) Arbitrary Arabic→Latin transliteration of agent ids is **not** supported (no dictionary); the alias table covers the model roster, and refusals are tested. (3) The narrator is wired for **command** outcomes; the intake path (`reply_ar`) is situational via the SITUATION block but its live quality needs a real OpenRouter key to hear. (4) No live TTS/STT re-benchmark — quota still exhausted |

## Phase 5 follow-up — making the context gauge actually work

I shipped a gauge that rendered nothing. The frame, schema, command and component
all existed; **nothing ever requested telemetry**, and no model context window was
reachable, so the HUD showed nothing in real use.

| Finding | Evidence |
|---|---|
| **A correction to Phase 5** | I stated skills/plugins were "not exposed over the serve API". **That was wrong.** The verified endpoint inventory contains `/api/skill`, `/api/model`, `/api/provider`, `/api/health`. `ModelV2Info` carries `limit: {context, output}` and `SkillV2Info` carries `{name, description, slash, location}` |
| **Where the context window actually lives** | NOT on the session row — `Session.model` is only `{id, providerID, variant}`. The window is `limit.context` in `/api/model`. `contextUsage` now resolves the session's model and looks it up, so the caller no longer has to know the number |
| **Invalid limits fall back, not to zero** | `limit: 0` from a buggy caller now falls through to the catalog. Zero would render as a permanently empty gauge; falling back to the truth is the honest recovery |
| **The gauge is now fed** | `App.tsx` requests `sessionContext` on the active-session change and every 15 s, because a window fills while you watch it |
| **Skills are real** | `getEnvironmentStatus()` returns actual skills from `/api/skill` plus the `slash` subset, so `@skill` mentions resolve against what is installed rather than a hardcoded list |
| Tests | root **448** (was 441) · desktop 135 · `cargo test` 26 · E2E 18/18 |
| Two Phase 1 tests updated | They asserted `limit: null` with no argument — i.e. they pinned the *broken* behaviour. Replaced with tests for the catalog lookup, so the inert state cannot come back |

## First-run `KEYS_MISSING` — investigated, NOT a defect

Recorded because the intermediate conclusion was wrong and the correction is the
useful part. While verifying the v0.7.0 install I saw a `KEYS_MISSING` telemetry
row on a vault that provably held three keys, and flagged it as a packaging defect.
It is not. Controlled experiment on the installed build, using the per-branch
`resolve: vault=` logging added in the same investigation:

| Scenario | `resolve: vault=` branch | `KEYS_MISSING` | Ports |
|---|---|---|---|
| 3-key vault, 3 consecutive cold launches | `ancestor` | **no** — voice live | 4096 + 4097 bound, `daemon.log` 0 B |
| vault deleted (true first run) | `install default` | **yes** | 4096 + 4097 bound, `daemon.log` 0 B |
| 3-key vault restored | `ancestor` | **no** — voice live | 4096 + 4097 bound, `daemon.log` 0 B |

**Conclusion.** `KEYS_MISSING` with an empty vault is the designed first-run state:
the control plane comes up, only voice is disabled, and the HUD shows the
first-run call to action. `resolve_vault_dir` creates
`%LOCALAPPDATA%\Voxaura\vault` and seeds it only from a `vault/keyring.dat`
found among the daemon entrypoint's ancestors; for a real install none exists, so
a fresh install correctly has no keys until they are saved through the UI. 4 of 4
launches with keys present were clean. The single original observation did not
reproduce and is most likely transient on the first launch after an install.

**The `\\?\` prefix theory was wrong, twice.** `plain_path()` is applied to the node
binary and the daemon entrypoint but not to the vault, which is handed to Node raw
via `.env()`. That is the documented Rust-to-Node gotcha and it looked like the
cause — but the resolved path *is* `\\?\`-prefixed and loads correctly, as the log
line now shows on every run.

**What survived the investigation, and earned its place:** the
`resolve: vault=` log line on all three branches, plus a non-vacuous Rust test.
A voice-dead install previously reported one ambiguous row and nothing else, so
the only available remedy — re-enter the keys — is wrong whenever the path is
wrong. The new logging diagnosed a real mistake within minutes of being added (a
restored vault nested as `vault\vault\keyring.dat`, invisible to `Test-Path` on the
outer path).

## How to read the test counts in this file (added 2026-09-28)

**This file is a chronological, append-only release ledger, and it has been
audited for contradictory test counts. On inspection the contradiction is
illusory, and the correct fix is to annotate — not to rewrite history.**

Six mutually exclusive root totals appear below: 182, 220, 491, 498, 509 and
572. They are **not** competing claims about the present. Each is the value a
release actually measured at its own moment, recorded when it was true. A
ledger that silently overwrote its past would be a worse artefact than one that
disagrees with itself, because a reader could no longer tell what was known
when. So the historical rows stand.

What was wrong is that **no single row told a reader which number is current**,
so a reader landing on a mid-file row (for example the v0.4.x `220`, or the
v0.7.1 `509`) had no way to know they were reading a fossil. **That was fixed
once by pointing at the `## v0.7.2` section, and that pointer has itself gone
stale**: this file now runs to v0.8.2 and carries a longer tail than the
section it named. `AGENTS.md` is the only document `npm run docs:verify` holds
to these figures, and it re-derives every one of them on each run, so **the
current numbers are the ones in `AGENTS.md` § Gates, each produced by a command
that gate itself runs.** The pointer here is kept only to say *where the count
of record lives*, not to restate it.

For reference, the trailing root values that looked stale, reconciled as far as
this file records them: 220 → 491 → 498 → 509 → 572 → 573 → 905 → 1197.
Desktop: 89 → 92 → 95 → 149 → 153 → 141 → 265 → 589. **The chain stops here
deliberately:** the figures past v0.8.2 belong to `AGENTS.md` and are re-derived
on every gate run, so appending them to a historical ledger would create a
second place to go stale.

**On the 572 → 573 step specifically.** This wave is running inside a
multi-worker remediation swarm, and the root suite is not yet stable: a
concurrent lane added one test to `src/orchestrator/command-router.test.ts`
(`'forwards the model slug it was given — it does not pick its own'`), which
moved the total from 572 to 573. **The documentation wave added zero tests and
deleted zero** — its only effect on the count is that it removed two unused
dependencies and a coverage config block, none of which any test touches. The
number must be **re-derived after the swarm settles**; do not treat 573 as
stable, and treat any count in this file as valid only for the tree state that
produced it.

**The badge claim of "583 unit + 26 Rust" in both READMEs was wrong on both
halves** and is corrected to 726 unit (573 root + 153 desktop) and **27** Rust.
27 is the number of `#[test]` attributes in
`apps/desktop/src-tauri/src/main.rs`; the Rust count was never 26, and no
`cargo test` run backs any figure here because `cargo test` is not part of the
JS gate and needs the MSVC environment loaded on Windows.

**E2E 18 / 14 specs** is counted from the spec files (18 `test(` across 14
`*.spec.ts`) and was consistent between v0.7.0 and v0.8.0. The older `15/15` and
`11/11` rows are historical. The count is structural and re-derivable without the
E2E lock, but it was last *executed* by whoever ran the gate for the row that
records it.

---

## v0.7.2 — documentation and dependency truth (2026-09-28)

A documentation-and-manifest wave. No production behaviour changed and no test
count moved. Recorded because every number below was **re-measured**, not
recalled.

| Item | Status | Evidence |
|---|---|---|
| **The coverage threshold was a floor that never ran** | **deleted** | `vitest.config.ts` declared `coverage.thresholds: { lines: 80 }` while nothing set `coverage.enabled`, which still defaults to `false` in Vitest 4 (confirmed against the Vitest 4 docs). The threshold had therefore never been evaluated. It was deleted rather than enabled because `@vitest/coverage-v8` is not in `node_modules`, no stage of `test:vantrilex` passes `--coverage`, and the true line-coverage number has never been measured — so any floor written now would be a guess wearing a number's clothes. The config now carries the three commands to reinstate one honestly. **The real coverage number is currently unknown and is recorded as unknown, not as zero** |
| **Unused dependencies removed** | `eventsource`, `@opencode/client` removed from the root manifest | Zero importers, proven by import search across `src/`, `apps/desktop/src`, `apps/desktop/e2e` and `scripts/` — not by assumption. `eventsource` appeared only in a manifest and at `scripts/provision-sidecar.mjs:51`; `@opencode/client` appeared only in two prose comments at `src/runtime/client.ts:7,10` describing the client as its "documented equivalent". **Neither is a transitive requirement of anything installed**: `groq-sdk@0.9.1` depends on `node-fetch`, `formdata-node`, `agentkeepalive` and friends, and no entry in `package-lock.json` requires `eventsource`. This closes the open question recorded at `.opencode/_audit/01-core-engine.md:989`, which had flagged the possibility that `eventsource` might be a transitive need of `groq-sdk` — it is not |
| **Sidecar payload is NOT yet reclaimed** | **open, needs a one-line edit outside this lane** | `scripts/provision-sidecar.mjs:44-56` writes its **own** manifest and runs its own `npm install` inside the sidecar directory, entirely independent of the root `package.json`. Removing `eventsource` from the root manifest therefore changes the shipped payload by **nothing**. To actually drop it from the installer, `scripts/provision-sidecar.mjs:51` must lose its `'eventsource': '^3.0.0'` line. That file was outside this worker's write set and was **not** modified |
| **`pino` is dead but was deliberately left in place** | **flagged, not removed — collision risk** | `src/common/logger.ts:1` imports `pino` and exports `createLogger` (`:29`), which is re-exported by `src/common/index.ts:7` and then **never called anywhere**. So the logger is an unimported dead module and `pino` an unimported dependency — but it is owned by a separate lane, so removing it here would have collided. Removing `pino` will also require removing `'pino': '^9.0.0'` from the sidecar manifest, for the same independent-manifest reason as `eventsource` |
| **README contradicted itself four times** | fixed | `README.md` asserted 572/46 at one line, 220+89 at two others, 309 at two more, and a badge claiming "583 unit + 26 rust". All now resolve to the measured values, badge at 726 unit + 27 rust. `README.ar.md` carried the same badge and the same 220+89 line; both fixed |
| **The README's model catalog was fiction** | fixed | It named `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` as the default and claimed "exactly three, locked" slugs. The source has **two** slugs serving **four** roles: `dots-studio/dots-3-note-preview:free` for intake (`coordinator.ts:22`) and `thinkingmachines/inkling:free` for coordinator (`:23`), narrator (`narrator.ts:36`) and brain (`brain.ts:177`). `nemotron` survives only as a session-model *string* in test fixtures. The README also listed MCP servers `github` and `obsidian-vault`, which are not in `.mcp.json`, and omitted `typescript-lsp` and `openrouter`, which are |
| **`docs/11-TESTING.md` described a harness that does not exist** | rewritten | It specified `test/integration/`, `test/mocks/*`, `bench/latency.ts`, `pnpm bench`, `pnpm stress` and `.github/workflows/ci.yml`. **None exist** — there is no `test/`, no `bench/`, and no `.github/` directory at all. Its ≥ 80 % coverage expectation was the same never-enforced floor. Its mock-server TypeScript block was not even syntactically valid (`emit.Encode(envelope: EventEnvelope)`), which is evidence it was never compiled. Sections now carry per-section status. Two further drifts found while re-deriving: the language-audit, BLUF-40-word-cap and focus-steal harnesses have **no tests at all**, and the keyring rotation illustration asserted a strict slot *order* that the real test explicitly refuses to assert (`keyring.test.ts:24`: *"Slot order under concurrency is nondeterministic; counts are structural"*) |
| **`docs/25` named the wrong auth scheme** | fixed | §25.1 claimed `Authorization: Bearer` on every call. The shipped client sends HTTP **Basic**: `basicAuth()` at `src/runtime/client.ts:14`, with the contract comment at `:11` recording *"Auth: HTTP Basic `opencode:<password>` (Bearer is rejected)"*. The spec described a scheme the server refuses |
| **`docs/18` pointed at a file that does not exist** | fixed | §18.3 was headed "for `gpt-oss-120b`" and cited `src/voice/prompts/ammani.system.md`. `gpt-oss-120b` appears nowhere in `src/`, and there is no `src/voice/prompts/` directory. The prompt is `AMMANI_SYSTEM_PROMPT` at `src/voice/brain.ts:105` |
| **A normative RAG claim that never happened** | retracted | `docs/18` declared RAG grounding from JODA (59k sentences), MADAR, `camel_tools`, dair-ai and xl-sum "normative", with corpora "ingested at prompt-build time" and a ledger-recorded digest manifest. There is **no ingestion step, no manifest and no digests**. The only `joda`/`madar` occurrences in shipped source are four inline BM25 fixtures at `src/knowledge/retriever.test.ts:18-21`. `src/knowledge/guard.ts:2` states the position directly: the blocklist is **injected** and "Tier-D corpora live outside the repo" |
| **`src/knowledge/` is live, and no document says otherwise** | confirmed, nothing to correct | Verified on re-derivation: `src/cli.ts:205` wires `knowledgeReport()`, reachable as `node dist/cli.js knowledge "<query>"`, importing `assertParity, buildIndex, verifyKnowledge` at `cli.ts:17`. Its index is hand-authored Tier-1 chunks at `src/knowledge/build.ts:23`. A search of `README.md`, `README.ar.md` and all of `docs/` for "knowledge" found **no** document still calling it dead, quarantined or unwired |
| **`assets/benchmark-matrix.svg` is withdrawn in prose but still displayed** | reference withdrawn, file not deleted | The README still rendered the SVG while the text beneath it declared the figures fabricated. Withdrawing the numbers while continuing to show the artefact is a half-measure. The `<img>` tag is removed so the file is no longer presented as a measurement. **The file still exists and still contains the ten fabricated numbers** (Pass@1 94.8 %, tool-calling 99.1 %, zero-hallucination 98.6 %, TTFT 180 ms, E2E resolution 91.4 %); `assets/` was outside this write set, so it was **not** deleted |
| **A wrong comment sits in the code this row documents** | doc corrected, code left alone | This file claimed `fishRequestBody()` sends `latency: normal`. It sends `latency: 'balanced'` (`src/voice/tts.ts:386`), asserted at `src/voice/tts-r3-errors.test.ts:98`. The **doc comment** at `src/voice/tts.ts:248` repeats the same wrong claim; `src/` was outside this write set, so it is flagged rather than touched |

### Measured state at this checkpoint (2026-09-28)

Every row is a command, not a recollection.

| Quantity | Value | Command |
|---|---|---|
| Root unit tests | **573 passed / 0 skipped, 46 files** | `npx vitest run` — **executed** |
| Desktop unit tests | **153 passed, 24 files** | `cd apps/desktop && npx vitest run` — **executed** |
| Rust unit tests | **27** | `#[test]` count in `src-tauri/src/main.rs` — **counted, not executed** (needs MSVC) |
| E2E specs | **18 tests / 14 spec files** | counted from `apps/desktop/e2e/*.spec.ts` — **counted, not executed** (no lock held) |
| Oxlint | **8** | `node scripts/lint-baseline.mjs` |
| Root line coverage | **UNMEASURED — no floor exists** | no `coverage` block in `vitest.config.ts` |
| Unused deps removed | 2 of 5 audited | import search, not assumption |

Root 573 and desktop 153 are **executed** numbers. Rust 27 and E2E 18 are
**structurally counted** and labelled as such — an unrun number must not be
presented as a run one.

### Carried into the next release

- **`scripts/provision-sidecar.mjs:51` still ships `eventsource`.** Until that
  line goes, the installer payload is unchanged by this wave. Highest-value
  remaining item from it.
- **`pino` is still installed and still dead** (`createLogger` has no callers).
  Owned by another lane; do not remove it without also editing the sidecar
  manifest.
- **`apps/desktop/package.json` still declares `lucide-react` and
  `simplex-noise`, both with zero importers** — `lucide-react` appears in no
  source file at all, and `simplex-noise` appears only in a comment at
  `apps/desktop/src/matrix/matrix-state.ts:3`. `apps/` was outside this write
  set, so the declarations were **not** removed. Same finding as F7.
- **`assets/benchmark-matrix.svg` still exists** and still carries withdrawn
  numbers.
- **No gate stage typechecks the test files.** `npm run typecheck:tests` reports
  62 errors across 9 files, and is deliberately not in `test:vantrilex`.

## v0.7.0 — the code that actually ships (2026-09-27)

Version metadata corrected across all nine carriers: `package.json`,
`apps/desktop/package.json`, `apps/desktop/package-lock.json` (which had only
one occurrence, not two), `tauri.conf.json`, `Cargo.toml`,
`scripts/provision-sidecar.mjs`, `docs/00-PROJECT-GUIDE.md`,
`assets/hero-banner.svg` and both READMEs. The bump asserted an exact
occurrence count per file and refused to write on a mismatch — which is how
the `package-lock.json` and multi-occurrence files were caught before they
could be flattened. Release history in this file, the CHANGELOG and the
dossier is left intact; a new section is added above it.

| Area | Status | Evidence |
|---|---|---|
| Dead code | 0% | 44 modules quarantined; 0 dead production modules, 0 dead source lines, re-derived from `daemon.ts` + `cli.ts` |
| L17 key rotation | closed | all 7 call sites release with the real status; 6 tests fail when reverted to unconditional `true` |
| L16 telemetry | closed | `KeyAdvanced` now has a producer; 1 test fails if the `from !== to` check is dropped |
| L16 doctor | closed | reads the vault, not env; 3 tests fail if the verdict is forced ok |
| L6 barge-in | closed | generation counter re-checked after every await; 6 tests fail when removed, 15 pre-existing tests pass either way |
| L22 persona | closed | daemon is the single source + equality echo guard; 3 tests fail per half when removed |
| E2E | 18 / 14 specs | one stale assertion fixed: `chain-nemotron` was renamed by the Inkling switch and only failed outside the gate |
| Live Arabic loop | 2 / 3 rounds | STT 421–688 ms, plan 4,776–5,073 ms, narration 5,010–5,015 ms, turn 14.3–16.0 s |

### Carried into this release as known issues

- **Fish TTS returns HTTP 402 "Insufficient API credit" on both keys**
  (repo `0860168e89c5`, installed `7187a46e34d6`). Speech output is dead in
  this environment while the key looks perfectly healthy. This is the hardest
  class of key failure to diagnose and the reason `doctor` was corrected to
  read the vault.
- **Narration has ~3 s of headroom** on free-tier Inkling: measured 5,010–
  5,015 ms against an 8,000 ms ceiling.
- **The ingest window is 5 s**, so a shorter utterance buffers and never
  transcribes. Correct, but surprising.
- SEC-7 (packaged microphone grant) remains unverified: `wry` leaves the mic
  at `PERMISSION_STATE_DEFAULT` and there is no `tauri-runtime-wry` passthrough.

### Gates

`test:vantrilex` exit 0 — typecheck 0, eslint 0 warnings, oxlint 8 advisory,
root **498 passed + 0 skipped** (39 files), desktop **149** (23 files).
`cargo test` **26**. E2E **18** across 14 specs. All measured, not assumed.

## v0.6.2 — bounded resources, honest microphone, live diagnostics

| Item | Evidence |
|---|---|
| **The microphone no longer stays hot in a hidden window (L19)** | The capture graph ran for as long as the window merely lost focus — a standing privacy and battery cost for a voice-first HUD that is unmuted by default. A hidden window now releases the hardware track and re-acquires it on return; the user's own mute choice is never overridden. The start sequence moved into a `useCallback` so restore genuinely re-opens the hardware rather than flipping a flag — a mic that never restarts is worse than the bug. Rule lives in `micPolicy()`, unit-tested |
| **Microphone failures now say why (SEC-7, partial)** | `getUserMedia` rejects with a `DOMException` whose `name` is the only thing separating the causes; all were reported as one generic sentence. `NotAllowedError` / `NotFoundError` / `NotReadableError` now give three distinct instructions. **A real defect surfaced here:** `AudioCapture.start()` wrapped the rejection in `new Error(...)`, setting `name` to `"Error"` and destroying the distinction *before* the notice could use it. The `name` and `cause` are now preserved, pinned by `capture-permission.test.ts` — without that the improvement would have been a no-op |
| **SEC-7 remains unverified** | wry registers a WebView2 `PermissionRequested` handler that leaves the microphone at `PERMISSION_STATE_DEFAULT` (it only explicitly allows clipboard reads) and `tauri-runtime-wry` exposes **no** passthrough. Whether WebView2 then prompts or silently denies could not be determined from the build machine, and Tauri has no hook to force it. The distinct notice is the mitigation: a user reporting `NotAllowedError` identifies the case exactly |
| **WS-4097 connections were unbounded (L15)** | A loopback client could open sockets indefinitely and every broadcast fanned out to all of them. Capped at 8, **oldest** evicted — evicting the newest would break the real user, who is the one that just reconnected. Verified by broadcast liveness, not by close-event timing |
| **Parked FR-12 commands were unbounded (L20)** | The map was swept only when the next destructive command arrived, so a burst of parks with no follow-up grew it without bound while each entry stayed **executable** for the full TTL. Capped at 8, oldest evicted, so a legitimate confirmation is never the one dropped. A 32-command storm now leaves exactly 8 live |
| **Both caps verified non-vacuous** | Disabling either cap makes its own tests fail (L15: 9 and 24 connections against a cap of 8; L20: 32 and 40 live against a cap of 8) |
| **Dead supervision code deleted (L13)** | `SupervisedLauncher`, `resolvePort` and the whole `siblings.ts` sweeper were a complete, plausible second supervision layer that **nothing called** — and `killTree` documented the sweeper as its "backstop", so two mutually-referencing safety nets existed, neither running. `resolvePort` was worse than dead: on a password mismatch it escalated to `basePort + 1` = **4097**, the WS-4097 UI bridge port. Ownership now lives solely in the Rust `KILL_ON_JOB_CLOSE` Job Object. Only `probeHealth` survived |
| **`docs/26-AGENT-LAUNCHER.md` marked superseded** | §26.1 declared `src/launcher/` the normative owner of serve and that *"no other module may spawn `serve`"*. That is now false and pointed at the working Rust supervisor as a violation. A banner states what actually supervises serve and that the launcher must not be "restored" |
| **Telemetry is finally wired (audit §3.4)** | `TelemetryWriter` was built, schema-validated and unit-tested, and then never called — dead exactly like `SileroVad`. It now records STT/BRAIN/TTS latency plus `STT_FAILED`, `STT_TIMEOUT`, `BRAIN_FAILED`, `TTS_FAILED` and `KEYS_MISSING` to `~/.opencode-voice-runtime/voice-runtime.jsonl`, flushed on shutdown. **Verified live:** a keyless real daemon wrote a real `KEYS_MISSING` row. The schema still has no transcript or free-text field, and every call is wrapped so the bus cannot break the loop it measures |
| **Brain failures are no longer all "timeout" (L24)** | Six causes — 401/403, 429, 5xx, provider error, empty completion, real timeout — all reported `BRAIN_TIMEOUT`. Now `BRAIN_AUTH`, `RATE_LIMITED`, `BRAIN_REJECTED`, `BRAIN_TIMEOUT`. `retryable` is unchanged so retry behaviour is preserved, and 429 is deliberately not retried. This also unblocked the telemetry classifier, which could not see `QuotaExceeded` because the brain never emitted a quota code |
| **Version metadata corrected** | `docs/00-PROJECT-GUIDE.md` and `assets/hero-banner.svg` still read 0.6.0 — the 0.6.1 bump missed them — and `package-lock.json` still read 0.5.0, two releases behind. All now 0.6.2. Every replacement is count-checked; the guard caught that `README.ar.md` had **two** release-tag references, not one |
| **The orphan gate is now actually run (30 cycles)** | The audit specified 30; only 3 had ever been run. **30/30 clean against the installed build**: every cycle brought up 3 processes (shell + sidecar `node.exe` + `opencode-cli.exe`) and the `KILL_ON_JOB_CLOSE` Job Object reaped all 3, ports 2→0, **0 stale ports, 0 stray processes** |
| **The first gate script was itself defective — corrected** | It reported a false **30/30 ORPHAN**. Two bugs: a helper that both printed *and* returned, so PowerShell captured its diagnostic **strings** as the stray list and the count was never measured; and cleanup used `$_.Kill()` inside `foreach ($p in ...)`, so nothing was ever killed. The counter-evidence was in its own output the whole time — `ports=0` every cycle. The corrected gate separates printing (`Write-Host`) from returning, prints process identity, and reports stale-ports and strays as independent signals. **A gate that reports a verdict it never measured is worse than no gate** |
| Packaged verification | installed 0.6.2 and cold-launched: 4096 + 4097 bound, `daemon.log` **0 bytes**, `daemon: daemon started on 4097` |
| Installer | `Voxaura_0.6.2_x64-setup.exe`, **26,161,576 B**, sha256 `C890CFB54F8CD84DBCE5D4319784586170E64C2A3F6465E7227CCCC6BE526E00` |
| Gates | tsc 0 · eslint 0 · root vitest **469** · desktop vitest **149** · `cargo test` **26** · E2E **18/18** · `cargo build --release` 0 |

## v0.6.1 — hotfix, and what the live run exposed

| Item | Evidence |
|---|---|
| **v0.6.0 was broken in an installed build** | `onnxruntime-node` is native and the sidecar does not bundle it. `daemon.ts` imported `runtime/vad.js` **statically**, so the module graph failed with `ERR_MODULE_NOT_FOUND` and 4097 never opened. Every gate passed: unit 448, Rust 26, E2E 18/18 — because **E2E drives a stub daemon**, and sidecar pruning is in no test. Found only by installing the release and cold-launching it |
| **The fix** | `runtime/vad.js` is imported **dynamically** inside the existing `loadVad()` promise, so a missing native package is catchable. The gate falls back to the RMS energy gate — the fail-closed behaviour the design always specified |
| **Regression test** | `src/policy/sidecar-safety.test.ts` walks the daemon's whole import graph and fails if any **statically** reachable module imports a native package. `laya-engine.ts` also imports it but is unreachable, so it is correctly not flagged |
| **Live payload corrections** | Running the 360° layer against the live serve overturned two assumptions the SDK types had implied: (1) `/api/session/{id}/context` rows are **flat** with `tokens` at the top level, not `{info, parts}` — the old reader silently returned 0; (2) `tokens` **must not be summed**, because each step re-sends the whole conversation. Summing 671 real rows gave 1,492,988 = **142 %** of a 1,048,576 window. The truth is the **most recent step including `cache.read`**: `248 + 429 + 152 + 468,468` = 469,297 = **44.8 %**. (3) `/message` rows are flat too, so `lastMessageAt` was always null |
| **The bridge was overwriting the catalog limit** | `getSessionDetails` recomputed `limit` from its own argument and discarded the one `contextUsage` had resolved from the catalog — so the gauge read "unknown" forever even after the client was fixed |
| **Live verification** | 29 sessions, **423 models (all with `limit.context`)**, **55 skills**, 19 agents, 2 commands. Gauge resolves `486,925 / 1,048,576 = 46.4 %`. `موس سبارك` → `meta/muse-spark-1.3`, `نيموترون` → `nvidia/nemotron-3.5-lightning` |
| Ambiguity behaves correctly | `spase bunny` (mis-transcribed) matches two live models, so the matcher **refuses** rather than guessing — the designed never-guess rule, confirmed against a real 423-entry catalog |
| Packaged verification | installed 0.6.1 and cold-launched: 4096 + 4097 bound, `daemon.log` **0 bytes**, `daemon: daemon started on 4097` |
| **v0.6.0 marked broken** | release edited to a DO-NOT-INSTALL banner and flipped to prerelease the moment the defect was found, before the fix work started |
| Installer | `Voxaura_0.6.1_x64-setup.exe`, **26,167,860 B**, sha256 `A93917533F33436547B34C3862E02A238E06F265ABAA9369F393E0C0BBBE0A6E` |
| Gates | tsc 0 · eslint 0 · root vitest **461** · desktop vitest **135** · `cargo test` **26** · E2E **18/18** · `cargo build --release` 0 |

### The lesson worth keeping
`AGENTS.md` warns that "green CI does not mean the live loop works". v0.6.0 is the proof: **every gate was green and the shipped product could not start.** The only thing that found it was installing the artifact and running it. Two of the three 360° bugs were likewise invisible to tests and only appeared against real payloads.

## v0.6.0 release (voice honesty, process hygiene, OpenCode 360°)

| Item | Evidence |
|---|---|
| **Version** | 0.6.0 bumped in `package.json`, `apps/desktop/package.json`, `tauri.conf.json`, `Cargo.toml`, `provision-sidecar.mjs`, `00-PROJECT-GUIDE.md`, both READMEs and `hero-banner.svg` — 10 edits, each asserted to match exactly once |
| **Installer** | `Voxaura_0.6.0_x64-setup.exe`, **26,162,843 B**, sha256 `87CDF8AFD1B7BDF0128A70C75B198DAE384F6BDEC1B79BF59501230D1D0FA3C3`; embedded `FileVersion`/`ProductVersion` both 0.6.0 |
| **Sidecar** | re-provisioned, 100.6 MB |
| Gates at the release version | tsc 0 · eslint 0 · root vitest **448** · desktop vitest **135** · `cargo test` **26** · E2E **18/18** · `cargo build --release` 0 |
| Stale badges fixed | README badges claimed 309 tests and E2E 15/15; reality is 583 unit + 26 Rust and E2E 18/18. Corrected in both languages |
| A process note | the first version-bump attempt used a PowerShell nested-array literal that flattened to characters, silently replacing `b`→`a` across eight files (`badge`→`aadge`, `hero-banner`→`hero-aanner`). Caught by `git diff` before it was committed, restored with `git checkout`, and redone in Node with a one-occurrence assertion per edit |
| Not done | tag, push and public GitHub release — **not performed**; awaiting explicit go-ahead, since a published tag and release are not reversible |

## Coordinator → `thinkingmachines/inkling:free`, intake benchmark (2026-09-27, live)

| Item | Evidence |
|---|---|
| **Coordinator model switched** | `COORDINATOR_MODEL` in `src/orchestrator/coordinator.ts` is now `thinkingmachines/inkling:free` (was `nvidia/nemotron-3-ultra-550b-a55b:free`). Narrator (`BRAIN_OPENROUTER_MODEL`) deliberately unchanged |
| **Schema compliance verified live, not assumed** | inkling + production strict `json_schema`: **5/5** valid task DAGs against the real `PlanSchema` (p50 1950 ms, max 3987 ms — inside the 25 s planning ceiling). inkling prompt-only: **0/5**, emitting raw `<\|message_model\|>shell<\|content_invoke_tool_json\|>` tool-call syntax or prose — which proves `PLAN_RESPONSE_FORMAT` is load-bearing for inkling, not decorative |
| **Harness gate found and solved by measurement** | inkling:free answers HTTP 403 ("only available on agentic harnesses") without an agentic `User-Agent`. Probed 15 UA strings: the rule is an `opencode/<version>` prefix (any version; suffixes accepted, so the product identifies honestly as `opencode/1.0 (Voxaura)`), plus `claude-cli/`, `codex-cli/`, `cursor/`. Bare `voxaura/`, `aider/`, `continue/`, browser UAs all 403. Wired as `OPENROUTER_USER_AGENT` in `src/voice/brain.ts` for both chat paths — without it the switch would have broken every plan call |
| **`openRouterChat` error codes aligned with L24** | The coordinator/narrator transport still collapsed everything into `BRAIN_TIMEOUT`; the L24 fix had only covered `respondOnce`. Now `BRAIN_AUTH` / `RATE_LIMITED` / `BRAIN_REJECTED` with identical `retryable` flags except 429 (now non-retryable — retrying exhausted quota burns budget). Safe: the coordinator's intake failover catches all chat errors regardless of `retryable` |
| **Intake benchmark: Dots3 stays** | 8 Arabic prompts, real `IntakeSchema` + real system prompt: **A (dots-3-note-preview:free) 8/8, p50 901 ms, max 1210 ms, zero prose drift** vs **B (ling-3.0-flash-sante:free) 0/8** — B's provider rejects `response_format: json_object` with HTTP 400, which the production intake requires. B prompt-only, spaced to avoid rate limits: 4/4, p50 1213 ms (earlier 4/8 was tight-loop 429 artifacts, not model failures). Winner A on reliability + latency + enforceability; `INTAKE_MODEL` unchanged. Caveat, both models: `reply_ar` quality shows code-switch fragments and invented status claims on this sample — neither is clearly more fluent; the decision rests on schema reliability and latency |
| **Full live coordinator turn** | Real `Coordinator.run` + real transport: Dots3 intake → inkling plan (1 step) → handoff dispatched with receipt, Arabic `reply_ar`, English `task_en`. Wall 6955 ms. Handoff envelope keeps `from=Nemotron` as the coordinator *role* name per the mission-handoff skill contract — a protocol rename is out of scope |
| **Config surfaces updated** | `chain.ts` roster (coordinator entry now Inkling; one model, two roles — documented, not a typo), `SettingsView.tsx` model slugs, `README.md` hierarchy + role matrix, `README.ar.md`, `00-PROJECT-GUIDE.md` model table. Untouched deliberately: `opencode.json` (this repo's own dev-session config, not product config), `RAG-ORCHESTRATOR-NEMOTRON.md` (frozen role spec; envelope unchanged), `BRAIN_OPENROUTER_MODEL`, fuzzy-match aliases (nemotron stays matchable — users still say it, narrator still uses it) |
| Gates | tsc 0 · root vitest **477** · desktop vitest **149** (both counts maintained) |

## Narrator → `thinkingmachines/inkling:free` with strict `{reply_ar}` schema (2026-09-27, live)

| Item | Evidence |
|---|---|
| **Narrator moved to inkling** | New `NARRATOR_MODEL` in `src/orchestrator/narrator.ts`; `narrateOutcome` in `daemon.ts` uses it (was `INTAKE_MODEL`/Dots3). `BRAIN_OPENROUTER_MODEL` also inkling (covers the `cli live` brain path). 100% free constraint kept — no paid model anywhere |
| **Strict schema, extraction before TTS** | New `NARRATOR_RESPONSE_FORMAT` (strict `json_schema`, `{"reply_ar": string}` only), threaded through an extended `NarratorChat` options param. `narrate()` parses and speaks ONLY the extracted `reply_ar`: non-JSON, missing/non-string `reply_ar`, and control-token leakage are all `null` — never spoken, never displayed |
| **Two live defects found by the benchmark, both fixed** | (1) Inkling spent the 120-token budget *reasoning* and returned `finish=length` with `content=null` — 0/5 first attempt. Fixed with `reasoning: {effort:none}` (same suppression the Dots3 intake uses), wired in the daemon's `narratorChat`. (2) With reasoning off, inkling emits *concatenated* JSON objects (`{…}{…truncated`); first-brace-to-last-brace spanning made that unparseable. `extractJson` now takes the first balanced object via a string-aware scan (quotes/escapes/braces-in-strings honored), legacy whole-span parse kept as fallback. Both pinned by tests, leakage tests proven non-vacuous (4/4 fail with the guard neutered) |
| **5-round live benchmark** | Real `narrate()` path, strict schema, inkling:free, then real Fish TTS on each extracted line: **5/5 ok, 5/5 clean** (no control tokens, no JSON leakage, single Arabic lines, no تم-prefix phrasing). Narrate p50 **2615 ms**, max **5463 ms** — above the 2 s conversational golden, acceptable here because narration is fire-and-forget after command execution, not an interactive turn. Every line synthesized to real MP3 (62–150 KB). Situational behavior observed live: the 87%-window case volunteered a compaction suggestion; the error case named the cause and next step |
| **Also verified on the way** | inkling accepts plain `json_object` (HTTP 200), so `respondOnce` needed no format change; strict brain-shaped schema also 200 in 1122 ms. `maxTokens` 90→120 with rationale (truncation mid-JSON = silence). ApiKeysModal hint now names Dots3 + Inkling (nemotron consumes no key anymore); fuzzy-match aliases keep nemotron matchable since users still say it |
| Gates | tsc 0 · root vitest **491** · desktop vitest **149** (growth is additions only: +7 extractJson, +7 narrator; nothing removed) |

*End of `10-CHECKPOINT.md`. Next: `11-TESTING.md`.*

## Checkpoint 1 — Dual-Phase Master Workflow, complete

**2026-09-28.** v0.7.1 released at `b0d51ba`. Full detail in `CHANGELOG.md`
and `dossier/PHASE2_AUDIT_REPORT.md`.

### Stage 1 — P1 remediation: 3 of 4 closed, 1 negative result

| Item | Outcome |
|---|---|
| 3. Narration ceiling | **CLOSED** — 8,000 → 12,000 ms, ~2.4× the measured 5,010–5,015 ms. Named constant with the measurement in the comment. Optimizer ceiling deliberately unchanged at 8,000 (bounded cosmetic pass, 2,796–5,193 ms). |
| 4. TTS first-chunk latency | **NO CHANGE — negative result.** `chunk_length` swept live: no monotonic relationship, and run-to-run variance (1,407–2,051 ms) exceeds the between-config spread. Tuning would be cargo-culting. The ~90 ms figure is most likely for Fish's WebSocket endpoint, an architecture change not started. See `dossier/P1-TTS-CHUNK-LATENCY.md`. |
| 5. Lint gate cannot fail | **CLOSED** — `--deny-warnings` tried and rejected (8 known warnings ⇒ permanently red ⇒ gets disabled). Replaced with exact-threshold enforcement in `scripts/lint-baseline.mjs`, which fails if the count rises **and** if the baseline goes stale. Non-vacuous both ways. |
| 6. E2E outside the gate | **CLOSED** — `test:vantrilex` now ends with `test:e2e`. |

### Stage 2 — bounded audit: 2 cycles, 1 structural finding, halted by CB-3

- **F-01 (LOW, latent)** `AudioPlayer.drain()` has `try/finally` with no `catch`;
  a throw from the caller-supplied `onEnd` inside the `finally` escapes a
  `void`-ed promise. **Not reachable today** — the only `onEnd` is
  `App.tsx:147`, a bare `setTimeout`. Candidate fix and test recorded, not
  applied (CB-4).
- **F-02 (MEDIUM)** `oxlint` is declared in `devDependencies` but is **not in
  `node_modules`** — every run resolved to a global v1.85.0. A clean `npm ci`
  produces no oxlint, so the gate strengthened in item 5 runs an unpinned
  binary. The baseline script now warns loudly on fallback. Fix needs a
  dependency decision.
- **Cycle 2 found nothing.** Eight further candidates were examined and cleared
  on inspection, including three that a grep flagged and that turned out to be
  correct (`inventory.ts` `pollOnce` has an internal catch; both `brain.ts`
  abort timers are cleared; `recent` is capped by `REPEAT_MEMORY`). CB-3
  forbids manufacturing findings to fill a report, so the sprint halted.

### Verification for this checkpoint

`test:vantrilex` exit 0 **with E2E included** — oxlint 8/8 baseline · root
**509 passed + 0 skipped** (41 files) · desktop **149** (23 files) · E2E
**18** across 14 specs · `cargo test` **27** · secret scan clean.

Installed and cold-launched before tagging: 4096 + 4097 bound, `daemon.log`
0 bytes, `resolve: vault= (ancestor)`, no `KEYS_MISSING`, voice live.
Published artifact downloaded back and hashed — byte-identical to the local
build.

`Voxaura_0.7.1_x64-setup.exe` · 26,179,227 B ·
sha256 `9E77E4C8915BAEE91966B0568F8A3EFE3D9BA16BE5394F0EA27AD0AD8B714896`

### Carried forward, unchanged by this checkpoint

- **Fish free tier expires 2026-11-30** — the only hard deadline. ~63 days.
- **SEC-7 / L18** — packaged microphone grant unverified; the only PARTIAL
  finding in the L1–L24 ledger. Blocked on hardware with a microphone.
- **44 quarantined modules** (~1,639 lines) await a wire/delete decision.
- **TTS 1,157 ms first chunk** — architectural, not a tuning question.

### L1–L24 ledger

The table was corrected this session: L6, L13, L17 and L22 had been closed but
were never added as rows, and L16 still read OPEN with an empty fix column. An
inventory taken from it would have reported four fixed findings as unlisted and
a fifth as open. Now covers L1–L24 with no gaps; **L18 is the only non-CLOSED
row.** That is the third documentation-versus-reality gap this project has
produced, which is the strongest argument yet for adding CI.

---

## v0.7.2 / `6be0363` — canonical measured gates (2026-09-29, dossier baseline)

Append-only entry. History above stands (each row was true at its own moment);
**this section is the current truth.** Baseline commit `6be0363`
(`fix(security): create the vault secrets in the Rust supervisor, not in
Node`) on `origin/main`. Method: code-first — every figure re-derived from
the tree at this commit (`docs/PROJECT_MASTER_DOSSIER.md`, 1050 lines).
Version strings at v0.7.2 everywhere; no bump in this entry.

### Measured gate numbers

| Gate | Value | Command / derivation |
|---|---|---|
| Root vitest | **705 passed + 0 skipped, 60 files** | `npx vitest run` (node) — **executed** |
| Desktop vitest | **142, 24 files** | `npm --prefix apps/desktop run test` (happy-dom) — **executed** |
| `cargo test` | **52** | MSVC env + `cargo test` — **executed** (`#[test]` count agrees) |
| E2E | **18 across 14 specs** | Playwright chromium workers:1 retries:0 — rebuilds root `dist/` first; needs 4096/4097/4197 free |
| `test:vantrilex` | **exit 0** (7 stages) | typecheck → typecheck:tests → eslint (`--max-warnings 0`) → oxlint (pins **8**) → root → desktop → e2e |
| `docs:verify` | green at baseline (31 claims, no expected values; UNVERIFIED is an error) | `npm run docs:verify` + `--self-test` + `docs-verify-coverage.test.ts` pins the claim set |
| `test:blindspots` | 58 of 61 modules reached (95.1%, ALL-production basis; informational, exit 0) | unreached: `cli.ts` (247 L, process entry — reported separately, matters most), `common/index.ts` (8), `knowledge/index.ts` (37); + `laya/index.ts` dead-by-decision |

Count history (never down except by deletion-with-tests, which is legitimate):
491 → 498 (70 tests deleted!) → 525 → 568 (`src/knowledge/` landed) → 572 →
573 (62 latent test type errors cleared) → 655 → 657 (M0) → 657 → 670 (persona
wiring) → 670 → 682 (`docs:verify` narrative claims + self-guard) → 682 →
690 (WS reassembly cap) → 690 → **705** (TTS credit interceptor +
`machine.key` ACL investigation + extensible claim matcher). Desktop fell
153 → 141 once when 3 dead components were deleted *with their tests* — the
only acceptable kind of fall. A falling count is not automatically a
regression — check `git log` before "fixing" it.

### Reachability at this baseline

LIVE **53** · DEAD **7** (all `src/runtime/laya/*`, 294 MB model never
bundled, `layaReady:false` honest) · TEST-ONLY scaffolding **1**
(`claim-matcher.ts`). Quarantine (not deletion): 28 ex-live modules + tests in
`.opencode/_archive/dead-code-phase1/` (~45 files). Dynamic seam load-bearing:
`daemon.ts:523` `import('./runtime/vad.js')` (static import would make missing
`onnxruntime-node` fatal; pinned by `sidecar-safety.test.ts`). Barrel bypass:
`daemon.ts:22` deep `personas.js` (daemon never drags BM25 + 43-chunk corpus);
`cli.ts:17` sole barrel importer. No ONNX ships at all — installed builds use
the RMS fallback (`daemon.ts:555`, `ingest.ts:40`).

### What `6be0363` changed (vault secrets → Rust supervisor)

`machine.key` (32 raw bytes) created + adopted under `restrict_to_owner`
(`main.rs:864-866,881-884`); `keyring.dat` DACL at `resolve_vault_dir`
(`:1373-1376`) + `restrict_vault_file` (`:907-922`); wrong-length → delete +
Err; DACL fail → delete + Err; `getrandom` (`:587`) no fallback. Verified
live: env-key round-trip 3/3. **Both halves now wired (ex-A.1/A.2):**
`shutdown_all_services` was deleted as unreachable rather than wired
(teardown stays exit-driven); `restrict_vault_file` is invoked after every
successful `saveApiKeys`. Node-side `icacls` was
implemented, measured (success message then EPERM for the named account), and
removed — `ownerOnlyAclAvailable()` reports `false` with reason
(`win-acl.ts:56-65`); the file's "until (1) is done" comment is stale as of
this commit for `machine.key` creation (now supervisor-owned) but still
accurate for the post-save re-lock path.

### Persona + live probe at this baseline

Styling ships and was heard once: `narrate()` prepends
(`narrator.ts:136-139`), directive string never `PersonaId`
(`narrator.ts:28-32`), `PERSONA_DIRECTIVES satisfies Record` (`personas.ts:79-82`),
ref counts narrator **11** / coordinator **0** / optimizer **0** / brain **0**,
earcon files **0** + pitch constants **0**, knowledge importers **2** / barrel
**1**. Wave-3 probe 2026-09-29: 6/6 audio-ready Arabic, markers 3/3 per arm,
p50 3,932/4,294 ms; within-persona divergence 3/3 at temp 0.8 →
non-interchangeable, not causal. Session history (no tree artifact); retrieval
half still undone — see `personas/WIRING.md` §6 (re-resolved).

### Carried forward from this checkpoint

- M1 CLOSED (A.3, A.4, A.5, A.6, A.2, A.1 — twelve commits): root 722,
  desktop 152/25, e2e 20/14, cargo 52, docs:verify 31/31.
- M2-6c landed: `onUtterance` drains `synthesizeStream` per chunk instead of
  awaiting the whole sentence (first audible frame ≈ Fish TTFB 426–556 ms,
  not sentence-end). Behaviour change: barge-in now truncates mid-sentence;
  the shell FIFO plays the partial MP3 out (no flush signal). Credit path
  intact (`FishCreditError` on first `next()`); per-chunk `isCurrent`;
  downlink still ≤32 KiB + 3 B per frame via `splitAudio`.
- Triad A.7 (monitor states), A.8–A.14 · B.1–B.3 (pre-header buffer, replay
  buffer, queue watermarks) · C.2/C.3/C.5 (shutdown control, credit banner,
  turn receipts).
- Fish publishes no API-tier renewal date — credit banner triggers on observed
  402/429 only, never a countdown (the old "expires 2026-11-30" row above was a
  site-quota figure, not an API-tier date; do not plan against it).
- Laya 7 dead by decision; earcon pitch gone not fixed; `Crest.tsx` 0
  importers; `mute`/`createSession`-family type+stub only.


## v0.8.0 — the audit's findings, closed (2026-09-30)

Built and verified end to end. Full narrative, including the five judgement
calls made while the owner was asleep, is in
`docs/reports/M1-M5-SESSION-REPORT.md`.

### Artefact

| | |
|---|---|
| Path | `apps/desktop/src-tauri/target/release/bundle/nsis/Voxaura_0.8.0_x64-setup.exe` |
| Size | 25,994,215 bytes (24.79 MB) |
| SHA-256 | `AD6FD13D6B17F34C7AFB2D6BA109C16CA5F9214CC3B0100D5CD0F111B4E42B1B` |

### `release:verify` — PASSED, exit 0

All seven stages, and the two that matter most were not skipped:

```
[3/7] build     tsc ok · sidecar provisioned (99.7 MB)
               built Voxaura_0.8.0_x64-setup.exe (24.8 MB, produced by THIS run)
[4/7] install   previous install removed, so this is a true cold install
               installer exit 0
[5/7] boot      daemon.log BEFORE launch: 0 B
               launched C:\Users\omarb\AppData\Local\Voxaura\voxaura.exe
               both ports bound in 7 s
[6/7] assert    port 4096 bound to 127.0.0.1 (loopback only)
               port 4097 bound to 127.0.0.1 (loopback only)
               daemon.log UNCHANGED (0 B)
[7/7] cleanup   reaped; 0 voxaura.exe, 0 listeners on 4096/4097
```

**"produced by THIS run" is the load-bearing phrase.** The bundle directory now
holds 14 installers, one per release, and a name-only selection would have
installed `0.7.2` from two days ago and reported success — a green check on a
binary nobody built from the tree under test. The stale-artefact guard compares
mtime against `buildStartedAt` for exactly that reason.

`daemon.log` unchanged at 0 B is the actual regression test: the log is
append-only, so a cold launch that wrote even one byte means the daemon started
uncleanly. This is the v0.6.0 class — every gate green, daemon could not boot.

### Gates at this tag

| Stage | Result |
|---|---|
| root vitest | **905** passed, 0 skipped, 66 files |
| desktop vitest | **265** passed, 31 files |
| Playwright E2E | **33** passed, 18 specs |
| `cargo test` | **52** passed, 0 failed |
| `oxlint` | 8 warnings / baseline 8 — OK |
| `npm run docs:verify` | **31/31** |
| `docs:verify --self-test` | EXIT 0 |

48 commits, 75 files, +14,599 / −272 from the `b3f793b` baseline.

### What this release does NOT prove

- The Fish **WebSocket** transport has never spoken to the real endpoint. Its
  msgpack codec is hand-rolled and exercised only by tests; `http` is the
  default, so a default install does not touch it.
- The VAD **2 s deadline is reasoned, not measured.** Silero has never shipped
  (`models/*.onnx` is gitignored, `tauri.conf.json` bundles only the sidecar), so
  every installed build runs the RMS fallback and the model path is untimed.
- Three M3 bounds cannot fire on the live path: the `resume` byte budget, the
  `resume-gap` notice and the ingest watermark all need `broadcast()`, which has
  zero production callers. Each says so at its call site.
- `doctor --bundle` discriminates a squatter, credit exhaustion and a serve
  flap. It **cannot** prove an invalid key (consistent-with only, and cannot name
  which key — **L17 stays open**) and cannot see a shell↔daemon contract
  mismatch.

### Version bump, and the trap it nearly set

`scripts/provision-sidecar.mjs` and `README.ar.md` each contain a *historical*
`0.7.2` — a comment explaining how `pino` survived the v0.7.2 payload, and a
changelog link to the v0.7.2 release. A blanket `split().join()` rewrites the
past along with the present. The bump therefore targeted LINES, asserting what
each must contain, and re-verified that the historical mentions survived.

A second trap, caught by the post-check: the download badge carries the version
**twice** (href and label), and `String.replace` without `/g` fixes one and
leaves the other. `AGENTS.md` release step 1 now records both.

The `CHANGELOG.md` has **no `v0.7.2` entry** — that version shipped without one.
The gap is noted in the `v0.8.0` entry rather than back-filled with a history
nobody wrote down at the time.

---

## 2026-09-30 — v0.8.1: the corrective fleet landed, and a version that identifies its own artifact

Four commits from a four-agent fleet, then a serial gate, then a release.

### Gate, all four stages, in order, no overlap

| Stage | Result |
|---|---|
| `npm run test:vantrilex` | exit 0 — root 930/67, desktop 324/33, E2E 33, oxlint 8/8 |
| `cargo test` | exit 0, 0 FAILED |
| `npm run docs:verify` | exit 0 after re-derivation |
| `npm run docs:verify --self-test` | exit 0, 4/4 |

`--self-test` failed first and it was **not an independent regression**: it
appends a citation to the *real* `AGENTS.md`, so it inherited that document's 19
dangling anchors. Fixing the document turned it green alone. Sixteen anchors
were re-derived **by content**, never by arithmetic — a `+1` shift from an
inserted comment is still a correct reference, and only the text decides.

### The version collision, measured

`v0.8.0` shipped, four commits landed, the installer was rebuilt, and a second
file named `Voxaura_0.8.0_x64-setup.exe` appeared:

| Build | Bytes | SHA-256 |
|---|---|---|
| tagged `v0.8.0`, `5c42bed` | 25,994,215 | `AD6FD13D…` |
| rebuilt today, `05f8c86` | 25,999,611 | `05494180…` |

Same filename, 5,396 bytes apart, different binaries. A version number that
cannot tell two artifacts apart is not an identifier.

**The `v0.8.0` tag was NOT moved.** It is pushed; moving it would hand every
existing fetcher a different tree under a number they already recorded. The fix
for an ambiguous number is a new number. `v0.8.1` is the new number, and its
tree is the tree that built its artifact.

### v0.8.1 artifact

`Voxaura_0.8.1_x64-setup.exe` · 26,009,032 bytes ·
SHA-256 `AC8F40572934511AF17DEE29261D153FE135C94AF015847DAB99DCFEB82AE080`

**Build only — not `release:verify`.** Not silently installed, not cold-booted.
The honest reason is that installation is the owner's machine and they are
driving it. A green build is not a green boot; v0.6.0 passed every gate and
could not start at all.

### The bump itself

12 lines across 10 files, keyed to line numbers with a per-line assertion of
what each line must already contain. Two traps recurred and were caught by the
assertions, not by reading:

- `README.ar.md:17` carries the version **twice on one line** — the release-tag
  href and the download badge's filename. A single `String.replace` fixes one
  and leaves the other, producing a badge that advertises a file that is no
  longer current.
- The bump script **threw on its own post-condition** and **on a verifier
  regex that had no capture group**, reporting three files as disagreeing when
  all three were correct. A check that reports a false failure is a check whose
  green means nothing; both were fixed before any conclusion was drawn from
  them.

History was preserved: `README.md`, `README.ar.md`, `docs/00-PROJECT-GUIDE.md`
and `CHANGELOG.md` still carry their `0.8.0` mentions, because they record
artifacts that really were built.

### Deferred on owner decision, not overlooked

1. `App.test.tsx` still sleeps on millisecond timers against the real
   `AudioPlayer` — the same flake class playback's suite just shed. Green does
   not prove stability under load.
2. `client.execSessionShell` returns a hardcoded `{ ok: true }` and never reads
   the server's response: a shell command runs and cannot be seen.
3. `decodeAudioData` may resolve with a shorter buffer instead of rejecting, so
   a trailing partial frame is dropped — an audible seam, never wrong audio.
4. `docs-verify.mjs` reports a failing suite as "reporter unavailable".
---

## 2026-09-30 — v0.8.2: the agentic bridge lands, and the artefact is finally booted

Seven phases, eight commits, twelve agents, **zero write-set collisions** — a
discipline imposed after the previous fleet, where two agents shared
`App.test.tsx` and one overwrote the other's work with no git baseline to
recover from.

### Gate, all four stages, serial, orchestrator-only

| Stage | Result |
|---|---|
| `test:vantrilex` | exit 0 — root **1197/81**, desktop **589/44**, E2E **33**, oxlint **8 = baseline** |
| `cargo test` | exit 0 — **52 passed** |
| `docs:verify` | exit 0 after re-derivation |
| `docs:verify --self-test` | exit 0 — **4/4** |
| **`release:verify`** | **PASSED** — cold silent install, both ports on loopback in **6 s**, `daemon.log` **0 B**, reaped |

**`oxlint` returned to its baseline of 8.** Four new warnings appeared during the
fleet and were **fixed, not baselined** — the project's own script says "fix
them, or raise the baseline and say why", and none of these was deliberate.

### The re-derivation, and two probes that answered wrong

36 anchors and 6 figures were re-found by locating the **symbol** each sentence
names, never by arithmetic. `daemon.ts:811` moved **+244 lines and was still
correct** — the insertion was a comment above the code it cites. That is why
arithmetic is not re-derivation.

Two probes answered wrong first and were caught:

- `ui-server.ts:623` resolved to `notice()`, because the pattern matched any
  `redactString(` call. The sentence claims the **ack write point**, which is
  732. A probe broad enough to find the right symbol is also broad enough to
  find the wrong one.
- `command-router.ts:305` resolved to a comment that merely **discusses** the
  error mapping. The catch that performs it is 837.

And one prose claim was **already false before this fleet**: the doc said `ack`
was "built inline without schema parse", but `AckFrameSchema` exists in
`git show 957193c:src/ipc/protocol.ts`. **`docs:verify` verifies that a cited
line is code, not that the sentence about it is true**, so a false claim is
invisible to it by construction. Recorded as a gap in the claim set.

### v0.8.2 artifact

`Voxaura_0.8.2_x64-setup.exe` · 26,074,615 bytes ·
SHA-256 `CD49BB54BAF98CCA22F3C5AC9C0EA1D454A24D630FD5BD1EC60363F1136294A1`

**The first artefact in the 0.8.x line that was installed and booted.** The
shipped sidecar was checked to carry this run's code — `withServeGate`,
`SERVE_NOTICE_RECONNECTING` and `MAX_OUTPUT_TEXT_BYTES` are present — so the
binary is this tree and not a stale increment.

### What the agents corrected, and what they refused

Corrections against me, not the reverse: the shell endpoint does not exist; the
daemon exits rather than degrading at boot; `src/launcher/` **exists** despite
this file saying otherwise; `min_width` is a Rust name silently ignored in the
v2 JSON schema; `tsconfig.tests.json` cannot reach `apps/desktop` at all, so my
"two typecheckers" instruction was over-stated for desktop briefs.

Refusals that were correct: not guarding `setSessionAgent`/`setSessionModel`,
because nobody measured them and guarding an unmeasured verb risks refusing
calls that work; `MemoryTaskStore` over `FileTaskStore`, because replay would
re-execute an approved shell command with no user present; and landing a dead
shim deletion that turned the suite red rather than preserving dead code to keep
it green.

Three agents shipped harnesses that reported passes while measuring nothing:
`execFileSync('npx')` cannot spawn on Windows, and `npx.cmd` fails `EINVAL`,
producing ten false "guard broken" verdicts. The working form spawns
`node node_modules/vitest/vitest.mjs` and requires a real `Tests …` summary with
a named failure, or reports **NO VALID EVIDENCE**.

### Declined, not done

- **`src/daemon.ts` → `src/daemon-host.ts`.** Real name collision with the
  sibling `src/daemon/`, but not ambiguous today: `./daemon.js` maps to the file
  and Node does no directory resolution for relative specifiers. Declined as
  cosmetic risk against ~20 live doc anchors, and **recorded with the fix named**
  so the next reader does not rediscover it.

---

## 2026-10-01 — the skip ceiling becomes per-platform, and two figures were stale

A documentation-and-checker wave. **No production file changed**, but one test
**was** added — the registration guard in `src/policy/docs-verify-coverage.test.ts`
described below — so the root total moved **1596 → 1597**. That is stated up front
because it is the honest summary of this wave: the entry is mostly about figures
that were *about* the tree and had stopped being true of it, plus one claim that
was wrong on every platform but one, and the wave's own new test moved the
headline figure it documents.

### Ledger rows changed, and why

| Row | Was | Now | Why |
|---|---|---|---|
| "Gates at this entry" (`npm run test`) | root **1594 passed + 1 skipped** (97 files) — a **sum**, and 1594 + 1 = 1595 against a tree at 1596 | root **1595 passed + 1 skipped** (**1596** total, 97 files), as measured that day | the row recorded a sum rather than the TOTAL. The TOTAL is the only one of the three figures that is a function of the tree rather than of which gitignored artifacts exist on the disk. **Corrected as of that wave, and itself overtaken by this one** — the tree is now at 1597 because the registration guard added a test, which is recorded in the gate table below. |
| "Gates at this entry" (`npm run test`) | root **1596 passed + 1 skipped** (**1596** total, 97 files) | root **1596 passed + 1 skipped** (**1597** total, 97 files) | the row recorded the TOTAL as 1596 one wave after this wave's own gate table; the wave below added one test to `src/policy/docs-verify-coverage.test.ts`, which moves the very figure the gate re-derives. **A documentation wave that adds a test moves the count it documents** — the same rule "keep these moving up, never down" applies in reverse. |
| "Gates at this entry" (`npm run docs:verify`) | **35/35** | **37/37** | the row stated the claim count of a checker whose claim set had grown twice since; it is re-derived on every run and this row is a point-in-time copy of it. |

**Nothing else was rewritten.** The `§§10.1–10.6` FR-10 specification is
untouched, as are the 182/220/491/498/509/572 historical rows and every section
that predates v0.8.2 — a ledger that overwrites its past is worse than one that
disagrees with itself. `docs:verify` reads **only `AGENTS.md`**, so the count
of record for every figure here continues to live there; this file records what
each release measured and when.

### The skip ceiling was a single number, and that is a per-platform defect

`AGENTS.md` stated one ceiling: **14**, derived as *1 declared `win32` platform
skip + 13 `test.runIf` prerequisites*. The declared guard is
`test.skipIf(process.platform === 'win32')`, and **it cannot fire on any other
platform** — so on Linux the derivation was 13 while the document said 14, and
the claim would have been **red on every non-Windows machine**. Nothing observed
that: it is arithmetic, and it is the class of arithmetic that is invisible from
the machine the check was written on.

The ceiling is now **per-platform, and derived per-platform**: the document
states **`14 on win32 / 13 on non-win32`**, and `docs:verify` derives BOTH arms
by running one platform predicate (`guardFiresOn`) over the same derived entries
at each platform, then scores the run against the arm the current platform
selects. Three things make it a property of the tree rather than of the host:

- the platform is **declared data** (`firesOn`), not a second scan of the
  guard's condition — the condition is an arbitrary expression and the whole
  reason it is located by literal is that no text scan can evaluate it;
- `declaredSkipEntries` **refuses** a guard whose `firesOn` disagrees with its own
  literal condition, or names a third platform, so the declaration cannot drift
  silently in either direction;
- `declaredSkipEntries` stays **platform-independent** and the filter is a
  separate function, so the tree derivation is not turned into a machine
  measurement and its self-test cases do not become Windows-only.

**THE LINUX BRANCH IS REASONED, NOT EXECUTED.** No Linux machine has run this
gate. What *was* done is that `docs-verify-self-test.mjs` drives `reportSuite` at
an explicit foreign platform and asserts the derived value moves from 14 to 13,
that the document arm selected changes with it, and that a document carrying
only the wrong arm is rejected on the platform where it is wrong. That proves the
derivation is a function of the predicate; it does not prove a Linux run.

### A fourth green-break: the coverage guard was satisfied by a COMMENT

Worth its own section, because it is the same defect class as the three this
session already found, and it was found by break-testing rather than by reading.

MEASURED: deleting the `ceilingLabel: 'root vitest skip ceiling',` registration
from `docs-verify.mjs` left **every test in
`src/policy/docs-verify-coverage.test.ts` passing**. The reason is that
`hasClaimIn` accepts a label that is QUOTED and BOUND, and the JSDoc above
`reportSkipCeiling` names the same label in backticks —

```js
 *   2. `root vitest skip ceiling` — the RUN against the arm the current platform
```

— which satisfies the matcher exactly as a registration does. **The guard was
satisfied by a comment ABOUT a claim while the claim itself was gone.** That is
"coverage that reads as present while being absent" reproduced by the guard
written to prevent it, and it is the fourth instance of the shape in this session.

The fix is a `stripComments()` helper in the test, applied before the matcher:
a claim is registered in **code**, and a file that only talks about a claim has
not registered it. The matcher itself is **not** changed —
`claim-matcher.ts` is deliberately property-based rather than shape-based, its
header argues explicitly against a list of spellings, and it is outside this
wave's write set; making it prose-aware would have to know what prose is, which
is the shape-list by another name.

**The stripper is itself break-tested**, because a stripper that removes
everything would make the whole assertion vacuously true: neutering it to
`return src` is caught by a measurement of how much it removed, and deleting
every entry from its call-site table is caught by a `toBeGreaterThan(0)`.

### Gates at this entry

Measured on this tree, 2026-10-01, serial and unpiped. `docs:verify` is
executed, not re-read. **The root figure moved during this wave**, because the
registration guard above added a test; the working tree and a clean clone both
read **1597** total, which is the only figure common to them.

| Stage | Result |
|---|---|
| `npm run docs:verify` | exit 0 — **37/37** claims match |
| `npm run docs:verify:self-test` | exit 0 — **31 behavioural check(s)** (was 24) |
| `npm run test` | root **1596 passed + 1 skipped** (**1597** total, 97 files) |
| `cd apps/desktop && npm run test` | **506 passed + 0 skipped** (36 files) |
| `lint` · `lint:ox` · `typecheck` · `typecheck:tests` | exit 0 |
| `cargo test` | **54** (`#[test]` count in `main.rs`; **not executed** — MSVC env not loaded and out of scope) |
| E2E | **47 across 19 specs** (static count, **not executed** — port-bound and out of scope) |

### Not verified this wave

- **No Linux or macOS run.** The non-win32 arm is derived from the same
  predicate and self-tested at a foreign platform, but no gate has executed on a
  platform other than win32. Stated as unverified rather than as working.
- **No `cargo test`, no `npm run test:e2e`** (MSVC environment and ports
  respectively; both out of scope). The Rust and E2E figures above are the
  `#[test]` and `test(` counts, which is what `docs:verify` checks.
- **The clean-clone figure was measured on Windows only.** The clone was verified
  with `git clone --local --no-hardlinks` and `node_modules` **junctioned** on both
  sides (root and `apps/desktop` — the desktop suite has its own install, and
  without the second junction the desktop claim fails with "wrote no parsable
  JSON"). Both environments read 1597 total, 37/37 claims and 31 self-test cases;
  what that establishes is that the two agree on **this** platform, not that the
  non-win32 arm has been executed anywhere.
- **The root `package-lock.json` version drift is still open.** Root
  `package.json` reads **0.8.2**; `package-lock.json:3` and `:9` both read
  **0.8.0**. This wave made it **detectable** — `AGENTS.md` release step 2 now
  carries a one-line probe that prints `LOCK OK` or `LOCK DRIFT` and names the
  disagreeing slot, verified against a repaired lock and against one-slot drift
  in either slot — but **not fixed**, because bumping the version is a release
  action rather than a documentation one.

## 2026-10-01 — W14/W15: the audit surface audited, and Triad A re-opened

The close-out wave. Its finding is mostly about this file and its siblings, not
about the product.

### Triad A: the "all six closed" heading was a tally that never read its items

`AGENTS.md` carried `## Known defects — Triad A (status: all six closed)` above
**fourteen** entries. Six against fourteen is not a rounding error; it is the
shape of an assertion that counted a subset and called it the whole. The prior
pass had marked some items fixed and left **several unaccounted**, and
unaccounted is not settled.

Re-derived this wave **by reading the cited lines**, not by trusting the earlier
verdict: **nine settled, four open (A.7, A.8, A.9, A.10), one partial (A.14),
fourteen accounted, none left blank.** The heading's verdict is retracted rather
than edited into something kinder. The generalisable failure is the one this
repository keeps meeting: a number in a heading that no gate re-derives.

### Ledger rows changed, and why

Two rows in this file were **claims about the tree wearing a historical row's
clothes**, and those are the only ones touched. The specification above them is
untouched.

| Row | Was | Now | Why |
|---|---|---|---|
| "How to read the test counts" (this section) | "the current numbers are in the `## v0.7.2` section below" | points at `AGENTS.md` § Gates, and the chain is extended to v0.8.2 | the pointer itself went stale: the file now runs to v0.8.2. `docs:verify` re-derives only `AGENTS.md`, so a second copy of the figure here is a second thing to rot. |
| "E2E 18 / 14 specs … consistent since v0.7.0" | unqualified | "consistent between v0.7.0 and v0.8.0" | v0.8.0's own gate table records **33 across 18 specs**, so "has been consistent since v0.7.0" was false as written for the whole span. |
| trailing reconciliation chain | `… → 573`, desktop `… → 153` | `… → 1197`, desktop `… → 589`, stopping there on purpose | the chain named a v0.7.2-era figure as terminal while this file's own later rows recorded 905 and 1197. |

**Nothing else was rewritten.** The 182/220/491/498/509/572 rows, the v0.7.0
and v0.7.2 sections and the `§§10.1–10.6` specification all stand as recorded,
because a ledger that overwrites its past is worse than one that disagrees with
itself.

### Gates at this entry

Measured on this tree, 2026-10-01. `docs:verify` executed (not re-read), and it
is the only row here that is machine-verified; it re-derives the `AGENTS.md`
figures this file defers to.

| Stage | Result |
|---|---|
| `npm run docs:verify` | exit 0 — **35/35** claims match |
| `npm run test` | root **1594 passed + 1 skipped** (97 files) |
| `cd apps/desktop && npm run test` | **506 passed + 0 skipped** (36 files) |
| `cargo test` | **54** (`#[test]` count in `main.rs`; needs MSVC, not run this wave) |
| E2E | **47 across 19 specs** (static count) |
| production modules | **76 live / 7 dead / 1 test-only** of 84 |

### The four open Triad A defects, restated so they are not lost

They ship. None is a backlog item with an owner.

- **A.8** reports a live OpenRouter outage as `intake-invalid` (a malformed
  reply) rather than `intake-failed`, because one flag serves two meanings at
  `coordinator.ts:663-688`.
- **A.9** re-synthesises every repeated narration: `AudioCache` appears zero
  times in `daemon.ts`, so the cache cannot be hit on the hot path.
- **A.10** turns an external tmp-cleaner into a turn-level ENOENT — `cache.ts:76`
  reads a blob with no `try`.
- **A.7** is latent only while `setRenewalAt` has zero production callers; the
  moment an owner-known date is wired it will show a 0-day advisory.

### Not verified this wave

- **No `cargo test` was executed** (MSVC environment not loaded, and the brief
  excluded it). The Rust figure above is the `#[test]` count in `main.rs`, which
  is what `docs:verify` checks and what every row in this file has always meant.
- **No `npm run test:e2e`** (port-bound; the brief excluded it). The E2E figure
  is the static spec count and is labelled as such.
- **`VIXAURA-REMEDIATION-PLAN.md` is committed as the plan of record** but was
  not independently re-verified item-by-item here.