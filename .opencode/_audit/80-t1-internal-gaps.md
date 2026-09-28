# Track 1 — Internal Gaps: four implementable specifications

**Scope:** Gap 1 (TTS billed while muted), Gap 2 (API-key health / silent failure), Gap 3 (Windows packaging / tray / installer), Gap 4 (desktop audio recovery).

**Method:** every claim below is derived from physical source at a cited `file:line`, or from a measurement I ran and describe. Markdown in this repo (`AGENTS.md`, `docs/*`, `dossier/*`, `CHANGELOG.md`) was treated as a claim and used **only** as a pointer; where it disagrees with the source, the source wins and the disagreement is recorded. Anything I could not verify is written `UNVERIFIED`.

**No code or config was modified.** This file is the only artefact.

---

## Measurement provenance

| # | Measurement | How obtained |
|---|---|---|
| M1 | `packaging-preflight.mjs` = 15 checks, 14 pass, 1 `MISS` = `MSVC linker (cl/link)` | ran `node scripts/packaging-preflight.mjs` in the repo root, read stdout, `EXITCODE=0` |
| M2 | `cargo test` count is **48**, not the 27 `AGENTS.md` claims | `Select-String -Pattern "#\[test\]" main.rs \| Measure-Object` → 48 |
| M3 | Fish first-chunk TTFB at `latency: 'balanced'` = **426–556 ms** (2 samples) | source comment `src/voice/tts.ts:379-386`. This is a *recorded claim in code*, not something I re-measured (no key, no quota). Re-derivable with `scripts/live_console_test.ts:297-330`. |
| M4 | Cached synthesis blobs, repo `audio-cache/`: 6 files, 128 kbps / 44.1 kHz, **3.13–5.49 s**, mean **4.24 s**, 407,079 B total, mtimes 2026-09-26 | wrote `%LOCALAPPDATA%\Temp\opencode\mp3probe.mjs` (MPEG frame-header walk, ID3-skip aware) and ran it over the directory |
| M5 | Cached synthesis blobs, installed `%LOCALAPPDATA%\Voxaura\audio-cache\`: 10 files, 128 kbps / 44.1 kHz, **2.80–4.99 s**, mean **3.40 s**, 574,375 B total, all mtime 2026-09-27 12:28–12:29 local | same script, same method |
| M6 | `artifacts/live_voice_test.mp3` = 140,851 B, 128 kbps, 44.1 kHz, **8.80 s** | same script |
| M7 | `~/.opencode-voice-runtime/voice-runtime.jsonl` = 144 rows, **142 `KEYS_MISSING` + 1 `STT_FAILED` + 1 `LAYA DEGRADED`**, **zero `TTS` rows**, span 2026-09-27T14:35:25.159Z → 2026-09-28T17:02:50.548Z | `ConvertFrom-Json` over the file, grouped by `subsystem,status` |
| M8 | Installed build **does** boot: `supervisor.log` lines `[1790598393]…` → `[1790598397] daemon: daemon started on 4097`, with `resolve: node=…\Voxaura\sidecar\node.exe entry=…\Voxaura\sidecar\dist\cli.js` | read `~/.opencode-voice-runtime/supervisor.log` |
| M9 | 62 of 67 `supervisor.log` lines are **unit-test output**, not production | `main.rs` test helper `temp_dir()` builds `%TEMP%\voxaura-phase2-{tag}-{pid}-{nanos}` (main.rs:1851 → the `temp_dir` fn); the log lines quote `voxaura-phase2-logs-fallback-…` paths and emit `JOB-CREATE-FAILED` / `job-adopt-failed` (6 + 24 occurrences) that only `with_unavailable_job()` (main.rs:474) produces |
| M10 | `TtsEngine`, `FileAudioOut`, `AudioCache`, `sweepOldPlaybackFiles`, `TTS_FIRST_CHUNK_BUDGET_MS`, `SPEECH_CACHE_MAX_ENTRY_BYTES` have **zero production importers** | `Select-String` over `src/**/*.ts` excluding `*.test.ts`; the only `new AudioCache` is `tts.ts:566` inside `TtsEngine` |

---

## Doc-vs-source disagreements found (not part of any gap, but they change the fix)

1. **`AGENTS.md` "Gates" claims `cargo test` 27 tests.** Actual: **48** (`#[test]` count in `main.rs`). M2.
2. **`AGENTS.md` claims the supervisor's token/pass come from "an xorshift64\* seeded with `nanos ^ pid`" and that "no test runner covers `main.rs` token generation".** Both are stale. `Cargo.toml:14-20` adds `getrandom = "0.3"` and documents it as RtlGenRandom/BCryptGenRandom; `main.rs` calls `secure_random_bytes`; `git log` shows `2529fc3 security(s2): replace the xorshift64* token generator with the kernel CSPRNG`. There are **48** tests in `main.rs`. Do not re-audit the CSPRNG — that gap is already closed (see `.opencode/_audit/20-w3-csprng.md`).
3. **`AGENTS.md` "Dead code — 0%" is true at *module* granularity and false at *symbol* granularity.** `src/voice/tts.ts` is reachable, so the scan passes, but the whole cache/audio-out layer inside it (M10) is unreachable. This is the same "green suite + reachable module ≠ wired feature" lesson, one level down. It is the direct cause of Gap 1.
4. **The voice runtime holds 144 telemetry rows and 0 of them are TTS.** M7. The gate ledger's "TTS works" claim has no telemetry behind it.

---

# GAP 1 — TTS is billed while muted

**Severity: HIGH (direct, recurring money loss; silent).**

## 1.1 Where the synthesis call happens

The single production TTS call site is `src/daemon.ts:776`:

```ts
776:  const mp3 = await fish.synthesize(sentence, voiceId);
```

- `fish` is `new FishHttpTransport(ring)` built at `src/daemon.ts:528` inside `buildVoicePipeline()`.
- It is called from the `onUtterance` handler wired into the `AudioPipeline` at `src/daemon.ts:756-795`.
- The reply is split first: `const sentences = splitSentences(text)` (`src/daemon.ts:771`, implementation `src/voice/tts.ts:157-182`), so **one reply costs one Fish HTTP call per sentence**, serially, in a `for` loop (`src/daemon.ts:774-779`).
- `synthesize` (`src/voice/tts.ts:504-517`) drains `synthesizeStream` into a **single buffered `Uint8Array`** before returning. So `ui.broadcastAudio(mp3)` at `src/daemon.ts:778` fires once per *whole sentence*, not progressively. The renderer's chunked downlink (`apps/desktop/src/bridge/ws.ts:372-374`) therefore receives one MP3 per sentence despite the transport streaming.

## 1.2 Where the mute state lives, and whether the daemon can see it

It cannot. Verified three ways:

1. **The state is a React `useState` and nothing else.** `apps/desktop/src/App.tsx:40` `const [botMuted, setBotMuted] = useState(false);`. Its only writers are `setBotMuted` at `App.tsx:418` and the lazy-player sync at `App.tsx:169`. Its only readers are `App.tsx:88-90`, `App.tsx:169`, `App.tsx:422-423`, `App.tsx:462`. There is no persistence, no store, no context, no bridge write.
2. **The renderer deliberately does not tell the daemon.** `App.tsx:402-428` documents it: *"assistant mute is now RENDERER-LOCAL, and that is the whole fix. It used to `send({kind:'mute'})`. The daemon's router answers `mute`, `deafen` and `arm` in one arm with no side effect at all (`src/orchestrator/command-router.ts:227-230`) and returns `ok:true`…"*. `toggleBotMute` (`App.tsx:416-428`) sends nothing on the wire.
3. **The daemon has no mute variable at all.** `Select-String 'muted|botMuted'` over `src/daemon.ts` returns exactly one hit: line 280, and it is a *comment* ("synthesize or broadcast afterwards. Plain state — safe before key setup."). The `onUtterance` body (`daemon.ts:756-793`) contains no mute check.

**The audio gate is real and correct** — `AudioPlayer.setMuted` (`apps/desktop/src/audio/playback.ts:74-78`) sets `this.muted`, calls `this.stop()`, and `enqueue` returns immediately at `playback.ts:81` when muted. So **nothing is emitted**. That part of Wave 2 works. Only the *billed synthesis* is unguarded.

**The wire already has a `mute` command that does nothing.** `src/ipc/protocol.ts:348` includes `'mute'` in `UiCommandSchema`'s `kind` enum; `src/orchestrator/command-router.ts:227-230` returns `{ ok: true }` for `mute`, `deafen` and `arm` in one shared arm. The renderer-side union also lists it (`apps/desktop/src/bridge/ws.ts:75`). So the contract has a slot and the handler is a stub.

## 1.3 Does a muted-but-cached reply still cost money? — **The cache is not on the path at all.**

This is the sharper finding. `AudioCache` exists (`src/voice/cache.ts:47-110`, 50-entry LRU, 64 MiB cap, per-entry 4 MiB cap from `src/common/config.ts:57-62`) and `TtsEngine` consumes it (`src/voice/tts.ts:558-607`, `:620-658`). But:

- **`TtsEngine` has zero production importers** (M10). The daemon deliberately bypassed it — `src/daemon.ts:542-546`: *"D4: deliberately no `speak` hook. It used to route the reply through TtsEngine + FileAudioOut, which wrote an MP3 to %TEMP% that nothing ever played — so every utterance was synthesised TWICE…"*.
- `tts.ts:369-375` says the same thing from the other side: *"the daemon's `onUtterance` path calls the transport directly, bypassing TtsEngine"*.
- `src/voice/cache.ts` is only ever constructed at `tts.ts:566`.

**Therefore the answer is worse than "a cache hit would make it free":** on the live path there is **no cache lookup at all**. Every sentence of every reply is a fresh, billed Fish request whether the bot is muted, whether the same sentence was said thirty seconds ago, and whether anyone is listening. `remediationAttempted: 'CacheBypassed'` exists in the telemetry union (`src/telemetry/writer.ts:33`) and has **no producer**.

Two corroborating artefacts, both orphaned:
- `%LOCALAPPDATA%\Voxaura\audio-cache\` holds 10 MP3s (M5, 574,375 B) written by the installed daemon on 2026-09-27 12:28–12:29.
- The current source has **no writer** for that directory on the TTS path, and `sweepOldPlaybackFiles` (`tts.ts:423`, retention `PLAYBACK_RETENTION_MS = 15 min` at `tts.ts:414`) has no caller. So those 10 files, plus 6 in the repo `audio-cache/` (M4, 407,079 B), are permanent orphans: **981,454 bytes of dead audio on two disks.** M4/M5/M10.

## 1.4 Quantifying the waste

Per muted reply, the daemon pays:

```
sentences(reply) × [ TTFB + full-sentence synthesis ]
```

Measured inputs:
- **TTFB: 426–556 ms** per Fish call at `latency: 'balanced'` (M3, `tts.ts:379-386`; the shipped value is `tts.ts:390`).
- **Speech produced per synthesis unit: 2.80–5.49 s** across the 16 measured blobs in M4+M5, mean 3.79 s. At 128 kbps that is **~60.6 KB per sentence billed and transmitted**, and the client throws it away at `playback.ts:81`.
- `MAX_SENTENCE_CHARS = 400` (`tts.ts:34`, enforced by `splitSentences` at `tts.ts:164,171`) bounds one call, not the reply. A three-sentence reply therefore costs ≥ 3 × 426 ms ≈ **1.28 s of pure TTFB before the first byte reaches a muted player** (the real number is higher, because the calls are serial: `daemon.ts:774`).

**Cost in currency: UNVERIFIED.** No billing figure exists anywhere in the repo, `s2.1-pro-free` is a free slug (`tts.ts:31`, and `tts.ts:22-29` records that a *paid* slug 402s identically), so the "money" is Fish rate-limit budget and the OpenRouter quota spent on the intake/plan/narration chain that produced the reply in the first place. What *is* measurable is latency and bytes: **a muted user still pays the full intake → plan → TTS chain, ~1.3 s+ of serial TTFB per reply, and ~60 KB of MP3 per sentence, to hear nothing.**

## 1.5 Specification

### 1.5.1 Daemon-side mute state (the minimum change)

The daemon needs one boolean it owns. Add it beside `activePersona` and `voicePhase` in the `startDaemon` closure in `src/daemon.ts` (both are closure-local plain state; `voicePhase` is declared before `setVoicePhase` at `daemon.ts:519-523`).

```ts
// src/daemon.ts — new, adjacent to the existing `voicePhase` plain state
let outputMuted = false;

