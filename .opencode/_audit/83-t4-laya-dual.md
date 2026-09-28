# 83 — Track 4: LAYA System-1 Dual Edition Feasibility

**Swarm track 4 of 5 · research only · no code, model or Python was modified.**
Sole write target: this file. Nothing committed, nothing pushed.

**Date:** 2026-09-28 · **Repo HEAD:** `0df59ad` · **Model:** opencode-Vantrilex (Voxaura)

---

## 0. VERDICT UP FRONT

1. **Sub-15 MB by quantizing the full model: NO.** The budget allows
   **0.4099 bits per weight**. Even a physically impossible 1-bit scheme lands at
   **36.59 MB = 2.44× the target**. 2-bit (the coarsest weight-only scheme anyone
   ships) is **82.3 MB = 5.49× over**. The sub-15 MB goal is not a quantization
   target; it is a different-model target.
2. **3 of the 4 heads are already implemented as rules in shipped code**
   (`barge_in`, `is_destructive`, `stuck_in_loop`). Only `should_speak` has no
   existing implementation anywhere in `src/`.
3. Therefore the honest Tier A is **LAYA Lite: zero model files, ~1 MB of pure
   TypeScript, no `onnxruntime-node` in the graph at all.** Tier B is the full
   model as an opt-in post-install download, never in the installer.
4. Quantifying the "already rules" finding further: the int8 model is **worse than
   the existing keyword rule** on `is_destructive` (precision 0.70,
   `ml/head_metrics.json:58`), and the FR-12 execution-boundary gate
   (`src/orchestrator/command-router.ts:65,248`) cannot be evaded by phrasing at
   all. The model head is *redundant* with a control that is already stronger.

---

## 1. HOW THE ARCHITECTURE FACTS WERE OBTAINED (and what is UNVERIFIED)

