# Maturity & Ecosystem Research

**Status: RESEARCH DELIVERABLE. No code modified.** Authored against `0df59ad`, v0.7.2.
Five parallel research tracks; primary evidence in `.opencode/_audit/80-` through `84-`
(≈3,300 lines). Every claim below is either cited `file:line`, observed from a
primary source with the date observed, or marked UNVERIFIED.

---

## 0. The finding that most changes how this document should be read

Two independent things in this repository answer to the name **"LAYA"**, and they
are unrelated:

| | Voxaura's LAYA | `NandhaKishorM/laya` |
|---|---|---|
| What | 306,942,724-weight ONNX reflex model | text decision model |
| Shape | 4 binary heads over a 32-token window | prose/typed decision API |
| Size | 293.78 MB INT8 / 1.14 GiB fp32 | hosted service |
| Popularity | internal, 0 external users | **27,505★, Apache-2.0** |
| Served by | local `onnxruntime-node` | `ollaya-dev/ollaya` (830★) behind a Jev-compatible `/v1/systemone` |

The widely-known repo is **not** this project's LAYA. Its headline benchmark
(0.766 vs 0.727) is measured on **email triage, not voice**. Any architecture
document that cites it as evidence about `src/runtime/laya/` is wrong, and the
collision is stable enough that a future reader will make exactly that mistake.
This is recorded here, and nowhere else in the repo, for that reason.

Separately: **LAYA currently ships nothing.** `tauri.conf.json:33` bundles only
the sidecar and `models/*.onnx` is gitignored, so **no ONNX has ever run in an
installed build** — including Silero VAD, which has been silently falling back to
the RMS energy gate at `daemon.ts:509` the whole time.

---

## 1. Executive scorecard

Scores are 0–5, argued from the code and the gates, never from README claims.

| Dimension | Score | Evidence |
|---|---|---|
| **Architecture & modularity** | **4** | 0 dead modules at `0b4cf27`; zero-dependency retriever; compile-time parity guarantee on Tier 1. Deducted one point: the invariant has since regressed to 7 dead (see §5.1). |
| **Tests & gate integrity** | **3** | Root 656/53, desktop 142/24, cargo 48/0, `typecheck:tests` 0, oxlint 8/8. But the network clients are injected mocks and E2E drives a **fake control plane**. Two tests currently defend bugs. |
| **Observability** | **2** | Telemetry exists and is now redacted, but `LAYA` and `LAUNCHER` have no producer, `ui.notice` is unredacted, there are zero `uncaughtException` handlers and zero Rust panic hooks. |
| **Build & release** | **2** | No CI. `packaging-preflight.mjs` is 15 checks, 14 pass, and **cannot fail** — it exits 0 regardless. |
| **Security** | **2** | CSPRNG fixed, redaction landed. But no test executes `main.rs`, `pino` still ships via a stale lock, and raw provider errors reach the HUD unredacted. |
| **Documentation** | **1** | Ten fabricated benchmark figures shipped. A ledger tally that did not sum. A knowledge chunk asserting a feature was wired when it was not. **Seven false load-bearing claims remain in AGENTS.md.** |

**Weighted read: this is a well-architected codebase with a badly-instrumented
release process.** The code quality is not the constraint. The constraint is that
the thing the gate verifies and the thing the user installs are different systems,
joined by a human remembering one line in a markdown file.

### 1.1 The single biggest process risk

> The verification gate and the shipped artefact are different systems, connected
> only by a human remembering `AGENTS.md` step 6.

That is precisely why **v0.6.0 shipped a daemon that could not boot** with every
gate green. `packaging-preflight.mjs` cannot fail and is in no npm script, so
nothing structurally links "tests passed" to "the installer works."

### 1.2 What the gate actually proves

`stub-daemon.mjs` imports the **real** `UiServer` and router from root `dist/`,
but fakes `ServeClient`, `saveKeys`, `switchSession`, the narrator, and binds
only 4097 + 4197. **4096 is never bound; there is no Tauri, no vault, no
provider, no daemon boot, no microphone.** So the gate proves the IPC contract and
the state machine. It does not prove the product starts, speaks, or that any
provider key is valid.

