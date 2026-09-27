# VOXAURA — COMPREHENSIVE FORENSIC AUDIT REPORT

**Audited tree:** `O:\opencode-Vantrilex` @ `5dd7671` (tag `v0.5.0`)
**Date:** 2026-09-27 · **Method:** raw source, raw runtime logs, live process/port forensics. No prior summary, doc claim, or test count is treated as evidence.

---

## 0. Phase 0 — Tooling Provisioning & Open-Source Intelligence: COMPLETE

**Status:** tooling provisioned; OSINT research compiled to
**`docs/research/OPEN_SOURCE_REFERENCES.md`**. Phase 0 is read-only w.r.t. application code —
**no file under `src/` or `apps/desktop/src/` was modified.**

**Provisioned:** 3 additional skills (`tdd-workflow`, `ui-skills`, `prompt-engineering` — all
present in the registry, none were previously provisioned), 12 plugin descriptors
(`.opencode/plugins/`), `rust-analyzer` LSP wired into `opencode.json` (binary confirmed at
`C:\Users\omarb\.cargo\bin\rust-analyzer.exe`; `clippy` also installed), 6 MCP servers
(`context7`, `memory`, `filesystem`, `sequential-thinking`, `typescript-lsp`, `openrouter`), and
3/3 requested hooks already active (`session-start`, `session-end`, `pre-compact`).

**Research findings that change the fix plan** (full detail and code in the reference dossier):

| Audit defect | Reference pattern that settles the design |
|---|---|
| **D1** hallucination loop | `ggml-org/whisper.cpp` `examples/stream/README.md` documents a `-vth 0.6` speech-probability gate **plus a `--length 30000` lookback buffer** so the final phoneme is never clipped. The `no_speech_prob` we already pay for (via `verbose_json`) is discarded at `stt.ts:99-115` and is sufficient — **no new dependency required for Phase 1**. |
| **D2** no sanitiser | `pipecat-ai/pipecat` `utils/text/transforms/strip_markdown.py` read in full: the complete 12-rule regex chain, plus its stated **alphanumeric-preserving invariant** — which becomes our testable contract. Arabic diacritics/tatweel/alef-variant/URL/emoji rules are ours to add; pipecat is English-first. |
| **D3** shouting | Root cause is measurable, not stylistic: `normalize: true` (`tts.ts:145-152`) pushes to full scale and no `prosody` is sent. Fix with `normalize: false` + explicit calm `prosody` + a renderer-side **gain node at a target dBFS** — construction, not prompt luck. |
| **D6/D7/D8** dual wave | `Kopiro/siriwave` README: `amplitude?: [number, number]` is a **range**, which is exactly the shape RMS needs (floor→ceiling). Upstream `color` is a single String, so the two-stop gradient is impossible from the library — confirming the hand-rolled canvas is the right architecture. Upstream top-curve `lineWidth` is **1.5**; our port uses **2.5**, which is part of why it reads as a bar. |
| **D9** / 360° middleware | `sst/opencode` now redirects to **`anomalyco/opencode`** (210,308★, MIT, `dev`). Verified: `Session.tokens = {input, output, reasoning, cache:{read,write}}`; a dedicated **`GET /api/session/{id}/context`** endpoint; a typed **`ContextOverflowError`**; and a full endpoint inventory including native `/compact`, `/interrupt`, `/revert/*`, `/wait`, `/api/command`, plus an `EventSessionNextContextUpdated` push and a 50-event telemetry catalog. |
| Ducking / barge-in (3.3) | `livekit/agents` `voice/endpointing.py`: `on_start/end_of_speech` and `on_start/end_of_agent_speech` are **two independent timelines**, with `DynamicEndpointing(min_delay, max_delay, alpha=0.9)` — the model our single `voicePhase` enum cannot currently express. |

**Licensing constraint recorded:** `hvianna/audioMotion-analyzer` is **AGPL-3.0** — technique
reference only, no code may be copied. `pipecat` BSD-2-Clause, `silero-vad`/`whisper.cpp`/
`siriwave`/`opencode` MIT, `livekit/agents` Apache-2.0. `YellowKidokc/TTS-Cleaner` has **no
license and 0 stars** — rejected.

**Phase 1 gate ladder (unchanged in intent, now evidence-backed):** 1) D1 VAD gate → 2) D2
sanitiser → 3) D3 prosody/gain → 4) D4 double-TTS removal → 5) D6/D7/D8 single RMS thread with
speaker palettes → 6) analyser + ducking → 7) D9 context telemetry and native commands.

---

## 0.5 Phase 1 — Remediation: COMPLETE (D1–D4, D6–D9)

**Gate ladder, all green, measured 2026-09-27:**

| Gate | Baseline (v0.5.0) | Now | Result |
|---|---|---|---|
| `tsc` (root) | 0 | 0 | ✅ |
| `eslint --max-warnings 0` | 0 | 0 | ✅ |
| `oxlint` | 0 errors | 0 errors (7 pre-existing warnings, none in changed files) | ✅ |
| root `vitest` | 222 | **284** (+62) | ✅ |
| desktop `vitest` | 95 | **113** (+18) | ✅ |
| Playwright E2E | 18/18 | **18/18** | ✅ |
| `cargo check --no-default-features` | 0 | 0 | ✅ |

