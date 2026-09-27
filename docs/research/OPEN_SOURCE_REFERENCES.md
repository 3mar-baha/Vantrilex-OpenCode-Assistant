# Open-Source Reference Architecture — Phase 0 Intelligence

**Project:** Voxaura (Tauri v2 + Node daemon over OpenCode v2)
**Workspace:** `O:\opencode-Vantrilex` @ `5dd7671` (`v0.5.0`)
**Compiled:** 2026-09-27
**Method:** every repository, file path, code block, CLI flag, and endpoint below was fetched
from primary source and read in this pass. Nothing is recalled from training data. Star counts
and `pushed_at` are as of 2026-09-27.

> **Phase 0 is read-only w.r.t. application code.** No file under `src/` or
> `apps/desktop/src/` was modified during this phase.

---

## 0. Verification ledger

| Source | Verified artefact | Method |
|---|---|---|
| `sst/opencode` → **`anomalyco/opencode`** (210,308★, MIT, branch `dev`) | `packages/sdk/js/src/v2/gen/types.gen.ts` (254,788 B) | raw fetch + local grep |
| `pipecat-ai/pipecat` (15,908★, BSD-2-Clause) | `src/pipecat/utils/text/transforms/strip_markdown.py`; dir listing of `utils/text/` | raw fetch + GitHub Contents API |
| `snakers4/silero-vad` (10,307★, MIT) | `README.md` | raw fetch |
| `ggml-org/whisper.cpp` (53,952★, MIT) | `examples/stream/README.md` | raw fetch |
| `livekit/agents` (14,371★, Apache-2.0) | `livekit-agents/livekit/agents/voice/endpointing.py`, `.../audio_recognition.py` | raw fetch |
| `Kopiro/siriwave` (1,731★, MIT) | `README.md` (option table + `curveDefinition`) | raw fetch |
| `hvianna/audioMotion-analyzer` (953★, **AGPL-3.0**) | `README.md` (72,935 B) | raw fetch + license check |
| `ricky0123/vad` (2,059★) | existence + license confirmed via API | repo API |

### Rejected sources (recorded so they are not re-researched)

| Source | Reason for rejection |
|---|---|
| `YellowKidokc/TTS-Cleaner` | 0 stars, **no license file** — not legally reusable, not production-trusted. Priceless lesson inside it though: it independently confirms the markdown-strip requirement as a *feature request*, corroborating Pillar B. |
| `ssmd` (Speech Synthesis Markdown) | `ssimonw/ssmd` returns 404; the readthedocs site could not be tied to a licensed repository. Not cited. |
| Any AGPL-3.0 source as a code donor | `audioMotion-analyzer` is AGPL-3.0. **Reference for technique only — no code may be copied into Voxaura**, which is MIT/proprietary-distributed. |

---

## Pillar A — VAD silence gating & anti-hallucination

**Our defect:** D1 — `src/orchestrator/audio-pipeline.ts:46-49` transcribes every 5-second
window unconditionally; `src/voice/stt.ts:99-115` discards the `no_speech_prob` that
`response_format: 'verbose_json'` already returns. Ambient audio is hallucinated, reasoned
about, and spoken back.

### A1. whisper.cpp — the gate + pre-roll pattern (the most directly portable idea)

`ggml-org/whisper.cpp/examples/stream/README.md`, verbatim:

> Setting the `--step` argument to `0` enables the sliding window mode:
> `./build/bin/whisper-stream -m ./models/ggml-base.en.bin -t 6 --step 0 --length 30000 -vth 0.6`
>
> In this mode, the tool will transcribe only after some speech activity is detected. A very
> basic VAD detector is used, but in theory a more sophisticated approach can be added. The
> `-vth` argument determines the VAD threshold - higher values will make it detect silence
> more often. It's best to tune it to the specific use case, but a value around `0.6` should
> be OK in general.
> When silence is detected, it will transcribe the last `--length` milliseconds of audio and
> output a transcription block that is suitable for parsing.

Two transferable mechanics:

1. **Gate on speech probability, not on a fixed timer.** A window is only worth transcribing
   once a detector says speech is present. `0.6` is a documented-reasonable default, not a
   guess.
2. **Keep a lookback buffer (`--length`).** The audio that *ends* the turn (the last
   consonant) is *below* the threshold by definition. Emitting "the last 30 000 ms" means the
   final phoneme is never clipped. This is the single most commonly missed detail in naive
   VAD implementations and it is why they cut people off mid-word.