const isOutputMuted = (): boolean => outputMuted;
```

Guard the synthesis loop at `src/daemon.ts:774-779`. The gate must sit **before `fish.synthesize`**, and it must also stop the reply from being reported as `speaking`, because `setVoicePhase('speaking', text)` at `daemon.ts:766` is what makes the HUD claim the assistant is talking (the renderer already compensates locally at `App.tsx:462`, but the daemon's `voice` frame is the contract and other shells will not):

```ts
// src/daemon.ts:761-779  (replaces the current body)
const text = stripSpeechText(utterance.reply);
if (!isSpeakable(text)) {
  setVoicePhase('idle');
  return;
}
if (isOutputMuted()) {
  // The text is still shown in the thread; it is simply not spoken, and it
  // costs no provider call. `voice` never reports `speaking`, so the HUD
  // cannot claim audible speech that is not happening.
  ui.notice('assistant-muted', 'تم كتم صوت المساعد — لم يُنفَّق رصيد على النطق.', 'info');
  setVoicePhase('idle');
  return;
}
setVoicePhase('speaking', text);
```

`isOutputMuted()` is read **inside** `onUtterance`, not captured once, so a mute pressed *mid-reply* takes effect on the next sentence of the same reply. `speechGate.isCurrent(gen)` at `daemon.ts:775` already handles the barge-in case; the mute check is the orthogonal one.

### 1.5.2 What crosses the wire, and which frame

Two options. **Take option B.**

**Option A (rejected) — reuse the existing `mute` command.** `src/ipc/protocol.ts:348` already accepts it and `command-router.ts:227` already answers it. But the command is `ack`-shaped (`{ok:true}`), and the W6 note at `App.tsx:405-411` explains precisely why acking a mute you did not honour was the original bug. Reusing it is fine only if the handler becomes real *and* honest. It also cannot express "muted" vs "rejected".

**Option B (specified) — a new additive frame, `output` (a state stream).**

Add to `src/ipc/protocol.ts`, alongside `VoiceFrameSchema` (`protocol.ts:453-460`):

```ts
/**
 * Output policy — whether the daemon is permitted to spend provider quota on
 * speech. Additive: a shell that predates this frame keeps its own local mute
 * and the daemon keeps speaking, which is exactly today's behaviour.
 */
export const OutputPolicySchema = z.enum(['audible', 'muted']);
export type OutputPolicy = z.infer<typeof OutputPolicySchema>;

export const OutputFrameSchema = z.object({
  type: z.literal('output'),
  seq: z.number().int().nonnegative(),
  output: OutputPolicySchema,
});
export type OutputFrame = z.infer<typeof OutputFrameSchema>;
```

This mirrors `context` (a state frame the shell requests and renders, `protocol.ts:462-475`) rather than `notice` (a transient banner, `protocol.ts:436-446`). A `notice` is wrong here: the shell already has a persistent `botMuted` control (`App.tsx:40`, `App.tsx:631-641`) and duplicating a *state* into a *transient* channel creates a second source of truth — the exact failure `L22` fixed for persona (`App.tsx:122-127`).

**Also mirror it into `hello` so a late-connecting shell adopts the daemon's state**, exactly as `persona` was done (`protocol.ts:311-317`):

```ts
// add to HelloFrameSchema (protocol.ts:304-318)
output: OutputPolicySchema.optional(),
```

### 1.5.3 Router handler

In `src/orchestrator/command-router.ts`, replace the shared no-op arm at `:227-230`:

```ts
// before
case 'mute':
case 'deafen':
case 'arm':
  return { ok: true };

// after
case 'mute':
  return { ok: true, detail: cmd.muted === true ? 'output-muted' : 'output-audible' };
case 'deafen':
case 'arm':
  return { ok: true };
```

and add `muted: z.boolean().optional()` to `UiCommandSchema` (`protocol.ts:384`, before the closing `})` at `:385`) and to `CommandMsg` (`apps/desktop/src/bridge/ws.ts:104`).

Wire the router dep. `deps.setPersona` is the pattern to copy (`command-router.ts` consumer side, `src/daemon.ts:407-422`): add `deps.setOutputMuted(muted: boolean): void`, and in `src/daemon.ts`:

```ts
setOutputMuted: (muted) => {
  if (outputMuted === muted) return;      // echo-loop defence, same as :418
  outputMuted = muted;
  ui.setOutput(muted ? 'muted' : 'audible');
},
```

with `UiServer.setOutput` in `src/ipc/ui-server.ts` next to `setPersona` (`ui-server.ts:132`):

```ts
setOutput(policy: OutputPolicy): void {
  this.broadcastFrame(OutputFrameSchema.parse({ type: 'output', seq: 0, output: policy }));
}
```

and include `output` in the `hello` frame built in `ui-server.ts` alongside `persona`.

### 1.5.4 Renderer

Replace `toggleBotMute` (`App.tsx:416-428`) with one that both applies locally and reports — the local apply must stay, because `AudioPlayer`'s gate is the only thing that stops bytes hitting a sink and because the player may not exist yet:

```ts
const toggleBotMute = (): void => {
  const next = !botMuted;
  setBotMuted(next);
  botMutedRef.current = next;
  playerRef.current?.setMuted(next);
  if (next) setSpeakingState(false);
  // The gate that costs money lives in the daemon, so the daemon must be told.
  const live = bridgeRef.current;
  if (live === null) { setAnnounce('الخادم غير متصل'); return; }
  void live.sendCommand({ id: nextCmdId(), kind: 'mute', muted: next });
};
```

Then adopt the daemon as the source of truth on connect and on the new frame, mirroring the persona adoption at `App.tsx:120-128` and the new frame handler in `apps/desktop/src/bridge/ws.ts` (next to `onNotice`, `ws.ts:471-484`):

```ts
// bridge option
onOutput?: (policy: 'audible' | 'muted') => void;

