# Voxaura — Master Implementation Roadmap

> Baseline: `b3f793b` (dossier `docs/PROJECT_MASTER_DOSSIER.md`, 1050 lines).
> Gates at baseline: `docs:verify` 31/31 · `test:vantrilex` EXIT 0 (root 705/60,
> desktop 142/24, e2e 18/14) · `cargo test` 52/52.
> This file is a PLAN, not a status report. Nothing below is implemented until
> its milestone closes through the FSM in §6. Figures marked HISTORY are session
> history, not re-derived claims. New code figures must never be phrased in a
> `docs:verify` claim shape inside `AGENTS.md` without deliberately adding the
> claim first.

---

## 0. Architecture transition (where we are → where we go)

```
TODAY (b3f793b)                          TARGET (M5 close)
─────────────────                        ─────────────────
turn = intake→plan→dispatch,             turn = intake-ack (<1s) + async
  synchronous, ~2-4.5 s voice            Task (owner FIFO) + safe-window
  silence while Inkling reasons          narration; plan never blocks voice
barge-in kills audio AND the             barge-in cancels speech only
  parked think (plan paid,               (stopSpeech); ACP turn survives;
  result discarded)                      epoch cancels the stale
credit 402/429 typed but                 credit faults neutral (no key burn),
  429 burns keys, 402 retries 3×         402 single-attempt, clock hoisted
unbounded: pre-header WS                 bounded: 2×MSG pre-header, capped
  buffer, replay-by-silence,             resume + resume-gap notice,
  queue depth, VAD loop                  watermarks + VAD race timeout
redaction by coincidence                 sink redaction for ack/voice/console
  on ack/voice/console
no renderer credit banner,               DACL receipt, credit banner, task
  no task receipts, no                   cards, calibration, dialect check
  calibration, generic notices
manual diagnosis (logs +                 doctor --bundle: one redacted JSON
  doctor + verify, hand-                 artifact → automatic root-cause
  assembled)
```

Non-goals for this roadmap: Laya wiring (stays dead by decision), RAG on the
narration path (corpus work, separate track), paid tiers (owner decision only),
cloud duplex models (structural mismatch — dossier §10.1 row 10).

---

## 1. Milestone 1 — High-Severity Invariants & Security Hardening (Triad A)

Ship order inside M1: **A.3 → A.4 → A.5 → A.6 → A.2 → A.1-last.**
(A.4 before A.6 so `httpStatusOf` churn and daemon churn land in separate
commits. A.1 last: Rust + docs only.)

### 1.1 Task breakdown

| Item | Files / symbols | Edit (exact) | Tests | Rollback |
|---|---|---|---|---|
| A.3 Fish 429 neutral | `src/voice/tts.ts:570-583` | `const credit = res.status===402\|\|429; release(key, credit, status)`; `if (credit) throw new FishCreditError`; do NOT touch `keyring.ts` (contract pinned by `keyring.test.ts:35`) | new/extended: 429 → rolloverLog empty + next acquire still K1 (break: revert arg → must fail); 401/403 still rotate; 402 unchanged; 500 plain Error | revert hunk → 429 burns a key (today) |
| A.4 OR 402 single-attempt | `common/errors.ts:12,55` + `brain.ts:229-237,326-336` | new `ErrorCode 'BRAIN_CREDIT'` + `httpStatusOf → 402` arm BEFORE `RATE_LIMITED`; 402 branch ×2 throwing `('BRAIN_CREDIT', false)`. NOTE: reusing `RATE_LIMITED` does NOT work (maps to 429 → still rotates; breaks `key-release-status.test.ts:34`) | 402 → code, non-retryable, `fetchImpl` ×1; `respond()` ×1 (break: retryable:true → ×3); ring rolloverLog empty on 402, non-empty on 429 | revert errors+brain TOGETHER (half-applied = code with no producer) |
| A.5 clock hoist | `daemon.ts:555→296` (+ handle `:81-90`, options `:60-79` seam `ttsCreditNow`) | pure relocation; `:821` unchanged | fault → saveKeys → 7d → still `…-overdue`, days 7 (break: constructor back inside → days 0) | revert move |
| A.6 key zeroing | `daemon.ts:330,550,848-849,911-921` + `keyring.ts:115` | `liveRing` + per-call `narratorRing` in try/finally; `rebuildVoice` destroys replaced; `stop()` destroys before `ui.close()`. LIMIT (state in comment): `Keyring.keys: string[]` immutable — removes Buffer residency, not all bytes | stop zeroes; rebuild destroys; throw-path finally; break: delete stop line → fail | revert daemon (never finally-only) |
| A.2 DACL re-lock | `apps/desktop/src/settings/vault-dacl.ts` (new, desktop → no reachability move) + `KeysView.tsx:72-76` | `restrictVaultFile()` mirroring `services.ts:34-64`; `raw!==true ⇒ {ok:false}`; call in `.then()` ok-branch BEFORE `setSavedAt`; amber `keys-dacl-warn` (save still reported saved), never `setError` | unit 6 (rows + absent-host + exact-string break) + e2e 2 (happy `keys-dacl-ok` + guard `false→warn+saved`) | drop module + block |
| A.1 dead command | `main.rs:1636-1640,3268` | **DELETE recommended** (5 lines; `reap()` stays for Exit path); update `AGENTS.md:84` + `12-SECURITY.md:74` by hand (`main.rs` anchors unchecked by script) | none (cargo stays 52) | re-add 4 lines |