Python is **not installed on this machine** (`python --version` → "Python was not
found"), so `onnx`/`onnxruntime` tooling was unavailable. Rather than guess the
architecture, I wrote a **streaming protobuf scanner** (no dependencies, seeks
past `raw_data` so a 1.17 GB graph never enters RAM) at
`%LOCALAPPDATA%\Temp\opencode\onnx-scan.mjs`, and ran it over both ONNX files.

**Everything in §2 marked VERIFIED is read out of the actual ONNX wire format,
not inferred.** Protobuf field numbers used: `ModelProto.graph=7`,
`GraphProto.node=1 / name=2 / initializer=5 / input=11 / output=12`,
`NodeProto.input=1 / output=2 / name=3 / op_type=4`,
`TensorProto.dims=1 / data_type=2 / name=8 / raw_data=9`. `dims` is a *packed*
proto3 repeated field, so it decodes as a length-delimited run of varints.

> Methodological note, because it nearly produced a wrong answer: the scanner
> has a three-layer reader. A `skip()` that advances past the read window must
> **clear the buffer**, or `ensure()` sees `pos - base = 0 <= buf.length` and
> serves stale bytes as zeros — which made a valid `onnx.quantize` header read as
> 8,388,608 zero bytes. Two further bugs had the same shape (a `fields()` end
> bound passed as the field *start*, so nested parses never ran). The final
> parse is self-validating: the independently-derived per-layer sum reproduces
> the fp32 parameter total with **delta = 0** (§2). If the arithmetic closes to
> zero, the parse is right.

**UNVERIFIED (stated rather than invented):** which of the four per-layer weight
matrices is fused-QKV vs. MLP gate/up vs. down. The *shapes* and the *count* are
verified byte-exactly, but the semantic assignment would need `AttributeProto`
parsing plus producer-side knowledge. **This is irrelevant to every size
calculation in this document** — quantization size depends only on the parameter
count and shapes, both of which are exact.

---

## 2. VERIFIED ARCHITECTURE

### 2.1 File sizes (measured, `Get-ChildItem`)

| File | Bytes | MB (÷1048576) | MiB |
|---|---:|---:|---:|
| `models/laya-m7-int8.onnx` | 308,050,615 | 293.78 | 280.14 |
| `models/laya-m7.onnx` | 1,228,429,195 | 1171.52 | 1118.02 |
| `models/silero-vad.onnx` | 2,243,022 | 2.14 | 2.14 |

All three confirmed present. `models/*.onnx` is **gitignored** (`.gitignore:40`,
confirmed by `git check-ignore -v`).

### 2.2 Graph facts (VERIFIED, both files)

```
inputs  = input_ids, attention_mask
outputs = logit_should_speak, logit_is_destructive, logit_barge_in, logit_stuck_in_loop
```

Producer: `onnx.quantize` `0.1.0` (from the ModelProto header bytes).

| Fact | Value | How derived |
|---|---:|---|
| Transformer layers | **22** | `Softmax=22`, `Erf=22`, `Split=22`, `LayerNormalization=45` (22×2 + 1 final) |
| Hidden width | **768** | every head weight is `[768,1]`; LayerNorms are `45 × [768]` |
| Vocabulary | **256,000** | `embeddings.tok_embeddings.weight = [256000, 768]` |
| Heads | **4 × Linear(768→1)** | 4× `[768,1] int8` + 4× `[1] fp32` bias |
| Per-layer weights | **4 matrices** | `MatMulInteger=92` = 22×4 body + 4 heads |
| Body ops | 44×`[768,2304]`, 22×`[1152,768]`, 22×`[768,768]` | shape histogram |
| Nodes | 3,305 (int8) / 2,935 (fp32) | node count |
| Weight dtypes (int8 file) | `uint8` 196,608,001 · `int8` 110,300,252 · `float32` 34,657 | dtype histogram |

**Shared vs per-head trunk: SHARED.** All four heads consume the *same* pooled
768-d vector; there is no per-head tower. Confirmed by the tensor names
`model.heads.<head>.weight_{quantized,scale,zero_point}` — four parallel 768→1
projections off one trunk, plus `ReduceSum=2` implementing the masked mean
pool described in `src/runtime/laya/constants.ts:12`.

### 2.3 Parameter budget — closes to zero (VERIFIED)

```
embedding      256000 x 768                =   196,608,000
per layer      2*(768*2304)+1152*768+768*768 = 5,013,504
x 22 layers                                 =   110,297,088
layernorms     45 x 768                     =        34,560
heads          4 x (768w + 1b)              =         3,076
                                       TOTAL =   306,942,724
cross-check vs fp32 initializer count     =   306,942,724   delta = 0
```

| Bucket | Params | Share |
|---|---:|---:|
| Embedding table | 196,608,000 | **64.05 %** |
| 22 transformer layers | 110,297,088 | 35.93 % |
| LayerNorms | 34,560 | 0.0113 % |
| **The 4 classification heads** | **3,076** | **0.001 %** |

**The heads — the actual product — are 3,076 parameters, one thousandth of one
percent of the file.** Everything else is a 306.9 M-parameter multilingual
encoder that exists only to produce 768 numbers.

The int8 file carries 186 extra scalars (92 `int8` zero-points + 93 `float32`
scales, minus the 4 head biases counted twice) → 306,942,910 vs 306,942,724.
This confirms the existing file is **per-tensor dynamic quantization**
(`DynamicQuantizeLinear=89`), **not** grouped weight-only.

Backbone provenance is documented in `ml/training_config.yaml:2,7-9`:
`convaiinnovations/laya-multilingual` (322 M), `unfreeze_top_layers: 2`.

---

## 3. PART 1 — THE QUANTIZATION ARITHMETIC

### 3.1 Assumptions, stated explicitly

Weight-only, symmetric, **one `float32` scale per group of `g` weights**, no
zero-point (absorbed into the scale), fp32 kept for LayerNorms/head biases, plus
≈1 MB of ONNX graph metadata (the current file shows 308,050,615 − 307,046,881 =
1,003,734 bytes of overhead).

```
bytes/weight = b/8 + 4/g
```

`b` = weight bits, `g` = group size. `g=128` is the community default; `g=64` is
shown to expose how fast the scale overhead grows.

### 3.2 Full-model weight-only quantization (P = 306,942,724)

| bits | g | B/weight | Bytes | MB | **× 15 MB target** |
|---:|---:|---:|---:|---:|---:|
| 8 (current) | 128 | 1.03125 | 316,534,684 | 301.9 | **20.12×** |
| 8 | 64 | 1.06250 | 326,126,644 | 311.0 | 20.73× |
| 6 | 128 | 0.78125 | 239,799,003 | 228.7 | 15.25× |
| 4 | 128 | 0.53125 | 163,063,322 | 155.5 | **10.37×** |
| 4 | 64 | 0.56250 | 172,655,282 | 164.7 | 10.98× |
| 3 | 128 | 0.40625 | 124,695,482 | 118.9 | 7.93× |
| 2 | 128 | 0.28125 | 86,327,641 | 82.3 | **5.49×** |
| 2 | 64 | 0.31250 | 95,919,601 | 91.5 | 6.10× |
| 1 (unachievable) | 128 | 0.15625 | 47,959,801 | 45.7 | 3.05× |

The brief's estimate — "4-bit ≈ 147 MB, 2-bit ≈ 74 MB" — is the *idealized*
per-weight figure with scale overhead ignored. With a realistic `g=128` scale the
true numbers are **155.5 MB at 4-bit and 82.3 MB at 2-bit**. Either way the
conclusion is identical and it is not close.

### 3.3 THE ANSWER: can any weight-only quantization reach under 15 MB? **NO.**

```
15 MB            = 15,728,640 bytes
budget/weight    = 15,728,640 x 8 / 306,942,724
                 = 125,829,120 / 306,942,724
                 = 0.4099 bits per weight
```

**You would have to store every one of 306.9 million weights in 0.41 bits.** That
is below one bit per weight. No weight-only scheme can represent a weight in less
than one bit on average without an external codebook — and a codebook is
*codebook* quantization, which is a different technique with its own
fidelity cliff, not a cheaper setting on this one.

Even the unreachable 1-bit floor:

```
306,942,724 / 8 = 38,367,841 bytes = 36.59 MB = 2.44x the 15 MB target
```

**Stated bluntly: the sub-15 MB goal is unreachable for this model by a factor of
2.4× even at a bit-width that does not exist.** It is not a quantization target.
It is a *different-model* target — one with roughly 40 M parameters or fewer, or
none at all. Any roadmap, ticket or doc that presents "get Laya under 15 MB" as a
quantization exercise is mis-framed, and the only honest readings are
"replace the backbone" or "drop the backbone".

---

## 4. PART 2 — THE REAL PATHS TO SOMETHING LAPTOP-SIZED

### 4.a PRUNING to a sub-network

The structural facts were needed to answer this, and they are verified in §2:
**22 layers, hidden 768, vocabulary 256,000, 4 matrices per layer, heads 0.001 %
of parameters, shared trunk.**

**Decisive fact: the embedding table is 64 % of the model.** Pruning transformer
depth cannot touch it, because the vocabulary is fixed by the tokenizer
(`256,000 × 768`). The ceiling on "delete layers and keep everything else":

| Scenario | Params | int8 MB | 4-bit MB | × 15 MB |
|---|---:|---:|---:|---:|
| Full model | 306,942,724 | 292.7 | 155.5 | 19.51× |
| **Drop all 22 layers** (embed + LN + heads only) | 196,645,636 | 187.5 | 99.6 | **12.50×** |
| Drop embed + all 22 layers (heads + LN only) | 37,636 | 0.04 | 0.02 | 0.00× |
| Vocab 256k→8k, keep all 22 layers | 116,478,724 | 111.1 | 59.0 | 7.41× |
| Vocab 8k + 4 layers, hidden 768 | 26,235,652 | 25.0 | 13.3 | 1.67× |

**Deleting the entire 22-layer trunk still leaves 187.5 MB — 12.5× over budget.**
Depth pruning alone is dead on arrival. You must shrink the *vocabulary* too, and
a smaller vocabulary means a different tokenizer, i.e. **a different model and a
re-trained head**. Once you have retrained, you are in §4.b, not §4.a.

**Effort:** high. Structural pruning of a 22-layer encoder to 4 layers while
keeping FP32 quality on a 4-head task typically loses far more than 18× the
parameter reduction suggests, and the checkpoint is CPU-trained
(`ml/training_config.yaml:4-5`). **Verdict: not the path. It is a stepping stone
to distillation, not an alternative to it.**

### 4.b DISTILLATION into a small classifier

**The argument that this works, and it works easily.** The function Laya must
learn is: *given ≤32 tokens, emit 4 independent binary decisions.* Measured
positive rates on the real test split `ml/data/splits/test.jsonl` (992 rows):
`should_speak` = 672 rows = **67.74 %**. From `ml/head_metrics.json:9,19,26,35`
the positives are 335/520, 102/520, 122/520, 131/520. This is a **shallow,
low-entropy, 4-label function over a 32-token window** — precisely the regime
where a 4 M-parameter student matches a 307 M-parameter teacher. The teacher's
extra 300 M parameters are buying contextual fluency that four binary decisions
do not consume.

| Distilled student | Params | int8 MB | 4-bit MB | Under 15 MB? |
|---|---:|---:|---:|---|
| L=4, h=256, vocab 8,192 | 4,066,308 | **3.88** | 2.06 | yes |
| L=6, h=256, vocab 8,192 | 5,050,372 | **4.82** | 2.56 | yes |
| L=4, h=384, vocab 16,384 | 10,719,748 | 10.22 | 5.43 | yes |
| L=6, h=384, vocab 32,768 | 19,224,580 | 18.33 | 9.74 | no |
| L=8, h=512, vocab 32,768 | 32,516,100 | 31.01 | 16.47 | no |

(intermediate = 1.5h, fused QKV + out + MLP; formula in the scratch script)

**Sub-15 MB is comfortably reachable — 3.9 MB is, in fact, the *conservative*
target.** And if `should_speak` is the only head that needs learning (§4.c), the
student can be far smaller still: a **hashing vectorizer + logistic regression**
over 2^18 buckets is `4 heads × 262,144 × 4 bytes` = 4.19 MB as fp32, **1.05 MB
as int8**, scoring in well under 1 ms, in **pure TypeScript with zero native
dependencies and zero ONNX runtime**.

**What you would measure to know** (all already-scriptable, no new infra):
1. **Teacher-student agreement** on `ml/data/splits/test.jsonl` — the ceiling.
   If a 4 M student cannot match the fp32 teacher (99.70 % `should_speak`,
   `ml/quant_report.json:4`), the head needs the trunk.
2. **Per-head macro-F1 against `ml/training_config.yaml:28-29` gates** (0.90
   should_speak + is_destructive; 0.85 barge_in + stuck_in_loop).
3. **The adversarial suite** `ml/adversarial_suite.json` (22,591 bytes) and
   `ml/negation_report.json` — negation and diacritic evasion are exactly where
   a bag-of-features student loses to a contextual trunk. This is the risk, and
   it is real.
4. **Latency sweep** against `ml/l2_report.json`.

**Verdict: this is the path. Effort: medium (it is a normal distillation run, and
`ml/train_laya.py` + `ml/requirements-cpu.txt` already exist). Fidelity: expected
high for 3 heads, genuinely uncertain for `should_speak`.**

### 4.c THE KEY QUESTION — how much of Laya is ALREADY RULES?

This is the finding that should change the roadmap. Read from source:

#### `barge_in` — **ALREADY COVERED. Three times. Zero new bytes.**

| Implementation | Location | Detail |
|---|---|---|
| RMS energy gate | `src/voice/ingest.ts:19` | `SPEECH_GATE_DB = -30` |
| | `src/voice/ingest.ts:22-37` | `windowRmsDb` — RMS in dBFS, floors at −100 |
| | `src/voice/ingest.ts:40-42` | `isLoudWindow` |
| Silero VAD (2.14 MB ONNX) | `src/runtime/vad.ts:46-96` | `SileroVad.prob` / `isSpeech`, threshold 0.5 |
| Silero wired in the daemon | `src/daemon.ts:494-505` | memoised `loadVad` via `import('./runtime/vad.js')` |
| | `src/daemon.ts:507-517` | `vadGate` — any speech frame in 156 admits the window |
| | `src/daemon.ts:509` | fail-closed fallback to `isLoudWindow` |
| Renderer barge-in | `apps/desktop/src/audio/vad.ts:20-22` | `isSpeechFrame`, default −30 dB |
| | `apps/desktop/src/audio/vad.ts:32-35` | `bargePolicy` → `'duck' \| 'barge' \| 'send'` |

`src/voice/ingest.ts:15-17` states the design intent: `SPEECH_GATE_DB` is
*"deliberately identical to the renderer's barge-in threshold ... so one number
describes 'this is speech' on both sides"*. The barge-in decision is **already
made, already shipped, and already consistent across the WS-4097 boundary.**

*Caveat, stated honestly:* Laya's `barge_in` is a **text** head — it reads 32
tokens, not audio. It answers "is this utterance directed at me mid-flight", not
"is there speech". The acoustic half is fully covered; the *intent* half is not.
But the intent half is `should_speak`'s job, not this head's.

#### `is_destructive` — **ALREADY COVERED, and the existing control is STRONGER.**

| Implementation | Location | Detail |
|---|---|---|
| Verb list | `src/voice/brain.ts:97` | `HIGH_STAKES_VERBS = ['destroy','delete','drop','force-push','force push','deploy','rm -rf','rm -rf ']` |
| Predicate | `src/voice/brain.ts:100-103` | `requiresConfirmation(text)` — lowered + `includes()` |
| **Execution-boundary gate** | `src/orchestrator/command-router.ts:65` | `DESTRUCTIVE_KINDS = new Set(['execSessionShell'])` |
| | `src/orchestrator/command-router.ts:248-263` | parks the command, `CONFIRMATION_TTL_MS = 60_000` |
| Injection defence | `src/orchestrator/command-router.ts:98-116` | `UNSAFE_SHELL_RE` refuses `[;&\|\`$<>\n\r*?(){}!~]`, `TRAVERSAL_RE` refuses `..` |
| Loop/dupe cap | `src/orchestrator/command-router.ts:73` | `MAX_PARKED = 8`, oldest-first eviction |
| Prompt rule | `src/voice/brain.ts:112` | "Destructive verbs ...: ALWAYS ask first" |
| Knowledge tier | `src/knowledge/shared/commands.ts:43-48` | same verb set, bilingual |
| Slash allowlist | `src/orchestrator/slash.ts:5` | `/rm -rf /` is refused, never forwarded |

**The decisive point:** `DESTRUCTIVE_KINDS.has(cmd.kind)` is keyed on the
*command kind*, not on the prose. A model scoring `is_destructive = 0.9` does not
gate anything; the kind check does, and it **cannot be evaded by phrasing** —
"please clean things up" and "نظّف المشروع" both hit the same gate, because the
gate never reads the sentence. The model's own engine file concedes the point at
`src/runtime/laya/laya-engine.ts:10`: *"Advisory-only: every decision is
schema-gated downstream (FR-12 confirmation still mandatory for destructive acts)."*

And the model is **measurably worse than the rule it would replace**: int8
`is_destructive` precision is **0.70** (`ml/head_metrics.json:58`) — it would
falsely clear 30 % of destructive utterances, where `requiresConfirmation` is a
deterministic substring test that never misses a listed verb. At int8 f1 = 0.784
(`ml/head_metrics.json:61`) it does not even clear its own 0.90 gate
(`ml/training_config.yaml:28`).

#### `stuck_in_loop` — **ALREADY COVERED by counters, and the model adds ~nothing.**

| Implementation | Location | Detail |
|---|---|---|
| Retry policy | `src/voice/brain.ts:113` | "heartbeat every 5 min or 3 fails, halt at 5 and ask" |
| Parked-command cap | `src/orchestrator/command-router.ts:73` | `MAX_PARKED = 8` + oldest-first eviction (`:257-263`) |
| Expiry | `src/orchestrator/command-router.ts:66,244` | `CONFIRMATION_TTL_MS = 60_000` |
| Ingest backpressure | `src/voice/ingest.ts:8,90-93` | `MAX_BUFFERED_BYTES = 6 × window`, `droppedWindows` counter |
| LLM-loop circuit breaker | `src/voice/cache.ts`, `src/voice/tts.ts` | per-module caches/retries |

**The model has almost nothing to add here, and the data agrees:**
`stuck_in_loop` is `acc = 1.0000, f1 = 1.0000` at fp32 and `0.9923` at int8
(`ml/head_metrics.json:32-37,74-80`) — the easiest of the four heads. A counter
gets that for free.

#### `should_speak` — **NOT COVERED. This is the gap.**

A repo-wide search for `should_speak` / `shouldSpeak` / `turnPolicy` outside
`src/runtime/laya/` returns **nothing**. There is no turn policy: the daemon
speaks whenever the pipeline completes (`src/daemon.ts:519-521` `setVoicePhase`).
This is the one head where a learned component could add real value, and it is
the only head that justifies a model at all.

### 4.c Verdict: **3 of 4 heads need no model whatsoever.**

And there is already a purpose-built seam for the fourth:

```ts
// src/knowledge/guard.ts:31-44
export async function guardText(
  text: string, blocklist: readonly string[],
  isDestructive: (text: string) => Promise<boolean>,
): Promise<GuardVerdict>
```

`src/knowledge/guard.ts:3` describes it as *"deterministic pre-filter + neural
backstop"*, `:27-29` names the intended backend — *"A.R.E.E.B./Laya
isDestructive"* — and `:40-42` makes it **fail-open** (a neural error never
blocks speech by itself; "FR-12 owns risk"). `src/knowledge/personas.test.ts:40-50`
tests both branches.