// VoxauraBridge message dispatch — add beside the onNotice branch
} else if (msg['type'] === 'output') {
  const out = msg['output'];
  if (out === 'audible' || out === 'muted') {
    this.lastSeq = typeof msg['seq'] === 'number' ? msg['seq'] : this.lastSeq;
    this.opts.onOutput?.(out);
  }
}
```

`App.tsx` wires `onOutput` to set `botMuted` and mirror the ref + player gate, so a second window's mute applies to the first. **Keep `setMuted` idempotent** — it already early-returns at `playback.ts:75`, so a duplicate frame is free.

**Guard the ordering:** `onHello` fires before any `mute` ack on a cold connect, so the `hello.output` field is what prevents a reconnecting shell from un-muting a muted daemon for the ~1 RTT until the user presses something. Prefer `hello.output` as the authority; treat the `output` frame as the change signal.

### 1.5.5 Cache interaction (required, or the fix is half a fix)

With the mute gate in place, an unmuted user still pays Fish on every repeat. `AudioCache` and `TtsEngine` are already written, already tested (`src/voice/tts.test.ts:325,392` construct `AudioCacheConfig`), and are currently dead (M10). Re-attaching them is the difference between "muting is free" and "the product is cheap".

Two options:

- **B (specified, smaller): put a cache in front of the *existing* daemon call, not behind `TtsEngine`.** `AudioCache` is self-contained (`get(text, voice) → Buffer | null` at `cache.ts:66`, `set(text, voice, bytes)` at `cache.ts:79`). Instantiate it once in `buildVoicePipeline` (`src/daemon.ts:525-799`) alongside `fish`, and in the sentence loop:

  ```ts
  const cached = await audioCache.get(sentence, voiceId);
  if (cached !== null) {
    if (speechGate.isCurrent(gen)) ui.broadcastAudio(cached);
    continue;
  }
  const mp3 = await fish.synthesize(sentence, voiceId);
  if (!speechGate.isCurrent(gen)) return;
  await audioCache.set(sentence, voiceId, mp3).catch(() => undefined);
  ui.broadcastAudio(mp3);
  ```

  Note the `voiceId` type: `cache.get/set` take a `VoiceId` (`cache.ts:66,79`) but `daemon.ts:769` computes a *Fish* `reference_id` string from `VOICE_IDS[...]`. Pass the `VoiceId` (`activePersona === 'nour' ? 'female-toggle' : 'male-default'`), not the mapped string, or the cache key silently changes meaning.

  Also populate `remediationAttempted: 'CacheBypassed'` on the miss path — the enum member already exists at `src/telemetry/writer.ts:33` and has no producer, so a miss is currently indistinguishable from a hit in the ledger.

- **A (rejected): re-wire `TtsEngine`.** It owns an `AudioOut` sink (`tts.ts:558-565`) whose only implementation is `FileAudioOut` (`tts.ts:205-223`), which writes an MP3 to disk and hands it to the OS — the exact double-synthesis D4 removed (`daemon.ts:542-546`). Re-wiring it means writing a second `AudioOut` that bridges to `UiServer.broadcastAudio`. More code, same cache, more risk.

**Cache correctness note that must be respected:** `AudioCache` is an in-process LRU (`cache.ts:48`) backed by files on disk (`cache.ts:60,84`). It is **not** shared between the installed app and a repo run, and it is not invalidated when the vault or the voice changes — the key already includes the voice (`cacheKey`, `cache.ts:41-45`), so persona switching is safe, but a changed Fish model or a `s2.1` upgrade is **not**. If the cache is re-attached, add `TTS_MODEL` (`tts.ts:31`) to the `cacheKey` input, otherwise an upgrade silently serves audio synthesised by the previous model.

### 1.5.6 Tests the change must ship with

1. `src/voice/tts-cache-wiring.test.ts` (root vitest) — a muted daemon issues **zero** `fish.synthesize` calls. Construct `startDaemon` with an injected transport stub and assert the call count. Verify non-vacuity by removing the `isOutputMuted()` guard and confirming the test goes red.
2. `src/ipc/protocol.test.ts` — extend the existing round-trip list (it already exercises `'mute'` at `protocol.test.ts:178,213` and `ui-server.test.ts:269`) with `output: 'muted' | 'audible'`, and assert `hello.output` round-trips.
3. `src/orchestrator/command-router.test.ts` — `mute` with `muted: true` returns `detail: 'output-muted'`, and `deps.setOutputMuted` was called exactly once; a repeated identical `mute` does not call it twice (echo-loop defence, mirroring `daemon.ts:418`).
4. `apps/desktop/src/bridge/ws.test.ts` — an inbound `{"type":"output","seq":N,"output":"muted"}` invokes `onOutput`; an unknown value does not.
5. A regression test that `onUtterance` while muted emits **no** `voice` frame with `phase: 'speaking'` — the `App.tsx:456-461` comment says this matters and today only the renderer compensates.

---

# GAP 2 — API-key health and silent failure

**Severity: HIGH (the app's primary failure mode is indistinguishable from normal silence, and there is no probe anywhere).**

## 2.1 The rotation rule, exactly

`Keyring.release` (`src/voice/keyring.ts:89-94`):

```ts
89:  release(key: AcquiredKey, ok: boolean, status?: number): void {
90:    key.material.fill(0);
91:    if (!ok && (status === 429 || status === 401 || status === 403)) {
92:      this.forceAdvance(key.pool, status === 429 ? 'rate-limited' : 'auth-failed');
93:    }
94:  }
```

- **402 → no advance.** Correct in isolation (a paid account out of credit is not a bad credential, and rotating would burn valid keys), but see §2.3: nothing *else* happens either.
- **5xx → no advance.** Deliberate and documented at `keyring.ts:133-136`: *"an unrecognised failure must not advance the pool, or a transient 5xx would burn a valid key."* Sound.
- **Timeout / network error → no advance.** `httpStatusOf` returns `undefined` for anything unrecognised (`src/common/errors.ts:51-70`).

`httpStatusOf` is the only status recovery path (`src/common/errors.ts:51-70`):
- `OrchestratorError` → `BRAIN_AUTH` ⇒ 401, `RATE_LIMITED` ⇒ 429, **everything else ⇒ `undefined`** (`errors.ts:52-58`). This includes `BRAIN_REJECTED`, which is what a 402 and a 5xx both become (`src/voice/brain.ts:236`).
- groq-sdk `APIError` → its `.status` verbatim (`errors.ts:60-62`), and `{error:{status}}` (`errors.ts:64-67`).

`withKey` (`src/voice/keyring.ts:138-166`) wraps the STT (`daemon.ts:563`) and brain (`daemon.ts:530`) paths and tags the error with a non-enumerable `ADVANCED` symbol when the pool actually moved (`:160-163`), which `keyAdvanced(err)` (`:176-178`) reads so the caller can write `remediationAttempted: 'KeyAdvanced'` (`daemon.ts:582`, `:715`, `:736`).

**The Fish path does not use `withKey`.** `FishHttpTransport.synthesizeStream` calls `keyring.acquire`/`keyring.release` directly (`src/voice/tts.ts:520, 533, 536`). That is functionally equivalent for rotation, but it means **TTS failures never get the `KeyAdvanced` marker and never write `remediationAttempted`** — `daemon.ts:780-789` records `TTS OK` or `TTS_FAILED` with no remediation field at all.

## 2.2 The structural finding: the keyring is built for N keys, the product stores 1

This is the finding that makes "rotation" almost fictional, and it is the reason "a single bad key can silently burn the pool" is *worse* than the brief states.

- The vault stores arrays: `PoolSecrets { keys: string[] }` (`src/voice/vault.ts:20-22`), encrypted per pool (`vault.ts:85-98`).
- The wire accepts **one key per provider**: `UiCommandSchema` has `groqKey`, `fishKey`, `openrouterKey` as single `z.string().max(512)` (`src/ipc/protocol.ts:376-378`); `CommandMsg` mirrors it (`apps/desktop/src/bridge/ws.ts:100-102`).
- `daemon.ts:426-430` writes exactly one key per pool: `writeKeyPools(vault, { groq: [keys.groq], fish: [keys.fish], openrouter: [keys.openrouter] })`.
- `mergeKeyPools` **replaces** the whole list rather than appending: `merged[pool] = [...next]` (`src/voice/key-store.ts:32`).

So the installed product's pools are always length 1. Now the consequence, from `forceAdvance` (`keyring.ts:97-108`):

```ts
100:  const current = Atomics.load(counter.view, 0);
101:  const currentKey = Math.floor(current / ROTATION_LIMIT) % list.length;
102:  const nextBoundary = (Math.floor(current / ROTATION_LIMIT) + 1) * ROTATION_LIMIT;
103:  Atomics.store(counter.view, 0, nextBoundary);
104:  const nextKey = nextBoundary === current ? currentKey : (currentKey + 1) % list.length;
```

With `list.length === 1`, `(currentKey + 1) % 1 === 0 === currentKey`, so `nextKey === currentKey`: the counter jumps forward ten slots and **the same dead key is handed out again on the very next request.** The only trace is a `K1 → K1` rollover row in `rolloverLog` (`keyring.ts:107`).

`withKey`'s own comment admits this and calls it *not* remediation (`keyring.ts:156-159`): *"`from !== to` rather than 'the log grew': forceAdvance also fires for a single-key pool, where it burns the remaining slots and logs K1 -> K1. That is a real event but it is not remediation."* The comment is correct about the *marker* and silent about the *consequence*: with one key, advancing is a no-op on the credential, forever.

## 2.3 Which failures are actually silent to the user

| Failure | Pool advances? | Telemetry | User-visible notice | Verdict |
|---|---|---|---|---|
| Groq 401/403 | yes (`errors.ts:61`) | `STT_FAILED` + `KeyAdvanced` (`daemon.ts:573-583`) | `stt-failed` banner (`daemon.ts:585`) | **not silent** |
| Groq 429 | yes | same | `stt-failed` | **not silent** |
| Groq 402 | no | `STT_FAILED`, `KeyAdvanced: 'None'` | `stt-failed` | not silent, but the message is Groq's raw text, so "insufficient credits" arrives as a generic Arabic failure |
| Groq 5xx / timeout | no (`errors.ts:52-58` for the brain; verbatim status for groq) | `STT_FAILED` or `STT_TIMEOUT` | `stt-failed` / `stt-timeout` | not silent |
| Fish 401/403/429 | yes (`tts.ts:533` → `keyring.ts:91`) | `TTS_FAILED`, **no remediation field** (`daemon.ts:782-788`) | `tts-failed` (`daemon.ts:789`) | banner yes, **rotation invisible** |
| Fish 402 | no | `TTS_FAILED`, no remediation | `tts-failed` with a *good* message (`tts.ts:323-324`) | **not silent, and well-handled** — `tts.ts:310-339` is the best error code in the repo |
| Fish 5xx | no | `TTS_FAILED` | `tts-failed`, message says "safe to retry" (`tts.ts:336-337`) — **but nothing retries**; `daemon.ts:781-792` catches and moves to `finally` | **misleading** |
| Fish timeout (20 s, `tts.ts:403`) | no | `TTS_FAILED`, `sanitizedErrorClass: 'TimeoutError'` | `tts-failed` | not silent |
| OpenRouter 401/403 | yes | `BRAIN_FAILED` + `KeyAdvanced` (`daemon.ts:730-737`) | `brain-failed` (`daemon.ts:738`) | not silent |
| OpenRouter 429 | yes | same | `brain-failed` | not silent |
| OpenRouter **402** | no — `BRAIN_REJECTED` ⇒ `httpStatusOf` ⇒ `undefined` (`errors.ts:56-57`) | `BRAIN_FAILED`, `KeyAdvanced: 'None'` | `brain-failed` | not silent, but `brain.ts:236` marks it `retryable: true`, so `brain.ts:288-289` **retries it 3×** — 3 wasted calls per turn against a known-dead account |
| OpenRouter 5xx | no | `BRAIN_FAILED` | `brain-failed` | retried 3× (`brain.ts:236` `retryable: true`) — correct |
| **No keys at all** | n/a | `KEYS_MISSING` **DEGRADED** (`daemon.ts:808-815`) | `voice-disabled-no-keys` warn banner (`daemon.ts:816`) | **not silent, and unbounded** — see below |

**So the honest answer to "which failures are silent" is: none of the *provider* failures are invisible to the user.** What is silent is:

1. **Every pool advance.** `rolloverLog` is read only by `withKey` itself (`keyring.ts:149,160`); grep confirms **no external consumer** and no notice, no telemetry row, no bridge frame. A key rotated away from a revoked credential is a fact the user can never observe.
2. **The transition from "one dead key" to "no working key".** With `list.length === 1` (§2.2) the K1→K1 rollover changes nothing, so the app simply keeps using the dead key and re-fails forever.
3. **The keyless state, which is not silent but is *indistinguishable from itself*.** M7: **142 identical `KEYS_MISSING` rows** over ~26 hours. `rebuildVoice()` runs at `daemon.ts:432` (on every `saveApiKeys`) and `daemon.ts:828` (at startup), and each failure writes a row and a `warn` notice (`daemon.ts:816`) with **no dedupe, no backoff, and no state change**. The banner is a single-slot `useState` (`App.tsx:42`), so the 142nd notice overwrites the 141st and the user sees the same line forever with zero escalation.
4. **`POOL_EXHAUSTED` and `RATE_LIMITED` in the telemetry union have no producer** (`src/telemetry/writer.ts:56-57`; grep finds them only in the schema and in `errors.ts:14,55`). This is the identical "enum with no producer" hole `KeyAdvanced` was (`keyring.ts:150-154`).
5. **The intake path mislabels every failure as `BRAIN_TIMEOUT`.** `src/daemon.ts:709-717` records the `optimizePrompt` / `INTAKE_MODEL` (`dots-3`, `daemon.ts:700`) failure as `errorCode: 'BRAIN_TIMEOUT'` regardless of cause. An intake 401, a 402, a 5xx and a genuine timeout all land on the same code — and `BRAIN_TIMEOUT` reads as retryable (that is exactly what L24 split `BRAIN_REJECTED`/`BRAIN_AUTH` out of, `src/common/errors.ts:6-12`), while this path **never retries**; it just falls back to the user's own words (`daemon.ts:708`, whose comment correctly calls that "honest"). The coordinator failure on the very next call uses the right code, `BRAIN_FAILED` (`daemon.ts:734`). **Fix:** add `'INTAKE_FAILED'` to `ErrorCodeSchema` (`src/telemetry/writer.ts:39-62`) and `'INTAKE_TIMEOUT'` only if a timeout is actually distinguishable, and write `keyAdvanced(err) ? 'KeyAdvanced' : 'None'` — which the row at `daemon.ts:715` already does correctly, so this is a one-word code change plus one enum member, not a redesign.

## 2.4 What a depleted key pool looks like from outside

**The app just stops speaking, and the HUD keeps claiming it is listening.** Concretely, from the source:

- `rebuildVoice` returns `null` → `ui.onAudio = null` (`daemon.ts:804`). The uplink entry point is therefore **never installed**, so no PCM from the renderer ever reaches `pipeline.pushChunk` (`daemon.ts:825`) and no `AudioPipeline` exists to be deaf. The renderer keeps calling `onAudio`-equivalent sends and they are accepted by the socket and dropped by the null handler.
- The status pill reads `● جارٍ الاستماع…` whenever `!userMuted || voicePhase === 'listening'` (`App.tsx:472-473`), and `userMuted` defaults to `false` after the user unmutes. So a keyless, mute-dead app shows **"listening"** while dropping every frame.
- `voicePhase` is set to `listening` at `daemon.ts:824`, but that is inside `ui.onAudio`, which is `null`. So `voicePhase` stays `idle` and the pill falls through to the `matrix`-driven text (`App.tsx:474-478`), which `matrixForDaemonState` derives from daemon `event` frames. Whether that says "listening" depends on the matrix, not on the truth.
- The only signal is the `voice-disabled-no-keys` **warn** banner (`daemon.ts:816`, level `warn`, not `error`).

**The installed build demonstrates this.** M7: the real telemetry file for this machine has **144 rows and not one TTS row** — because the vault at `%LOCALAPPDATA%\Voxaura\vault\keyring.dat` (818 B, mtime 2026-09-27 17:5x) either has no usable keys or has keys this machine cannot decrypt (`key-store.ts:60-63` documents the two causes, `vault.ts:24-31` binds the blob to `machine.key`). Either way the observable product is: the app runs, the pill says something reassuring, and nothing is ever spoken.

## 2.5 Specification — a key-health model

### 2.5.1 Make the pool able to hold more than one key (prerequisite)

The rotation machinery is already correct for N≥2. The intake path is what caps it at 1. Two changes:

**Wire (additive):** in `UiCommandSchema` (`src/ipc/protocol.ts:376-378`) keep the singular fields and add plural ones so an operator *can* seed a pool, without breaking any deployed client:

```ts
groqKeys: z.array(z.string().min(1).max(512)).min(1).max(8)
  .refine((v) => v.every((k) => !CONTROL_CHARS_RE.test(k)), 'control characters').optional(),
fishKeys: /* same shape */,
openrouterKeys: /* same shape */,
```

**Store (append, not replace):** `mergeKeyPools` (`src/voice/key-store.ts:28-35`) must stop clobbering. This is a behaviour change and needs an explicit rule, because "user typed one key into the form" must still mean "replace", not "append forever":

```ts
// src/voice/key-store.ts — replace line 32
if (next !== undefined && next.length > 0) {
  // A plural field is an explicit pool set; a singular field is a single
  // credential and must not grow the list. `Set` de-dupes without reordering
  // so the stored pool order stays the operator's order.
  merged[pool] = [...new Set(next)];
}
```
Callers that mean "add one" pass the plural field; callers that mean "set one" pass the singular field and get a length-1 pool, which is today's behaviour. The API-keys modal (`apps/desktop/src/components/portals/ApiKeysModal.tsx`) needs a newline-or-comma separated multi-key input per provider; that is UI work outside this audit's scope but is a hard dependency for the rest of §2.5.

**Empty-pool guard:** `Keyring.load` already throws on an empty pool (`keyring.ts:39`) and `Keyring.fromKeys` too (`:52`), so a pool can never be length 0 in the ring. That guard is what makes "pool exhausted" a *detectable* state rather than a modulo-by-zero.

### 2.5.2 Classify every status, and rotate on the right ones

`httpStatusOf` is the single place to make this honest. It currently collapses 401/403 (`errors.ts:47-49`) — keep that — but it must stop returning `undefined` for statuses that *are* actionable. Add an explicit classifier next to it, and keep `httpStatusOf` as the status extractor:

```ts
// src/common/errors.ts — new, additive
export type KeyFault = 'auth' | 'quota' | 'credits' | 'transient' | 'none';