Out of scope (deliberate): A.7 (`reset()`/`renewalAt` — inert, no production
caller), A.9–A.14.

### 1.2 M1 mechanics corrections (evidence-backed, from planning)

- **A.2 mechanism corrected** (Microsoft Learn: descriptor assigned on
  *creation*, lost on cross-volume move only). Real path: temp file is newly
  created → inherits profile ACL → same-volume rename carries it. Fix the
  rationale at `main.rs:901-905`, `vault.ts:141-147`, `AGENTS.md:226` or a
  future audit deletes a live fix.
- **New-module placement:** A.2's helper lives in `apps/desktop/src` so
  `live modules 53 / dead 7 / total 61` do not move. New root tests go in
  EXISTING files (`brain`, `tts-r3-errors`, `daemon`, `key-release-status`);
  only `vault-dacl.test.ts` is new (desktop files 24→25).
- **Comment hygiene:** added `brain.ts` comments must not contain `persona`
  (claim C23 = 0); A.13-class drift: re-derive every shifted `.ts` anchor by
  hand — the gate checks existence, not rightness.
- Expected deltas: root 705→723, desktop 142→148, e2e 18→20 (specs 14),
  cargo 52, lines 9122→~9136. Six claims move; 25 do not.

---

## 2. Milestone 2 — QwenAudio Low-Latency & Duplex

Ship order inside M2: **6c → 2 → 1 → 3 → 6a → 6b** (6c is one `await`→`for
await` with the largest measured win; 6b last — msgpack surface + unmeasured
free-tier `flush` benefit).

### 2.1 Prerequisites (before any M2 code)

- **P1:** M1-A.5 hoisted (a task queue inside `buildVoicePipeline` would drop
  in-flight tasks on every key save). Queue lives at daemon scope beside
  `speechGate` (`daemon.ts:295`), `maxDepth 8`, `PLAN_DEADLINE_MS 30_000`.
- **P2 (new Triad-A candidate A.15):** `coordinator.run()` never reaches an
  FR-12 confirmation from voice (`coordinator.ts:286-298` returns
  `needsConfirmation`; only the shell `confirm` path parks). File it as a
  defect first; M2 routes it (completed task + notice → approval re-enters
  via `tasks.get(id)` dispatch, never re-plan).
- **P3:** no ACP session-cancel path exists (`client.ts`: `promptSession:330`,
  `execSessionShell:468`, no abort) — verify whether serve exposes an abort
  endpoint before claiming "explicit cancel stays".

### 2.2 Patterns