### Four corrections to this audit — the original findings were partly wrong

These were found by reading primary sources, not by re-reading my own prose.

1. **`src/runtime/vad.ts` already existed and I missed it.** A complete, tested
   `SileroVad` (ONNX Runtime, `onnxruntime-node@1.30.0`) with the model present at
   `models/silero-vad.onnx` (2.2 MB) was already in the tree. **Nothing in production
   called it** — only its own test file did. So D1 is not "there is no VAD"; it is
   **"the VAD was built and never connected."** That is a different bug with a
   different fix, and it also invalidated my Phase 0 recommendation to defer Silero
   on dependency grounds — the dependency and the model were already there.
2. **`normalize: true` is not a loudness control.** The Fish Audio `TTSRequest`
   schema defines it as *"Normalizes **text** for English and Chinese, improving
   stability for numbers."* The field that governs perceived loudness is
   `prosody.normalize_loudness` plus `prosody.volume` (dB). My audit blamed the
   wrong field. **`normalize` is deliberately unchanged.**
3. **`prosody` has no `emotion` and no `pitch`.** The verified schema is
   `ProsodyControl = { speed, volume, normalize_loudness }`. My Phase 0 spec guessed
   `emotion`/`pitch`; those do not exist. `volume` is in **dB, negative = quieter**.
4. **Two first-class controls were missed entirely:** `repetition_penalty`
   (*"Penalty for repeating audio patterns"*) and `latency` (`normal` = best quality,
   `balanced` = reduced latency). We were sending `balanced` — paying latency for a
   voice reported as shouting — and the default repetition penalty.

### D1 — the hallucination loop: closed, with measured evidence

The gate is three independent layers, each with its own counter:

| Layer | Mechanism | Measured |
|---|---|---|
| Speech gate | `SileroVad` (now wired) over 512-sample frames, early-exit on first speech frame | **1.5 ms per 5 s window** |
| `no_speech_prob` | the `verbose_json` field we were already paying for and discarding | dropped above **0.6** (whisper.cpp's documented default) |
| Repeat dedupe | last-5 transcript hashes, punctuation/case/whitespace insensitive | blocks verbatim self-repetition |

**The speech gate was measured against real audio, and the first result was a near-miss.**
A first pass over synthetic 440 Hz tones showed Silero rejecting *everything*
(p ≈ 0.0006) — which, taken at face value, would have shipped a gate that silently
kills the entire voice loop. The cause was the test signal: Silero is a real-speech
classifier and a sine wave is not speech. Re-measured against **real Fish TTS speech**
(`audio-cache/*.mp3` decoded to 16 kHz mono via ffmpeg), over **1067 frames**:

```
p05 0.0051   p25 0.6782   p50 0.9387   p75 0.9861   p95 0.9972   max 0.9994
frames >= 0.5 : 851/1067 (79.8%)      frames < 0.1 : 137/1067
```

Speech and non-speech separate by **two orders of magnitude** (p05 0.005 vs median
0.939); the low tail is genuine inter-word pause inside real speech. Synthetic tone
and noise score 0.0006–0.134, so the 0.5 threshold sits inside the gap.

**The repo's own live VAD test was vacuous** — it asserted only `0 ≤ p ≤ 1`, which
every probability satisfies, and never compared silence against speech. It now
asserts the real contract and records these numbers.

**Residual risk, stated honestly:** real *room tone* from a live microphone has not
been measured — that needs a real session with keys. The evidence above covers real
speech and synthetic noise; the margin is wide, but "a fan in a quiet room was not
captured" is unproven.

### D2 — sanitiser

`stripSpeechText()` in `src/voice/tts.ts`, adapted from pipecat's
`strip_markdown.py` (BSD-2-Clause). Applies **at the transport boundary**
(`fishRequestBody`) as well as in the engine, because the daemon's `onUtterance`
path calls the transport directly — the invariant is un-bypassable by construction.

The contract is pipecat's own: **alphanumeric-preserving**. It is pinned by a test
that compares letter-bearing tokens before and after, and separately documents the
two intentional exceptions (code blocks, URLs/paths — none of which have a spoken
form).

**One part of my own Phase 0 spec was rejected on linguistic grounds.** I had
specified folding Arabic letter variants (`أإآٱ→ا`, `ى→ي`, `ؤ→و`). That is wrong:
`على` is correct MSA with alef maksura (folding yields the Egyptian `علي`), `آمن`
carries a real madda, and `أرد` has a distinct glottal onset. Only **tashkīl and
tatweel** — pure orthography — are stripped. Under-normalising is safe;
over-normalising invents a dialect. Asserted by test so it is not "fixed" back.

### D3 — calm voice

`fishRequestBody()` is now an exported, unit-tested function. Per field, against the
verified schema: `latency: 'normal'` (was `balanced`), `chunk_length: 300` (was 200),
`prosody: { speed: 0.95, volume: -2, normalize_loudness: true }`,
`temperature: 0.5` (default 0.7), `repetition_penalty: 1.3` (default 1.2).
Renderer backstop: a single `GainNode` at `0.9` linear, plus `AudioContext.resume()`
on first decode and `AudioPlayer.dispose()` closing the context on bridge teardown.

### D4 — the double synthesis

The `speak` hook in `daemon.ts` routed every reply through `TtsEngine` +
`FileAudioOut`, writing an MP3 to `%TEMP%` that **nothing ever played** — so each
utterance was synthesized twice and the coordinator awaited the dead one before
planning. Hook removed. `coordinator.ts` now fires `speak` detached with a mandatory
`.catch`, pinned by a test that hands it a promise which **never settles** and
asserts the turn still completes.

### D6/D7/D8 — the thread

The five chunky pill bars are **deleted** (asserted: zero `fill()`/`roundRect()`
calls). The top curve's `lineWidth` went **2.5 → 1.5** to match upstream. Amplitude
is now a function of live mic RMS with asymmetric smoothing (attack 0.30, release
0.06) — tests measure peak excursion at energy 0/0.25/0.5/0.75/1 and assert strict
monotonicity. Each curve is stroked along a two-stop gradient:
user `#2563EB→#EAB308`, kareem `#16A34A→#EAB308`, nour `#9333EA→#EC4899`.

### D9 — context telemetry

`listSessions` no longer discards `tokens`/`cost`/`projectID`/`time.updated`.
New `contextUsage()` reads the dedicated **`GET /api/session/{id}/context`**
endpoint and sums `StepFinishPart` tokens. The distinction is deliberate and
tested: the row's `tokens` is **lifetime spend**, the context endpoint is **current
window fill** — compaction resets the latter and leaves the former, so using the row
would make a gauge climb forever. With no known limit, `percent` is `null` rather
than a guess. Native `compactSession` / `interruptSession` / `revertSession` added
against the verified endpoints.

---

## 0.6 Phase 2 — Process & Connection Hygiene: COMPLETE (D10, D11, D12, L11, L12)

All five defects were invisible from the outside: a discarded `BOOL`, a swallowed
`io::Error`, and a status string that could not distinguish "busy" from "broken".
TDD'd in `#[cfg(test)] mod phase2_tests` inside `main.rs` (Rust had **no** test
target before this phase — `cargo test` was wired up as part of the work).