---

## 2. Internal gap audit (Track 1)

Full detail: `.opencode/_audit/80-t1-internal-gaps.md` (1,210 lines).

### 2.1 Muted speech still costs a full provider round-trip — HIGH

The mute gate is **renderer-only** (`App.tsx:40`); the daemon contains no `muted`
symbol at all, and calls `fish.synthesize` per sentence at `daemon.ts:776`.

Worse than a wasted call: **`TtsEngine` and `AudioCache` have zero production
importers**, so there is no cache on the spoken path either. A muted reply costs a
3-call serial Fish chain — 426–556 ms TTFB each, ~2.80–5.49 s of speech generated,
for audio nobody hears.

**Decision:** an additive `output: 'audible' | 'muted'` state frame mirroring
`hello.persona`, gating **synthesis** rather than playback, so the daemon owns the
quota decision. Do **not** revive the `{ok:true}` no-op `mute` command.

### 2.2 The key pool is structurally one key wide — HIGH

`writeKeyPools` stores one key per pool, so `forceAdvance` on a 1-key pool is a
no-op (K1→K1) and a revoked key is retried indefinitely. Telemetry contains **142
identical `KEYS_MISSING` rows** — proof the keyless state never escalates.

**Decision:** never probe (a probe burns quota). Derive a stateful `PoolHealth`
from real traffic and make `arm` the single veto point, refusing at
`ARM_REFUSE_THRESHOLD = 5` — chosen from the existing 3× brain retry plus the 15 s
STT timeout.

### 2.3 The diagnostic log is written by the test suite — HIGH (instrument)

`cargo test` writes **24 fabricated `JOB-CREATE-FAILED` lines into the real
`supervisor.log`**, because `log_line` has no `cfg!(test)` gate. *A green gate
beside a lying diagnostic file is exactly the v0.6.0 shape.* Fix is ~10 lines and
should precede everything else in this section.

### 2.4 No system tray exists, and none can — structural

`Cargo.toml:11` has `features = []`, `tauri.conf.json:12-28` has no `trayIcon`,
and the capabilities grant no tray permission. Additionally `decorations: false`
removes the close control, so **window close is a full quit** that reaps every
child (`main.rs:2898-2902`).

### 2.5 Audio recovery is pinned as a feature — HIGH

There are **zero** `devicechange` / `onended` / `onmute` handlers in the renderer.
After a mic disconnect `running` stays `true` forever, and `start()`'s
`if (this.running) return` (`capture.ts:78`) makes every recovery path — including
the mic button — a silent no-op. `capture-permission.test.ts:74-83` **asserts that
guard.**

**Decision:** replace the boolean with a four-state machine where `running === true`
means only `live | stalled`, so `start()` re-acquires from `lost`. Drive it from
track `onended`, `mediaDevices.ondevicechange`, and a 4,000 ms frame watchdog
derived from the 100 ms frame contract. **Migrate** the existing test — it is
defending the bug, not the behaviour.

---

## 3. Curated ecosystem catalog (Track 2)

**Bottom line: ship what exists.** Measured p99 retrieval is **0.0128 ms against a
10 ms budget — 780× headroom.** There is no latency problem to solve, and every
candidate below trades a non-problem for a real one.

All figures observed by fetching the source; star counts dated 2026‑09‑28.

### 3.1 AST / tree-sitter — **REJECT, none adopted**

| Repo | Stars | License | Deps | Verdict |
|---|---|---|---|---|
| `web-tree-sitter` 0.27.0 | — | MIT | zero | 204.7 KB wasm, technically clean — **solves nothing**: a 43-chunk corpus contains no code. |
| `tree-sitter-typescript` + `tree-sitter-rust` (native) | — | MIT | `node-gyp-build` | **52.6 MB + native binding** — the exact v0.6.0 failure class. |