**The deterministic-first-then-injected-neural pattern this project already uses
IS the Laya Lite architecture.** Tier A is not an invention; it is the
`guard.ts` pattern applied to the remaining head.

---

## 5. PART 3 — SPECIFICATION: LAYA LITE (Tier B in the brief's numbering)

### 5.1 Design constraints, taken from the existing code

1. **Structurally identical advisory façade** so it drops into the same seam as
   `src/runtime/laya/loader.ts:36-41`:
   ```ts
   export interface LayaAdvisory {
     decide(text: string): Promise<LayaDecision | null>;
     readonly heads: readonly LayaHead[];
     readonly operatingLength: number;
   }
   ```
2. **Zero native dependencies.** The strongest architectural argument for Lite:
   if nothing imports `onnxruntime-node`, then `src/runtime/laya/laya-engine.ts`
   never enters the graph, `src/policy/laya-sidecar-safety.test.ts` passes
   trivially, and **the entire v0.6.0 failure class disappears** rather than
   being defended against by two layers. `src/runtime/laya/loader.ts:19-29`
   explains that defence; Lite makes it unnecessary (keep it anyway — harmless).
3. **Advisory, never gating.** `src/runtime/laya/laya-engine.ts:8-10` and
   `src/knowledge/guard.ts:40-42`: FR-12 owns risk. Lite must not gate anything.