### A2. Silero VAD — the accuracy reference, and its cost envelope

From `snakers4/silero-vad/README.md`:

> One audio chunk (30+ ms) takes less than **1ms** to be processed on a single CPU thread.
> Using batching or GPU can also improve performance considerably.

> - Example of VAD ONNX Runtime model usage in C++
> - Voice activity detection for the browser using ONNX Runtime Web (`ricky0123/vad`)
> - Optional offline ONNX sequence inference (`examples/onnx_sequence`) for long recordings

Implication for Voxaura: a sub-1 ms per 32 ms frame detector is **~3 % of one core** — free.
There is no performance argument against real gating. The obstacle is purely integration
(`onnxruntime-node` is a native module and would need to ship inside the sidecar).

### A3. LiveKit Agents — endpointing as a state machine (this is the barge-in model)

`livekit-agents/livekit/agents/voice/endpointing.py`:

```python
class BaseEndpointing:
    def on_start_of_speech(self, started_at: float, overlapping: bool = False) -> None: ...
    def on_end_of_speech(self, ended_at: float, interruption: NotGivenOr[bool] = NOT_GIVEN) -> None: ...
    def on_start_of_agent_speech(self, started_at: float) -> None: ...
    def on_end_of_agent_speech(self, ended_at: float) -> None: ...

class DynamicEndpointing(BaseEndpointing):
    def __init__(self, min_delay: float, max_delay: float, alpha: float = 0.9): ...
    def between_utterance_delay(self) -> float: ...
    def between_turn_delay(self) -> float: ...
    def immediate_interruption_delay(self) -> tuple[float, float]: ...
```

And from `audio_recognition.py` — the anti-hallucination rule stated explicitly in a
production system:

```python
# We treat such an inconsistent anchor the same way we treat unreliable VAD: skip
def on_vad_inference_done(self, ev: vad.VADEvent) -> None: ...
```

Three design lessons we should copy:

- **Separate `on_start/end_of_speech` from `on_start/end_of_agent_speech`.** Two independent
  timelines. This is exactly what our ducking and barge-in logic (3.3) needs and what our
  current single `voicePhase` enum cannot express.
- **Adaptive delay, not a fixed delay.** `DynamicEndpointing(alpha=0.9)` widens the silence
  window over a turn, so long reasoning does not get cut off by a fixed 800 ms threshold.
- **"Skip on unreliable anchor" is a first-class policy**, not an error path. Silence is a
  normal outcome; it must be cheap and silent.

### A4. What was actually shipped, and the measurement behind it

**Correction.** This section previously recommended deferring Silero to Phase 3 on
dependency grounds, and asserted the gate could be built without it. Both were wrong:
`src/runtime/vad.ts` **already contained** a complete, tested `SileroVad` over
`onnxruntime-node`, and `models/silero-vad.onnx` (2.2 MB) was already on disk. The
defect was never "there is no VAD" — it was **"the VAD was built and never wired to
the pipeline."** The fix was to connect it.

Both layers ship, because they fail in different directions:

- **Silero** decides *is this speech?* Cost measured at **1.5 ms per 5 s window**
  (~0.03 % of the window), early-exiting on the first speech frame.
- **`no_speech_prob`** decides *did Whisper itself hear speech?* — a field
  `response_format: 'verbose_json'` already returned and we were discarding.
  Threshold **0.6**, matching whisper.cpp's documented `-vth 0.6` default.
- **Repeat dedupe** is ours: last-5 transcript hashes, punctuation/case/whitespace
  insensitive, cleared on `reset()`.

**How the threshold was chosen — and a near-miss worth recording.** A first
measurement over synthetic 440 Hz tones showed Silero rejecting *everything*
(p ~= 0.0006). Taken at face value that gate would have silenced the entire voice
loop, and the unit tests would not have caught it, because they stub the ONNX
session and return a fixed 0.9. The cause was the *signal*, not the model: Silero is
a real-speech classifier and a sine wave is not speech.

Re-measured against **real Fish TTS speech** (`audio-cache/*.mp3` decoded to 16 kHz
mono Int16 with ffmpeg), over **1067 frames of 512 samples**:

```
p05 0.0051   p25 0.6782   p50 0.9387   p75 0.9861   p95 0.9972   max 0.9994
frames >= 0.5 : 851/1067 (79.8%)       frames < 0.1 : 137/1067
```