No official prebuilt-WASM grammar repository exists: `tree-sitter/tree-sitter-wasms`
**404s**, and the community prebuilders are 2★ and 56★.

### 3.2 Retrieval — **REJECT MiniSearch, keep house BM25**

Measured on the real 43-chunk corpus:

| Engine | p50 | Arabic recall (tashkeel queries) |
|---|---|---|
| **House BM25** (`retriever.ts`) | **0.0042 ms** | **3/5** |
| MiniSearch 7.2.0, correctly wired | 0.0131 ms | 3/5 |
| MiniSearch 7.2.0, **unwired** | — | **0/5** |
| FlexSearch | — | rejected (below) |
| `lunr-languages/lunr.ar.js` | — | worse than house normalizer |

- **MiniSearch** 7.2.0 — **6,150★**, MIT, 5.7 KB gz, **empirically 0 transitive
  deps**. Genuinely the best candidate, and it still loses: **3.1× slower,
  identical recall.** The `0/5` unwired row independently reproduces the finding
  that motivated the whole knowledge layer.
- **FlexSearch** — rejected harder. It is **unranked** (returns no scores, so
  `SharedHit.score` would be *fabricated*), and npm `latest` 0.8.212 is **three
  releases behind a published command-injection fix**.
- **`lunr-languages`** — the only real Arabic normalizer found, and it is **worse**
  than `normalize.ts`: folds alef maksura the wrong way, keeps only the first alef
  variant, and deletes ~500 Arabic stopwords **including `كيف`**.

### 3.3 Vector / semantic cache — **REJECT, none adopted**

| Option | Footprint | Verdict |
|---|---|---|
| `@lancedb/lancedb-win32-x64-msvc` | **301.9 MB unpacked** | 3× the entire sidecar. Rejected. |
| `sqlite-vec` | 0.3 MB native ext | Mechanism is fine — `node:sqlite` exposes `loadExtension`. But `pre-v1`, and pointless at 43 chunks. |
| Any offline embedder | routes through `onnxruntime-node` (**287 MB**) | `daemon.ts:338` lazy-loads that module *on purpose*. A semantic cache would put the v0.6.0 failure module back on the critical path. |

### 3.4 The one actionable retrieval finding

`إيش سويت` and `٤٠٩٦` return 0 hits **not because scoring failed but because the
facts are not in `capabilities.ts`.** This is a **corpus coverage gap**, not a
retrieval defect, and it is fixed by writing chunks.

Also: `retriever.ts:24-29` still reads as a standing minisearch TODO. Having now
been measured three times and lost each time, it actively invites a future agent
to "finish" a swap that is a measured regression. It should carry today's numbers
or be deleted.

---

## 4. Jev ecosystem (Track 3)

**VERDICT: EXISTS** — verified against primary sources, 39 logged queries including
the 404s, a 503 and a DNS failure. Full detail: `.opencode/_audit/82-t3-jev.md`.

TypeSafe AI (Diogo Almeida), released **2026‑09‑15**, "System One Models", trained
with RLCD; independently analysed in **arXiv:2609.30216v1** across 2,170 GitHub
projects. Thesis: *state in → typed decision + probability out* — no prose.

**API:** `POST /v1/systemone`, body `{state, model, questions}`. All questions
evaluate in parallel. 70–500 ms, 32k window, text-only.

| Construct | Returns |
|---|---|
| `Choice` | label + full distribution + `confidence` (≤255 options) |
| `Score` | level + distribution + `confidence` |
| `Noul` | a single 0–1 float, and explicitly **no** `confidence` field |

### 4.1 Two of the four artefacts in the commissioning brief are wrong

- **`jev-gateway` is not a TypeSafe artefact** — it self-describes as *"Independent
  project, not affiliated with or endorsed by TypeSafe"* (npm 0.5.0, 241★,
  `vinilana`).
- **`jev-voice` is 404 on npm.** The real thing is `jev-voice-browser` (360★).
- `fast-jev-opencode` is real (npm 0.4.3) but **3 days old and 0★**.

### 4.2 LAYA's actual contract, read from source