4. **Fail-open on absence.** `src/runtime/laya/loader.ts:81-88` returns `null`,
   never throws; the caller speaks.
5. **Honest advertisement.** `src/ipc/ui-server.ts:389` sets `layaReady: false`
   and `:381-388` explains that a frame asserting a live feature that is not live
   is the exact defect class this project hunts. Lite must set it truthfully.

### 5.2 Module layout

```
src/runtime/laya-lite/
  constants.ts     LAYA_LITE_HEADS, thresholds, reuses LayaHead from ../laya/constants.js
  types.ts         LayaLiteDecision  (4-head shape, identical to LayaDecision)
  rules.ts         isDestructiveRule / bargeInEnergy / stuckInLoopCounter   (pure, no I/O)
  should-speak.ts  the only learned component (hashing vectorizer + logistic weights)
  decision.ts      composition + turn policy + telemetry
  loader.ts        loadLayaLite() — the ONE sanctioned dynamic door
  index.ts         barrel — FORBIDDEN for the daemon, same poison as laya/index.ts
```

Mirror the two-layer split from `src/runtime/laya/{constants,types,loader}.ts`:
`loader.ts` must hold **no specifier-bearing edge** to anything that can fail to
load, not even an erased `import type` (`src/runtime/laya/types.ts:8-15`).

