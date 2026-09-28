# 02 — Voice Pipeline Forensic Audit

**Auditor:** Forensic Auditor 2 · **Repo:** `O:\opencode-Vantrilex` · **Date:** 2026-09-28
**Scope:** `src/voice/`, `src/orchestrator/audio-pipeline.ts`, `apps/desktop/src/audio/`
**Method:** every fact below is read from physical source on disk. Markdown is treated as
untrusted; where a doc contradicts code, the contradiction is recorded as a finding (§8).

---

## 0 — File-existence verification (brief correction)

The brief listed `src/voice/capture.ts`, `src/voice/vad.ts`, `src/voice/playback.ts`.

`Get-ChildItem -Path "O:\opencode-Vantrilex\src\voice" -File` returned exactly 20 files:

| File in `src/voice/` | Bytes |
|---|---|
| `brain.test.ts` | 12586 |
| `brain.ts` | 16464 |
| `cache.test.ts` | 660 |
| `cache.ts` | 2966 |
| `fish-free-tier-header.test.ts` | 2680 |
| `ingest.test.ts` | 8232 |
| `ingest.ts` | 4273 |
| `key-advanced-telemetry.test.ts` | 3967 |
| `key-release-status.test.ts` | 8185 |
| `key-store.test.ts` | 2142 |
| `key-store.ts` | 3200 |
| `keyring.test.ts` | 4287 |
| `keyring.ts` | 7516 |
| `stt.test.ts` | 7135 |
| `stt.ts` | 7223 |
| `tts-r3-errors.test.ts` | 5587 |
| `tts.test.ts` | 18775 |
| `tts.ts` | 27096 |
| `vault.ts` | 4913 |

**Verdicts:**

- `src/voice/capture.ts` — **DOES NOT EXIST.** Capture lives in the renderer:
  `apps\desktop\src\audio\capture.ts` (6541 bytes). It is renderer-side
  `AudioWorklet` code and could not live in the Node daemon.
- `src/voice/vad.ts` — **DOES NOT EXIST.** Two *different* VAD implementations exist and
  the brief conflated them:
  - `src\runtime\vad.ts` (6185 bytes) — **Silero V5 ONNX** neural VAD, `onnxruntime-node`,
    server-side, loaded **dynamically** by `daemon.ts` (see §1, step 6).
  - `apps\desktop\src\audio\vad.ts` (4142 bytes) — **pure energy** DSP barge-in/ducking
    policy in the renderer. No ONNX, no model file.
  Neither is a re-export of the other; they implement different gates.
- `src/voice/playback.ts` — **DOES NOT EXIST.** Playback lives in the renderer:
  `apps\desktop\src\audio\playback.ts` (6410 bytes).

The brief's suspicion about `src/runtime/vad.ts` and
`apps/desktop/src/audio/playback.ts` is **CONFIRMED**.

---

## 1 — End-to-end audio trace

### Uplink (mic → orchestrator)

| # | Hop | File:line | Function |
|---|---|---|---|
| 1 | `getUserMedia({audio:{sampleRate:16000, echoCancellation:true, noiseSuppression:true}})` | `apps/desktop/src/audio/capture.ts:85-87` | `AudioCapture.start` |
| 2 | `new AudioContext({sampleRate: 48000})` | `apps/desktop/src/audio/capture.ts:100` | `AudioCapture.start` |
| 3 | `AudioWorkletNode` "voxaura-capture", module blob inlined at `capture.ts:44-53`; posts `channel.slice(0)` per render quantum; `ScriptProcessorNode(4096,1,1)` fallback at `capture.ts:138` | `capture.ts:127-144` | `AudioCapture.start` |
| 4 | `emit(input, inputRate)` — RMS energy `Math.min(1, rms*4)` → `onEnergy`; throttled to 80 ms in the shell | `capture.ts:102-125` / `apps/desktop/src/App.tsx:220-226` | `emit` |
| 5 | `downsample(input, 48000 → 16000)` linear interpolate; **throws on upsampling** | `capture.ts:19-35` | `downsample` |
| 6 | Re-framing: `FRAME_SAMPLES = (16000*100)/1000 = 1600` samples; loop emits `while (offset + 1600 <= joined.length)`, remainder retained in `this.pending` | `capture.ts:8`, `capture.ts:117-121` | `emit` |
| 7 | `floatToInt16` — clamp to [-1,1], `Math.round(v * 32767)` (note: **32767**, not 32768) | `capture.ts:10-17` | `floatToInt16` |
| 8 | `encodeFrame` — `DataView.setInt16(i*2, v, true)` little-endian | `capture.ts:37-42` | `encodeFrame` |
| 9 | Barge-in policy: `bargePolicy(speaking, frame)` → `'send'` when not speaking; when speaking, `isSpeechFrame(...)` → `'barge'` else `'duck'` | `apps/desktop/src/audio/vad.ts:32-35` | `bargePolicy` |
| 10 | On `'barge'`: `playerRef.current?.stop()`, `setSpeakingState(false)`, WS command `{kind:'abort'}` | `App.tsx:234-239` | `startMic` |
| 11 | `bridgeRef.current?.sendPcm(bytes)`; `'duck'` frames never leave the machine | `App.tsx:232-240` | `startMic` |
| 12 | `sendPcm` → `socket.sendBinary(bytes)`; fire-and-forget, **bypasses the ack ledger**; returns `false` if socket is null or send throws | `apps/desktop/src/bridge/ws.ts:324-333` | `sendPcm` |
| 13 | `ws.binaryType = 'arraybuffer'` set once at connect | `bridge/ws.ts:228` | `VoxauraBridge` |
| 14 | Server reads binary frame, enforces cap (see §7), then `this.onAudio?.(Buffer.from(frame.payload))` | `src/ipc/ui-server.ts:441-453` | frame handler |
| 15 | `ui.onAudio = (pcm) => { setVoicePhase('listening'); void pipeline.pushChunk(pcm).catch(() => undefined) }` | `src/daemon.ts:658-664` | `rebuildVoice` |
| 16 | `AudioPipeline.pushChunk(chunk)` captures `generation`, iterates `this.ingest.push(chunk)` | `src/orchestrator/audio-pipeline.ts:116-118` | `pushChunk` |
| 17 | `AudioIngest.push` — concat, shed over-cap, emit every complete `WINDOW_BYTES` | `src/voice/ingest.ts:86-100` | `AudioIngest.push` |
| 18 | Generation re-check → `isSpeech(window)` | `audio-pipeline.ts:119-126` | `pushChunk` |
| 19a | **Energy gate (default):** `isLoudWindow(window)` = `windowRmsDb(window) > -30` | `audio-pipeline.ts:167` → `ingest.ts:40-42` | `isLoudWindow` |
| 19b | **Silero gate (injected):** `this.deps.speechGate(window)` — replaces the energy gate, never stacks | `audio-pipeline.ts:165-168` | `isSpeech` |
| 20 | `transcribeWindow(window)` → `deps.transcribe(window)`; `SttTimeoutError` → counted and dropped, **all other errors rethrown** | `audio-pipeline.ts:176-185` | `transcribeWindow` |
| 21 | `withKey(ring, 'groq', key => transcribeStream(pcm, new GroqWhisperClient(keyMaterial(key))))` | `daemon.ts:401-403` | pipeline `transcribe` dep |
| 22 | `transcribeStream` → `chunkPcm(pcm)` then **sequential `for` loop** of `withTimeout(client.transcribe(chunk), 15000)` | `src/voice/stt.ts:164-193` | `transcribeStream` |
| 23 | `GroqWhisperClient.transcribe` — `pcmToWav` 44-byte RIFF header, `File([...], 'chunk-N.wav', {type:'audio/wav'})`, `audio.transcriptions.create({file, model, language, response_format})` | `stt.ts:93-106` | `transcribe` |
| 24 | Hallucination gate: `noSpeechProb > 0.6` → `hallucinationCount += 1`, skip | `audio-pipeline.ts:137-140` | `pushChunk` |
| 25 | Repeat dedupe: `recent.includes(repeatKey(transcript))`, memory 5, `repeatKey` strips `؟?!.،,:؛;'"«»()[]{}-—–` + lowercases | `audio-pipeline.ts:141-144`, `188-203` | `isRepeat`/`remember` |
| 26 | `await this.deps.think(transcript)` | `audio-pipeline.ts:146` | `pushChunk` |
| 27 | Optional fallback `dispatch(transcript)` only when `receipt === null` **and** `dispatch !== undefined` **and** `activeSessionId() !== undefined` | `audio-pipeline.ts:153-156` | `pushChunk` |
| 28 | `deps.onUtterance?.({transcript, reply, receipt})` | `audio-pipeline.ts:160` | `pushChunk` |