`constants.ts:17` — `['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop']`,
all binary, frozen at compile time. `constants.ts:15` — operating length 32, and
**the file itself marks the timing UNVERIFIED**. Input: one bare string → int64
`[1,32]`. Output (`types.ts:17-22`): four sigmoid scores + `elapsedMs` + ISO
timestamp. **No confidence, no distribution, no calibration.**

### 4.3 Integration verdict: **none recommended**

`Noul` is the only crossing primitive, and it crosses *into* something **slower** —
70–500 ms of network against LAYA's ~26 ms in-process — and the obvious target is
`barge_in`, where sub-second latency is the entire point. `Choice` and `Score` have
no counterpart in a fixed four-binary-head contract, and LAYA's sigmoid scores have
**nothing to calibrate against** because no confidence or distribution is emitted.

The shapes are not merely different; they are anti-correlated with this product's
latency requirement.

---

## 5. LAYA dual-tier feasibility (Track 4)

Full detail: `.opencode/_audit/83-t4-laya-dual.md`.

### 5.1 Sub-15 MB by quantization: **NO**

Parsed directly from the ONNX wire format with a streaming protobuf scanner (no
Python available), validated by reproducing the fp32 per-layer total with
**delta = 0**: **306,942,724 weights**.

| Target | Size | vs 15 MB budget |
|---|---|---|
| INT8 (today) | 293.78 MB | 19.6× |
| 2-bit @ g=128 | 82.3 MB | **5.49× over** |
| 1-bit (impossible) | 36.59 MB | **2.44× over** |
| Budget affords | **0.41 bits/weight** | — |

A Lite tier is a **different-model** target, not a precision target.

### 5.2 The finding that settles it: the heads are 0.001% of the model

Architecture: 22 layers, hidden 768, **vocab 256,000**, and 4 × `Linear(768→1)` on
a shared trunk. Essentially all 306M parameters are the shared trunk. **The
decision function is four linear readouts.**

And **3 of 4 heads are already implemented with no model at all:**

| Head | Existing implementation | Model's measured value |
|---|---|---|
| `barge_in` | `ingest.ts:19-42` energy gate; Silero `runtime/vad.ts`; wired `daemon.ts:494-517`; renderer `audio/vad.ts:32-35` | not measured |
| `is_destructive` | `brain.ts:97-103`, behind a **stronger** kind-based FR-12 gate `command-router.ts:65,248` | not measured |
| `stuck_in_loop` | `MAX_PARKED` `command-router.ts:73` + retry policy `brain.ts:113` | **0.9923–1.0000 — already saturated** |
| `should_speak` | **nothing, anywhere in `src/`** | the only head with real headroom |

The full model is needed, at most, for **one head** — and `should_speak` is a
turn-taking policy, not a language task.

### 5.3 Recommended tiering

| Tier | Form | Installer impact | `onnxruntime-node` in graph |
|---|---|---|---|
| **LAYA Lite** | ~1.1 MB, **pure TypeScript** | **1.20×** | **no** |
| **LAYA Full** | 294 MB INT8, opt-in download | 12.77× | yes, behind the loader seam |
| **fp32** | 1.14 GiB | 47.92× | **never** |

**The full edition is defensible only if `should_speak` measurably beats a
rules-based turn policy — an experiment nobody has run.** That is the single
highest-value Laya experiment available, and it is cheap: both candidates fit in a
day.

### 5.4 Two defects in the existing Laya evidence

- `l2_report.json:10-11` **passes a 40 ms gate on p50 while p99 is 94.43 ms** —
  2.4× the budget, hidden by reporting the median. `constants.ts:12-13` also
  misquotes the file it cites.
- The dead-code invariant has **regressed**: `src/runtime/laya/*` is 7 modules
  that are unreachable from `daemon.ts`/`cli.ts` because the seam is deliberately
  not installed. AGENTS.md still claims **0 dead**. The claim became false at
  `9394f32`.

---

## 6. Maturity & practice findings (Track 5)

### 6.1 New defects surfaced by this audit