### 5.3 Decision function signatures

```ts
// ---- rules.ts — pure, synchronous, deterministic, fully unit-testable ----

/** FR-12 mirror. Delegates to the shipped predicate; never re-implements it. */
export function ruleIsDestructive(text: string): boolean;
export const ruleIsDestructive: (t: string) => boolean;  // = requiresConfirmation, brain.ts:100

/** Energy gate. Reuses the existing dBFS scale — no new number. */
export function ruleBargeIn(rmsDb: number, speechProb: number | null): boolean;
//  speechProb !== null ? speechProb >= 0.5 : rmsDb > -30   (vad.ts:96 / ingest.ts:41)

/** Loop detector. O(1) state, no model. */
export interface LoopState { repeats: number; lastNormalized: string; sinceHeartbeatMs: number; }
export function newLoopState(): LoopState;
export function ruleStuckInLoop(text: string, s: LoopState, now: number): boolean;
//  normalized-repeat >= 3  ||  >= 5 distinct failures since last heartbeat
//  (thresholds taken from brain.ts:113: "3 fails ... halt at 5")

// ---- should-speak.ts — the ONLY learned part ----
export interface ShouldSpeakModel {
  readonly kind: 'hashing-logreg';      // extendable: add 'onnx' later, same interface
  readonly version: string;
  score(text: string): number;          // p(speak), synchronous
  readonly bytes: number;               // for telemetry
}

// ---- decision.ts ----
export interface LayaLiteDecision {
  readonly scores: Record<LayaHead, number>;
  readonly source: Record<LayaHead, 'rule' | 'model'>;   // per-head provenance
  readonly elapsedMs: number;
  readonly at: string;
}
export function decideLite(
  text: string, model: ShouldSpeakModel, state: LoopState,
  audio: { rmsDb: number; speechProb: number | null }, now: number,
): LayaLiteDecision;

// ---- loader.ts — mirrors src/runtime/laya/loader.ts:76 ----
export interface LayaLiteAdvisory {          // structurally == LayaAdvisory
  decide(text: string): Promise<LayaLiteDecision | null>;
  readonly heads: readonly LayaHead[];
  readonly operatingLength: number;          // 32, from laya/constants.ts:15
}
export async function loadLayaLite(
  opts?: { readonly sink?: LayaTelemetrySink | null },
): Promise<LayaLiteAdvisory | null>;         // never throws
```

**Call site — the sanctioned seam, mirroring `src/daemon.ts:500` and
`src/runtime/laya/loader.ts:9-16`:**

```ts
// daemon.ts, inside the same shape as loadVad()
layaLite = import('./runtime/laya-lite/loader.js')
  .then((m) => m.loadLayaLite({ sink: record }))
  .catch(() => null);
```