/**
 * What a provider status means for the key pool. `none` must be the only
 * value that never advances the pool: a transient 5xx or a timeout is not a
 * credential fault and burning a valid pool on one is how a network blip
 * turns into a dead app.
 */
export function keyFaultOf(status: number | undefined): KeyFault {
  if (status === undefined) return 'none';       // timeout, abort, parse, TtsTimeoutError
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credits';
  if (status === 429) return 'quota';
  if (status >= 500) return 'transient';
  return 'none';                                  // 4xx we do not model: do not guess
}
```

`release` becomes:

```ts
// src/voice/keyring.ts:89-94
release(key: AcquiredKey, ok: boolean, status?: number): void {
  key.material.fill(0);
  if (ok) return;
  switch (keyFaultOf(status)) {
    case 'auth':
      this.forceAdvance(key.pool, 'auth-failed');
      return;
    case 'quota':
      this.forceAdvance(key.pool, 'rate-limited');
      return;
    case 'credits':
    case 'transient':
    case 'none':
      return;   // documented at keyring.ts:133-136 — never burn a pool on these
  }
}
```

`credits` and `transient` deliberately do not advance, matching today's behaviour, **but they must be recorded** (§2.5.3), because "the account is out of credit and I am going to keep calling it" is the current 402 story.

**Also fix the Fish path's missing marker.** `synthesizeStream` calls `release` directly (`tts.ts:533,536`), so TTS never gets `KeyAdvanced`. Route it through `withKey`:

```ts
// src/voice/tts.ts:519-555 — the whole generator body becomes
async *synthesizeStream(text: string, fishVoiceId: string): AsyncGenerator<Uint8Array> {
  const self = this;
  const stream = withKey(this.keyring, 'fish', async function* (key) {
    const res = await fetchWithTimeout(
      self.endpoint,
      { method: 'POST', headers: fishHeaders(Buffer.from(key.material).toString('utf8')),
        body: JSON.stringify(fishRequestBody(text, fishVoiceId)) },
      self.timeoutMs, self.fetchImpl,
    );
    if (!res.ok || res.body === null) {
      throw Object.assign(
        new Error(fishErrorMessage(res.status, await fishErrorDetail(res))),
        { status: res.status },           // httpStatusOf reads .status (errors.ts:61)
      );
    }
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
  yield* stream;
}
```

Two details that are load-bearing: the thrown error must carry `.status`, because `httpStatusOf` recovers the status from the *error*, not from the `Response` (`errors.ts:39-40`, `:60-62`); and the `catch` that zeroed `key.material` on transport failure (`tts.ts:547-553`) becomes redundant, since `withKey`/`release` zero on every path (`keyring.ts:90`). This is what makes `daemon.ts:782-788` able to write `remediationAttempted: keyAdvanced(err) ? 'KeyAdvanced' : 'None'`, matching STT (`:582`) and the brain (`:715`, `:736`).

### 2.5.3 The health record

`rolloverLog` (`keyring.ts:110-112`) is already the right shape — `{at, reason, from, to}` (`keyring.ts:17-22`) — and already has the three `reason` values needed (`count-exhausted | rate-limited | auth-failed | manual`, `:19`). Add the two missing ones and make it readable:

```ts
// src/voice/keyring.ts:19
readonly reason: 'count-exhausted' | 'rate-limited' | 'auth-failed' | 'credits-exhausted' | 'manual';

// src/voice/keyring.ts:97 — forceAdvance gains a credits path
forceAdvance(pool: KeyPool, reason: 'rate-limited' | 'auth-failed' | 'credits-exhausted' | 'manual'): void
```

Then add the one accessor the product is missing — a **pool-level health verdict** that answers "can this pool still serve a turn?":

```ts
// src/voice/keyring.ts — new
export interface PoolHealth {
  readonly pool: KeyPool;
  readonly size: number;
  /** Keys the pool has rotated past and not returned to. */
  readonly disabled: number;
  /** The fault class of the most recent failure, or 'none' if clean. */
  readonly lastFault: KeyFault;
  readonly lastFailureAt: string | null;
  /** Failures with no advance since the last success — a 402 loop lands here. */
  readonly consecutiveFailures: number;
  readonly healthy: boolean;
}

export function poolHealth(ring: Keyring, pool: KeyPool): PoolHealth
```

`Keyring` needs three new private fields to answer the last two (`lastFault`, `lastFailureAt`, `consecutiveFailures`), reset on every `release(key, true)`. This is deliberately *stateful* rather than derived from `rolloverLog`, because "a 402 that never advances the pool" is invisible in a rotation log by construction — that is the whole point of §2.3 row 2.

### 2.5.4 What to probe, how often, and what the user is told

**Do not build a new probe endpoint.** There is no provider-side health API for Groq/Fish/OpenRouter that a client can call cheaply and that is not itself a billable call. Probing costs quota and, for Fish, costs TTS characters. Instead:

**Reactive probe, on the real path, with a cooldown.** `poolHealth` is consulted at the *start* of a turn, and it is only ever updated by real traffic. That makes the probe free and makes it impossible for a health check to be the thing that burns a quota.

Cadence, specified exactly:

| Trigger | Action |
|---|---|
| Daemon start, after `rebuildVoice()` at `daemon.ts:828` | Emit one `keyHealth` frame per pool from `poolHealth`. No network call. |
| `saveApiKeys` (`daemon.ts:432`) | Same: re-emit all three. This is the only moment a pool can become healthy. |
| Every `poolHealth` transition where `healthy` flips `true → false` or `false → true` | Emit `keyHealth` + one `notice`. |
| Every 60 s of *idle* (no STT, no TTS, no brain call) | Emit `keyHealth` if and only if it changed since the last emit. Level-triggered, so a stable state costs zero frames. The 60 s is the same shape as the existing `sessionContext` poll at `App.tsx:446` and the bridge watchdog at `App.tsx:201-205`. |
| Never on a timer while a turn is in flight | A turn's own failures update health; a concurrent poll would double-count. |

**What the user is told** — three distinct, non-overlapping messages, because the current design collapses them all into one `warn`:

| Condition | `level` | Arabic `detail` | Rationale |
|---|---|---|---|
| `size === 0` | `error` | `لا توجد مفاتيح — الحلقة الصوتية معطّلة. افتح نافذة المفاتيح.` | Today's message (`daemon.ts:816`) is `warn` and repeats forever. `error` + a de-duped single frame is the honest escalation. |
| `disabled === size` (every key rotated past an `auth` fault) | `error` | `كل مفاتيح <provider> مرفوضة. استبدل المفتاح من نافذة المفاتيح.` | This is the state that does not exist today and is the answer to "what does a depleted pool look like from outside". |
| `consecutiveFailures ≥ 3` with `lastFault === 'credits'` | `error` | `رصيد <provider> منتهٍ (402). لن يُنفَّق على الصوت حتى التجديد.` | 402 is currently a `tts-failed` banner **per utterance**; this says it once and explains the silence. |
| `consecutiveFailures ≥ 5` with `lastFault === 'transient'` | `warn` | `<provider> لا يستجيب. جارٍ المحاولة تلقائياً.` | 5xx is retried (`brain.ts:288-289`); the user should know why it is slow, not that it failed. |

De-duplication is the whole point: `App.tsx:42` holds **one** `notice`, so a repeating notice silently replaces whatever the user was reading. Every `notice` emitted by the health model must therefore be gated on a state transition in the daemon, not on the failure.

### 2.5.5 The arm threshold — refuse to arm rather than fail mid-utterance

`arm` is currently a no-op (`command-router.ts:229-230`) and the renderer's notion of armed is purely `!userMuted` (`App.tsx:39`, `:388-399`). So the daemon has no veto and the user always arms into a dead pipeline. Give it one.

**The daemon refuses to arm, and says why, in the same `arm` ack.** Not a separate mechanism — the ack is where the shell already looks (`App.tsx:313-325` reads `outcome.ok` and `outcome.detail`).

```ts
// src/orchestrator/command-router.ts — replace the `arm` arm
case 'arm': {
  const health = deps.poolHealth('fish');
  if (health.size === 0) {
    return { ok: false, detail: 'arm-refused:no-keys',
             // surfaced as a `warn` notice by the daemon, once
    };
  }
  if (health.disabled === health.size) {
    return { ok: false, detail: `arm-refused:pool-exhausted:${cmd.id ?? ''}`.slice(0, 128) };
  }
  if (health.consecutiveFailures >= ARM_REFUSE_THRESHOLD) {
    return { ok: false, detail: 'arm-refused:provider-unavailable' };
  }
  deps.setArmed(true);
  return { ok: true, detail: 'armed' };
}
```

with the threshold as a named constant, not a literal:

```ts
// src/orchestrator/command-router.ts — top of file
/**
 * Consecutive non-advancing failures before the app refuses to arm.
 *
 * Chosen from the measured retry budget: the brain already retries a
 * retryable failure 3× (`src/voice/brain.ts:288-289`) and STT gives up at
 * 15 s (`src/voice/stt.ts:135`). Five consecutive failures is one full
 * brain retry budget plus one full STT timeout, i.e. the point at which the
 * user has already waited ~30 s for a turn that was never going to work.
 * Refusing earlier would break a user on a slow network; refusing later means
 * the first thing they experience is a silent assistant.
 */
export const ARM_REFUSE_THRESHOLD = 5;
```

**Why arm and not the other gates:** gating `deafen` is impossible (`deafen` is a *privacy* control — it must always succeed, `App.tsx:388-399`). Gating the STT path instead would fail mid-utterance, which is precisely what the brief says to avoid. The mic button is the last moment where refusing costs the user nothing, because nothing has been said yet.

**The renderer must not fake it.** `toggleUserMute` currently optimistically sets state first and asks later (`App.tsx:388-399`, and `send(...)` swallows the outcome into `setAnnounce` at `App.tsx:324`). For `arm` it must revert on refusal:

```ts
const arm = async (next: boolean): Promise<void> => {
  const live = bridgeRef.current;
  if (live === null) { setUserMuted(!next); setAnnounce('الخادم غير متصل'); return; }
  const outcome = await live.sendCommandDetailed({ id: nextCmdId(), kind: 'arm', armed: next });
  if (!outcome.ok) {
    setUserMuted(!next);                       // revert — the daemon vetoed
    setAnnounce(outcome.detail.startsWith('arm-refused:')
      ? armRefusalNotice(outcome.detail)
      : 'تعذّر تغيير حالة الميكروفون');
    return;
  }
  setUserMuted(!next);
  if (!next) startMic();
};
```

with a new `armRefusalNotice` in `apps/desktop/src/audio/vad.ts`, next to `micFailureNotice` (`:78-93`), so all Arabic user-facing copy stays in one module:

```ts
export function armRefusalNotice(detail: string): string {
  if (detail.startsWith('arm-refused:no-keys')) {
    return 'تعذّر التفعيل — لا توجد مفاتيح. افتح نافذة المفاتيح من الإعدادات.';
  }
  if (detail.startsWith('arm-refused:pool-exhausted')) {
    return 'تعذّر التفعيل — كل مفاتيح المزوّد مرفوضة. استبدل المفتاح وحاول مجدداً.';
  }
  return 'تعذّر التفعيل — المزوّد لا يستجيب. تحقق من الاتصال ثم حاول.';
}
```

`arm` must gain `armed: z.boolean().optional()` in `UiCommandSchema` (`protocol.ts:384`) and `CommandMsg` (`ws.ts:104`) — same additive treatment as §1.5.3, and the same `deps` pattern as `setPersona` (`daemon.ts:407-422`).

### 2.5.6 Telemetry: give the dead enum members producers

`POOL_EXHAUSTED` and `RATE_LIMITED` (`src/telemetry/writer.ts:56-57`) must stop being decorative, or they must be removed. M7 shows a 144-row file with neither, in a machine that is *definitionally* pool-exhausted. Emit them from the health model:

```ts
// wherever poolHealth transitions healthy -> false
record({
  subsystem: 'KEYRING',
  status: 'DEGRADED',
  latencyMs: 0,
  errorCode: health.lastFault === 'credits' ? 'POOL_EXHAUSTED'
           : health.lastFault === 'quota'   ? 'RATE_LIMITED'
           : 'KEYS_MISSING',
  sanitizedErrorClass: 'AuthError',
  remediationAttempted: health.disabled > 0 ? 'KeyAdvanced' : 'None',
});
```

**And de-duplicate `KEYS_MISSING`.** 142 identical rows (M7) is not telemetry, it is a loop. `rebuildVoice` (`daemon.ts:801-827`) must record the keyless state **once per transition**, not once per call — a `let keylessReported = false` beside the closure state, cleared in the success branch at `daemon.ts:819`. Same for the notice at `daemon.ts:816`.

### 2.5.7 Tests

1. `src/voice/keyring-health.test.ts` — `keyFaultOf` is total: `undefined → 'none'`, `401 → 'auth'`, `403 → 'auth'`, `402 → 'credits'`, `429 → 'quota'`, `500/503 → 'transient'`, `400 → 'none'`. A 5xx must **not** advance: assert `rolloverLog.length` is unchanged.
2. **The single-key regression that motivates §2.2** — `Keyring.fromKeys({fish:['k'],…})`, `release(k, false, 401)` then `acquire('fish')` returns the **same** material, and `poolHealth(ring,'fish').disabled === 0` while `consecutiveFailures === 1`. Then re-run with `{fish:['a','b']}` and assert the second acquire returns `'b'`. This test fails on today's `keyring.ts:104` and is the reason §2.5.1 is a prerequisite, not a nice-to-have.
3. `src/voice/tts-r3-errors.test.ts` (extend) — a Fish 401 now yields `keyAdvanced(err) === true`; a Fish 402 yields `false` and `keyFaultOf === 'credits'`.
4. `src/daemon-telemetry-dedupe.test.ts` — calling the keyless branch N times produces **one** `KEYS_MISSING` row. Verify non-vacuity by removing the dedupe flag and confirming N rows.
5. `src/orchestrator/command-router.test.ts` — `arm` returns `ok:false, detail:'arm-refused:pool-exhausted'` at `consecutiveFailures === ARM_REFUSE_THRESHOLD` and `ok:false` at `disabled === size`, and `deps.setArmed` is **not** called in either case.
6. `apps/desktop/src/audio/mic-policy.test.ts` (extend) — `micPolicy` is unchanged; assert the new `armRefusalNotice` maps the three `arm-refused:*` prefixes to **three distinct** strings (the pattern already used at `capture-permission.test.ts:61-72`).

---

# GAP 3 — Windows packaging, tray, installer

**Severity: HIGH for the diagnostic-integrity finding (§3.5); MEDIUM for the rest (the app works today, per M8 — the gap is the absence of recovery affordances, not a broken boot).**

## 3.1 Is there a system-tray implementation? **No. None. And it is structurally impossible today.**

Four independent confirmations:

1. **No Tauri tray feature.** `apps/desktop/src-tauri/Cargo.toml:11`: `tauri = { version = "2", features = [] }`. Tauri v2's `TrayIconBuilder` is gated behind the `tray-icon` feature. With an empty feature list the API is not compiled in.
2. **No tray construction.** `main.rs` is 2,903 lines; `grep -n 'tray|on_window_event|CloseRequested|prevent_close|WindowEvent'` over it returns exactly two hits: `use tauri::{Manager, RunEvent};` (`:32`) and the run loop at `:2898-2901`. The builder chain is `tauri::Builder::default().manage(…).invoke_handler(…).setup(…).build(…).run(…)` (`:2871-2902`) — no `.tray_icon()`.
3. **No tray config.** `tauri.conf.json` has no `app.trayIcon` block. The `app` object is `windows` (`:13-25`) and `security` (`:26-28`) only.
4. **No tray permission.** `capabilities/default.json:6-12` grants five permissions: `core:window:allow-get-all-windows`, `core:window:allow-create`, `core:window:allow-set-focus`, `core:window:allow-close`, `core:webview:allow-create-webview-window`. No tray permission, and the file's own `description` (`:4`) enumerates the permissions as derived from the exact `@tauri-apps/api` calls the shell makes — i.e. the capability set is *by construction* closed to a feature that does not exist.

## 3.2 What happens if the user closes the window? **The whole app exits — and there is no close control.**

- **No `on_window_event` handler, and no `prevent_close`.** `main.rs:2898-2902` is the entire run loop:
  ```rust
  app.run(|app_handle, event| {
      if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
          app_handle.state::<Supervisor>().reap();
      }
  });
  ```
  Tauri v2's default is to exit when the last window closes. There is no interception, so the `ExitRequested` branch always runs, `reap()` kills every job-adopted child (`main.rs:504-511`), and 4096 + 4097 go cold. **There is no hide path.**
- **There is no way to close the window from the UI.** `decorations: false` (`tauri.conf.json:21`) removes the titlebar and its close button; `resizable: false` and `maximizable: false` (`:18-19`) remove everything else. The only way out is Alt+F4 or Task Manager.
- **The intended affordance is orphaned.** `apps/desktop/src/window/close-current-window.ts:7-18` exists precisely for this — its own comment: *"The bug this fixes: an Esc handler that only unmounted the React tree left the native window alive showing a blank (white) webview"* — and it is called from **nowhere**. `grep -rn closeCurrentWindow apps/desktop/src` returns only its own definition (`close-current-window.ts:7`). There is no `keydown` handler for Escape in `App.tsx` either: the only listener is `App.tsx:210-218`, which handles `Ctrl+,` exclusively.
- **The user gets nothing to reopen the app.** Without a tray, without a close button, and with no `Start Menu`/auto-start config in `tauri.conf.json` (no `bundle.windows.startMenuEntries`, no `startup` plugin in `Cargo.toml`), once the window is gone the app is only reachable by finding `voxaura.exe` — which lives at `%LOCALAPPDATA%\Voxaura\voxaura.exe` (M8, confirmed by the `resource_dir` the supervisor logged).

For a **voice companion whose entire value proposition is an always-listening mic**, "close the window" ≡ "turn the product off", with no discoverable way to tell the difference. The settings and API-keys windows are *not* the escape hatch: `apps/desktop/src/settings/open-settings.ts:21-39` creates them as separate webview windows via `WebviewWindow`, and `main.rs`'s `ExitRequested` handler reaps the supervisor regardless of which window is still open.

## 3.3 Installer resilience

### Upgrade path
- **No `bundle.windows.nsis` block exists at all.** `grep -n 'nsis|windows|upgrade|installMode|allowDowngrade' tauri.conf.json` returns nothing. `bundle` is only `{active, targets, resources, icon}` (`tauri.conf.json:30-35`). Every NSIS behaviour is therefore a **Tauri v2 default**, and nothing in this repo can change it without adding the block.
- **Consequence: `allowDowngrades` defaults to false.** NSIS refuses to run an installer whose version is lower than the installed one. There is **no rollback path** for a bad build — the operator must uninstall first. Given M8 (the currently installed build does boot) and the v0.6.0 history, that is a real operational hazard: the documented recovery is a two-step manual sequence (uninstall, reinstall the older `.exe`), and the uninstaller deletes the vault (§3.4), so the operator also loses their keys.
- **No updater.** `Cargo.toml:10-20` declares `tauri`, `serde`, `serde_json`, `getrandom` and the `windows-sys` block. No `tauri-plugin-updater`, no `tauri-plugin-process`. `tauri.conf.json` has no `plugins.updater` and no `createUpdaterArtifacts`. Updates are manual download-and-run, full stop.
- **13 installers sit in `target/release/bundle/nsis/`**, from `Voxaura_0.3.0` (26,127,843 B) to `Voxaura_0.7.2` (26,186,272 B) — I enumerated the directory. Because downgrades are blocked, only the newest is installable over an existing install; the other 12 are install-only-after-uninstall.

### Sidecar / `node.exe` integrity
- **No integrity check of any kind.** `grep -in 'sha256|checksum|integrity'` over `main.rs` returns **zero hits**. `scripts/provision-sidecar.mjs` copies `process.execPath` to `sidecar/node.exe` (`:34-36`) and copies `dist/` (`:39`) and runs `npm install` against a hand-written 3-dependency manifest (`:57-62`); it never hashes anything, and `main.rs:1243-1256` (`resolve_node_bin`) only checks `bundled.exists()`.
- **A truncated or AV-quarantined `node.exe` therefore fails at spawn**, and the failure surfaces as `BindOutcome::SpawnFailed(msg)` → `Err("could not spawn daemon via {node}: {msg}")` (`main.rs:1430`). That is a *good* error string, but it names the path, not the cause, and nothing distinguishes "missing" from "wrong architecture" from "quarantined".
- **The pruned manifest is a second, quieter hazard.** `provision-sidecar.mjs:48-56` documents that the sidecar manifest is independent of the root `package.json` and that a dependency removed at root "is still shipped inside the installer until it is removed from **BOTH** places" — and it names `pino` as a case that shipped into the v0.7.2 payload despite having no callers. The live payload is `sidecar/node_modules/{groq-sdk, lru-cache, zod}` (verified on disk, M-adjacent). A `dist/` that imports a dep not in that 3-name list produces a `MODULE_NOT_FOUND` at daemon boot. The `spawn_and_wait_for_port(..., 20 s)` guard (`main.rs:1413`) then kills the child and returns `Err("daemon (pid N) did not open 4097 in time…")` — correct, and the log names `daemon.log`. This is the v0.6.0 shape, and the guard is already in place.
- **One asymmetry worth fixing:** `main.rs:1379` passes the entry through `plain_path(&entry)` (`:1174-1180`, which strips the `\\?\` prefix Node's resolver rejects), but `main.rs:1387` passes `resolve_vault_dir(Some(&entry))` **raw**. M8 shows the result in the shipped log: `resolve: vault=\\?\C:\Users\omarb\AppData\Local\Voxaura\vault (ancestor)` — the extended-length prefix is handed to the Node child in `VOXAURA_VAULT_DIR`. It happens to work here because the vault is found and `fs` tolerates the prefix, but it is exactly the class of bug `plain_path` was written for, in the one path that was missed. Note also the `(ancestor)` branch fired, not `(install default)`, because `resolve_vault_dir` (`:1196-1206`) walks up from the sidecar `dist/` and finds `%LOCALAPPDATA%\Voxaura\vault` before reaching the `%LOCALAPPDATA%` fallback at `:1207-1211`.

### Uninstall
- **`vault/keyring.dat` lives inside the install directory.** Verified on disk: `%LOCALAPPDATA%\Voxaura\` contains `voxaura.exe`, `uninstall.exe`, `sidecar\`, `vault\` (with `keyring.dat`, 818 B) and `audio-cache\`. `resolve_vault_dir`'s install default is `%LOCALAPPDATA%\Voxaura\vault` (`main.rs:1207-1211`), i.e. the same tree the installer owns.
- So uninstall has two possible outcomes and **the repo cannot say which**: if NSIS removes the whole tree, the user loses the encrypted keyring and must re-enter three keys; if it preserves it, the app leaves `keyring.dat` behind after the user believes they removed a credential store. There is **no installer hook in this repo** to make it deliberate — no `bundle.windows.nsis.installerHooks`, no custom `.nsi`, no `installerHooks` path. That ambiguity is the defect.
- **`~/.opencode-voice-runtime/` is outside the install tree and is never touched by any uninstall path in this repo.** It holds `machine.key` (32 B), `ipc.token` (64 B), `serve.pass` (64 B), and the append-only `*.log` + `voice-runtime.jsonl`. `machine.key` is the scrypt input for the vault (`vault.ts:24-35`), so it must outlive the vault to re-decrypt it — but it also means uninstalling leaves a long-lived key-derivation input on disk with no owner.

## 3.4 `packaging-preflight.mjs`: the actual check count and the one failure

**15 checks. 14 pass. 1 `MISS`.** Measured — M1, ran the script, full output captured.

The single failing check is row 6 of 15:

```
MISS  MSVC linker (cl/link) — missing — install VS Build Tools
```
…produced by `scripts/packaging-preflight.mjs:35-36`:
```js
35: const msvc = which('cl') ?? which('link');
36: add('MSVC linker (cl/link)', msvc !== null, msvc ?? 'missing — install VS Build Tools');
```

**This is a false negative, and the script's own framing makes it worse.** `which()` is `where.exe <cmd>` on PATH (`:10-17`). `cl.exe` and `link.exe` live in the Visual Studio developer environment and are **not on PATH in a normal PowerShell session** — they appear only after `VsDevCmd.bat`. So the check reports "install VS Build Tools" on a machine with Visual Studio fully installed. The two trailing verdicts (`:68-70`) are computed from this one wrong row:
```
Windows bundle (NSIS): BLOCKED — needs MSVC linker (cl/link)
```
and, as a side effect, **`EXITCODE=0`** regardless — so the script cannot gate anything even when it is right.

The remaining 14 rows, for the record (all `PASS` in this repo): `node ≥22`, `npm`, `rustc`, `cargo`, `NSIS makensis`, `apps/desktop/package.json`, `renderer deps installed`, `tauri CLI dep`, `tauri.conf.json parses`, `capabilities/default.json`, `Cargo.toml + Cargo.lock`, `icons (icon.ico)`, `icons (icon.icns)`, `frontend dist built` (`:31-56`).

**What the preflight does not check, each of which is a real installer defect class:** sidecar `node.exe` present; `sidecar/dist/cli.js` present; `sidecar/node_modules` complete against `sidecar/package.json`; the version in `Cargo.toml` == `tauri.conf.json` == `sidecar/package.json` == root `package.json`; NSIS `allowDowngrades`/`installMode`; the vault path's existence; whether a `\\?\` prefix reaches a child.

## 3.5 The finding that matters most: `cargo test` writes into the production diagnostic log

This is the v0.6.0 lesson recurring in a new place, and it is fully measured (M8, M9).

`log_line` (`main.rs:525-539`) unconditionally appends to `runtime_dir()/supervisor.log` = `%USERPROFILE%\.opencode-voice-runtime\supervisor.log` (`:514-519`). It has **no test gate**. Meanwhile the unit tests call `log_line` through the code under test:

- `temp_dir` (the test helper, main.rs, used as `temp_dir("logs-fallback")` at `:1851` and `temp_dir("logs-unavailable")` at `:1866`) builds `%TEMP%\voxaura-phase2-{tag}-{pid}-{nanos}`.
- `with_unavailable_job()` (`:474`) injects a `Supervisor` whose job slot is `None`, which is the **only** way to produce `JOB-CREATE-FAILED` (`:450`) and drives `job-adopt-failed` (`:460`).

The shipped `supervisor.log` on this machine has **67 lines**. Lines 1–8 are a real bring-up. Lines 9–67 are test output: **24 `log: "…voxaura-phase2-logs-fallback-…/daemon.log" unavailable (Access is denied. (os error 5)); using …` lines and 24 `ERROR`-matching `job-adopt-failed` lines, plus 6 `JOB-CREATE-FAILED`.** All 24 quote `voxaura-phase2-` temp paths, i.e. they came from the test binary.

The damage is concrete:
1. **The one file the release procedure tells a human to read is 92 % test noise.** `AGENTS.md` step 6 says to confirm a healthy install; the only way to do that is `supervisor.log` + `daemon.log`. Both are now polluted.
2. **`JOB-CREATE-FAILED pid=NNNN` in that file is indistinguishable from a real failure.** The real one (`main.rs:450`) and the test-induced one are byte-identical strings. An operator triaging a boot failure will read six fabricated "no job object exists, so the child cannot be supervised" lines.
3. **The file is append-only by design** (`main.rs:176-179`: *"Append, never truncate: a restart that fails for a different reason must not erase the evidence of the previous failure"*), so the pollution is permanent for that install.

## 3.6 Specification

### 3.6.1 Make the diagnostic log trustworthy (do this first — it is 10 lines)

`log_line` is the correct place, because every one of the polluting lines goes through it.

```rust
// apps/desktop/src-tauri/src/main.rs — replace log_line (525-539)
/// Append one line to the supervisor log, in the runtime directory.
///
/// Tests must not write here. `cargo test` produced 24 fabricated
/// `JOB-CREATE-FAILED` / `job-adopt-failed` lines and 24 fabricated
/// "log unavailable" lines in the shipped `supervisor.log`, indistinguishable
/// from real bring-up failures, because `with_unavailable_job` and
/// `temp_dir` both route through this function. The release procedure tells a
/// human to read this file; a test must not be able to lie in it.
fn log_line(message: &str) {
    if cfg!(test) {
        return;
    }
    // …existing body, unchanged (514-519 + 529-538)
}
```

If a test ever *needs* to assert on a logged line, it must inject a sink rather than reach the real file — the same injectable-diagnostic convention `TelemetryWriter` already uses (`src/telemetry/writer.ts:91-94`, `options.logger`).

**Also: the timestamp is unix seconds** (`main.rs:529-532`). Six launches on the same day collapse to indistinguishable stamps. Change to milliseconds plus the pid, which `unique_suffix` (`:170-174`) already models correctly:

```rust
let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);
if let Ok(mut existing) = fs::read_to_string(&path) {
    existing.push_str(&format!("[{stamp} {}] {message}\n", std::process::id()));
    // …
```

This makes the existing log greppable per-process, which is what makes §3.5's pollution *detectable* rather than merely fixable going forward.

### 3.6.2 The tray (spec, not implementation)

Requires three coordinated changes; the first is a Cargo edit and the second is a capability edit, and skipping either produces a build or runtime error, not a degraded tray.

**(a) Enable the feature** — `apps/desktop/src-tauri/Cargo.toml:11`:
```toml
tauri = { version = "2", features = ["tray-icon"] }
```

**(b) Add the permission** — `apps/desktop/src-tauri/capabilities/default.json:6-12`, append `"core:tray:default"`. The file's own `description` (`:4`) must be updated in the same edit to list it, because that description is the documented invariant that the permission set is derived from the `@tauri-apps/api` calls the shell makes.

**(c) Build the tray in `main.rs`** — inside `.setup(…)` (`:2878-2894`), which already has `app.handle()`:

```rust
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

app.tray(TrayIconBuilder::new()
    .icon(app.default_window_icon().cloned().unwrap())
    .tooltip("Voxaura")
    .menu(&Menu::with_items(app, &[
        &MenuItem::with_id(app, "show", "إظهار", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "mic", "كتم/تشغيل الميكروفون", true, None::<&str>)?,
        &MenuItem::with_id(app, "bot", "كتم/تشغيل صوت المساعد", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", "خروج", true, None::<&str>)?,
    ])?)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id().as_ref() { /* … */ })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            let app = tray.app_handle();
            toggle_main_window(app);
        }
    })
    .build(app)?)?;