| Finding | Severity |
|---|---|
| **`ui.notice` is unredacted** and `daemon.ts:584/738/789` push raw provider `err.message` into the HUD — bypassing the redaction landed in Wave 2 | **HIGH** |
| **`package-lock.json` still declares `pino`** (5 root deps vs 4 in `package.json`; `node_modules/pino` present; `npm ls` reports 12 extraneous) | **HIGH** — ships the exact bloat Wave 2 removed |
| **7 false load-bearing claims in AGENTS.md**, including "0 dead" | MEDIUM |
| `LAYA` + `LAUNCHER` telemetry have no producer, and no guard checks that | MEDIUM |
| Zero `uncaughtException` handlers; zero Rust panic hook | MEDIUM |
| `assets/benchmark-matrix.svg` still holds the 10 withdrawn fabricated figures | MEDIUM |
| `Crest.tsx` — last dead component with passing tests | LOW |

> The `pino` lock drift is **my error**, introduced in `0b4cf27`: I ran
> `npm install --package-lock-only` after Track-7's removals, then W2b removed
> `pino` and I never re-verified. It shipped in `9394f32`. One command fixes it.

### 6.2 Practice research: what was explicitly rejected

For a local-first Windows app whose selling point is that nothing leaves the
machine:

- **Hosted crash reporting** (Sentry et al.) — requires egress; contradicts the product.
- **Opt-out analytics toggle** — *a "disable telemetry" switch teaches users to
  hunt for a socket that does not exist.* Rejected on that basis.
- **OpenTelemetry SDK + collector** — a collector is a server dependency; the
  sidecar has none and should have none.

What *is* appropriate and missing: structured local logging with size-bounded
rotation, a Rust panic hook, and `uncaughtException` handling.

---

## 7. Prioritised roadmap

Probabilities are honest estimates of landing, not of merit.

### M0 · v0.7.3 — stop the document from lying · **P ≈ 95%**

1. **`npm run docs:verify`** — mechanically re-derive AGENTS.md and README counts,
   dead-code figure, gate composition and version; **exit non-zero on mismatch**.
2. Delete `assets/benchmark-matrix.svg`.
3. Redact `ui.notice`.
4. Fix the `pino` lock drift.
5. Delete or annotate the stale minisearch TODO.

*Everything after this is planned against a contract that is 7/17 wrong.*

### M1 · v0.8.0 — the Fish cliff (63 days) · **P(voice intact past 2026‑11‑30) = 30%**

The free tier expires **2026‑11‑30** with no SLA. Measure a second TTS provider by
**2026‑10‑15**, and ship an honest degraded-voice mode **regardless** — do not
make it contingent on the migration succeeding. P(honest degradation) ≈ **85%**.

### M2 · v0.8.1 — make the release verifiable · **P ≈ 70% as a human-run script; ~25% ever in CI**

`npm run release:verify`: gate → NSIS build → `/S` install → **assert 4096 and
4097 are bound and `daemon.log` is 0 bytes.** This is the v0.6.0 regression
converted from tribal knowledge into a command. It is the highest-leverage item
in this document.

### M3 · v0.8.2 — close the four operational gaps

In order: `log_line` `cfg!(test)` gate → audio recovery state machine → muted
synthesis → key-pool health. The first is ~10 lines and currently corrupts the
only diagnostic file the project has.

### M4 · v0.9.0 — Laya Lite, and only Lite

Ship the ~1.1 MB pure-TS reflex engine. Run the `should_speak` A/B against a
rules-based policy **first**; if the model does not win, the full model never
ships, and 294 MB never enters an installer.

---

## 8. What this document does not claim

- No code was modified. Every fix named here is a specification, not an applied change.
- The `pino` lock drift and the dead-code regression are **measured on this
  machine today**, not inferred.
- Jev's characterisation rests on primary sources, not blog summaries. Its
  "no integration" verdict is an architectural judgement, not a claim that
  integration is impossible.
- E2E's 18/14 count was **not** re-run as part of this research and is carried
  from the last gate.