**L6 generation guard** — `reset()` bumps `this.generation` (`audio-pipeline.ts:113`).
`pushChunk` re-checks after the speech gate (`:123`), after transcribe (`:130`), after
`think` (`:149`), and after `dispatch` (`:159`). Four checks total.

### Downlink (brain → speakers)

| # | Hop | File:line | Function |
|---|---|---|---|
| 29 | `onUtterance` handler: `stripSpeechText(reply)`; if `!isSpeakable(text)` → `setVoicePhase('idle')` and return | `daemon.ts:599-603` | `onUtterance` |
| 30 | Persona snapshotted **once per utterance** (prevents a mid-reply voice split): `VOICE_IDS[activePersona === 'nour' ? 'female-toggle' : 'male-default']` | `daemon.ts:607` | `onUtterance` |
| 31 | `const gen = speechGate.capture()`; `const sentences = splitSentences(text)` | `daemon.ts:608-609` | `onUtterance` |
| 32 | Per sentence: **check gate → synthesize → check gate → broadcast** | `daemon.ts:612-617` | `onUtterance` |
| 33 | `fish.synthesize(sentence, voiceId)` → `FishHttpTransport.synthesize` → drains `synthesizeStream` into one `Uint8Array` | `daemon.ts:614` → `tts.ts:500-513` | `synthesize` |
| 34 | `keyring.acquire('fish')` (raw — **not** `withKey`) | `tts.ts:516` | `synthesizeStream` |
| 35 | `fetchWithTimeout(endpoint, {method:'POST', headers: fishHeaders(...), body: JSON.stringify(fishRequestBody(...))}, 20000, fetchImpl)` | `tts.ts:518-527` | `synthesizeStream` |
| 36 | `!res.ok \|\| res.body === null` → `release(key, false, res.status)` then `throw new Error(fishErrorMessage(status, await fishErrorDetail(res)))` | `tts.ts:528-531` | `synthesizeStream` |
| 37 | `release(key, true)`; `res.body.getReader()` loop yielding each `value` | `tts.ts:532-539` | `synthesizeStream` |
| 38 | `ui.broadcastAudio(mp3)` | `daemon.ts:616` | `onUtterance` |
| 39 | `splitAudio(mp3, this.audioSeq)` → 32768-byte slices, `seq % 65_536`; then `this.audioSeq = (seq+1) % 65_536` | `src/ipc/ui-server.ts:253-256`, `src/ipc/audio.ts:31-38` | `broadcastAudio` |
| 40 | `encodeAudioChunk(seq, chunk)` = `[0x01][seqHi][seqLo][mp3…]`, 3-byte header | `audio.ts:9-16` | `encodeAudioChunk` |
| 41 | `encodeBinaryFrame` (unmasked, FIN set) → fanned out to every connected shell | `ui-server.ts:257` | `broadcastAudio` |
| 42 | Renderer `onMessage`: `bytes.byteLength >= 4 && bytes[0] === 0x01` → `onAudio(bytes.subarray(3))`; **any other binary is silently ignored** | `bridge/ws.ts:367-372` | `onMessage` |
| 43 | Lazily `createDefaultPlayer({onStart, onEnd})`; `catch → return` (silently drops audio if `AudioContext` is unavailable) | `App.tsx:141-154` | `onAudio` |
| 44 | `playerRef.current.enqueue(bytes)` | `App.tsx:155` | `onAudio` |
| 45 | `AudioPlayer.enqueue` → drop-oldest to cap → `onStart` latch → `void this.drain()` | `playback.ts:54-68` | `enqueue` |
| 46 | `drain()` loop: generation check → `queue.shift()` → `await decode(next)` → generation check → `sink.play(buffer)` | `playback.ts:94-110` | `drain` |
| 47 | `createDefaultPlayer` decode: `context.resume()` if suspended, copy bytes, `decodeAudioData`; sink: `createBufferSource` → `gain` (0.9) → `destination` | `playback.ts:158-174` | `createDefaultPlayer` |

**Important architectural note:** the daemon does **not** use `TtsEngine.speak` /
`speakSentences` for the voice path. It calls `fish.synthesize()` directly
(`daemon.ts:614`). `TtsEngine` (and therefore `AudioCache` and `FileAudioOut`) is only
exercised by `node dist/cli.js live` (`src/cli.ts:92`, `src/cli.ts:127`).

---

## 2 — Fish Audio TTS request body

### `fishRequestBody(text, fishVoiceId)` — `src/voice/tts.ts:365-396`

The returned object, verbatim, with line numbers:

| Field | Value | Line |
|---|---|---|
| `text` | `stripSpeechText(text)` | 371 |
| `reference_id` | `fishVoiceId` (the argument) | 372 |
| `format` | `'mp3'` | 373 |
| `latency` | `'balanced'` | 386 |
| `chunk_length` | `300` | 387 |
| `min_chunk_length` | `50` | 388 |
| `normalize` | `true` | 389 |
| `temperature` | `0.5` | 390 |
| `top_p` | `0.7` | 391 |
| `repetition_penalty` | `1.3` | 392 |
| `condition_on_previous_chunks` | `true` | 393 |
| `prosody` | `{ speed: 0.95, volume: -2, normalize_loudness: true }` | 394 |

That is **12 top-level keys**, no more. `text` is sanitised *again* inside the body
builder (`tts.ts:367-370`) because `daemon.ts:614` bypasses `TtsEngine`;
`stripSpeechText` is idempotent so the earlier pass costs nothing.

### Claim-by-claim verdict

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | `latency: 'balanced'` | **TRUE** | `tts.ts:386` `latency: 'balanced',`. Pinned by `tts.test.ts:286` `expect(body.latency).toBe('balanced')`. |
| 2 | model header is `s2.1-pro-free` | **TRUE** | `TTS_MODEL = 's2.1-pro-free'` at `tts.ts:31`; set as header `model: TTS_MODEL` at `tts.ts:287`. Pinned by `fish-free-tier-header.test.ts:20` and `:26-27`. |
| 3 | `normalize: true` | **TRUE** | `tts.ts:389`. Pinned by `tts.test.ts:306` `expect(fishRequestBody('مرحبا','ref-1').normalize).toBe(true)`. |
| 4 | format is `mp3` | **TRUE** | `tts.ts:373`. Pinned by `tts.test.ts:317` `expect(body.format).toBe('mp3')`. |