```

`TrayIconBuilder::new()` is the v2 API; `icon()` must be given an explicit `Image` because `app.default_window_icon()` returns `Option<&Image>` and the configured window has no icon of its own.

**(d) The behaviour change that makes the tray necessary** — intercept the close. In `main.rs`, add before the existing run loop:

```rust
    .on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Closing the HUD must not tear down the control plane: the whole
            // product is an always-listening mic, and today closing the window
            // is indistinguishable from quitting (main.rs:2898-2902 reaps every
            // child and 4096/4097 go cold). Hide instead, and leave `quit` as
            // the only way to stop the children.
            api.prevent_close();
            let _ = window.hide();
        }
    })
```

and make `quit` the exit path:

```rust
"quit" => { window.hide(); app.exit(0); }
```

`app.exit(0)` still fires `RunEvent::ExitRequested`, so `reap()` at `main.rs:2900` keeps working unchanged.

**(e) The close affordance the window is missing.** `decorations: false` (`tauri.conf.json:21`) plus no close control means the user currently cannot close the window at all. Either wire the orphaned `closeCurrentWindow` (`apps/desktop/src/window/close-current-window.ts:7`) to an Escape handler in `App.tsx` — the helper's own comment (`:1-6`) says that is what it was written for — or, once the tray exists, add a `×` glyph button to the header at `App.tsx:496-514` that calls it. **Specified as: the header gets a close button; Escape is not bound**, because Escape-to-close on a settings window typed into by the user is a footgun and the helper already falls back to `window.close()` outside Tauri (`close-current-window.ts:17`).

**(f) `telemetry: { window: { decorations: false } }` is already correct; do not add `"skipTaskbar": true`**, because the tray is the only affordance and a hidden-from-taskbar app with a missing tray is unreachable.

**Tests.** `main.rs` already has 48 `#[test]`s (M2) and the `#[test]` at `:1512` is a *source-text* assertion (it greps its own body) — a convention worth matching, since it needs no filesystem. Add: a test asserting the `log_line` body contains `cfg!(test)` (mirroring `:2860-2865`, which is a positive control on `restrict_to_owner`'s documentation); and a Playwright E2E asserting that closing the window leaves 4097 bound.

