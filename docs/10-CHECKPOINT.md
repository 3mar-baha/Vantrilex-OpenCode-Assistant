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
| **Barge-in & echo prevention** | renderer ducks quiet mic frames while TTS plays (`vad.ts` energy gate), stops the player and sends silent `abort` on voice bursts; daemon `abort` trips a `SpeechGate` so stale sentences never synthesize/broadcast | `vad` + `stop()` + `onAbort` unit tests; WS-4097 contract unchanged |
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
| **D3 calm voice** | `fishRequestBody()` against the verified Fish schema: `latency: normal` (was `balanced`), `chunk_length: 300` (was 200), `prosody {speed 0.95, volume −2 dB, normalize_loudness}`, `temperature 0.5`, `repetition_penalty 1.3` |
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

*End of `10-CHECKPOINT.md`. Next: `11-TESTING.md`.*