**Pattern 1 — `spawn_thinking` split.** New `src/orchestrator/task-queue.ts`
(`TaskRecord{…status,result immutable…}`, `TaskQueue{enqueue sync, drain FIFO
concurrency 1, cancel(epoch), stats}`). `Coordinator.run()` splits into
`intake()` (moved verbatim `:204-232`, returns ack or `intake-failed/invalid`)
and `plan(ack,{signal})` (`:252-280` + retry, AbortSignal-checked per await);
`run()` retained as intake→plan so 20+ existing tests compile. Daemon speaks
the ack immediately via `onUtterance({…, receipt:null})` while `drain()` plans.
Epoch supersede (`epoch < current` → `cancelled-superseded`, never dispatch);
kill-switch `tasks.enabled` (default on → `await coordinator.run(task)`).
Tests: FIFO, supersede-no-dispatch (break: drop `epoch <` check), deadline,
abort-mid-plan; E2E `spawnthinking.spec.ts` via stub `POST /task`.

**Pattern 2 — speech-only barge-in.** New `stopSpeech` command
(`protocol.ts:kind` + `command-router.ts:201` one-line, no session contact);
`daemon.onStopSpeech → speechGate.abort()` only. `onAbort` stays full
`abortTurn`, reachable solely from the explicit button (`App.tsx:664-669`).
Real gap closed: `synthesizeStream(text, voiceId, {signal?})` with
`signalFor(gen)` from `SpeechGate`; signal into `fetchWithTimeout`
(`tts.ts:501`); ordering abort → idle → notify, ACP/task/session untouched.
Tests incl. non-interference (`stopSpeech` must NOT bump pipeline generation);
E2E `bargein.spec.ts` re-pointed + button-`abort` coverage kept.

**Pattern 3 — completion ≠ delivery.** New `src/orchestrator/delivery.ts`
(`DeliveryBuffer{offer → delivered\|buffered, drain coalesced newest-wins,
cancelEpoch}`, cap 4, TTL 30 s, drop-oldest). `playbackStarted` command
(`protocol.ts:428` + optional bounded `playbackId`), fired ONCE per utterance
from `AudioPlayer.onStart` (not per chunk); daemon acks via existing
`dispatchCommand` (zero frame change). `retry(taskId)` re-offers immutable
`TaskRecord.result` — test asserts plan NOT re-run (break: re-plan).

**Pattern 6a — never-assert-results guard.** One line in `intakeSystem()`;
bounded 1-retry re-ask; still asserting → drop ack, stay silent (`narrate()
→ null` precedent). Drop-don't-edit (filters mangle Arabic).

**Pattern 6c — incremental drain (do first).** `daemon.ts:801-806`:
iterate `synthesizeStream`, `broadcastAudio` per chunk (≤32 KiB) — surfaces
the measured 426–556 ms TTFB with no protocol/file change.

**Pattern 6b — WS transport (do last).** New `src/voice/fish-ws.ts`
implementing `FishTransport` (`tts.ts:236-240`): start{request} → text per
sentence → flush → stop (NOT close), msgpack framing, warm-socket reuse with
re-`start` on reconnect. VERIFIED (context7, `docs.fish.audio`): endpoint
`wss://api.fish.audio/v1/tts/live`, model-header enum incl. `s2.1-pro-free`,
`latency: low\|normal\|balanced` (schema default `normal` — send `balanced`
explicitly; already done at `tts.ts:428`), `chunk_length` 100–300 default 300
(we ship 300 deliberately for prosody — REJECT 100 for this milestone),
`min_chunk_length` 0–100 default 50 (we send 50), temp/top-p/penalty/prosody
all in range. UNVERIFIED: Node `WebSocket` availability (else `ws` dep +
sidecar-manifest update per the `pino` lesson); free-tier `flush` TTFB win;
`pcm`-format renderer benefit. Rollback: `TTS_TRANSPORT=http|ws`.

### 2.3 Latency budget (measured baselines only)

intake p50 901 · plan p50 1950/max 3987 · Fish TTFB 426–556 (HISTORY; STT/TTS
end-to-end figures are UNVERIFIED, not in tree — never budget on them).
Split → ack heard ≈ 1.4 s, plan behind it · barge <100 ms audio stop, plan
survives · delivery adds 0 ms to first ack · 6c → TTFB ≈ 0 perceived.