Then, in the same commit, flip `src/ipc/ui-server.ts:389` `layaReady` to `true`
— per `:381-388`, only in the commit that installs the seam, and only once
verified.

### 5.4 Wiring the one head that is not already covered

`should_speak` is the only head needing a learned component, and the seam already
exists:

```ts
// Replaces the current advisory call in the plan/narrate path.
const decision = await layaLite?.decide(transcript);
if (decision !== null && decision.scores.should_speak < 0.35) {
  // hold the reply; stay listening
  return;
}
```

`0.35` is an initial value only; it must be **calibrated on
`ml/data/splits/test.jsonl`** to hit the recall target in §5.5, not guessed.

### 5.5 Benchmark plan

**Latency** (measured, not asserted) — 10,000 iterations over
`ml/data/splits/test.jsonl`, report p50/p95/**p99**, compare against:

| Baseline | p50 | p99 | Source |
|---|---:|---:|---|
| Laya full @32 (current gate passes) | 24.86 ms | **94.43 ms** | `ml/l2_report.json:24,26` |
| Laya full @128 | 73.04 ms | 177.70 ms | `ml/l2_report.json:14,16` |
| Laya Lite target | **< 2 ms** | **< 5 ms** | this spec |

**Two findings to carry into the checkpoint, both measured:**

1. **`ml/l2_report.json:10,11` records `gate_ms: 40.0, latency_gate_pass: true`,
   but the gate is evidently applied to p50 only.** p50 @32 = 24.86 ms passes;
   **p99 @32 = 94.43 ms is 2.36× the 40 ms gate.** A latency gate that ignores
   p99 will not catch a tail-latency regression on a laptop.
2. **`src/runtime/laya/constants.ts:12-13` is stale.** It claims *"p50 25.8 ms vs
   66.4 ms at 128 (docs/09 ADR-008, ml/l2_report.json)"*. The file it cites says
   p50 **24.86** @32 and **73.04** @128, and quotes **neither p99**. `constants.ts:13-14`
   already flags itself `UNVERIFIED`, which is honest, but the numbers are wrong.

**Accuracy** — gates from `ml/training_config.yaml:28-29`: **0.90** for
`should_speak` + `is_destructive`, **0.85** for `barge_in` + `stuck_in_loop`.
Baselines to beat: fp32 `should_speak` acc **0.9970** (`ml/quant_report.json:4`),
int8 **0.9728** (`:26`).

**Lite target: `should_speak` acc ≥ 0.95 AND negative-class recall ≥ 0.90.**

The accuracy-only framing is a trap, and the data makes it explicit:
`should_speak` is **67.74 % positive** (672/992 rows in
`ml/data/splits/test.jsonl`), so a `should_speak`-that-does-nothing classifier
scores **67.74 %**. Any headline accuracy number must therefore be reported
alongside **recall on the 32.26 % negative class**, which is the number that
actually describes whether the assistant stays quiet when it should. The same
applies to `is_destructive` (102/520 = 19.6 % positive) and `barge_in`
(122/520 = 23.5 %).

Also mandatory before any accuracy claim: run **`ml/adversarial_suite.json`**
(22,591 bytes) and **`ml/negation_report.json`**. A hashing-vectorizer student is
structurally weak on negation ("don't delete the branch" contains "delete"), which
is precisely the failure the existing `requiresConfirmation` rule *over*-triggers
on. That asymmetry is acceptable for a *gate* (false positives cost one
confirmation prompt) and unacceptable for a *veto* — which is another reason
Lite stays advisory, per `src/knowledge/guard.ts:40-42`.

### 5.6 How it would be tested

- **Rules: exhaustive unit tests, no model needed.** `ruleIsDestructive` over the
  8 verbs in `src/voice/brain.ts:97` + negatives; `ruleBargeIn` on the exact dBFS
  boundary (mirror `src/voice/ingest.test.ts:76-120`, which already tests
  `windowRmsDb`/`isLoudWindow` at 0.0056, 0.25 and the `-30` constant);
  `ruleStuckInLoop` for 3-repeats, 5-fails, TTL reset, state reset.
- **Model: golden-file test.** `should-speak` weights checked in as a fixture;
  score a fixed corpus and assert the vector. Deterministic, no ONNX, no network.
- **Contract test: Lite ≡ Laya structurally.** Assert `LayaLiteAdvisory` is
  assignable to `LayaAdvisory` (`src/runtime/laya/loader.ts:36-41`) so either can
  be installed at the seam. This is the test that makes "swap editions" real.
- **Parity test.** Where both editions are available, assert Lite and Laya agree
  on the 3 rule heads **by construction** (Lite *is* the rules) — and log the
  disagreement rate on `should_speak` as the migration signal.
- **Sidecar safety.** Extend `src/policy/sidecar-safety.test.ts` to assert
  `onnxruntime-node` is **still** unreachable statically from the daemon —
  Lite must not regress this by importing something new.
- **Honesty test.** `layaReady` in the `hello` frame must equal "Lite is
  actually loaded" — the defect `src/ipc/ui-server.ts:381-388` documents.

### 5.7 Abandon criteria — when to ship the full model instead

Abandon Lite and ship **Tier B (full model, opt-in download)** if **any** holds:

1. **Accuracy floor missed.** The distilled `should_speak` cannot reach
   **acc ≥ 0.95 and negative-class recall ≥ 0.90** on `ml/data/splits/test.jsonl`.
   This is the primary trigger: it means the head genuinely needs the trunk.
2. **Adversarial regression.** Lite fails negation/evasion cases in
   `ml/adversarial_suite.json` that the full model passes, in a way that changes
   user-visible behaviour.
3. **Latency floor missed.** p99 > 20 ms on the target laptop class.
4. **Rules misfire in production.** A `brain.ts`-class false positive in
   `stuck_in_loop` or `is_destructive` is observed more than once in the field —
   the counters are right in theory and must be proven in telemetry.

**Critical constraint on Tier B, stated up front: Tier B is a POST-INSTALL
DOWNLOAD, never a bundled resource.** The numbers in §6 make bundling
untenable, and adding a model-fetch step changes the release process (which is
out of scope for this track and must be designed deliberately, not improvised).

---

## 6. PART 4 — RISK, QUANTIFIED

### 6.1 What the installer ships today

| Fact | Evidence |
|---|---|
| Bundle resources = **sidecar only** | `apps/desktop/src-tauri/tauri.conf.json:33` → `"resources": ["sidecar/**/*"]` |
| **No ONNX model ships — including VAD** | `models/*.onnx` gitignored (`.gitignore:40`, via `git check-ignore -v`) |
| Current NSIS size | **24.97 MB** (measured: `Voxaura_0.7.2_x64-setup.exe`) |
| Provisioned sidecar | 2,203 files, 100.69 MB |