### Is `model` an HTTP header or a body field? — **HEADER. PROVEN.**

`fishHeaders(key)` at `tts.ts:283-290` returns exactly four entries:

```
Authorization: `Bearer ${key}`
Content-Type:  'application/json'
model:         TTS_MODEL
Accept:        'audio/mpeg'
```

Three independent proofs that it is a header and **not** a body field:

1. **Construction site** — `model` is written into the object literal returned by
   `fishHeaders` (`tts.ts:287`), and that object is passed as `headers:` in the fetch
   init (`tts.ts:522`).
2. **Absence from the body** — `fishRequestBody` (`tts.ts:365-396`) has no `model` key.
3. **Negative assertion test** — `fish-free-tier-header.test.ts:30-36`:
   ```ts
   test('the model is NOT a body field', () => {
     const body = fishRequestBody('مرحبا', 'ref-1');
     expect(body).not.toHaveProperty('model');
     expect(Object.keys(body)).not.toContain('model');
   });
   ```
   `fish-free-tier-header.test.ts:45-50` additionally pins lower-case key casing via
   `expect(Object.keys(fishHeaders('k'))).toContain('model')`.

**Why it matters (documented failure mode)** — `tts.ts:264-282` and
`fish-free-tier-header.test.ts:4-16` record four live probes against
`api.fish.audio` on 2026-09-28:

| Configuration | Result |
|---|---|
| model as header | 200, audio returned |
| model in JSON body | 402 "Insufficient API credit" |
| no model at all | 402 "Insufficient API credit" |
| model header + full body | 200, audio returned |

The error names the wrong cause, so an engineer tops up a balance that was already fine
and the next request 402s identically. `dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md:144`
independently records that **401/403 rotate; 402/422/404 do not.**

### Other TTS constants

| Constant | Value | Line |
|---|---|---|
| `TTS_MODEL` | `'s2.1-pro-free'` | `tts.ts:31` |
| `TTS_FIRST_CHUNK_BUDGET_MS` | `800` | `tts.ts:32` |
| `MAX_SENTENCE_CHARS` | `400` | `tts.ts:34` |
| `FISH_TIMEOUT_MS` | `20_000` | `tts.ts:399` |
| `SPEECH_CACHE_MAX_ENTRY_BYTES` | `2 * 1024 * 1024` = `2 097 152` | `tts.ts:407` |
| `PLAYBACK_RETENTION_MS` | `15 * 60_000` = `900_000` | `tts.ts:410` |
| `SPEECH_FILLERS` | 6 entries: `'يعني'`, `'طيب'`, `'يعني،'`, `'طيب،'`, `'اوك'`, `'تمام،'` | `tts.ts:44` |
| `TERMINATORS` | `'.!?؟!…'` | `tts.ts:46` |
| Default endpoint | `https://api.fish.audio/v1/tts` | `tts.ts:493` |
| `PLAYBACK_GAIN` | `0.9` (≈ −0.9 dB) | `playback.ts:144` |

**Free-tier end date:** `tts.ts:14-30` records that S2.1 Pro Free access runs through
**2026-11-30** with no SLA, no TTFA guarantee, and training-retention of requests.
Fallbacks named: paid Fish plan, Groq `canopylabs/orpheus-arabic-saudi`, or the Fish
WebSocket endpoint on a paid model.

---

## 3 — Audio drain queue (`apps/desktop/src/audio/playback.ts`)

### `PLAYBACK_QUEUE_CAP`

**`export const PLAYBACK_QUEUE_CAP = 32;`** — `playback.ts:28`.

Enforced at `playback.ts:59-62`:
```ts
while (this.queue.length > PLAYBACK_QUEUE_CAP) {
  this.queue.shift();
  this.droppedCount += 1;
}
```
**Drop-OLDEST, not drop-newest** — stated at `playback.ts:57-58`: "the tail is what the
user is waiting to hear, and dropping it would truncate the reply mid-sentence."
Overflow is therefore silent audio loss, counted in `droppedCount` and exposed via the
`dropped` getter (`playback.ts:51-53`).

### The `drain()` try/catch structure

Two distinct `try` blocks plus a `finally` (`playback.ts:94-135`):

```
drain()                                    // line 94
  if (this.draining) return;               // 95   reentrancy guard
  this.draining = true;                    // 96
  const gen = this.generation;             // 97
  try {                                    // 98   OUTER try
    for (;;) {                             // 99
      if (gen !== this.generation) break;  // 100
      const next = this.queue.shift();     // 101
      if (next === undefined) break;       // 102
      try {                                // 103  INNER try
        const buffer = await this.options.decode(next);  // 104
        if (gen !== this.generation) break;              // 105
        this.options.sink.play(buffer);                  // 106
      } catch {                            // 107  INNER catch
        // Corrupt chunk: skip it, keep the queue flowing.  108
      }                                    // 109
    }
  } finally {                              // 111
    this.draining = false;                 // 112
    try {                                  // 124  CONSUMER try
      if (this.queue.length === 0 && this.started) {   // 125
        this.started = false;              // 126
        this.options.onEnd?.();            // 127
      } else if (this.queue.length > 0) { // 128
        void this.drain().catch(() => undefined);       // 129
      }
    } catch {                              // 131  CONSUMER catch
      // A consumer callback must not reject the floating drain promise.  132
    }
  }                                        // 133
```

The **inner** catch (`:107-109`) is the "corrupt chunk: skip it, never stall" rule
named in the file header (`playback.ts:2-3`). It swallows BOTH a rejecting `decode()`
**and** a throwing `sink.play()`.

### The `draining` flag ordering — and a documentation defect

**Actual code order:** `this.draining = false` executes at **`playback.ts:112`**, which
is the **first statement inside the `finally` block**, and it runs **before** the
consumer callback `this.options.onEnd?.()` at `:127`.

**What the comment claims** — `playback.ts:120-121`:
> "`draining` is reset BEFORE the try, not inside it: leaving it true would wedge the
> player permanently"

**That description is false as written.** The flag is *not* reset before the outer
`try`; it is reset inside the `finally`. The comment is also repeated verbatim in
`apps/desktop/src/audio/playback-f01.test.ts:57-59`:
> "Swallowing the throw is only safe because `draining` is reset before the try; if it
> were not, the second enqueue would be dropped and the player would be dead for the
> rest of the session."

**The invariant the comment wants is nonetheless satisfied**, and the `finally` is
exactly the right construct: `draining = false` at `:112` precedes the only throwing
statement at `:127`, so the flag is always cleared even when `onEnd` throws. The code is
correct; the *description of the code* is wrong.

**Why this is a live hazard, not a nit:** a future maintainer who "tidies" the
`finally` into the happy path — or who reads the comment and believes the flag is
already false, then adds a statement between the `try` and the `finally` — reintroduces
the permanent wedge. The comment currently documents a mechanism that is not the one in
the file. **FINDING — see §8.6.**

### Can a throwing consumer wedge the queue? — **NO.**

Three independent reasons, all structural:

1. **`draining` is cleared in a `finally`.** `playback.ts:111-112`. Even if the
   consumer callback throws, the flag is already `false` by the time the throw
   propagates, so the next `enqueue()` → `void this.drain()` (`:67`) sees
   `this.draining === false` at `:95` and proceeds. It cannot wedge.
2. **The consumer callback is inside its own `try`/`catch`.** `playback.ts:124-133`.
   A throwing `onEnd` is swallowed at `:131`, so it never rejects the floating
   `drain()` promise, so no global `unhandledrejection` fires in the WebView2 renderer.