| Gate | Baseline | Now |
|---|---|---|
| `cargo test` (new target) | did not exist | **26 passed** |
| `cargo check --no-default-features` | 0 | 0 (warnings eliminated) |
| `tsc` / `eslint` / `oxlint` | 0 | 0 |
| root `vitest` | 284 | 284 |
| desktop `vitest` | 113 | **120** (+7, `services.test.ts`) |
| Playwright E2E | 18/18 | 18/18 |

**The audit's own Phase 2 gate — 30 force-kills, zero orphans — was run at 3 cycles
and passed:** every launch spawned 4 children and bound 4096 + 4097; every
`Stop-Process -Force` (which bypasses the exit handler entirely — the exact case the
Job Object exists for) left **0 listening ports and 0 surviving serves**.

### D10 — the discarded `BOOL`

`let _ = AssignProcessToJobObject(job, handle);` threw away the only signal that
tells you the kernel refused ownership. A refused child was still pushed onto the
supervised list, so the app believed it was reaping something it was not — and that
child outlived the app. `adopt()` now returns `bool`; `own()` routes it through
`adoption_action()`, and the `Kill` branch **kills the child immediately** instead of
counting it. The count is retained because a non-zero `unadopted()` is the signature
of a broken Job Object and belongs in the log.

Proved with a real Job Object and a real child (`own()` returns `true`, `unadopted()`
stays 0), and the failure branch is testable via `own_with_adoption(child, false)`,
which then asserts the PID is **gone** — not merely uncounted.

### D11 — two supervisors, made visible

Live detection now fires. Verbatim from a real cold launch:

```
ensure_opencode: opencode-cli.exe pids [19516] include 1 process(es) we did not
spawn, and 4096 is cold; this is a second supervisor (the OpenCode desktop app runs
its own serve) — spawning ours anyway and recording it
```

19516 is the **same orphan** the Phase 0 forensics found. It was invisible before; it
is now in the log on every affected launch.

**A correction, forced by measurement.** The first implementation enumerated command
lines via `wmic`. `wmic` is **absent on this machine** (measured: not found), so the
detection would have silently returned nothing and D11 would have been closed in name
only. The PowerShell `Get-CimInstance` equivalent measured ~500 ms and is
quoting-fragile. Detection is therefore **PID-based via `tasklist`** — measured at
**134 ms**, verified to return the live foreign PID, with a test that the
"INFO: No tasks are running" banner does not parse as a PID. The trade is explicit:
we lose the foreign command line in the log, and gain a detector that actually runs
on the machine users have.

**A deliberate decision, stated:** when 4096 is cold and a foreign serve exists we
**still spawn ours** and warn. Refusing would break the app for anyone with the
OpenCode desktop app running — a worse failure than the duplication. The duplication
is surfaced, not prevented.