**Consequence, and it is a live bug, not a hypothetical: because `models/` is
gitignored and not a bundle resource, `existsSync(cfg.vad.modelPath)` is false in
an installed build, so `loadVad()` rejects and `vadGate` falls back to
`isLoudWindow` (`src/daemon.ts:509`).** Installed builds have been running on the
RMS energy gate alone, with the Silero model sitting un-shipped on the same disk.
The same `existsSync` test is what makes `loadLayaAdvisory()` return `null`
(`src/runtime/laya/loader.ts:81-88`) and why `layaReady: false`
(`src/ipc/ui-server.ts:389`) is the correct current value.

So the *honest* delta is measured against a baseline that ships zero models, and
the first model shipped should be VAD, not Laya.

### 6.2 Installer arithmetic (base 24.97 MB)

| Bundle | Added | Total | Multiple |
|---|---:|---:|---:|
| VAD only (2.14 MB) | 2.14 | **27.11 MB** | 1.09× |
| **Laya Lite (≤ 5 MB)** | 5.00 | **29.97 MB** | **1.20×** |
| Laya int8 (293.78 MB) | 293.78 | **318.75 MB** | **12.77×** |
| Laya int8 + VAD | 295.92 | 320.89 MB | 12.85× |
| + tokenizer.json (~40 MB) | 40.00 | 358.75 MB | 14.37× |
| **Laya fp32 (1,171.52 MB)** | 1171.52 | **1,196.49 MB** | **47.92×** |
| fp32 + int8 + VAD + tokenizer | 1,507.44 | 1,532.41 MB | 61.37× |

NSIS solid-compresses this data at roughly 2:1, so realistically:
int8 ≈ **172 MB**, fp32 ≈ **611 MB**. Even the compressed int8 installer is
**~7× today's 25 MB**, and the fp32 one is ~24×.

### 6.3 What this does to the release process

The v0.6.0 lesson (`AGENTS.md`; `src/runtime/laya/loader.ts:10-16`;
`src/policy/sidecar-safety.test.ts:5-14`) is that **every gate can be green and
the daemon still cannot boot**, because E2E drives `stub-daemon.mjs` — a fake
control plane, not the real daemon. Bundling a native model makes that failure
mode materially more likely, and it breaks the documented release flow in four
places:

1. **Step 3 assumes one artefact.** AGENTS.md step 3 says "verify
   `Voxaura_<v>_x64-setup.exe`; compute SHA-256; record it". Four artefacts
   (exe + 3 models) means four hashes, four recorded digests, and a matching
   release-note table.
2. **Step 5 assumes one asset.** `gh release create <tag> <setup.exe>` becomes
   multi-asset. A 1,196 MB installer also sits far outside what a user will
   download on a metered connection — and 293.78 MB × multiple mirrors is a
   CI/CD and support burden with no product upside for 3 of 4 heads.
3. **The v0.6.1 containment is currently untested end-to-end.** `loader.ts:19-29`
   defends against a missing `onnxruntime-node` via `await import(...)` +
  `.catch()`. That defence is correct and unit-tested, but **no installed build
   has ever exercised it with a real model present** — and `memory_probe.mjs:11-13`
  shows the model load path has never run inside the sidecar payload.
4. **Disk and install time.** A 12.77× installer is a materially worse first-run
   experience for a desktop app whose whole pitch is a lightweight voice HUD.