---

## 3. Milestone 3 — Stability, Backpressure & Defensive Limits

Order: **B.1 → B.5 → B.2 → B.4 → B.3-last** (B.3 touches renderer + can
deadlock; lands after M2 epochs with the carve-out proven).

- **B.1** pre-header cap: `MAX_PREHEADER_BYTES = 2×MAX_MESSAGE_BYTES`
  (`protocol.ts:22`); reset-before-throw + `discardPending`; 1009 close via
  existing path (`ui-server.ts:438`). 4 break-tests (dribble, boundary,
  legit-512 KiB, reset-not-just-throw). Root +4.
- **B.2 re-scoped** (brief premise corrected: `resume` capped at 256 AND
  `broadcast()` has zero production callers — no OOM path): **B.2a** bound
  outbound inventory (`.max(200)` at `protocol.ts:488`, first-200 policy);
  **B.2b** 64 KiB byte budget on `resume` (prophylactic, say so); **B.2c**
  `resume-gap` warn notice (Arabic, names range) when `lastSeq` predates
  retention — closes the silence-vs-missed hole `onGap` covers only for
  restarts. Root +3. Do NOT wire `broadcast()` (feature, not limit).
- **B.3** watermarks: `PAUSE 256 KiB / RESUME 32 KiB` beside `MAX_BUFFERED`
  (`ingest.ts:8`; pause < shed 937.5 KiB); edge-triggered `onWatermark`
  callback (transport-blind); additive `flow{pause\|resume}` frame with seq;
  `ui.flow()` via `broadcastFrame`; renderer `onFlow` advances `lastSeq`,
  drops (never stops mic) while paused. Deadlock rules R1–R5: evaluate on
  EVERY mutation incl. `reset()`; pause gates UPLINK only (abort/downlink/
  voice/notice/flow never gated); edge-triggered; reset `paused=false` on
  daemon-restart hello; order barge→stop→abort→sendPcm with abort ungated.
  Root +4, desktop +2.
- **B.4** VAD race: extract `src/runtime/vad-gate.ts`
  (`makeVadGate(load,fallback,timeoutMs)`), `VAD_GATE_TIMEOUT_MS=2000`
  (reasoned: 156 serial awaits, Silero never shipped — re-measure when ONNX
  ships); timeout resolves to `fallback(window)` NOT false; losing promise
  resolves (no unhandled rejection); timer only when `vad!==null`, cleared
  fast-path. Tests with fake timers incl. both fallback branches. Root +3.
- **B.5** sink redaction: `redactString(outcome.detail)` (`:505-511`),
  `redactString(transcript)` (`:233-237`), wrap both `console.error`
  interpolations. Tests use the deliberate-`AAAA` pattern with BOTH asserts
  (absent + `[REDACTED]` present — the second is what makes it non-vacuous).
  Root +3. Voice-transcript masking is an intended behaviour change (spoken
  keys masked on own HUD — correct fail-closed trade).

End: root 722, desktop 144, e2e 18, cargo 52. Re-derive counts; fix document.

## 4. Milestone 4 — Target-Audience Reliability & UX Polish

Load-bearing scoping facts (read, not assumed): the `event` frame has ZERO
production producers (`broadcast()` called only by tests + stub) — C.5 must
NOT be built on `event` in Phase 1; the live progress signal is `inventory`
(15 s, real serve state); `tts-credit` has zero renderer surface; storage
reality: `localStorage` 0 hits + no fs capability → renderer holds no durable
state (calibration is user-invoked, measure-and-advise only).

- **C.1** DACL receipt (blocked on M1-A.2): `KeysView` renders `keys-saved`
  ONLY after invoke resolves; `Ok(true)` → «…محمي بصلاحيات المالك فقط»;
  `Ok(false)`/missing → honest warn (M1 should widen return to
  `{state,path}`); `Err` (file DELETED fail-closed) → error + re-enter keys;
  no-Tauri → render nothing. E2E asserts the negative in browser (count 0).