### 3.6.3 Fix `resolve_vault_dir` asymmetry

```rust
// apps/desktop/src-tauri/src/main.rs:1387
.env("VOXAURA_VAULT_DIR", plain_path(&resolve_vault_dir(Some(&entry))))
```
`plain_path` (`:1174-1180`) already exists and already guards the sibling arg at `:1379`. M8 shows the `\\?\` prefix currently reaching the child in this exact variable. One-line, and it is the same class of bug the function's own doc comment (`:1171-1173`) describes.

### 3.6.4 Give the preflight teeth

```js
// scripts/packaging-preflight.mjs — replace the MSVC row (35-36) and the verdict (67-70)
const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
// `cl`/`link` are NOT on PATH outside a developer shell, so `where.exe` is the
// wrong probe: it reports MSVC missing on every correctly-installed machine.
// Ask vswhere, and only fall back to `where` if vswhere itself is absent.
const msvc = existsSync(vswhere)
  ? (() => { try { return execFileSync(vswhere, ['-latest', '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })
      .trim() || null; } catch { return null; } })()
  : (which('cl') ?? which('link'));
add('MSVC toolset (vswhere / cl)', msvc !== null, msvc ?? 'missing — run VsDevCmd.bat or install "Desktop development with C++"');
```
and make the script **exit non-zero on failure** so it can gate anything, plus add the sidecar checks that would have caught a v0.6.0-class build:

```js
add('sidecar node.exe', pathExists(join(desktop, 'src-tauri', 'sidecar', 'node.exe')), '');
add('sidecar dist/cli.js', pathExists(join(desktop, 'src-tauri', 'sidecar', 'dist', 'cli.js')), '');
add('sidecar node_modules', pathExists(join(desktop, 'src-tauri', 'sidecar', 'node_modules')), '');
// Version agreement across the four places provision-sidecar.mjs and the
// release flow both write, from different files.
const versions = [
  ['package.json', JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version],
  ['apps/desktop/package.json', JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version],
  ['tauri.conf.json', JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).version],
  ['Cargo.toml', /version = "([^"]+)"/.exec(readFileSync(join(desktop, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1]],
].filter(([, v]) => typeof v === 'string');
add('version agreement', new Set(versions.map(([, v]) => v)).size === 1 && versions.length === 4,
  versions.map(([f, v]) => `${f}=${v}`).join(' '));