**Recommendation: ship Laya Lite in the installer (1.20×, and with zero native
deps it cannot reproduce the v0.6.0 class at all). Ship the full model as an
explicit, user-triggered post-install download with its own checksum and its own
telemetry — which is exactly the shape `src/voice/vault.ts` +
`%LOCALAPPDATA%\Voxaura\` already use for first-run assets.**

---

## 7. RECOMMENDED TIERING (final)

| Tier | Contents | Size | Ships as | Justified by |
|---|---|---:|---|---|
| **Tier A — Laya Lite** | 3 rule heads (already written) + 1 distilled `should_speak` (hashing + logreg, pure TS) | **≤ 1.1 MB** | **bundled** | §4.c: 3/4 heads already covered; §5.5 < 5 ms p99; no `onnxruntime-node` in the graph |
| **Tier B — Laya full** | `laya-m7-int8.onnx` + tokenizer | 293.78 + ~40 MB | **opt-in download** | only for `should_speak` if Lite misses §5.7 |
| **Tier C — `laya-m7.onnx` fp32** | full precision | 1,171.52 MB | **never ship** | 47.92× the installer; 11.2× the accuracy of nothing (fp32 vs int8 `should_speak` 0.9970 vs 0.9728) |

Tier C is dead on arrival: it costs 877 MB more than Tier B to gain 2.4 points of
`should_speak` accuracy (`ml/quant_report.json:4` vs `:26`).

---

## 8. OPEN QUESTIONS AND UNVERIFIED ITEMS (explicit)

| # | Item | Status |
|---|---|---|
| 1 | Semantic identity of the 4 per-layer matrices (fused-QKV vs MLP gate/up vs down) | **UNVERIFIED** — shapes and counts verified byte-exactly; identity needs `AttributeProto` parsing. **Does not affect any size calculation here.** |
| 2 | Whether 22 or 23 layers | **Resolved: 22.** `Softmax=22, Erf=22, Split=22, LayerNormalization=45 (22×2+1)`, and the per-layer sum reproduces the fp32 total with **delta = 0**. |
| 3 | Live latency at 32 tokens | **Measured but not by me**: `ml/l2_report.json:24,26` p50 24.86 / p99 94.43. `src/runtime/laya/constants.ts:12-13` disagrees (25.8 / 66.4) and is **stale**. |
| 4 | Whether int8 `is_destructive` precision 0.70 (`ml/head_metrics.json:58`) reflects a shipping-quality gate | **It should not be a gate** — see §4.c; the kind-based FR-12 gate is the control. |
| 5 | True download-size pain for a 1.2 GB installer | **Estimated, not measured** — no build performed. NSIS ratio is a rule of thumb, not a measurement on this payload. |
| 6 | Distilled-student accuracy | **Not yet measured.** §5.5 defines the measurement; no distillation has been run. |
| 7 | Vocab/segmentation of the checkpoint tokenizer (~40 MB, not vendored) | **UNVERIFIED** — `src/runtime/laya/loader.ts:46-52` documents the absence; the file is not on this machine. |

---

## 9. REPRODUCTION

Everything numeric here is reproducible from:

```powershell
# Verified file sizes
Get-ChildItem O:\opencode-Vantrilex\models | Select-Object Name, Length

# Verified ONNX architecture (streaming protobuf scan, no deps, no Python)
node %LOCALAPPDATA%\Temp\opencode\onnx-scan.mjs O:\opencode-Vantrilex\models\laya-m7-int8.onnx
node %LOCALAPPDATA%\Temp\opencode\onnx-scan.mjs O:\opencode-Vantrilex\models\laya-m7.onnx

# Verified arithmetic (parameter budget, quantization table, installer table)
node %LOCALAPPDATA%\Temp\opencode\calc.mjs

# Verified installer baseline
Get-ChildItem O:\opencode-Vantrilex\apps\desktop\src-tauri\target\release\bundle\nsis | Select-Object Name, Length

# Verified that no model ships
git -C O:\opencode-Vantrilex check-ignore -v models/laya-m7-int8.onnx
```

Scratch scripts live in `%LOCALAPPDATA%\Temp\opencode\` per repo convention
(`AGENTS.md`, *Conventions that will bite*). **No file in the repository was
modified by this track.**

---

## 10. ONE-PARAGRAPH SUMMARY

Weight-only quantization of `laya-m7-int8.onnx` **cannot** reach under 15 MB.
The model has 306,942,724 weights (verified from the ONNX wire format, and the
per-layer breakdown reproduces the total with delta = 0), so 15 MB affords
**0.4099 bits per weight**; even an impossible 1-bit scheme is 36.59 MB, and
realistic 2-bit is 82.3 MB. The sub-15 MB goal is a different-model goal, not a
quantization goal. The route to laptop-sized is structural, and the structural
finding is better than expected: **three of the four heads are already
implemented as rules in shipped code** — `barge_in` by the RMS gate
(`src/voice/ingest.ts:19-42`) plus Silero VAD (`src/runtime/vad.ts`, wired at
`src/daemon.ts:494-517`) plus the renderer's `bargePolicy`
(`apps/desktop/src/audio/vad.ts:32-35`); `is_destructive` by
`requiresConfirmation` (`src/voice/brain.ts:97-103`) *behind* the far stronger
kind-based FR-12 execution gate (`src/orchestrator/command-router.ts:65,248`);
`stuck_in_loop` by the `MAX_PARKED` counter and the retry policy
(`src/orchestrator/command-router.ts:73`, `src/voice/brain.ts:113`) — a head the
model already scores 0.9923–1.0000 on. Only `should_speak` has no implementation
anywhere in `src/`, and it is the only head that justifies a model. The project
already owns the correct architecture for closing that gap: the
deterministic-then-injected-neural, fail-open `guardText` seam at
`src/knowledge/guard.ts:31-44`, whose comment at `:29` literally names
"Laya isDestructive" as the intended backend. So **Laya Lite is that pattern
applied to one head: ~1.1 MB of pure TypeScript, no ONNX runtime in the import
graph, bundled at 1.20× the installer — which also retires the v0.6.0
native-module failure class instead of defending against it.** The full model
belongs in an opt-in download (12.77× the installer) and fp32 belongs nowhere
(47.92×, for 2.4 accuracy points).