Speech and non-speech separate by two orders of magnitude (p05 0.005 vs median
0.939); the low tail is genuine inter-word pause inside real speech, and synthetic
tone/noise score 0.0006-0.134. The 0.5 threshold sits inside that gap.

**Residual risk, stated rather than hidden:** real *room tone* from a live microphone
is unmeasured — that needs a real session with vault keys. The evidence covers real
speech and synthetic noise; the margin is wide, but "a fan in a quiet room is not
mistaken for speech" has not been observed on this machine.

**Gate blind spot found and fixed:** the repository's own live VAD test asserted only
`0 <= p <= 1`, which every probability satisfies — it never compared silence against
speech, so a completely broken model would have passed. It now asserts the real
contract and carries these numbers.

### A5. Anti-repetition layer (our defect, no external reference needed)

A second, independent hallucination vector: the assistant repeating a phrase because
the model did. Shipped in `AudioPipeline` as a bounded ring of the last **5**
normalised transcripts, compared per window:

- `repeatKey()` strips punctuation, collapses whitespace and lowercases, so
  `"نفس الجملة"`, `"  نفس الجملة  "` and `"نفس الجملة؟؟"` collapse to one key and
  the second and third are dropped. Pinned by test.
- `reset()` (session switch, mute) clears the ring, so a genuinely new turn may
  legitimately repeat a phrase the previous one used. Pinned by test.
- Counters `gatedWindows` / `hallucinationDrops` / `repeatDrops` attribute every
  silence to a cause, so the observability record can tell "gated", "hallucinated"
  and "repeated" apart instead of reporting one opaque "no reply".
- An empty-after-sanitisation transcript is never dispatched (see Pillar B).

A normalised *prefix* check was considered and not implemented: it has no evidence
behind it, and a near-duplicate matcher on Arabic conversational text produces false
positives that would silently swallow a legitimate repeated instruction. Bounded
exact-match-after-normalisation is the defensible subset.

---

## Pillar B — Pre-TTS text sanitisation & calm prosody

**Our defect:** D2 (no sanitiser exists anywhere — verified by grep) and D3
(`normalize: true`, no `prosody`, `chunk_length: 200`).

### B1. pipecat `strip_markdown` — the reference implementation, read in full

`pipecat-ai/pipecat/src/pipecat/utils/text/transforms/strip_markdown.py` (BSD-2-Clause,
safe to adapt with attribution). The complete chain:

```python
async def strip_markdown(text: str, aggregation_type) -> str:
    # Fenced code blocks (``` or ~~~)
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"~~~[\s\S]*?~~~", "", text)
    # Inline code
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Bold+italic ***text*** or ___text___
    text = re.sub(r"\*{3}(.+?)\*{3}", r"\1", text)
    text = re.sub(r"_{3}(.+?)_{3}", r"\1", text)
    # Bold **text** or __text__
    text = re.sub(r"\*{2}(.+?)\*{2}", r"\1", text)
    text = re.sub(r"_{2}(.+?)_{2}", r"\1", text)
    # Italic *text* or _text_
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    text = re.sub(r"\b_(.+?)_\b", r"\1", text)
    # ATX headers (# ## ### etc.)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Blockquotes
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    # Horizontal rules
    text = re.sub(r"^\s*[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    return text
```

Three properties worth copying verbatim in spirit:

1. **The docstring states an invariant:** *"This transformer is alphanumeric-preserving: the
   normalized alnum sequence of the output is identical to the input."* That guarantee is what
   makes a downstream word-completion tracker possible with no segment map. It is also exactly
   the property our tests should assert — the sanitiser must never eat a word.
2. **Deliberately does not touch link/image syntax**, because the *label* carries meaning:
   `re.sub(r"`([^`]+)`", r"\1", ...)` keeps content, drops the delimiter.
3. **Fenced blocks are removed, not read.** Code is unpronounceable; drop it entirely.

### B2. What pipecat does *not* do, and we must (Arabic + calm prosody)

pipecat is English-first. Our gap list, each item an explicit requirement for our
`stripSpeechText()`:

| Gap | Rule | Why |
|---|---|---|
| Emoji / pictographs | strip ranges `U+1F300–1FAFF`, `U+2600–27BF`, `U+FE0F`, `U+200D` | Fish vocalises or chokes; never spoken |
| List bullets | `^\s*[-*+•]\s+` and `^\s*\d+[.)]\s+` → drop marker, keep text | bare "dash dash" reading |
| Arabic diacritics (tashkīl) | strip `U+064B–U+0652`, `U+0670` | inconsistently honoured by neural voices → erratic prosody |
| Tatweel | strip `U+0640` | elongation marks read as hesitation |
| Alef/ya/ta-marbuta variants | normalise `أإآٱ→ا`, `ى→ي`, `ؤ→و`, `ئ→ي` | inconsistent pronunciation of the same word |
| LTR/RTL controls | strip `U+200E/U+200F/U+202A–202E` | can flip vocalisation order |
| URLs / paths | drop `https?://\S+` and bare `\S+/\S+` paths entirely | spelled-out letter-by-letter gibberish |
| Filler words | strip a bounded leading set (`يعني`، `تمام`، `شوف`، `اِ`…) | conversational filler ≠ spoken reply |
| Terminal punctuation | guarantee the last segment ends with `.` / `؟` | Fish needs terminal punctuation for final intonation |
| Sentence length | force-split on `MAX_SENTENCE_CHARS` (400, our existing constant) | bounded synthesis request |