- **C.3** credit banner: new `components/status/CreditBanner.tsx`, in-flow
  above generic notices (`data-testid`, `data-code`, overdue
  `data-dismissible=false`, `aria-live=assertive`); mapping
  exhausted/dismissible vs overdue/latched vs renewal (map the arm, unreachable
  today — say so); day count owned by daemon `noticeDetailAr`, never
  re-derived; clear path = `voice phase:'speaking'` AFTER the notice (proof
  TTS worked — no daemon change). Tests: 4 mapping rows, no-double-render,
  clear-on-speaking; E2E `credit.spec.ts` via existing stub `/notice`.
- **C.5** task cards: Phase 1 derives from `inventory` (honest 15 s) via new
  `matrix/task-state.ts` (`queued/running/done/failed/unknown`, unknown →
  neutral chip, never colour-by-guess); `queued` synthesised locally at
  utterance time; display-only (test asserts zero commands emitted);
  `max-h-[88px] overflow-y-auto` (auto-size guard). Phase 2 (M2 producer)
  adds the `event` caller — until then event-cards stay unshipped (green-E2E/
  dead-production trap).
- **C.6** calibration wizard: footer «معايرة الميكروفون» → `PortalShell`;
  3 phases/10 s (listen 0–3 s micEnergy meter; measure 3–8 s room floor vs
  shared −30 dB; verdict 8–10 s with three outcomes + measured floor).
  Pure `CalibrationMeter({samples})` for happy-dom; E2E only deterministic
  paths (fake-tone energy UNVERIFIED). No threshold persistence (SPECULATIVE,
  defer — renderer threshold only affects barge-in ducking).
- **C.7** dialect check: Phase 1 renderer-pure `script-check.ts`
  (`looksNonArabic`: Latin ≥60% AND Arabic ~0 — mixed sentences like
  `افتح المنفذ 4096` must NOT trip); copy scoped to what it catches (Latin
  echo, NOT Arabic-script gibberish — the common failure). SPECULATIVE path:
  capture `res.language` from Groq `verbose_json` (UNVERIFIED — needs one live
  call recorded in `10-CHECKPOINT.md`) → optional additive `langHint`.

Constraints on all: 440×600 auto-size (in-flow only), RTL, Arabic `title` per
control, zero canned replies (no `narrate()`, no commands, no `announce`
writes). Gate: ~4 desktop files, ~2 e2e specs → deliberate AGENTS.md updates.

---

## 5. Milestone 5 — Diagnostic Introspection (`doctor --bundle`)

One new module `src/diag/bundle.ts` (pure, injectable, NO `daemon.ts` import —
most needed when the daemon is down); ~15 lines in `cli.ts`; zero
WS/protocol/installer edits (sidecar copies `dist/` wholesale).

- **Schema** (`schemaVersion: 1`): ports[] (bound/bindAddress/ownerPid/probe/
  healthy/refusal per port) · daemon{ownerMarker, pidAlive,
  classification Cold\|Ours\|Foreign+reason, bringUp mirror labelled
  `derivedBy:"cli"`} · config (slugs, timeouts, flags, env booleans — never
  values) · keys (counts + `sha256:`10hex fingerprints, 16-byte entropy floor
  or `fingerprint:null`; `undecryptable[]`) · logs (last 200 lines × 5 files,
  2000-char/line cap) · telemetry (50 rows + code/subsystem histograms —
  derive `daysSinceFirstFault` from jsonl timestamps, NOT the rebuilt monitor)
  · docsVerify{ran\|skipped\|failed + counts, NEVER a cached pass} ·
  redactions{scanned, scrubbed, refused}. Absent sources → present-key-null,
  never missing keys.
- **Redaction:** reuse `redactString/redactObject`; per-line scrub at the read
  boundary (opencode.log is upstream stdout, never through either sink);
  whole-bundle `containsSecret===false` assertion; trip → per-line
  `[REDACTION-REFUSED]`, bundle still written (bundle-or-nothing must favour
  the bundle). Structural rule: key strings only ever enter `createHash`.
  Bundle designed pastable into a public ticket (paths included deliberately,
  called out in header).
