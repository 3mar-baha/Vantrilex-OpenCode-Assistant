# 10 — Checkpoint: Deterministic Session Checkpointing, Reconstruction & Ledger Persistence

> **Canonical status:** Governance. State-survival truth. Implements FR-10 (see `01`).
> Types: `05` §5.2–§5.3 · Reconnect: `25` · Gate-5 updates: `16` §16.7.3.

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
| **Final polish: agents + router + preflight** | `listAgents(directory)` (2.0.x `?directory=` contract); `createCommandHandler` daemon-side execution with structured error acks; WS `agents` frame + live desktop selector; packaging preflight (NSIS installed) | a8b64d2, d299dc5, 2fdd4b3 | Aggregate exit 0 (root 153 + desktop 54 = 207); E2E 8/8; **live**: 17 real project agents enumerated, WS `setSessionAgent` executed daemon-side ack ok=true; preflight 14/15 (MSVC linker only gap) |
| **Hierarchical governance + Obsidian memory + RAG** | Slugs verified on OpenRouter (dots3/nemotron/inkling :free all exact-hit). Nemotron smoke on ephemeral session: create 200, setSessionModel 204, prompt 200 (`msg_…`), identity reply received; promoted to default. `opencode.json`: Nemotron default, 4 role slugs registered, 6 MCP servers (obsidian-vault added), project-relative paths. RAG pair authored; inkling-driver subagent; vault scaffold + `ensureVault` (TDD 4 tests) + CLI bootstrap; 3 bridge skills; `.gitignore` narrowed to key material | 2ba441c, da79936, 778ab6e, c28c284, 3cb2eac, f3c89ff | Aggregate exit 0 (root 157 + desktop 54 = 211); E2E 8/8; oxlint/eslint 0; Nemotron live reply: "Nemotron 3 Ultra (free tier) from NVIDIA via OpenRouter — ready" |

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

*End of `10-CHECKPOINT.md`. Next: `11-TESTING.md`.*