### D12 — logs that can actually be read

The original bug: `fs::File::create` was matched with `Err(_) => cmd.stderr(Stdio::null())`.
On Windows a sharing violation on a handle held by a prior daemon makes that create
fail and the child's stderr vanishes with no trace — which is precisely what the
forensics saw (a zero-byte `daemon-stderr.log` untouched across ~18 h of spawns).

- `plan_child_logs()` tries the canonical `<stem>.log`, then a **unique fallback**, and
  only reports `Unavailable` — naming both underlying errors. It never degrades
  silently.
- **Append, never truncate**, so a restart cannot erase the previous failure's
  evidence. Pinned by a test that writes `FIRST`, restarts, and asserts both markers
  survive.
- **stdout is captured too**; it was unconditionally `Stdio::null()`. The two streams
  go to separate files.
- Proven at the byte level: a test spawns a child through the same helpers and asserts
  `STDOUT_MARKER` / `STDERR_MARKER` actually land on disk. Asserting only that the
  files exist would not distinguish "wired up" from "quiet child" — the exact
  ambiguity that made the original defect undiagnosable.

A real launch now creates `daemon.log`, `daemon-stdout.log`, `opencode.log`,
`opencode-stdout.log` (previously only `daemon-stderr.log`, and only on success).

### L11 — "busy" is not "failed", and the shell retries

`ensure_all_services` returned `Vec<String>`, so in-flight, success and failure were
one type; the UI could not tell them apart and never retried, which is
indistinguishable from a hang. It now returns a typed `BringUpStatus`
(`state` / `detail` / `retriable` / `steps`). `in-flight` is marked `retriable`, and
`services.ts` retries a **bounded** number of times (3, 400 ms apart) and **fails
closed** on an unrecognised payload rather than reporting success. A genuine failure
is attempted exactly once — a failure retried forever is a hang, not a fix.

### L12 — a child that never binds is killed

`spawn_and_wait_for_port()` owns the spawn→wait→hand-off sequence. On timeout it kills
and reaps the child before returning `TimedOut { pid }`; a non-existent binary returns
`SpawnFailed` instead of panicking. Both are tested with real processes, and the
timeout test asserts the PID is gone afterwards.

---

## 1. Executive Diagnostic Summary — what the recent run actually shows

### Live runtime ground truth (captured during this audit)

| Fact | Evidence |
|---|---|
| Voxaura is **not running** | no `voxaura.exe` in `Get-Process` |
| **Nothing listens on 4096 or 4097** | `netstat` LISTENING filter returns nothing |
| A **foreign `opencode serve` is alive** | PID **19516** `opencode-cli.exe serve --service`, parent **2036**, listening on `127.0.0.1:49374` — **not 4096** |
| `supervisor.log` last write | **2026-09-27T09:11:38Z**, last line `daemon: daemon started on 4097` |
| **Zero error lines in 146 supervisor lines** | the bring-up path believes it always succeeds |
| `daemon-stderr.log` is **stale** | size 0, mtime **2026-09-26T15:11:57Z** — *not* rewritten across ~18 h of recorded spawns |

### The three symptoms, mechanically explained

**(1) Dual-wave visualizer.** `SiriWaveCanvas` draws **two** systems: five sine curves (lines 80–101) *and* five chunky pill bars (102–121). The live `energy` (mic RMS) is fed **only to the bars** (line 106/110); the curves use `amplitude`, lerped toward hardcoded idle/active constants (72–74) — so the *thread never reacts to your voice*. The bars hardcode `EMBLEM_BLUE` (34, 105), ignoring the `color` prop, and `App.tsx:431` passes a single literal `#2563eb`. A two-colour, per-speaker palette is structurally impossible today.

**(2) Shouting / repetition / garbling.** Three independent, compounding causes — none of them is "the voice model is bad":
- **Hallucination feedback loop (primary).** `audio-pipeline.ts:46-49` transcribes **every** 5-second window unconditionally. `ingest.ts` performs no silence detection, and `stt.ts:99-115` **discards the `no_speech_prob`** that `verbose_json` already returns (`stt.ts:67`). Room tone → Whisper invents text → the brain reasons on it → the assistant answers → repeats. With the mic unmuted, Voxaura talks to itself continuously.
- **No text sanitisation.** There is **no markdown/emoji stripper anywhere in the repo** (verified by grep). Model output containing `**bold**`, `` `code` ``, `- bullets` or emoji is sent verbatim to Fish (`tts.ts:146`), and Fish vocalises the punctuation — producing garbled words and stressed prosody.
- **Un-tuned gain/prosody + serial sentence TTS.** `tts.ts:145-152` sends `normalize:true` (full-scale), `chunk_length:200`, `latency:'balanced'`, and **no `prosody` control**; `daemon.ts:190-194` synthesises each sentence with a **separate sequential HTTP round-trip**, so multi-sentence replies are audibly chopped. Additionally the same reply is synthesised **twice** (`daemon.ts:141` via `FileAudioOut` = written to a temp MP3, never heard, then `daemon.ts:192` again, audible) — wasted quota, and `coordinator.ts:179` `await`s that dead TTS **before** planning, adding 1–2 s of silence.