**Non-negotiable:** after sanitisation, if the result has zero alphanumeric characters, do not
send it to Fish at all. That is the cheapest hallucination kill in the whole pipeline.

### B3. Calm prosody — the verified Fish Audio `TTSRequest` schema

**Read this before trusting the older revision of this document.** An earlier draft
guessed `prosody: { speed, emotion, pitch }`. Those fields **do not exist**. The
verified schema, from `https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech`
(openapi v1 `TTSRequest` / `ProsodyControl`):

```yaml
prosody:
  speed:              { default: 1,  range 0.5-2.0, "speaking rate multiplier" }
  volume:             { default: 0,  "Volume adjustment in decibels (dB). 0 = no change,
                                  positive = louder, negative = quieter." }
  normalize_loudness: { default: true, "Applies to the S2 family" }

latency:            { default: normal, enum: [low, normal, balanced],
                      "normal: best quality, balanced: reduced latency" }
chunk_length:       { default: 300, min 100, max 300, "text segment size" }
normalize:          { default: true, "Normalizes TEXT for English and Chinese,
                                  improving stability for numbers." }   # TEXT, not audio
temperature:        { default: 0.7, "Controls expressiveness; lower is more consistent" }
repetition_penalty: { default: 1.2, "Penalty for repeating audio patterns" }
condition_on_previous_chunks: { default: true }
min_chunk_length:   { default: 50 }
```

Two corrections follow, both invalidating an earlier audit claim:

- **`normalize: true` is a text normaliser, not a loudness control.** Perceived
  loudness is `prosody.volume` (dB) + `prosody.normalize_loudness`. An earlier audit
  blamed `normalize` for a "shouting" voice; that reading was wrong, and the field is
  deliberately unchanged because it improves number stability.
- **`repetition_penalty` and `latency` were missed entirely.** The code sent
  `latency: 'balanced'` — trading quality for latency on a voice already reported as
  shouting — plus the default repetition penalty on a voice reported as repeating.

Shipped policy, all in `fishRequestBody()` and unit-tested without a network call:
`latency: 'normal'`, `chunk_length: 300`,
`prosody: { speed: 0.95, volume: -2, normalize_loudness: true }`,
`temperature: 0.5`, `repetition_penalty: 1.3`. The renderer adds a `GainNode` at
`0.9` linear as a deterministic backstop.

### B4. Arabic normalisation — what must NOT be folded

pipecat is English-first, and the obvious "normalise Arabic" step is wrong. Folding
letter variants mispronounces Modern Standard Arabic:

| Fold | Breakage |
|---|---|
| `ى → ي` | `على` (correct MSA, alef maksura) becomes `علي` — Egyptian |
| `آ → ا` | `آمن` loses a real madda |
| `أإٱ → ا` | `أرد` loses a distinct glottal onset |

Only **orthography** is safe to strip: tashkil (`U+064B–U+0652`, `U+0670`) and
tatweel (`U+0640`). Under-normalising leaves a word intelligible; over-normalising
invents a dialect the speaker does not use. Pinned by test so it is not "fixed" back.
---

## Pillar C — Siri-style pure thread sine wave

**Our defects:** D6 (five chunky bars drawn at `SiriWaveCanvas.tsx:102-121` on top of the
thread), D7 (`energyRef` never enters the curve math — the thread cannot react to speech),
D8 (single hardcoded `color`; `App.tsx:431` passes a literal `#2563eb`).