3. **The re-arm path is inside the same `try`.** `playback.ts:128-130` re-enters
   `void this.drain().catch(() => undefined)` when the queue is non-empty, with its own
   `.catch` attached — so even a throw on that path cannot reject.

**The guarantee is pinned by non-vacuous tests** in
`apps/desktop/src/audio/playback-f01.test.ts`:
- `:44-54` — a throwing `onEnd` raises **zero** unhandled rejections (captured via
  `process.on('unhandledRejection')`, `:21`).
- `:56-74` — "the player is not wedged": the throwing `onEnd` is called **twice**,
  proving the second `enqueue` really drained rather than returning early on a stuck
  flag.
- `:76-85` — control: a normal `onEnd` fires **exactly once**, so a fix that swallowed
  everything would fail.
- `:87-95` — `onEnd` is optional.

Overflow is also pinned at `playback.test.ts:126`, `:134` and the conservation identity
`player.queued + player.dropped + 1 === enqueued` at `playback.test.ts:143-144`.

**Caveat — a different wedge is not covered.** `drain()` awaits
`this.options.decode(next)` at `:104` **outside** any timeout. A `decode` that never
settles parks the single drain loop forever: `draining` stays `true`, so every
subsequent `enqueue` is accepted into the queue but never played, and the queue fills
to `PLAYBACK_QUEUE_CAP` and then silently drops the oldest. Nothing in `playback.ts`
bounds `decode()`. (Not a contradiction of any doc — an unstated failure mode.)

---

## 4 — Groq Whisper STT (`src/voice/stt.ts`)

| Property | Value | Line |
|---|---|---|
| Model id | `'whisper-large-v3-turbo'` | `stt.ts:98` |
| Language (pinned) | `'ar'` | `stt.ts:99` |
| `response_format` | `'verbose_json'` | `stt.ts:100` |
| SDK | `groq-sdk`, `new Groq({apiKey})` | `stt.ts:1`, `stt.ts:90` |
| `SAMPLE_RATE` | `16_000` | `stt.ts:7` |
| `BYTES_PER_SAMPLE` | `2` | `stt.ts:8` |
| `CHUNK_MS` | `5000` | `stt.ts:9` |
| `OVERLAP_MS` | `500` | `stt.ts:10` |
| `CHUNK_BYTES` | `16000*2*5000/1000` = `160 000` | `stt.ts:11` |
| `OVERLAP_BYTES` | `16000*2*500/1000` = `16 000` | `stt.ts:12` |
| `STT_TIMEOUT_MS` | `15_000` | `stt.ts:135` |
| Timeout error class | `SttTimeoutError` | `stt.ts:142-147` |
| WAV header | hand-built 44-byte RIFF, mono, 16-bit, LE | `stt.ts:109-132` |

`language: 'ar'` is **hardcoded with no override parameter** (`stt.ts:96-101`). English
audio therefore yields Arabic output by design — this is the pinned-contract behaviour
`AGENTS.md` warns about, and it is confirmed in code, not inferred.

### Streaming behaviour — the name is a misnomer

`transcribeStream` (`stt.ts:164-193`) is **not** streaming and **not** concurrent. It is
a strictly **serial `for...of` loop** with `await` inside (`stt.ts:174-182`). For N
chunks the wall-clock cost is the *sum* of N Whisper round-trips, not the max. The
function is named for "stream of chunks", not for pipelining. `AGENTS.md` quotes a
measured STT p50 of 726 ms; that is one round-trip, and the live path issues exactly one.

**Timing:**
- `withTimeout(client.transcribe(chunk), timeoutMs)` per chunk (`stt.ts:175`), implemented
  by `Promise.race` with a `setTimeout` (`stt.ts:196-204`). The race is deliberate —
  `stt.ts:159-162` — so the bound holds even if the SDK ignores cancellation. Note the
  timer is **not** passed an `AbortSignal`, so a timed-out Whisper call keeps running
  in the background; only the `await` is abandoned.
- `roundTripMs: Date.parse(nowIso()) - Date.parse(startedAt)` (`stt.ts:190`) — measured
  across **all** chunks, not per chunk.
- `AudioPipeline.transcribeWindow` (`audio-pipeline.ts:176-185`) catches **only**
  `SttTimeoutError`, increments `sttTimeouts`, fires `onSttTimeout(STT_TIMEOUT_MS)`, and
  returns `null` so the loop continues. Any other error propagates and, per
  `audio-pipeline.ts:172-174`, abandons every later window in the batch.
- `AudioPipeline.pushChunk` awaits windows serially (`audio-pipeline.ts:118-161`).

### `no_speech_prob` aggregation — two different aggregations

| Layer | Function | Aggregation | Line |
|---|---|---|---|
| Within one Whisper response | `meanNoSpeechProb(segments)` | **mean** over well-formed finite `no_speech_prob` values | `stt.ts:43-52` |
| Across chunks in one window | `transcribeStream` | **max** (`Math.max(...probs)`) | `stt.ts:186` |
| Gate | `NO_SPEECH_DROP = 0.6` | `noSpeechProb > 0.6` → drop | `audio-pipeline.ts:27`, `:137` |

Both aggregations are intentional and commented: the mean protects a real utterance with
one leading-silence segment (`stt.test.ts:39-43`), while the max ensures one
confidently-non-speech chunk taints the window (`stt.ts:184-185`). `undefined` means
"unknown" and is never coerced to `0` — `stt.ts:38-42` states that `0` means
"maximally confident speech" and would defeat the gate.

### FINDING — the 0.5 s overlap geometry is unreachable in the live path

`chunkPcm` (`stt.ts:54-75`) uses `step = CHUNK_BYTES - OVERLAP_BYTES = 160000 - 16000 =
144000` (4.5 s) to build overlapping windows. But `AudioIngest` (`ingest.ts:95-98`) has
**already** split the stream into exact non-overlapping 160 000-byte windows before the
pipeline calls `transcribe`. So `chunkPcm` receives exactly `160 000` bytes:

- `stt.ts:60` loop enters, `end = Math.min(0 + 160000, 160000) = 160000`
- `stt.ts:64-69` pushes chunk index 0, 160 000 bytes
- `stt.ts:70` `if (end >= pcm.byteLength) break;` → `160000 >= 160000` → **break**

Result: **exactly one chunk, `OVERLAP_MS` never applied.** The only test exercising
multi-chunk behaviour is `stt.test.ts:185`
(`expect(chunkPcm(new Uint8Array(400_000)).length).toBeGreaterThan(1)`), which
constructs a 400 000-byte buffer no live caller ever produces. The multi-chunk test in
`.opencode/_archive/dead-code-phase1/src/voice/voice.test.ts:15-21` is quarantined
outside the runner. `CHUNK_MS`/`OVERLAP_MS`/`OVERLAP_BYTES` are exported but no live path
consumes the overlap. **Not a contradiction of any doc** — an unstated dead configuration.

---

## 5 — Keyring (`src/voice/keyring.ts`) — rotation matrix

### The rotation predicate, verbatim

`Keyring.release` — **`keyring.ts:89-94`**:
```ts
release(key: AcquiredKey, ok: boolean, status?: number): void {
  key.material.fill(0);
  if (!ok && (status === 429 || status === 401 || status === 403)) {
    this.forceAdvance(key.pool, status === 429 ? 'rate-limited' : 'auth-failed');
  }
}
```

**The set of rotating statuses is exactly `{429, 401, 403}`.** Three codes. Nothing else.

### `withKey()` — `keyring.ts:138-166`