- **CLI:** `--bundle` (+ JSON stdout), `--bundle-out <path>`, `--json`;
  no-flag path byte-identical. Exits: 0 healthy · 1 degraded-collected ·
  2 collection-failed (self-describing JSON disambiguates the `cli.ts:246`
  usage-2 collision). `parseDoctorFlags(argv)` unit-tested (no bare
  `argv[3]`).
- **Probes, honestly:** ports from env+defaults (ephemeral-port testable);
  4096 via existing `probeHealth` + status-code surfacing (401≠unreachable =
  the L17 discriminator); 4097 via authenticated handshake (bare TCP is the
  called-out shortcut — UNVERIFIED: Node `fetch` cannot set subprotocols;
  likely raw `net.Socket` + `wsAccept()` reuse; confirm, don't guess).
  `docsVerify` runs live with new `--json` flag (never parse prose; never
  attach stale); `skipped` in installed payloads (no `scripts/` shipped),
  informational only.
- **Five failures discriminated:** squatter (bound + Foreign + pidAlive/
  keyMatch) · invalid key (count>0 + STT auth errors + zero credit rows) ·
  credit (codeHistogram 402/429) · serve flap (4097 Ours + 4096 down + 0-byte
  daemon.log) · version mismatch (config≠marker + refusal three-way).
- **Docs:** rewrite `specification/14-RUNBOOK.md §14.4` (documents a fictional
  `diag --out diag.zip` — replace with shipped surface; `git log` range stays
  out; per-line-refusal recorded); flip dossier §12.2 to *"bundle: yes;
  key-validity signal: still no"* — never overclaim FULL. `00-PROJECT-GUIDE`
  pre-flight table.
- **Tests:** `src/diag/bundle.test.ts` (schema, deliberate-fake redaction ×4
  surfaces, entropy floor, never-read spy, empty/torn/binary/10k-line logs,
  unknown-flag JSON, flag parser) + `bundle.integration.test.ts` (stub daemon,
  ephemeral ports, `describe.sequential`). New module must be DIRECTLY
  test-imported or blindspot count moves. Gate: root count rises (re-derive;
  pin claim set in coverage test); cargo 52, desktop 142, e2e 18 untouched.
  Rollback: single revert, no migration, no persisted state.

---

## 6. Multi-agent deployment (agency-agents × skills.sh, adapted)

Adopted patterns (fetched 2026-09-29 — `skills.sh/topic/agent-workflows`,
`github.com/msitarzewski/agency-agents`): writing-plans → PLAN state;
executing-plans → hard VERIFY checkpoint; TDD → BREAK-GUARD-FIRST; systematic
debugging (observe→hypothesize→test→verify, ≤3 iters) → DEBUG state;
verification-before-completion → COMMIT unreachable on un-run evidence, exit
codes read unpiped; dispatching-parallel-agents + using-git-worktrees → only
across proven-disjoint sets, orchestrator-only gate; finishing-a-development
-branch → CLOSE (revert rehearsed, tag-after-commit); mission-boundary
contracts (read-all / write-only-X / never-scripts); Code-Reviewer peer
handoff (different read-only agent, can reject); Minimal-Change discipline
(A.13-style drive-bys are scope violations). REJECTED: ralph autonomous loops
(manual gates + fixed ports + interpretive `docs:verify` — unattended loops
cannot run them).

### FSM (per triad item)

```
[S0 PLAN] ─G1─► [S1 BREAK-GUARD-FIRST] ─G2─► [S2 IMPLEMENT] ─G3─► [S3 VERIFY]
  │                  │ (fail-right-reason, landed-confirmation,      │
  │                  │  non-vacuous re-red)                          │ G5 red → S1b
  │                  ▼                                               │ G6 claims → S1c
  │            [S1b DEBUG ≤3] ──G8──► [S6 ROLLBACK] ◄──G7 abort──────┘
  │                  │                     │
  └──────────────────┴──► [S4 PEER-REVIEW] ─G9─► [S5 COMMIT] ─► [S7 CLOSE]
                              (diff + transcript + claim delta;
                               name-vs-assertion smell check)
```

S0 emits write-set + at-risk claims + break assertion + revert range + roles
(G1: ≥1 claim named or zero-exposure proven). S2 minimal diff, `git diff
--name-only ⊆ plan` (G3). S3 ordered sequence: focused test → root vitest →
typecheck:tests → cargo → docs:verify → self-test → coverage test →
blindspots → `test:vantrilex` (orchestrator only). S5: one commit per triad
item, BOM-free file, no UNVERIFIED-shaped doc phrases. S6: revert
`<first-sha>^..<doc-commit-sha>` (doc-figure commit LAST — code-only revert
re-breaks claims); never retrofit an earlier claim from a later milestone.

### Rollout order + parallel pairs

**Order: M5-S0 (schema) ∥ M1 → M2 → M3 → M4 → M5-close.**
M5-S0 runs first (enum frozen before M1–M4 emit codes; M5 owns schema,
M1–M4 produce). M1 before M2 (shared `coordinator.ts`/`daemon.ts`/`protocol.ts`
— M1's edits land last-commit-first). M2 before M3-B.3 (epoch carve-out proven
before watermarks) and before M4-C.5-Phase-2. Within M1: A.3→A.4→A.5→A.6→A.2→A.1.
Within M3: B.1→B.5→B.2→B.4→B.3. Within M2: 6c→2→1→3→6a→6b.
Parallel ONLY: **M1∥M4** (A.2-invoke vs C.1-render split), **M3a∥M4** (B.7
split: daemon codes vs shell collection), A-voice∥A-rust (A.1/A.2 serialized
on `main.rs`), M2-S0∥M1 (planning, no writes). FORBIDDEN: two concurrent full
gates (EADDRINUSE by construction).

### Verification gates (per milestone close, in order)

`npx vitest run` → desktop suite → `cargo test` (MSVC env) → `npm run
docs:verify` → `--self-test` → coverage test → `test:blindspots`
(informational) → `npm run test:vantrilex` (orchestrator only) →
`release:verify --stage=gate`. Exit codes unpiped; re-anchor by content
(`Select-String` the symbol), never arithmetic. New modules pre-declare
reachability class (each moves C10/C13/C30/C31 at once); renderer-only work is
immune to C10–C13/C30–C32 (walk roots `src/` only — derived, re-confirm);
`cli.ts`-first-test decision flips 3 claims deliberately or not at all;
never wire `test:blindspots` into the gate without the recorded decision.

---

## 7. Executive summary

| # | Milestone | Impact | Validation gates |
|---|---|---|---|
| 1 | Security hardening (A.1–A.6) | stops key burn, single-attempt billing, stable 7-day clock, no heap residency, live DACL re-lock, dead command removed | root 723, desktop 148, e2e 20, cargo 52, 6 claims re-derived, break-guards ×4 |
| 2 | Latency + duplex (Qwen 1/2/3/6) | ack ≈1.4 s, barge <100 ms w/ surviving plan, deferred delivery, TTFB ≈0 perceived | root +~30, desktop +4, e2e 16–17, modules 53→55+, Fish body-shape guard |
| 3 | Stability + backpressure (B.1–B.5) | all inbound bounded, pause/resume without deadlock, VAD never stalls, sink redaction complete | root 722, desktop 144, e2e 18, cargo 52 |
| 4 | UX reliability (C.1/C.3/C.5–C.7) | honest receipts, latched credit banner, task cards, calibration, dialect check | desktop +~4 files, e2e +~2 specs, deliberate claim updates |
| 5 | `doctor --bundle` diagnostics | one redacted artifact → automatic root-cause for 5 failure classes | 2 new root files (direct-imported), counts re-derived, schema v1 |
| × | FSM + rollout discipline | no vacuous guards, no claim drift, per-item rollback, orchestrator-only gates | docs:verify + self-test + coverage per close |

*End. Method inherited from the dossier: code-first, break-the-guard, fix the
document — never the script. New `ErrorCode`, new WS kinds, new notice codes
and the bundle enum are contract changes: declare first (S0), emit second,
verify third.*