### C1. `Kopiro/siriwave` — the canonical curve definition and the RMS hook

The 5-curve definition in the upstream README matches what our port already uses:

```js
{ attenuation: -2, lineWidth: 1,   opacity: 0.1 },
{ attenuation: -6, lineWidth: 1,   opacity: 0.2 },
{ attenuation:  4, lineWidth: 1,   opacity: 0.4 },
{ attenuation:  2, lineWidth: 1,   opacity: 0.6 },
{ attenuation:  1, lineWidth: 1.5, opacity: 1 },
```

> `noOfCurves?: [number, number];`
> `amplitude?: [number, number];`
> `speed?: [number, number];`

**`amplitude?: [number, number]` is the finding that matters.** Upstream treats amplitude as a
*randomised range*, not a constant. That is precisely the shape we need: the minimum is the
idle floor and the maximum is the loud-speech ceiling, and the live RMS selects within it. So
D7's fix is not an invention — it is using the upstream parameter the way it was designed.

**Upstream `color` is a single String and is only applied in the `ios` style.** So a
two-stop per-speaker gradient is *not* available from the library as-is. That is the
architectural justification for keeping our hand-rolled canvas instead of importing the
library: we already own the draw loop, so per-curve colours cost us one line each and would
cost a fork upstream.

Note our port's `lineWidth: 2.5` on the top curve vs upstream `1.5` — our thread is ~67 %
thicker than the reference. Part of why it reads as a "bar" rather than a "string". Align to
`1.5` and let `opacity` carry depth.

### C2. Two-stop speaker gradient — the exact mapping

Render curve *i* of N at a colour lerped across the pair:

```ts
const ramp = (i: number, n: number, [c1, c2]: readonly [string, string]) =>
  mixHex(c1, c2, n <= 1 ? 0 : i / (n - 1));
```

| Speaker | Stops | Hex |
|---|---|---|
| User | blue → yellow | `#2563EB` → `#EAB308` |
| Kareem | green → yellow | `#16A34A` → `#EAB308` |
| Nour | purple → pink | `#9333EA` → `#EC4899` |

Asymmetric smoothing is the anti-jitter requirement and belongs in the same place as the
amplitude lerp: fast attack (≈0.30) so speech onset is visible instantly, slow release (≈0.06)
so the thread falls off calmly instead of flickering.

### C3. `hvianna/audioMotion-analyzer` — WebGL technique reference only

953★, **AGPL-3.0**. Read for technique (a WebGL gradient-mapped spectrum/oscilloscope
pipeline running off a single `AnalyserNode`). **No code may be copied.** Its architectural
lesson for us is the one C4 depends on: one analyser, many visual layers.

### C4. Playback energy + ducking (needs the same `AnalyserNode`)

`apps/desktop/src/audio/playback.ts:92-114` creates an `AudioContext` that is never closed and
whose `resume()` is never called (L4/L5). While we are in there:

- attach one `AnalyserNode` to the TTS source → the thread can visualise **what is being
  spoken**, not only what is being heard by the mic;
- **ducking**: while TTS is active, the mic-side energy is unreliable (it hears the
  loudspeaker). LiveKit's `on_start_of_agent_speech` / `on_end_of_agent_speech`
  (`endpointing.py`) is the reference state split — duck to ≈35 % and tint with the speaker
  palette for the duration;
- this also gives us the honest barge-in behaviour: human speech during TTS should be
  measured against the *ducked* baseline, not the raw one.

---

## Pillar D — OpenCode v2 session & context telemetry

**Our defect:** D9 — `src/runtime/client.ts:353-359` `listSessions` throws away the `tokens`,
`cost`, and `time` objects the API returns. The 360° middleware is absent.

> **Repo note:** `sst/opencode` now redirects to **`anomalyco/opencode`** (210,308★, MIT,
> branch `dev`, pushed 2026-09-27). All types below were read from
> `packages/sdk/js/src/v2/gen/types.gen.ts` on that `dev` branch.

### D1. The session row already carries per-session token accounting

```ts
export type Session = {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  parentID?: string
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<SnapshotFileDiff> }
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
  title: string
  agent?: string
  model?: { /* … */ }
}
```

We already parse this object and keep `id/agent/model/state`. The fix is additive: keep
`tokens`, `cost`, `projectID`, `summary`, and `updatedAt`.