```
const key = ring.acquire(pool);                        // 143
try {
  const out = await use(key);                          // 145
  ring.release(key, true);                             // 146   ok=true → no branch possible
  return out;                                          // 147
} catch (err) {
  const before = ring.rolloverLog.length;              // 149
  ring.release(key, false, httpStatusOf(err));         // 150
  const entry = ring.rolloverLog[before];              // 160
  if (entry !== undefined && entry.from !== entry.to
      && typeof err === 'object' && err !== null) {    // 161
    Object.defineProperty(err, ADVANCED, { value: true, enumerable: false, configurable: true });
  }
  throw err;                                           // 164   rethrown unchanged
}
```

Note `ring.release(key, true)` at `:146` passes **no** status, so the `!ok` guard at
`:91` is false and the rotation branch is unreachable on the success path. The original
error is always rethrown by identity — pinned at `key-release-status.test.ts:154-162`
(`rejects.toBe(boom)`).

### `httpStatusOf(err)` — `src/common/errors.ts:51-70`

Two recovery shapes, then `undefined`:

| Input shape | Handling | Line |
|---|---|---|
| `err instanceof OrchestratorError`, `code === 'BRAIN_AUTH'` | returns `401` | `errors.ts:54` |
| `err instanceof OrchestratorError`, `code === 'RATE_LIMITED'` | returns `429` | `errors.ts:55` |
| `err instanceof OrchestratorError`, any other code | returns `undefined` | `errors.ts:57` |
| object with numeric `.status` | returns it verbatim (groq-sdk `APIError`, fetch `Response` errors) | `errors.ts:61-62` |
| object with `error.status` numeric | returns it (openai/groq wrapped payload) | `errors.ts:64-67` |
| anything else | returns `undefined` | `errors.ts:69` |