```
That last row is the mechanical version of `AGENTS.md` release step 1's warning that the 0.6.1 bump *"missed the guide, the hero banner and the lock file"*. `provision-sidecar.mjs:47` also hardcodes `version: '0.7.2'` in the sidecar manifest — a **fifth** copy, and a preflight row is the cheapest place to catch a sixth.

### 3.6.5 Installer resilience — the minimum

Add the block that does not exist (`tauri.conf.json:30-35`):

```json
"bundle": {
  "active": true,
  "targets": ["nsis", "appimage"],
  "resources": ["sidecar/**/*"],
  "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
  "windows": {
    "nsis": {
      "installMode": "currentUser",
      "allowDowngrades": true,
      "installWebviewRuntime": true,
      "languages": ["English", "Arabic"],
      "startMenuFolder": "Voxaura",
      "installerHooks": "./installer-hooks.nsh"
    }
  }
}
```

- `allowDowngrades: true` is the one that matters operationally: it is the rollback path that v0.6.0 proved is needed. The cost is that a downgrade must be a deliberate act by a human running an old `.exe` by hand, which is already true (there is no auto-updater), so the flag adds no new footgun and removes an unnecessary one.
- `installerHooks` makes the vault decision deliberate. The hook file must contain exactly the two things, and nothing else:

```nsis
; apps/desktop/src-tauri/installer-hooks.nsh
; UNINSTALL: the vault is inside the install tree (%LOCALAPPDATA%\Voxaura\vault,
; main.rs:1207-1211) and holds the AES-256-GCM keyring. Leaving it behind
; after the user believes they removed a credential store is worse than making
; them re-enter three keys on reinstall. Delete the tree, keep nothing.
!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Voxaura\vault"
!macroend
```

`~/.opencode-voice-runtime/` must **not** be deleted: `machine.key` is the scrypt salt for the vault (`vault.ts:24-35`), and deleting it would make a re-seeded vault undecryptable in a way `key-store.ts:60-63` can only report as "saved on another machine". It is a small, non-secret, non-credential file; leaving it is correct and should be stated in the hook comment so the next reader does not "fix" it.

### 3.6.6 Sidecar integrity

Minimum, no new dependencies: have `provision-sidecar.mjs` write a manifest and `main.rs` verify it once at resolve time, next to `resolve_node_bin` (`:1243-1256`).

```js
// scripts/provision-sidecar.mjs — append after :40
import { createHash } from 'node:crypto';
// A manifest the supervisor verifies at resolve time. AV quarantine, a
// truncated copy and a wrong-architecture node.exe are all silent today:
// resolve_node_bin only checks .exists(), and the failure surfaces as
// "could not spawn daemon via …" with no cause.
{
  const parts = [];
  const walk = (dir, base = sidecar) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, base);
      else parts.push(`${relative(base, p).replace(/\\/g, '/')} ${createHash('sha256')
        .update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(sidecar);
  writeFileSync(join(sidecar, 'MANIFEST.sha256'), parts.join('\n') + '\n');
}
```
and in `main.rs`, after `resolve_node_bin` returns a bundled path, hash `node.exe` and `dist/cli.js` and compare. **Do not hash `node_modules/`** — 574 KB of zod locales make that slow for a check that runs on every launch; the two files that decide whether the daemon boots are the two that matter. On mismatch, `ensure_daemon` (`:1372-1374`) must return a distinct `Err("sidecar integrity check failed — reinstall Voxaura")` rather than falling through to a confusing spawn error.

---

# GAP 4 — Desktop audio recovery

**Severity: HIGH (the failure is invisible, unreported, and self-locking; the product's core input device can die silently.)**

## 4.1 What happens to an in-flight capture on device disconnect

**Nothing, and then nothing can fix it.** The mechanism:

1. `AudioCapture` has exactly two mutable state fields: `graph` and `running` (`apps/desktop/src/audio/capture.ts:69-71`). `running` is set `true` only at `capture.ts:151` and set `false` only at `capture.ts:155` — i.e. **only inside `stop()`**.
2. `start()` begins with `if (this.running) return;` (`capture.ts:78`).
3. On Windows, unplugging a USB microphone ends the `MediaStreamTrack`. That fires `track.onended`. **There is no `onended` handler.** Verified by grep over the entire renderer for `devicechange|onended|onmute|onunmute|enumerateDevices|MediaStreamTrack`: the **only** hits are `capture.ts:165` (`graph.stream.getTracks()` inside `stop()`) and `ws.ts:233` (`ws.readyState`). Zero `onended`, zero `devicechange`, zero `onmute`.
4. Consequence: the track ends, the worklet's `process()` stops receiving live input, the `AudioContext` may go `suspended`, and `this.running` **stays `true` forever**.
5. Every subsequent `start()` call is now a silent no-op at `capture.ts:78`. And `start()` is the only way to re-acquire.

**The three places that call `start()` all become no-ops:**

| Caller | Location | Result after a disconnect |
|---|---|---|
| `startMic()` on visibility restore | `App.tsx:281` (via the effect at `:277-292`) | no-op, no error, no notice |
| Un-mute button | `App.tsx:396` → `startMic()` at `:233` | no-op, no error, no notice |
| Lazy first-start | `App.tsx:233` on mount | n/a |

**The only recovery is a two-click accident.** `toggleUserMute` (`App.tsx:388-399`) calls `capture.stop()` on mute — which is the *only* statement in the codebase that clears `running`. So clicking the mic button twice (mute → unmute) re-acquires. A user who clicks once (the natural "let me try that again") makes it strictly worse in appearance without fixing it.

**And the guard is pinned as a feature by a test.** `apps/desktop/src/audio/capture-permission.test.ts:74-83` asserts that `start()` is idempotent so a spurious `visibilitychange` cannot open a second graph. The fix therefore **must not delete the guard** — it must make `running` false when the device dies. Deleting the guard would trade a silent death for a leaked hardware track, which is the bug the test was written for.

**What the user sees: nothing.** The status pill renders `● جارٍ الاستماع…` whenever `!userMuted || voicePhase === 'listening'` (`App.tsx:472-473`), and `micEnergy` is driven by `onEnergy` (`App.tsx:238-245`), which simply stops being called — the visualizer freezes at its last non-zero value. There is no frame-rate watchdog on the uplink; `lastFrameAt` (`App.tsx:69`, written at `:117,152`, read at `:201-205`) tracks **inbound** frames only, so a dead mic does not trip it. The single `announce` string (`App.tsx:41`) is only written from a `start()` rejection (`App.tsx:263`) or a `onError` callback (`App.tsx:261`), and a disconnect produces neither.

**Is this silent by design?** No — `micFailureNotice` (`apps/desktop/src/audio/vad.ts:78-93`) maps `NotReadableError`/`TrackStartError` to *"الميكروفون مستخدم من تطبيق آخر — أغلقه ثم أعد المحاولة"* (`vad.ts:88-89`), i.e. the product clearly *intends* to report a mic failure. It reports the failure that surfaces as a `getUserMedia` rejection. A mid-stream device loss surfaces as nothing.

## 4.2 Windows sleep / resume

**Also unhandled, and the same self-lock.** Verified: `grep -in 'resume|suspend|sleep|power|PowerMode'` over `main.rs` returns **no matches** for any of those — only `std::thread::sleep(...)` calls at `:1052, 1084, 1577, 1648, 1826, 2078, 2193`. There is no `tauri::RunEvent::Resumed` / `Suspended` handler, no `WM_POWERBROADCAST`, no `power_monitor` plugin in `Cargo.toml:10-20`.

The renderer has one lifecycle hook, and it is visibility-based, not power-based (`App.tsx:277-292`):

```ts
279:  const action = micPolicy(document.visibilityState === 'hidden' ? 'hidden' : 'visible', userMuted);
280:  if (action === 'release') captureRef.current?.stop();
281:  else if (action === 'start') startMic();
...
286:  document.addEventListener('visibilitychange', onVisibility);
287:  window.addEventListener('blur', onVisibility);
```

`micPolicy` (`vad.ts:54-57`) returns `release` on `hidden` and `start` on `visible && !muted`. This is the L19 privacy fix and it is correct. The problem is that on Windows sleep, WebView2 does **not reliably** fire `visibilitychange` or `blur` — the documented behaviour of both is that they are visibility/focus signals, and a suspended process is neither focused nor unfocused. The comment at `App.tsx:283-285` even anticipates the platform's unreliability for *minimise* (`"a minimise does not always fire visibilitychange in WebView2"`), and the mitigation given is to also listen to `blur` — which has the same limitation on sleep.

On resume, one of three things happens, all bad:
1. Nothing fires → the dead `AudioContext` and the dead track stay dead. `running === true` → self-locked, per §4.1.
2. `visibilitychange` fires with `visible` → `startMic()` → **no-op at `capture.ts:78`**, and this is the *good* outcome avoided: the correct behaviour is indistinguishable from the bug.
3. `visibilitychange` fires with `hidden` → `stop()` → `running = false`, so the next `start()` genuinely re-acquires. This is the only self-healing path, and it is incidental.

**A suspended `AudioContext` is also never re-resumed on the capture side.** `capture.ts:145-149` calls `context.resume()` once, inside `start()`, and swallows the rejection with the comment *"Headless/fake devices may refuse resume; frames still flow on process."* Contrast `playback.ts:189`, which re-checks `context.state === 'suspended'` and resumes **on every decode** — the downlink handles this and the uplink does not.

## 4.3 The WebView2 / Tauri boundary

- **No device or power events cross it.** `main.rs` has no device-change or power handling (§4.2). `tauri.conf.json` has no `withGlobalTauri` and no plugin config; `capabilities/default.json:6-12` grants five `core:window`/`core:webview` permissions and no device or power permission. There is **no path** for the host to tell the renderer that the OS audio stack changed.
- **WebView2 has no device-plug notification in the renderer path.** `navigator.mediaDevices.ondevicechange` is the web API for this and it is unused. Adding it requires **no** new Tauri permission, **no** Rust change, and **no** CSP change — the CSP at `tauri.conf.json:27` has no `connect-src`/`script-src` restriction that touches it. This is the cheapest real fix in the entire audit.
- **The one documented WebView2 permission hazard is already handled, and it is why the user must be able to self-diagnose.** `vad.ts:64-71`: *"In a packaged Tauri build this is the live risk: wry registers a WebView2 `PermissionRequested` handler that leaves the microphone in `PERMISSION_STATE_DEFAULT` … Whether WebView2 then prompts or silently denies could not be verified from here, so the user has to be able to tell us which it was."* That `UNVERIFIED` still stands — I did not test it, and it cannot be tested from a static audit. It is a live reason to keep `micFailureNotice`'s per-`name` granularity rather than collapsing it.
- **An in-flight *uplink frame* is silently dropped when the socket is down.** `sendPcm` returns `false` and discards (`ws.ts:331-340`); `App.tsx:259` ignores the return value entirely. The daemon's 5 s window (`stt.ts:9`) plus 0.5 s overlap means a dropped window is recoverable by the next one, so this is acceptable — but it is a distinct, *correct* loss to keep separate from §4.1's device loss when writing the recovery spec, so a future reader does not "fix" it with a queue.

## 4.4 Specification — recovery states

### 4.4.1 The state model

`AudioCapture` currently has a boolean. It needs a small closed union, because "running" and "believed running" are different facts and conflating them is the bug:

```ts
// apps/desktop/src/audio/capture.ts — replaces `private running = false;` (:71)
export type CaptureState =
  | 'idle'            // no graph, never started or deliberately stopped
  | 'live'            // graph built, track live, frames flowing
  | 'stalled'         // graph still built but no frame has arrived for STALL_MS
  | 'lost';           // track ended / devicechange with no input device; recoverable

export interface CaptureEvents {
  onFrame(bytes: Uint8Array): void;
  onError?(err: Error): void;
  onEnergy?(energy: number): void;
  /** NEW. Fired on every CaptureState transition, including the initial 'live'. */
  onState?(state: CaptureState, previous: CaptureState): void;
}
```

`active` (`capture.ts:73-75`) keeps its meaning — `return this.state === 'live'` — so nothing downstream changes. But `start()`'s guard becomes:

```ts
// apps/desktop/src/audio/capture.ts:78
if (this.state === 'live' || this.state === 'stalled') return;
```

i.e. **`start()` re-acquires from `lost`, and is still idempotent for `live`/`stalled`.** That satisfies `capture-permission.test.ts:74-83` unchanged if the test's `(capture as unknown as {running: boolean}).running = true` is migrated to `state = 'live'` — the test's *intent* ("a spurious visibilitychange must not open a second graph") is preserved, and the test should additionally gain a case asserting that `start()` from `lost` **does** re-acquire. Without that second case the fix is untested and, per this repo's own rule, unverifiable.

### 4.4.2 The three detectors, in priority order

**D1 — `track.onended` (device physically removed).** Register immediately after `getUserMedia` succeeds (`capture.ts:85-87`), before the graph is built, so a device that dies during setup is still caught:

```ts
const track = stream.getAudioTracks()[0];
if (track === undefined) {
  throw Object.assign(new Error('microphone denied or absent: no audio track in the stream'),
    { name: 'DevicesNotFoundError' });
}
track.addEventListener('ended', () => this.markLost('device-ended'), { once: true });
track.addEventListener('mute',  () => this.markStalled(),            { once: true });
track.addEventListener('unmute', () => { if (this.state === 'stalled') this.setState('live'); });
```
`mute`/`unmute` are the *correct* pair for the Windows sleep case: a suspended/resumed endpoint goes `mute → unmute` without necessarily ending the track. This is why D1 needs all three events, not just `onended`.

**D2 — `navigator.mediaDevices.ondevicechange`.** No permission, no Rust, no CSP change (§4.3). It is the only signal that fires when the user plugs a *different* microphone in, which is the case where auto-recovery is most valuable:

```ts
// apps/desktop/src/audio/capture.ts — module scope
const onDeviceChange = (): void => {
  // devicechange fires for input AND output devices; enumerateDevices is the
  // only way to tell. It returns no labels without permission, which is fine —
  // this only needs the *count* of audioinput devices.
  void navigator.mediaDevices.enumerateDevices()
    .then((all) => { const n = all.filter((d) => d.kind === 'audioinput').length; /* … */ })
    .catch(() => undefined);
};
```

Route `n === 0` → `markLost('devicechange')`, and `n > 0` while `state === 'lost'` → `void this.start(this.lastEvents)`, which is D3's re-acquire path. This is what turns "unplug, then plug a different mic in" from a permanent silent death into a self-heal. Because `enumerateDevices` needs no permission to return `kind`/`deviceId`, this works even when `getUserMedia` was refused — which is a bonus: it can distinguish "permission refused" from "no hardware" *before* the user ever speaks, which is precisely the `UNVERIFIED` at `vad.ts:64-71`.

**D3 — a frame-arrival watchdog.** `onended`/`devicechange` do not fire for every stall (a driver that wedges without ending the track, or a suspended `AudioContext`). The uplink already knows the frame cadence exactly: `AUDIO_FRAME_MS = 100` and `AUDIO_FRAME_BYTES = 3200` (`src/ipc/protocol.ts:25-26`, asserted by `capture.test.ts:40-44`). So the watchdog threshold is derivable, not guessed:

```ts
// apps/desktop/src/audio/capture.ts
/**
 * No uplink frame for this long while `live` means the graph is dead, not the
 * room. 10 frames at the 100 ms contract rate (src/ipc/protocol.ts:25) with a
 * 4x margin: 1.0 s of total silence would be unusual, 4.0 s is unambiguous.
 */
export const CAPTURE_STALL_MS = 4_000;
```

Stamped in `emit` (`capture.ts:102-125`, where every `onFrame` call is at `:118`). The timer must be owned by the class and cleared in `stop()` (`:154-173`) or it leaks a timer per restart — the same class of leak `playback.dispose` documents (`playback.ts:111-119`).

### 4.4.3 Re-acquire policy

One rule, and it must be a **debounced, bounded** retry, because `markLost` can fire repeatedly:

```ts
/**
 * Re-acquire after a loss. Debounced, because `ended` + `mute` + `devicechange`
 * can all fire for one unplug, and an un-debounced retry would open N graphs.
 * Bounded, because a microphone that is genuinely gone must not spin.
 */
const REACQUIRE_DELAY_MS = 500;
const REACQUIRE_MAX_ATTEMPTS = 5;   // ~2.5 s, then stop and ask the user
```

After `REACQUIRE_MAX_ATTEMPTS` the state is `lost` and **the UI must say so** — no infinite retry, no silent give-up. A manual retry (the mic button, `App.tsx:388-399`) resets the counter: `toggleUserMute` already calls `stop()` on mute, and `stop()` must reset both the counter and the stalled timestamp.

**One thing must not be re-acquired automatically: permission.** If the last `start()` failed with `NotAllowedError`/`SecurityError`, a `devicechange` must **not** re-trigger `getUserMedia` in a loop — Windows will not prompt again and `vad.ts:81-83`'s instruction ("فعّله من إعدادات ويندوز") is the correct and only answer. So `markLost` records `retryable: boolean` derived from the last error name.

### 4.4.4 What the user should see

Four states, four distinct affordances. The current UI has one `announce` string (`App.tsx:41`) and one pill (`App.tsx:465-478`), and it says "listening" in all four of these cases. That is the actual defect on the display side.

| Capture state | Pill | Mic button | Extra |
|---|---|---|---|
| `idle` | unchanged | `MicOffGlyph`, `aria-pressed` per `userMuted` (`App.tsx:612-627`) | — |
| `live` | `● جارٍ الاستماع…` (`App.tsx:473`) | `MicGlyph` | visualizer driven by `onEnergy` |
| `stalled` | `● الميكروفون صامت…` (**new**) | `MicGlyph` | visualizer dims to 0 rather than freezing at its last value — a frozen meter reads as "live" and is itself a lie |
| `lost` | `● لا يوجد ميكروفون — اضغط لإعادة الاتصال` (**new**) | `MicOffGlyph`, `title` = the new Arabic string | the user must be able to tell `NotAllowedError` from no-hardware from busy: reuse `micFailureNotice` (`vad.ts:78-93`) verbatim rather than writing a fourth message |

The new Arabic strings go in `apps/desktop/src/audio/vad.ts` next to the existing two functions, so **all** user-facing mic copy stays in one module — the same convention the SEC-7 comment at `vad.ts:59-77` establishes.

`App.tsx` wiring is one `onState` callback inside the existing `startMic` closure (`App.tsx:233-264`), which already passes `onEnergy`/`onFrame`/`onError`:

```ts
onState: (next, prev) => setCaptureState(next),
```
plus a `useEffect` on `captureState` that maps the table above. Nothing else in `App.tsx` changes; `startMic` is already a `useCallback` with no dependencies (`App.tsx:233`, `:264`) specifically so it can be called from a lifecycle handler (`App.tsx:226-232`), which is what the `devicechange` path needs.

**Interaction with `userMuted`.** A deliberate mute must win over auto-recovery: while `userMuted` is true, `markLost` must not schedule a re-acquire. `micPolicy` (`vad.ts:54-57`) already encodes "the user's own choice is never overridden in either direction" (`vad.ts:49-50`) and its `muted` parameter is the user's toggle, *not* whether a track exists (`vad.ts:51`) — the same distinction the new state machine must honour. Concretely: `App.tsx:279` already passes `userMuted` into `micPolicy`; add the same guard to the re-acquire scheduler.

### 4.4.5 The sleep/resume hook

Renderer-only, because the renderer already owns the `visibilitychange`/`blur` pair (`App.tsx:286-287`):

```ts
// App.tsx — add beside the existing visibilitychange effect (277-292)
useEffect(() => {
  // WebView2 does not reliably fire visibilitychange across a Windows sleep,
  // so neither does it for resume — the window is neither focused nor
  // unfocused. `pageshow` with persisted=true is the one lifecycle event a
  // restored-from-suspend renderer reliably gets, and it is the one signal
  // that distinguishes "the WebView was torn down and reloaded" (captureState
  // is back to its initial 'idle' and the AudioContext is gone) from a
  // resume of the same page.
  const onRestore = (e: PageTransitionEvent): void => {
    if (!e.persisted) return;
    startMic();
  };
  window.addEventListener('pageshow', onRestore);
  return () => window.removeEventListener('pageshow', onRestore);
}, [startMic]);
```

`startMic()` alone is not enough while `state === 'stalled'` (the guard at §4.4.1 returns early), so the D3 watchdog is the actual backstop for the case where `pageshow` does not fire. **This is the belt-and-braces pair, and it must be stated as such**: `pageshow` covers page-reload-after-suspend, D3's watchdog covers a live-but-silent graph, and D1's `mute`/`unmute` covers a suspended endpoint. Any one of the three alone leaves a hole.

**For a true OS-level signal, the minimum is a Tauri `RunEvent`, which needs no plugin:** add to the run loop at `main.rs:2898-2901`

```rust
// main.rs — a Resumed event tells the renderer the OS audio stack came back.
// Tauri v2 exposes no tray/device event without the `tray-icon` feature
// (§3.1) and there is no power-monitor plugin in Cargo.toml:10-20, so this
// is the only host-side hook available. The renderer does the real work;
// this just invalidates its watchdog.
if let RunEvent::Resumed = event {
    let _ = app_handle.emit("voxaura:resumed", ());
}
```
plus `"core:event:default"` in `capabilities/default.json` and an `emit`→`listen` bridge in the renderer. **This is a nice-to-have, not a prerequisite** — the three renderer-side detectors cover the observable failure modes, and adding a capability is a security-surface change that should not be bundled into a fix that does not need it.

### 4.4.6 Tests

1. `apps/desktop/src/audio/capture-recovery.test.ts` (new) — the four detectors, driven with injected fakes:
   - `track.onended` → state `'lost'`; a subsequent `start()` calls `getUserMedia` again. **This is the non-vacuity test** — it fails on today's `capture.ts:78` and is the whole point of §4.4.1.
   - no frame for `CAPTURE_STALL_MS` → `'stalled'`; a frame → back to `'live'`.
   - `devicechange` with zero `audioinput` devices → `'lost'`; with one and `state === 'lost'` → re-acquire.
   - debounce: `ended` + `mute` + `devicechange` in the same tick produce **exactly one** `getUserMedia` call, and at most `REACQUIRE_MAX_ATTEMPTS` total.
   - `stop()` clears the watchdog timer (assert via a fake `setInterval`/`clearInterval` pair, the pattern `playback-f01.test.ts` already uses for a floating-promise regression).
2. **Migrate, do not delete, `capture-permission.test.ts:74-83`.** Change `(capture as unknown as {running: boolean}).running = true` to `state = 'live'` and keep the assertion. Add the sibling case (`state = 'lost'` → `getUserMedia` **is** reached). If the existing case is deleted rather than migrated, the L19 double-graph bug returns — say so in the commit message.
3. `apps/desktop/src/audio/mic-policy.test.ts` — assert `micPolicy` is unchanged (it must be: it is a pure function of visibility + the user's toggle and needs no new input), and that the two new notice strings are distinct from `micFailureNotice`'s three.
4. E2E: `apps/desktop/e2e/` — the Playwright harness drives `e2e/stub-daemon.mjs` with a fake control port, so it cannot unplug a real microphone. What it *can* assert is the state machine's effect on the UI: stub `AudioCapture` to emit `onState('lost')` and assert the pill text and the mic-button glyph change, and stub a 4 s uplink gap and assert the `stalled` pill. Add it to the `bargein.spec.ts` family, which is the existing barge-in/behavioural spec.

---

## Cross-cutting note: all four gaps share one root cause

Three of the four (1, 2, 4) are the same failure at three different layers — **the renderer holds a truth the daemon does not have, or a state the world can invalidate without telling anyone, and the protocol carries no way to say so.** The WS-4097 contract has nine frame types (`hello`, `event`, `ack`, `error`, `inventory`, `agents`, `notice`, `voice`, `context` — `src/ipc/protocol.ts:304,321,388,404,424,438,453,464` plus `ACK_KIND`/`ERROR_KIND` at `:29-30`) and not one of them can express *"I am muted"* or *"this key is dead"* or *"the microphone is gone."* The `UiCommand` enum has 15 members (`protocol.ts:346-362`) and three of them — `mute`, `deafen`, `arm` — are answered `{ok:true}` while doing nothing (`command-router.ts:227-230`).

The fourth (3) is the same disease in the build: `main.rs` is 2,903 lines with 48 tests, and the one diagnostic file a human is told to read is written by the test binary. Green gates, broken instrument.

**Recommended order, if these are implemented as work:** §3.6.1 (10 lines, makes the instrument trustworthy) → §1.5.1–1.5.2 (the mute gate, the actual money) → §4.4.1–4.4.3 (the mic self-lock) → §2.5.2–2.5.4 (key health) → §3.6.2 (tray) → §2.5.5 (arm veto) → §3.6.4–3.6.5 (preflight teeth, NSIS block).