### D2. There is a **dedicated context endpoint** — use it, do not guess

```ts
// types.gen.ts:11804
url: "/api/session/{sessionID}/context"

export type V2SessionContextResponses = {
  200: { data: Array<SessionMessage> }
}
```

`GET /api/session/{sessionID}/context` returns the session's message set. Summing the
`StepFinishPart` token objects across those messages gives the **true current context
occupancy**, which is not the same as the cumulative `Session.tokens` (that number is
lifetime-spend, not window-fill). This distinction is the whole point of the feature: a bar
showing "78 % of the window consumed" must be computed from the context endpoint, and one
showing "this session has burned 412 k tokens" from the row. Mixing them is the classic bug.

### D3. Context-window overflow is a typed, catchable error

```ts
export type ContextOverflowError = {
  name: "ContextOverflowError"
  data: { message: string; responseBody?: string }
}
```

So overflow is not an opaque 400 — it is a named error we can map to a specific
Arabic-language notice ("the context is full, should I compact?") instead of a generic
`BRAIN_TIMEOUT`-style failure. This also fixes audit item **L24** (brain errors collapsing
into one code).

### D4. Complete verified endpoint inventory (session, command, agent, permission, question, file)

From the same `types.gen.ts`, all `url:` literals matching session/command/agent/pty/
question/permission/file, sorted:

```
/api/agent
/api/command
/api/permission/request
/api/permission/saved
/api/permission/saved/{id}
/api/pty
/api/pty/{ptyID}
/api/pty/{ptyID}/connect
/api/pty/{ptyID}/connect-token
/api/question/request
/api/session
/api/session/active
/api/session/{sessionID}
/api/session/{sessionID}/agent
/api/session/{sessionID}/compact
/api/session/{sessionID}/context
/api/session/{sessionID}/event
/api/session/{sessionID}/history
/api/session/{sessionID}/interrupt
/api/session/{sessionID}/message
/api/session/{sessionID}/message/{messageID}
/api/session/{sessionID}/model
/api/session/{sessionID}/permission
/api/session/{sessionID}/permission/{requestID}
/api/session/{sessionID}/permission/{requestID}/reply
/api/session/{sessionID}/prompt
/api/session/{sessionID}/question
/api/session/{sessionID}/question/{requestID}/reject
/api/session/{sessionID}/question/{requestID}/reply
/api/session/{sessionID}/revert/clear
/api/session/{sessionID}/revert/commit
/api/session/{sessionID}/revert/stage
/api/session/{sessionID}/wait
```

What this buys us, mapped to the 360° requirement:

| Capability | Endpoint | Note |
|---|---|---|
| Native `/compact` | `POST /api/session/{id}/compact` | real compaction, not a prompt asking the model to forget |
| Native `/abort` | `POST /api/session/{id}/interrupt` | this is the correct barge-in primitive |
| Native `/undo` | `POST /api/session/{id}/revert/{stage,commit,clear}` | three-phase revert |
| Slash-command catalog | `GET /api/command` → `CommandListData` / `CommandV2Info` | enumerate, then validate; **never blind-forward a `/x` string** |
| Await-idle | `POST /api/session/{id}/wait` | replaces polling; removes a race class |
| Per-session event stream | `/api/session/{id}/event` | telemetry without polling |
| Question flow | `.../question` + `reply` / `reject` | a natural FR-12 surface for clarifying questions from the Prompt Optimizer |

### D5. The event catalog is a ready-made observability schema

`types.gen.ts` declares these event unions (excerpt, all verified present):

```
EventSessionCreated / Updated / Deleted
EventMessageUpdated / Removed / EventMessagePartUpdated / EventMessagePartDelta
EventSessionNextPrompted / PromptAdmitted
EventSessionNextAgentSwitched / ModelSwitched
EventSessionNextContextUpdated          <-- context telemetry, push not poll
EventSessionNextStepStarted / StepEnded / StepFailed / Retried
EventSessionNextToolInputStarted / Delta / Ended / ToolCalled / ToolProgress / ToolSuccess / ToolFailed
EventSessionNextTextStarted / Delta / Ended
EventSessionNextReasoningStarted / Delta / Ended
EventSessionNextShellStarted / ShellEnded
EventSessionNextCompactionStarted / Delta / Ended
EventSessionNextPrompted / NextMoved / NextSynthetic
EventPermissionV2Asked / Replied / EventQuestionV2Asked / Replied / Rejected
EventSessionDiff / EventSessionError / EventTodo
```