**403 is deliberately collapsed to 401 only for `OrchestratorError`** — `errors.ts:48-49`
("They are distinct HTTP statuses but the same user action and the same rotation, and
`release` only branches on 429 vs auth"). A raw `status: 403` on a plain error object is
passed through as `403` and still rotates, because `release` tests `403` directly.

### Exhaustive rotation matrix

**`ok === true`** (no status, or status ignored) → **no rotation**, all statuses.

**`ok === false`:**

| HTTP status | Rotates the pool? | Rollover reason | Evidence |
|---|---|---|---|
| **401** | **YES** | `'auth-failed'` | `keyring.ts:91`; test `key-release-status.test.ts:86` |
| **403** | **YES** | `'auth-failed'` | `keyring.ts:91`; test `key-release-status.test.ts:96-104` |
| **429** | **YES** | `'rate-limited'` | `keyring.ts:92`; test `key-release-status.test.ts:106-115` |
| **402** | **NO** | — | absent from `keyring.ts:91`. `CHANGELOG.md:172-173`: "deliberately does not rotate on 402: a billing problem is not a bad key". `dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md:144`. `tts.ts:317-320`: "NOT a key fault, so L17 correctly does not rotate". |
| **422** | **NO** | — | absent from `keyring.ts:91`. `dossier/FISH-AUDIO-COMPLIANCE-AUDIT.md:144`: "402/422/404 do not, correctly". |
| **404** | **NO** | — | same |
| **400** | **NO** | — | absent from `keyring.ts:91` |
| **500 / 502 / 503 / any ≥500** | **NO** | — | test `key-release-status.test.ts:144-152`; `errors.ts:45-46`, `keyring.ts:134-136` |
| **timeout** (`SttTimeoutError`, `TtsTimeoutError`, `BRAIN_TIMEOUT`) | **NO** | — | test `key-release-status.test.ts:129-142` |
| **non-object throw** (string, `undefined`, `null`) | **NO** | — | `errors.ts:60` guard `err !== null` + `errors.ts:69` fallthrough |
| object with non-numeric `.status` (e.g. `'429'` string) | **NO** | — | `errors.ts:62` requires `typeof direct === 'number'` |
| `OrchestratorError` with any code other than `BRAIN_AUTH` / `RATE_LIMITED` | **NO** | — | `errors.ts:56-57` |

### Verdict on the brief's claim of "401/402/422/429"

| Brief claim | Truth |
|---|---|
| 401 rotates | **TRUE** |
| 402 rotates | **FALSE** — 402 is explicitly excluded |
| 422 rotates | **FALSE** — 422 is explicitly excluded |
| 429 rotates | **TRUE** |
| *(omitted from the brief)* | **403 rotates** — it is in the code and is the more commonly cited of the two auth codes |

The brief is wrong on two of four and silent on the one that `AGENTS.md:130` and
`dossier/COMPREHENSIVE_AUDIT_REPORT.md:407` both call out ("401/403 forces a key
advance").

### What happens on an unrecognised status

`httpStatusOf` returns `undefined` (`errors.ts:57`, `:69`). In `withKey`,
`release(key, false, undefined)` is called (`keyring.ts:150`); the predicate
`status === 429 || status === 401 || status === 403` is false, so `forceAdvance` is
**not** called. The pool is left untouched, no `RolloverInfo` is pushed
(`keyring.ts:107`), and `keyAdvanced(err)` returns `false` (`keyring.ts:176-178`), so
the telemetry row is stamped `remediationAttempted: 'None'`.

This is deliberate and documented at `keyring.ts:133-136`:
> "Status recovery is httpStatusOf, which returns undefined for anything it does not
> recognise. That is deliberate: an unrecognised failure must not advance the pool, or a
> transient 5xx would burn a valid key. Rotation is driven only by an explicit auth
> rejection or a rate limit."

The safety cost is real and recorded: a provider returning an unrecognised auth-failure
shape will silently reuse a dead key — exactly the L17 failure mode
`dossier/COMPREHENSIVE_AUDIT_REPORT.md:407` flags as **open**
("all keys can be bad and the UI stays silent").

### `KeyAdvanced` marking — a deliberate refinement

`keyring.ts:160-163` marks the error only when the rollover entry's `from !== to`, not
merely because the log grew. Reason (`keyring.ts:155-159`): `forceAdvance` fires even
for a **single-key pool**, burning the remaining slots and logging `K1 → K1`. That is a
real event but **not remediation**, and `KeyAdvanced` would otherwise appear on rows for
failures that changed nothing. `ADVANCED` is a non-enumerable `Symbol`
(`keyring.ts:169`, `:162`) so it never reaches a JSON log line.

### `acquire()` and `forceAdvance()`

- `ROTATION_LIMIT = 10` (`keyring.ts:9`).
- `acquire` (`keyring.ts:75-87`): `slot = Atomics.add(counter.view, 0, 1)`;
  `keyIndex = Math.floor(slot / ROTATION_LIMIT) % list.length`. So request #1..#10 → K1,
  #11..#20 → K2. Slot 0 is consumed by the counter's own initial value, so
  `keyId` is `K${keyIndex+1}`.
- `forceAdvance` (`keyring.ts:97-108`): stores
  `nextBoundary = (floor(current/10) + 1) * 10` so the **remaining slots on the current
  key are skipped entirely**, then zeroes the cached buffer and logs the rollover.
- `poolMaterial` (`keyring.ts:61-73`) zeroes and re-materialises the cached `Buffer` on
  index change; `acquire` returns a **copy** (`keyring.ts:72` `Buffer.from(buf)`), so the
  caller's zeroing in `release` cannot corrupt the pool's own cache.
- `destroy()` (`keyring.ts:115-118`) zeroes all cached material — the shutdown path.

### TTS does NOT use `withKey`

`FishHttpTransport.synthesizeStream` calls `this.keyring.acquire('fish')` directly
(`tts.ts:516`) and `this.keyring.release(key, false, res.status)` with the **raw Fish
status** (`tts.ts:529`). Consequences:

- Rotation still works for TTS — `release` sees the literal HTTP status, so 401/403/429
  rotate identically.
- But the `KeyAdvanced` marker is **never applied on the TTS path**, because only
  `withKey` sets it (`keyring.ts:161-163`). TTS telemetry at `daemon.ts:618-626` records
  `errorCode: 'TTS_FAILED'` with **no `remediationAttempted` field at all** — unlike the
  STT path (`daemon.ts:420`) and the brain path (`daemon.ts:553`). A Fish key rotation is
  therefore **invisible in telemetry**.
- Also note the raw status bypasses `httpStatusOf` entirely, so a Fish error that is not a
  genuine HTTP failure (e.g. `res.body === null` with `res.ok === true`, `tts.ts:528`)
  passes `res.status` — `200` — which does not rotate. That is the correct outcome.

---

## 6 — `fishErrorMessage` / `fishErrorDetail` — exact strings

### `fishErrorMessage(status, detail = null)` — `tts.ts:306-336`

| Status | Returned string (exact) | Line |
|---|---|---|
| `401` | ``TTS auth rejected (401) - the Fish API key is invalid, revoked or not entitled; rotate it`` | 316 |
| `403` | ``TTS auth rejected (403) - the Fish API key is invalid, revoked or not entitled; rotate it`` | 316 |
| `402` | `TTS out of credit (402) - top up the Fish balance or wait for quota; the key itself is fine` | 320 |
| `422`, `detail === null` | `TTS request rejected by the API (422) - a parameter is out of range` | 325 |
| `422`, `detail !== null` | ``TTS request rejected by the API (422): ${detail}`` | 326 |
| `429` | `TTS rate limited (429) - backing off` | 328 |
| `404` | `TTS voice model not found (404) - the reference_id does not resolve` | 330 |
| default, `status >= 500` | ``TTS provider error (${status}) - Fish failed on their side, safe to retry`` | 333 |
| default, `status < 500` | ``TTS failed: HTTP ${status}`` | 334 |

Every separator is an ASCII hyphen-minus `-` (U+002D) surrounded by single spaces, not
an em dash. The status is **interpolated**, not hardcoded, for the 401/403 pair
(`tts.ts:313-315`): "401 and 403 share a cause but NOT a meaning… An operator reading
'401' when the server said 403 is sent to debug the wrong thing entirely."

Statuses falling into the `default` branch, i.e. **not** specially handled: `400`, `405`,
`408`, `410`, `418`, `451`, and every unlisted 4xx. All render as
`TTS failed: HTTP <n>`. `3xx` cannot reach here (`res.ok` is false for 3xx in `fetch`,
so they hit the default branch, `n < 500`).

### `fishErrorDetail(res)` — `tts.ts:346-363`

| Step | Behaviour | Line |
|---|---|---|
| Guard | `if (res.status !== 422) return null;` — **only 422 body is ever read** | 347 |
| Parse | `await res.json()` inside `try`; `catch → return null` | 349-352 |
| Shape | `if (!Array.isArray(parsed)) return null;` | 354 |
| First element | `parsed[0]`; `if (first === undefined) return null;` | 355-356 |
| `msg` | `typeof first.msg === 'string' ? first.msg : null` | 357 |
| `loc` | `Array.isArray(first.loc)` → `filter(p => typeof p === 'string' \|\| typeof p === 'number').join('.')`, else `null` | 358 |
| Both absent | `return null` | 359 |
| Format | `(loc === null ? '' : \`${loc}: \`) + (msg ?? 'invalid')` | 361 |
| Bound | `.slice(0, 120)` — the return is truncated to **120 characters** | 362 |

`type` and `ctx` fields on Fish's 422 objects are **discarded**. Anything beyond the
**first** array element is discarded. Rationale (`tts.ts:339-344`): 401/402/404 bodies
are `{status, message}` — **account metadata** — and are deliberately never echoed, so a
caller cannot accidentally leak them into a log line (`tts.ts:302-304`).

This message is surfaced to the user verbatim at `daemon.ts:627`:
`` `تعذّر توليد الصوت: ${err instanceof Error ? err.message : 'خطأ'}` `` prefixed to code
`tts-failed`, level `'error'`.

---

## 7 — The 5-second window and the 160000 / 65536 byte constants

### `WINDOW_BYTES = 160_000` — `src/voice/ingest.ts:6`

`160 000` bytes = 16 000 samples/s × 2 bytes/sample × 5 s. Pinned by `ingest.test.ts:15`
(`expect(WINDOW_BYTES).toBe(160_000)`).

`MAX_BUFFERED_BYTES = WINDOW_BYTES * 6` = **960 000** bytes = 30 s —
`ingest.ts:8`, **private** (not exported).

**There are two independent 5 s windowing systems with the same size and no overlap
between them:**
- `ingest.ts` — `WINDOW_BYTES = 160_000`, non-overlapping, server-side, emits to the pipeline.
- `stt.ts` — `CHUNK_BYTES = 160_000` (from `CHUNK_MS = 5000`), *intended* to overlap by
  `OVERLAP_BYTES = 16 000`, but receives exactly one already-windowed buffer (§4 finding).

### Exceeding the window cap — `ingest.ts:86-100`

```ts
push(chunk) {
  if (chunk.byteLength === 0) return [];
  this.buffered = concat(this.buffered, chunk);
  while (this.buffered.byteLength > MAX_BUFFERED_BYTES) {   // 90
    this.buffered = this.buffered.subarray(WINDOW_BYTES);   // 91
    this.dropped += 1;                                     // 92
  }
  const out = [];
  while (this.buffered.byteLength >= WINDOW_BYTES) {        // 95
    out.push(this.buffered.subarray(0, WINDOW_BYTES));      // 96
    this.buffered = this.buffered.subarray(WINDOW_BYTES);   // 97
  }
  return out;
}
```

- **Over the 960 000-byte cap:** whole 160 000-byte windows are shed from the **front**
  (oldest first) and `dropped` increments. Partial frames are never discarded — the
  comment at `ingest.ts:89` is explicit ("never partial frames"). The loss is counted
  and surfaced via `droppedWindows` (`ingest.ts:81-83`, `audio-pipeline.ts:84-86`).
- **Under the window size:** `push` returns `[]` and the bytes accumulate in
  `this.buffered`. **An utterance shorter than 5 seconds is never transcribed** — it
  buffers indefinitely until either 160 000 bytes accumulate or `reset()` is called
  (`ingest.ts:103-105`). `CHANGELOG.md:176-179` states this as intended: "A 5-second
  utterance is the minimum that works… a shorter turn buffers and never transcribes."
- **Frame count:** one window = 160 000 / 3 200 = **50 uplink frames** of 100 ms.

### `MAX_AUDIO_BYTES = 64 * 1024` = **65 536** — `src/ipc/protocol.ts:28`

Enforced **inbound only**, at `src/ipc/ui-server.ts:442-446`:
```ts
if (frame.opcode === Opcode.Binary) {
  if (frame.payload.byteLength > MAX_AUDIO_BYTES) {
    safeWrite(conn, this.conns, encodeTextFrame(
      JSON.stringify({ type: ERROR_KIND, detail: 'audio frame too large' })));
    continue;
  }
  try { this.onAudio?.(Buffer.from(frame.payload)); }
  catch { /* Ingest errors must never crash the socket; the control plane stays up. */ }
  continue;
}
```

Behaviour on exceed:
- A JSON `{"type":"error","detail":"audio frame too large"}` text frame is written back.
- The offending frame is dropped. `continue` — **no `onAudio` call**.
- The **socket stays open**. The loop continues to the next frame.
- **The renderer never surfaces it.** `bridge/ws.ts:379` handles text frames; let me be
  precise: `onErrorFrame` is wired at `App.tsx:132`, but the frame in question has
  `type: 'error'`, and the daemon's own error-frame schema differs. The `error` frame
  carries **no `id`**, so it cannot be correlated to a command. `App.tsx:132`
  `onErrorFrame: (detail) => setNotice({code:'transport', detail, level:'error'})` is the
  only consumer, and in normal operation the renderer only ever sends 3 200-byte frames
  — exactly 4.9 % of the cap — so the branch is unreachable from the shipped shell.
- Pinned by `src/ipc/ui-server.test.ts:328` — "oversized binary frame gets an error
  frame, no onAudio, socket survives".
- `AGENTS.md` describes this as "silently, if you aren't collecting `error` frames" —
  accurate.

### Related transport constants

| Constant | Value | File:line | Note |
|---|---|---|---|
| `AUDIO_SAMPLE_RATE` | `16 000` | `protocol.ts:24` | |
| `AUDIO_FRAME_MS` | `100` | `protocol.ts:25` | |
| `AUDIO_FRAME_BYTES` | `(16000*100)/1000 * 2` = `3 200` | `protocol.ts:26` | uplink frame size |
| `MAX_AUDIO_BYTES` | `64 * 1024` = `65 536` | `protocol.ts:28` | inbound cap |
| `MAX_MESSAGE_BYTES` | `1024 * 1024` = `1 048 576` | `protocol.ts:22` | enforced in `parseHeader` → `WsProtocolError` (`protocol.ts:217-219`) |
| `MAX_CONNECTIONS` | `8` | `protocol.ts:19` | L15 cap |
| `MAX_AUDIO_CHUNK` | `32 * 1024` = `32 768` | `src/ipc/audio.ts:7` | **downlink** slice size |
| Downlink wire frame | `3 + 32 768` = `32 771` bytes | `audio.ts:10` | `[type:1][seq:u16be][mp3]` |
| `AUDIO_DOWNLINK_TYPE` | `0x01` | `audio.ts:6` | |
| Downlink seq space | `seq % 65_536` | `audio.ts:35`, `ui-server.ts:256` | wraps; `ui-server.ts` advances `(seq+1) % 65_536` **after** splitting (`ui-server.ts:254-256`) |
| `RESUME_BUFFER_CAP` | `256` | `protocol.ts:20` | |
| `UI_WS_PORT` | `4096 + 1` = `4097` | `protocol.ts:6` | |
| `UI_WS_PATH` | `'/v1/ui'` | `protocol.ts:7` | |
| `UI_SUBPROTOCOL` | `'voice-ui.v1'` | `protocol.ts:8` | |
| `PING_INTERVAL_MS` / `MISSED_PINGS_LIMIT` | `5000` / `3` | `protocol.ts:11-12` | |

**Note the 65 536 appears twice with unrelated meanings:** the inbound audio byte cap
(`protocol.ts:28`) and the 16-bit downlink sequence-number wrap (`audio.ts:35`,
`ui-server.ts:256`). They are not connected; only the latter is a modulus on a counter.

The renderer accepts any binary frame `>= 4` bytes whose first byte is `0x01`
(`bridge/ws.ts:369`) and takes `subarray(3)` — it does **not** re-validate the
`MAX_AUDIO_CHUNK` size, and it does **not** check the sequence number for loss or
reordering. `decodeAudioChunk` (`audio.ts:23-28`) is exported and tested but is **not**
used by the bridge.

### Other gates on the same path

| Constant | Value | File:line |
|---|---|---|
| `SPEECH_GATE_DB` | `-30` | `ingest.ts:19` |
| `NO_SPEECH_DROP` | `0.6` | `audio-pipeline.ts:27` |
| `REPEAT_MEMORY` | `5` | `audio-pipeline.ts:30` |
| Barge-in threshold | `-30` dB default | `apps/desktop/src/audio/vad.ts:20`, `:32` |
| `VAD_SAMPLE_RATE` | `16 000` | `src/runtime/vad.ts:8` |
| `VAD_WINDOW_SAMPLES` | `512` | `src/runtime/vad.ts:9` |
| `VAD_STATE_SHAPE` | `[2, 1, 128]` | `src/runtime/vad.ts:10` |
| Silero default threshold | `0.5` | `src/runtime/vad.ts:58` |
| Silero model | `onnx-community/silero-vad` → `models/silero-vad.onnx` (gitignored) | `src/runtime/vad.ts:5`, `:11` |
| Energy throttling in shell | `80` ms | `App.tsx:222` |

`ingest.ts:15-17` asserts `SPEECH_GATE_DB` is "deliberately identical to the renderer's
barge-in threshold (`apps/desktop/src/audio/vad.ts:20`)". **VERIFIED TRUE:** `-30` at
`ingest.ts:19` and `thresholdDb = -30` at `apps/desktop/src/audio/vad.ts:20`. One number
describes "this is speech" on both sides of WS-4097. The Silero gate's `0.5` is a
separate, model-internal scale and is *not* unified with the −30 dB energy value.

---

## 8 — Discrepancies: code vs `docs/` and `dossier/`

### 8.1 `docs/10-CHECKPOINT.md:421` — contradicts the shipped TTS body (HIGH)
> "**D3 calm voice** | `fishRequestBody()` … `latency: normal` (was `balanced`)"

Code: `tts.ts:386` is `latency: 'balanced'`. `tts.test.ts:286` asserts `'balanced'`.
`docs/06-API-SPECIFICATION.md:217` also says `"latency": "balanced"`. `docs/research/
OPEN_SOURCE_REFERENCES.md:290-295` describes the *current* body correctly. The
checkpoint ledger is the stale artifact — it records a state (D3, `normal`) that was
subsequently reverted by R2. `tts.test.ts:264-286` documents the revert explicitly
("CHANGED in v0.7.2 (R2). This previously asserted normal, chosen deliberately…").
`AGENTS.md` requires "real measured numbers" in `10-CHECKPOINT.md`; this row is stale.

### 8.2 `src/voice/tts.ts:246-262` — the docblock above `fishHeaders` contradicts its own file (HIGH)
The `TTSRequest` docblock still declares:
> "`latency: 'normal'` — docs: 'normal: best quality, balanced: reduced latency'. We were
> paying latency for a voice that came out shouting."

The code 124 lines below sends `'balanced'` (`tts.ts:386`), and a *second* comment block
at `tts.ts:374-385` explains at length **why** `'balanced'` is now correct (measured
426-556 ms vs 1 405-1 432 ms to first chunk). The `normal` rationale — "paying latency for
a voice that came out shouting" — is also **wrong on its own terms**: the loudness
complaint is addressed by `prosody: {volume: -2, normalize_loudness: true}`
(`tts.ts:394`), and `normalize` was explicitly *re-blamed and cleared* in the same
docblock (`tts.ts:259-261`). Three mutually contradictory rationales survive in one file.
This is a stale-comment hazard: the docblock is directly above the load-bearing
`fishHeaders` function whose own comment warns that an untested/undocumented invariant is
"one refactor away from being tidied into the body" (`tts.ts:280-282`).

### 8.3 `docs/06-API-SPECIFICATION.md:218` — wrong `chunk_length` (MEDIUM)
Spec example body says `"chunk_length": 200`. Code: `tts.ts:387` `chunk_length: 300`,
pinned by `tts.test.ts:287`. The spec example also omits seven fields the code actually
sends (`min_chunk_length`, `temperature`, `top_p`, `repetition_penalty`,
`condition_on_previous_chunks`, `prosody`). The spec's `model: s2.1-pro-free` HTTP block
(`docs/06:208`) is **correct** — it is presented under an `http` fence as a header, and it
matches `tts.ts:287`.

### 8.4 `docs/research/OPEN_SOURCE_REFERENCES.md:195` — describes a superseded state (LOW)
> "(`normalize: true`, no `prosody`, `chunk_length: 200`)."

`prosody` **is** sent (`tts.ts:394`) and `chunk_length` is `300`. Same staleness as 8.3,
in the research annex. The section immediately below it (`:285-295`) is correct and
explicitly corrects the `normalize` misreading, so the file contradicts itself.

### 8.5 `AGENTS.md` / `dossier` model claims — **ALL TRUE** (no discrepancy)
- `INTAKE_MODEL` = `dots-studio/dots-3-note-preview:free` — `coordinator.ts` (grep-confirmed
  via `daemon.ts:538`).
- `COORDINATOR_MODEL` / `NARRATOR_MODEL` / `BRAIN_OPENROUTER_MODEL` = `thinkingmachines/inkling:free`
  — `narrator.ts:36`, `brain.ts:177`. Confirmed.
- `OPENROUTER_USER_AGENT = 'opencode/1.0 (Voxaura)'` — `brain.ts:23`, sent at `brain.ts:206`
  **and** `brain.ts:306`. Confirmed mandatory.
- `reasoning: {effort:'none'}` required for Inkling — confirmed on all three Inkling
  paths, though **not** in `narrator.ts` itself: `daemon.ts:174` (narrator adapter),
  `daemon.ts:535` (prompt optimizer), `coordinator.ts:215` (Dots3 intake). `narrate()`
  passes only `responseFormat` (`narrator.ts:116-118`); the suppression is injected by
  the daemon's `narratorChat` adapter at `daemon.ts:174`. The `NarratorChat` type
  accepts a `reasoning` option (`narrator.ts:23`) that `narrate()` never populates —
  so the invariant lives in a caller, not in the narrator. Latent fragility, not a
  current defect.
- `json_schema` load-bearing — `NARRATOR_RESPONSE_FORMAT` is
  `{type:'json_schema', json_schema:{name:'narration', strict:true, schema:{…
  additionalProperties:false}}}` (`narrator.ts:39-51`). Confirmed `strict: true`.
- "4h45m" style geometry, `ROTATION_LIMIT=10`, FR-8 "exactly 10 requests then #11 rolls
  over" (`docs/01-PRODUCT-REQUIREMENTS.md:158-159`) — **matches** `keyring.ts:9`, `:79`.

### 8.6 `playback.ts:120-121` and `playback-f01.test.ts:57-59` — comment contradicts code (MEDIUM)
Both state `draining` is "reset BEFORE the try, not inside it". It is reset **inside the
`finally`** (`playback.ts:112`). The invariant holds; the description does not match the
file. Documented in full in §3. Flagged as a hazard because the two statements exist
specifically to warn a maintainer about a permanent wedge.

### 8.7 `AGENTS.md:130` — "L17 is open" vs `CHANGELOG.md:106` — consistent, both TRUE
`AGENTS.md:130` says "A key that is *present but invalid* looks identical to a healthy
one until the first utterance (L17 is open): a 401/403 advances the key **and surfaces
nothing**." `dossier/COMPREHENSIVE_AUDIT_REPORT.md:407` likewise records L17 as open
("all keys can be bad and the UI stays silent"). `CHANGELOG.md:106-118` claims the
rotation half shipped. Both are true: rotation shipped (`keyring.ts:89-94`, pinned by
`key-release-status.test.ts:96-115`), the *surfacing* half did not. Verified: no `notice`
is emitted on rollover; `forceAdvance` only pushes to `this.rollovers`
(`keyring.ts:107`), and no caller reads `rolloverLog` for a UI signal. The
`keyAdvanced()` marker (`keyring.ts:176-178`) reaches telemetry
(`daemon.ts:420`, `daemon.ts:553`) but **not** the TTS path (see §5).

### 8.8 `src/knowledge/shared/capabilities.ts:42,50-52` — accurate, verified
The Tier-1 ground truth restates the window and cap correctly: "The capture window is 5
seconds, 160000 bytes at 16 kHz"; "A binary audio frame larger than 65536 bytes is
rejected with an error frame and never reaches the pipeline. The window is 160000 bytes,
so audio must be sent in chunks of at most 32768". Matches `ingest.ts:6`,
`protocol.ts:28`, `audio.ts:7`.

### 8.9 Undocumented behaviour (no doc claims otherwise — recorded for completeness)
1. **STT 0.5 s overlap is unreachable** (§4). `OVERLAP_MS`/`OVERLAP_BYTES` are exported,
   documented at `stt.ts:5`, and dead in the live path.
2. **`AudioPlayer.drain()` has no timeout on `decode()`** (§3). An unsettled decode is a
   permanent, silent wedge that the `PLAYBACK_QUEUE_CAP` overflow then hides behind
   `droppedCount`.
3. **TTS telemetry omits `remediationAttempted`** (§5). STT and brain stamp it; TTS does
   not, so a Fish key rotation is unobservable.
4. **The voice path bypasses `AudioCache` entirely** (§1, step 33). `daemon.ts:614` calls
   `fish.synthesize()` directly, so `AudioCache.get`/`set` and `FileAudioOut` run **only**
   in `node dist/cli.js live` (`cli.ts:92`, `:127`). `docs/18-VOICE-PIPELINE.md:139` —
   "**Cache first:** key `sha256(normalize(text) + '|' + fishVoiceId)`; hit → play blob" —
   describes the daemon's spoken-reply path, which does not consult the cache.
   `docs/04-ARCHITECTURE.md:83` and `docs/18:139-141` both present cache-first as the
   live voice behaviour. **MEDIUM-HIGH doc/code discrepancy** in a load-bearing latency
   claim (`docs/18:151` "cache-hit playback starts in < 50 ms").

---

## 9 — UNVERIFIED

- **Live behaviour of Fish Audio, Groq, and OpenRouter.** No network call was made. All
  provider timings quoted in code comments (426-556 ms balanced, 1 405-1 432 ms normal,
  726 ms STT, 3 196+1 267 ms TTS, the 5/5 and 0/5 narration trials) are **UNVERIFIED**
  — they are in-source claims, not measurements I reproduced.
- **The four-way Fish 402 probe** (`fish-free-tier-header.test.ts:5-10`,
  `tts.ts:268-273`) is **UNVERIFIED**; it is recorded as a 2026-09-28 live probe, not
  re-executed here.
- **The 2026-11-30 free-tier end date** (`tts.ts:14-30`) is **UNVERIFIED** — no
  provider documentation was fetched.
- **Whether `apps/desktop/src/audio/vad.ts` energy gate and `src/runtime/vad.ts` Silero
  gate are ever both active** — `audio-pipeline.ts:164-168` shows the injected detector
  *replaces* rather than stacks on the energy gate, but which is injected at runtime
  depends on `daemon.ts`'s dynamic VAD load, which was not traced in full.
- **E2E coverage of the audio path.** `apps/desktop/e2e/` drives `stub-daemon.mjs`, which
  per `AGENTS.md` has no providers and no vault; no claim is made here about which hops
  are exercised end-to-end.