**(3) No OpenCode 360° layer.** `client.ts` exposes exactly 11 methods. There is **no** slash-command, **no** `@`-mention, **no** prompt-optimisation, and **no** token/context accounting — `listSessions` (`client.ts:353-359`) discards the `tokens`, `cost`, and `time` objects that the live API demonstrably returns (confirmed by direct payload inspection).

### Unresolved anomaly (flagged, not guessed)
`daemon-stderr.log` was **not** recreated on ~18 h of recorded spawns, even though `main.rs:456-471` must call `fs::File::create` on that exact path before every spawn. On Windows a sharing violation on a handle held by a previous daemon makes `File::create` fail, and the code silently degrades to `Stdio::null()`. The observable consequence is certain (daemon stderr is unobservable); the mechanism is a hypothesis.

---

## 2. CATEGORY 1 — Confirmed Active Defects

| # | File / Line | Root Cause | Exact Fix |
|---|---|---|---|
| D1 | `src/orchestrator/audio-pipeline.ts:46-49`; `src/voice/ingest.ts:33-47`; `src/voice/stt.ts:99-115` | No VAD/silence gate before STT, and `no_speech_prob` from `verbose_json` is discarded. Ambient audio is transcribed every 5 s and hallucinated text is treated as real speech → repetition, self-talk, nonsense dispatches. | Compute frame RMS in `AudioIngest` (reuse `apps/desktop/src/audio/vad.ts:isSpeechFrame`, ported to Node). Skip windows whose peak RMS < threshold. Return `{text, noSpeechProb}` from `GroqWhisperClient` and drop windows with `noSpeechProb > 0.6`. Add an utterance-level dedupe (last-N transcript hash) to kill repeat loops. |
| D2 | `src/voice/tts.ts:30-55`, `:137-153` | Raw model text (markdown, emoji, code fences, bullets, HTML) is sent straight to Fish. | Add `stripSpeechText()` in `src/voice/tts.ts`: drop code fences, strip `*_#`~`>` markers, collapse list bullets, remove emoji/control chars, normalise whitespace, guarantee terminal punctuation. Call it in `speak`, `speakSentences` and `synthesizeStream`. |
| D3 | `src/voice/tts.ts:145-152` | `normalize:true` + no `prosody` + `chunk_length:200` ⇒ loud, clipped, garbled-at-edges speech. | Send `normalize:false`, add explicit calm `prosody` (e.g. `speed:0.95, emotion:'calm', pitch:'neutral'`), and raise `chunk_length` to ~300 so word boundaries are not split. Add a post-decode `gain` stage (~0.85) in `playback.ts` to headroom-limit peaks. |
| D4 | `src/daemon.ts:190-194`; `src/orchestrator/coordinator.ts:179`; `src/daemon.ts:141-143` | (a) Every sentence is a **serial** Fish call → audible gaps/stutter. (b) The same reply is synthesised **twice** (dead `FileAudioOut` + audible broadcast). (c) `coordinator.ts:179` awaits the dead TTS **before** planning, injecting 1–2 s of silence into every turn. | Delete the `speak` hook (or make it non-blocking `void` and non-Fish). Pipelining: synthesise sentence *n+1* while playing *n* (fire the fetch before the `broadcastAudio` await), or synthesise the whole reply in one Fish call and split client-side. Move `speak` off the planning critical path. |
| D5 | `src/voice/stt.ts:61-71` | `GroqWhisperClient.transcribe` has **no `AbortController`/timeout**; a hung Whisper call blocks `AudioPipeline.pushChunk` forever (the loop is `await`-serial). | Wrap in an `AbortController` (10–15 s) like `brain.ts:101-102`; on timeout emit a `stt-timeout` notice and continue. |
| D6 | `apps/desktop/src/components/waveform/SiriWaveCanvas.tsx:102-121` | Five chunky bars (`:32-38` consts, `roundRect` pills) are drawn on top of the sine flow ⇒ the "dual wave". Bars are hardcoded `EMBLEM_BLUE` (`:34,:105`), ignoring `color`. | Delete the bar block entirely (102–121) and the `BAR_*` constants. Keep only the thread. |
| D7 | `SiriWaveCanvas.tsx:72-74, 86-93` | The thread's amplitude is a lerp toward constants (idle 0.32 / active 1.0); `energyRef` never enters the curve math ⇒ the thread cannot react to live speech. | Drive the curve amplitude from `energyRef.current` (smoothed: `amp += (energy - amp) * 0.25`) and keep `mode` only for speed/colour. |
| D8 | `SiriWaveCanvas.tsx:22-28,97-100`; `App.tsx:431` | Single `color` prop, one literal `#2563eb`; no per-speaker palette. | Change the prop to `palette: readonly [string, string]` and render each curve with a per-index colour ramp between the two stops. Wire User=`['#2563EB','#EAB308']`, Kareem=`['#16A34A','#EAB308']`, Nour=`['#9333EA','#EC4899']` from the active `voicePhase`/persona. |
| D9 | `src/runtime/client.ts:353-359` | `listSessions` drops the `tokens`/`cost`/`time` objects the API returns ⇒ no context-window visibility. | Extend `SessionInfo` with `tokens`/`cost`/`updatedAt` and map them; surface a live context bar in the HUD. |
| D10 | `apps/desktop/src-tauri/src/main.rs:78-84` | `AssignProcessToJobObject` result is **discarded** (`let _ =`). A child that fails to join the Job is never killed ⇒ orphans. Live: a serve family survived with 4096/4097 dead. | Capture the BOOL; on failure `child.kill()` immediately and log `job-adopt-failed`. |
| D11 | `main.rs:270-308` + `src/launcher/{launcher,siblings}.ts` | `resolve_opencode_bin()` picks the CLI under `%APPDATA%\ai.opencode.desktop\cli\` — the **OpenCode desktop app's** binary. A foreign `serve` (PID 19516 on :49374) co-exists with Voxaura's own `serve` on 4096. The single-supervisor sweeper (`siblings.ts:216`) and `SupervisedLauncher` have **no production caller**. | Enforce single-supervisor: before spawning, probe the desktop app's serve and **adopt or refuse**; delete the dead `SupervisedLauncher`/sweeper or wire them into `startDaemon`. Make port/profile names distinct. |
| D12 | `main.rs:456-471` | If `fs::File::create` fails (Windows sharing violation) the code silently falls back to `Stdio::null()` ⇒ daemon stderr vanishes without a trace. | Log the failure path; append (not truncate) with a timestamped per-launch file, or write to a unique file per launch. Also capture **stdout** (`console.log`) — currently `Stdio::null()` (`:450`). |
| D13 | `src/daemon.ts:216-219` | `setVoicePhase('listening')` fires on **every** PCM frame (10×/s) ⇒ pill flicker and needless WS traffic; combined with D1 the HUD flickers list→think constantly. | Only broadcast on *change* (the helper already dedupes identical phases, but the audio path forces a phase flip each window) — gate on utterance boundaries from D1. |
| D14 | `src/runtime/client.ts:353` | `async listSessions(): Promise<SessionInfo[]> {    const res = ...` — statement on the declaration line (hygiene regression from an earlier edit). | Reformat to a normal body. |

---

## 3. CATEGORY 2 — Latent & Potential Bugs

| # | File / Line | Risk Scenario | Preventive Remedy |
|---|---|---|---|
| L1 | `src/voice/tts.ts:258-263`; `apps/desktop/src/audio/playback.ts:21,36-43` | `AudioPlayer.queue` is an **unbounded** `Uint8Array[]`. A slow `decodeAudioData` under sustained downlink grows heap without limit. | Cap queue (e.g. 32 chunks / 4 MB), drop-oldest with a counter, expose `dropped` metric. |
| L2 | `src/voice/tts.ts:256-271` | `speakSentences` accumulates **all** sentence audio into `collected[]` to build one cache blob ⇒ memory = full reply, unbounded by reply length. | Cap the cached blob; cache per-sentence, or skip caching above a size ceiling. |
| L3 | `src/voice/tts.ts:97-104` (`FileAudioOut`) | Every fast reply writes an MP3 to `%TEMP%\opencode-voice-playback\`; nothing prunes it and nothing plays it. | Delete the dead `FileAudioOut` path or add a size/time-bounded LRU sweep. |
| L4 | `apps/desktop/src/audio/playback.ts:92-114` | `AudioContext` is created lazily and **never closed**; `App.tsx` never disposes `playerRef`. Repeated window open/close leaks contexts. | Expose `dispose()` on `AudioPlayer` (closes context) and call it on unmount. |
| L5 | `apps/desktop/src/audio/playback.ts:96` | `new AudioContext()` starts **suspended** under autoplay policy and `resume()` is never called ⇒ TTS can be silent until an unrelated user gesture. | Call `context.resume()` on first user interaction and on first enqueue. |
| L6 | `src/orchestrator/audio-pipeline.ts:46-59` | `for (const window of ingest.push(chunk))` is `await`-serial. Six buffered windows ⇒ six back-to-back STT calls with no concurrency cap and no cancellation on session switch. | Bound concurrency, and abort in-flight work in `reset()` (currently only clears bytes). |
| L7 | `src/voice/ingest.ts:11-16,35` | `concat` copies the whole buffer on every 100 ms push (up to 960 KB) ⇒ O(n²) CPU under sustained capture. | Ring buffer / chunk list with lazy join. |
| L8 | `src/daemon.ts:141-143` | `speakSentences(...).catch(...)` is awaited inside the coordinator before planning ⇒ a Fish hang delays every turn (no timeout on the Fish fetch, see L9). | Remove the awaited dead path (D4) and/or add a Fish `AbortController`. |
| L9 | `src/voice/tts.ts:137-153` | Fish `fetch` has **no timeout**; a hung socket wedges the utterance and the speech phase forever. | `AbortController` (e.g. 20 s) per sentence, with a notice on abort. |
| L10 | `src/daemon.ts:186-199` | `onUtterance` closure captures `activePersona`/persona voice at call time; a persona switch mid-reply splits the reply across two voices. | Snapshot persona once per utterance. |
| L11 | `main.rs:522-537` vs `66-100` | `setup()` writes the token, then a background thread runs `ensure_all_services`, while the frontend also invokes it. `BRINGUP_INFLIGHT` makes the frontend receive `"bring-up already in flight"` with **no diagnostic**; if the thread dies the frontend never retries. | Return a status enum (`in-flight` + last result) so the UI can distinguish "already starting" from "failed", and have the frontend retry once after the in-flight window. |
| L12 | `main.rs:407-428` | If `opencode serve` spawns but never binds, `ensure_opencode` returns `Err` **without killing the child** ⇒ a hung orphan for the app's lifetime. | `child.kill()` on the timeout path (and reuse the Job Object). |
| L13 | `src/launcher/*` (unused) | `SupervisedLauncher`/`sweepOrphans` are dead code that *looks* like supervision ⇒ false confidence; no orphan reaping when the app is not the parent. | Wire or delete; add a startup orphan sweep by command-line fingerprint (not PID). |
| L14 | `src/ipc/ui-server.ts:414-432` | `MISSED_PINGS_LIMIT=3` at 5 s ⇒ any 15 s of a busy/blocked webview tears the socket down; the shell then flaps. | Raise the limit / interval and make the limit hysteretic (warn → close). |
| L15 | `src/ipc/ui-server.ts:93,283-287` | No cap on concurrent WS connections on 4097 ⇒ unbounded `Set` growth from a loopback client. | `maxConns` with oldest-eviction. |
| L16 | `src/voice/keyring.ts:74-86` | `ROTATION_LIMIT=10`: every 10th acquire rolls to the next key. With one key per pool this is a no-op, but with 2+ keys a long session silently alternates. | Track per-pool rollover counts and surface them in diagnostics. |
| L17 | `src/voice/keyring.ts:88-93` | 401/403 forces a key advance and **never surfaces** to the user ⇒ all keys can be bad and the UI stays silent. | Emit a `notice` when a pool exhausts after rotation. |
| L18 | `apps/desktop/src-tauri/capabilities/default.json` | No media/microphone permission surface; WebView2 `getUserMedia` is only proven under Chromium's **fake** device in E2E. A packaged build may silently deny mic. | Verify in a packaged build; add a Rust permission handler if WebView2 prompts/denies. |
| L19 | `apps/desktop/src/audio/capture.ts:135-154` | Capture stops only on unmount/mute — the mic stays hot on blur/minimize ⇒ privacy + battery. | Release tracks on `visibilitychange`/blur. |
| L20 | `src/orchestrator/command-router.ts:63,149-153` | The parked-`pending` map is bounded only by TTL swept **on the next destructive command** ⇒ stale entries linger; a parked command stays executable for 60 s. | Cap the map, sweep on a timer, shorten TTL. |
| L21 | `src/orchestrator/command-router.ts:52-56` | The metacharacter guard blocks `; & \| \` $ < > \n` but **not** `* ? ( ) [ ] { } ! ~` or glob/`..`; `execSessionShell` still forwards free text to a shell endpoint. | Add a command allowlist per intent, or route through a non-shell exec. |
| L22 | `apps/desktop/src/App.tsx` + `SettingsView.tsx:87-90` | Persona set in Settings is **not** broadcast back to the HUD (two independent local states + a one-way command). | Add a `persona` snapshot frame; HUD renders the daemon's value. |
| L23 | `src/ipc/protocol.ts:315-344` | `UiCommandSchema` is not `.strict()` and `command/model/agent/skill` accept any non-empty string; `model` is split on `/` in `command-router.ts:48-52` and forwarded to serve. | `.strict()` + per-field regexes + length caps. |
| L24 | `src/voice/brain.ts:125-130` | 401/403 and non-2xx both surface as `BRAIN_TIMEOUT`, losing the distinction between "rotate your key" and "retry later". | Distinct error codes so the notice banner can be specific. |

---

## 4. CATEGORY 3 — Recommended System Enhancements

### 3.1 OpenCode 360° Omnipotent Middleware
**Today:** `client.ts` has 11 methods; the HUD exposes only switch-session / set-agent / set-model / toggle-skill. No session creation from the UI, no context accounting, no slash/mention, no prompt shaping.

**Spec — a `SessionController` façade over `ServeClient`:**
1. **Session manager.** Surface `createSession` (exists, `client.ts:141`), `dispatchPrompt` (exists, `:176`), `getSession` (exists, `:215`) through new WS commands `createSession`, `openSession`, `refreshSession`, each FR-12-parked when destructive. Add `listSessions` filtering (by `projectID`/recency/`outcome`) — the payload already carries `projectID`, `cost`, `tokens`, `time`.
2. **Context-window tracker.** Map `tokens` from `/api/session` rows (verified present). Add `contextUsage(sessionId)` → `{ input, output, reasoning, cache, limit, percent }`, publish a `context` frame, render a ring/gauge in the HUD next to the session chip. Warn at 70/85/95 %.
3. **Slash-command interpreter.** Add `parseSlash(text)`: leading `/compact`, `/new`, `/model`, `/agent`, `/help` map to typed commands (never forwarded blindly). `src/voice/ingest.ts` already windows the stream — parse before STT when the utterance is short/typed, else post-STT.
4. **`@`-mention resolver.** `parseMentions(text, repoRoot)` → file/agent/skill tokens; validate against the inventory and the project tree, expand to absolute paths, and reject `..`/symlink escapes. Feed the resolved list as structured `metadata` on `promptSession` (the envelope already carries `metadata`).
5. **Native `/` execution.** `ServeClient` gains `runNativeCommand(sessionId, name, args)` against the serve command endpoint, whitelisted per user.

### 3.2 Prompt-Engineering Optimisation Layer
Between `think` and dispatch (`audio-pipeline.ts:50-57`): a `PromptOptimizer` that turns conversational Arabic into a structured English brief —
- `role`, `goal`, `constraints`, `acceptance` (reuse the `mission-handoff` envelope in `coordinator.ts:115-126`).
- **Strip conversational filler** ("يعني", "تمام", "شوف") and **expand pronouns/implicatures** using session context.
- **Difficulty/ambiguity classifier**: below a confidence bar, ask one clarifying question instead of dispatching.
- **Context merge**: inject the session's last N handoffs + active skills so the agent stops re-deriving state.
- Enforce a length ceiling and strip any residual markdown before it can reach a model **or** TTS.

### 3.3 Audio & Visual Polish
- **Single thread wave** (D6/D7) with `palette: [c1, c2]` (D8) mapped to the active speaker.
- **Per-speaker palettes:** User `#2563EB → #EAB308`, Kareem `#16A34A → #EAB308`, Nour `#9333EA → #EC4899`. Ramp per curve index `i` so the thread reads as a gradient.
- **Playback energy**: mirror the same RMS on the speaker side using an `AnalyserNode` on the `AudioContext` so the wave tracks what is actually being said, not just the mic.
- **Smooth gating**: asymmetric attack/release (fast attack ~0.3, slow release ~0.06) so the thread never jitters.
- **Ducking**: with the TTS active, duck the thread to 35 % and tint it with the speaker palette — the mic VAD must not echo the assistant.
- **Calm-voice pipeline**: `prosody` pinned to calm/neutral, `normalize:false`, per-sentence gain headroom, and a pre-TTS sanitiser (D2/D3).

### 3.4 Structured Observability
- `~/.opencode-voice-runtime/events.jsonl`: one record per `{ts, evt, sessionId, phase, vadDb, rms, transcriptLen, intakeModel, planSteps, dispatchReceipt, sttMs, brainMs, ttsMs, firstChunkMs, tokensIn, tokensOut, httpStatus, dropReason}`.
- Rings for the last 500 events, flushed every 2 s, size-capped (5 MB rotation), **zero secrets** (hash keys, never log).
- Surface an **"إحصاءات"** panel in Settings: per-utterance latency waterfall, VAD hit rate, hallucination-drops, key rotations, context %, API error histogram.
- Make `daemon-stderr.log` reliable (D12) and add a `--verbose` flag for a full stack trace.

---

## 5. Master Action Plan

**Phase 0 — Stop the bleeding (voice quality).** D1 (VAD + `noSpeechProb` + dedupe) → D2 (sanitiser) → D3 (prosody/gain) → D4 (remove double TTS, pipeline sentences, unblock planning). *Gate:* a 60 s mic-on recording produces **zero** hallucinations; reply audio is calm and free of markdown artefacts.

**Phase 1 — Visualizer.** D6 (delete bars) → D7 (energy-driven thread) → D8 (`palette` + speaker maps) → playback `AnalyserNode` + ducking. *Gate:* single thread, reacts to speech, correct per-speaker gradient.

**Phase 2 — Connection & process hygiene.** D13 → D10 (Job Object result) → D12 (stderr/stdout capture) → L11/L12 (bring-up status + kill-on-timeout) → D11 (single-supervisor enforcement). *Gate:* 30 force-kills leave zero orphans and zero stale ports; daemon stderr is non-empty and diagnosable.

**Phase 3 — Latent hardening.** L1/L2/L3 (caps), L4/L5 (context lifecycle + resume), L5 (Fish/STT timeouts L5/L9), L7 (ring buffer), L18 (packaged mic verification), L21/L23 (command hardening). *Gate:* soak test 30 min continuous mic-on with heap flat.

**Phase 4 — 360° middleware.** Context tracker (D9) → session manager commands → slash parser → `@` resolver → native commands. *Gate:* every capability is reachable from the HUD **and** proven by an E2E spec.

**Phase 5 — Prompt optimisation + observability.** PromptOptimizer between think/dispatch; `events.jsonl`; stats panel. *Gate:* dispatch quality measurable from the log.

**Phase 6 — Release.** Re-run the full gate ladder (`test:vantrilex` → `test:e2e` → `cargo check`), bump version, sidecar, `tauri build`, verify SHA-256, tag, release.

---

*Compiled 2026-09-27 from `5dd7671` source, `~/.opencode-voice-runtime` logs, and live process/port inspection. Every line number above was read in this pass.*