Two direct consequences for §3.4 of the audit report:

- **Observability is a subscription, not a build.** `EventSessionNextStepStarted/Ended` gives
  per-step latency; `.../ToolCalled/Success/Failed` gives tool telemetry; `.../Retried` gives
  provider retry counts. We should consume these and write them to `events.jsonl` rather than
  instrumenting the daemon by hand.
- **A structured `context.updated` push exists**, so the HUD context gauge can be event-driven
  instead of a poll — cheaper and correct.

### D6. Prompt-optimisation layer — grounded in this contract

Between `think` and `dispatch` (`audio-pipeline.ts:50-57`), the Optimizer should emit the
existing `mission-handoff` envelope shape (`coordinator.ts:115-126`) and attach resolution
metadata that the `prompt` endpoint already accepts. The `@`-mention work should validate
against `/api/agent`, the command catalog from `/api/command`, and the real project tree
under `Session.directory` — rejecting `..` traversal and symlink escapes, and closing audit
item **L21** (the metacharacter guard's blind spots) at the same time.

---

## Licensing summary (decision-grade)

| Repo | License | Usable how |
|---|---|---|
| `anomalyco/opencode` (was `sst/opencode`) | MIT | integrate, attribute |
| `pipecat-ai/pipecat` | BSD-2-Clause | adapt code, keep notice |
| `snakers4/silero-vad` | MIT | model + reference |
| `ggml-org/whisper.cpp` | MIT | pattern reference |
| `livekit/agents` | Apache-2.0 | adapt design, NOTICE required |
| `Kopiro/siriwave` | MIT | parameter/curve reference |
| `hvianna/audioMotion-analyzer` | **AGPL-3.0** | **technique reference only — no code** |
| `YellowKidokc/TTS-Cleaner` | none | **not usable** |

---

## Phase 1 implementation plan (patterns → our files)

| Step | Defect | Pattern source | File(s) to change | Verified gate |
|---|---|---|---|---|
| 1 | D1 | A1 (`-vth 0.6` gate + lookback), A3 (skip-is-normal), A4 (reuse `no_speech_prob`) | `src/voice/ingest.ts`, `src/voice/stt.ts`, `src/orchestrator/audio-pipeline.ts` | 60 s mic-on with a silent room ⇒ **zero** dispatches, zero `notice` frames |
| 2 | D2 | B1 (pipecat chain), B2 (Arabic + filler + URL rules) | new `stripSpeechText()` in `src/voice/tts.ts`, called from `speak`/`speakSentences`/`synthesizeStream` | unit test asserts **alnum-preserving** invariant + zero-emoji + Arabic-variant normalisation |
| 3 | D3 | B3 (params + renderer gain node) | `src/voice/tts.ts:145-152`, `apps/desktop/src/audio/playback.ts` | recorded peak dBFS at target; listening A/B recorded in `docs/10-CHECKPOINT.md` |
| 4 | D4 | — (ours) | `src/daemon.ts:141,190-194`, `src/orchestrator/coordinator.ts:179` | one Fish call per sentence, none duplicated, plan starts before TTS completes |
| 5 | D6/D7/D8 | C1 (`amplitude` range, `lineWidth 1.5`), C2 (ramp + asymmetric smoothing) | `SiriWaveCanvas.tsx`, `App.tsx:431` | single thread; amplitude provably tracks RMS; per-speaker stops correct |
| 6 | — | C3/C4 (one analyser; LiveKit dual-timeline) | `playback.ts` | `dispose()` + `resume()` + ducking; no context leak across window open/close |
| 7 | D9 + 360° | D1–D6 (endpoint + event inventory) | `src/runtime/client.ts`, new WS commands, HUD | context gauge driven by `context.updated`; `/compact` `/abort` `/undo` reachable from the HUD **and** an E2E spec |

**Order is deliberate:** 1–4 are the voice-quality bleeding (they cause the reported symptoms
and need no new dependencies or endpoints); 5–6 are self-contained renderer/audio work; 7 is
the capability layer and is last because it should be built on an `events.jsonl` trail that
1–6 make trustworthy.

**Do not do in Phase 1:** Silero/ONNX (needs measurement first — A2), the prompt-optimisation
layer (needs D2 sanitised text to be trustworthy as an input), and anything touching
`main.rs` supervision (D10/D11) — that is Phase 2 process hygiene with its own gate.
