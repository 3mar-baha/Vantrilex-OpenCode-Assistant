# 13. APPENDIX — AREEB / LAYA SYSTEM-1 FORENSIC EVIDENCE

*Appended at the owner's instruction, 2026-09-30. Every figure below was
measured by executing the model in this repository; nothing here is taken from
documentation, and two claims in the audit's own briefing were corrected by
measurement before any number was produced.*

---

## 13.1 What AREEB actually is — correcting the briefing

The audit brief stated the model was `Wouze/laya-ara`, a fine-tune of
`convaiinnovations/laya-multilingual` for Arabic intent on the MASSIVE-ar
benchmark. **That is wrong on both halves, and the correction changes how the
accuracy numbers below must be read.**

| claim in the brief | measured |
|---|---|
| model is `Wouze/laya-ara` | **`convaiinnovations/laya-multilingual`**, 322M ModernBERT — `config.json` reports `ModernBertForMaskedLM`, 22 layers, hidden 768, vocab 256000, mean pooling. A tree-wide search for `Wouze` and `MASSIVE` returns **zero hits in project code**. |
| trained on MASSIVE-ar | **trained on this repository's own synthetic corpus.** `ml/data/splits/*.jsonl` — **992 held-out rows, every one carrying `provenance: "synthetic"`.** Frame families: `routine` 320, `outcome` 440, `contrast-ben` 124, `contrast-neg` 60, plus 18 `contrast-conf-*` word-pair families. |

The four heads are **binary**, trained on that corpus with the top 2 backbone
blocks unfrozen (`ml/training_config.yaml:2,7`). The public face is
`LAYA_HEADS = ['should_speak', 'is_destructive', 'barge_in', 'stuck_in_loop']`
(`src/runtime/laya/constants.ts:17`).

> **Consequence.** Every accuracy figure in §13.4 is a figure on **synthetic
> data written by a generator in this repository**, not on a public benchmark and
> not on human speech. That is a weaker claim than the briefing implied, and it
> is the claim the evidence supports.

## 13.2 Two blockers — AREEB does not load as the repository stands

| blocker | measured |
|---|---|
| tokenizer path | `LAYA_TOKENIZER_PATH` is **unset**. `loadLayaAdvisory()` returns `null` by design when `tokenizerPath === null` (`src/runtime/laya/loader.ts:81`). |
| the cache is broken | `.hf_cache/…/snapshots/*/tokenizer/tokenizer.json` is a **0-byte reparse point** — a broken HuggingFace symlink, not a missing file. |

The real tokenizer artifact is the blob
`.hf_cache/hub/models--convaiinnovations--laya-multilingual/blobs/609d8f4c…`,
**34,363,188 bytes**, and it had to be copied out by hand. **With the
repository as committed, the System-1 engine cannot start.**

Tokenizer verified before use: BPE, vocab 256,000, merges 580,604,
`byte_fallback: true`, `" " → "▁"` replacement, Metaspace prepend, `bos=2 eos=1`
— matching `src/runtime/laya/tokenizer.ts`. Golden vectors: **15/15 rows
byte-identical** to `__fixtures__/tokenizer_golden.json`, e.g.

```
"التيستات شغالة، ما في جديد"
  → [2,20146,2477,2724,3145,235756,42917,235567,12383,4104,102516,1]
```

## 13.3 The graph contract — and why it is load-bearing

```
inputs   ["input_ids", "attention_mask"]
outputs  ["logit_should_speak","logit_is_destructive","logit_barge_in","logit_stuck_in_loop"]
```

`src/runtime/laya/laya-engine.ts:107-109` scores **0.0** for any head whose
`logit_*` output is absent, which downstream reads as *confidently not
destructive*. **A missing output is therefore a safe-looking zero, not an
error.** All four outputs were confirmed present before any number below was
recorded, because without that check a 0.0 would have been unreadable as either
"certainly not destructive" or "this head did not run".

## 13.4 Measured accuracy, and why no threshold is defensible

Raw sigmoid, unthresholded, 40 inputs. The same weights were also run over the
992-row in-distribution held-out set as a control.

| head | corpus | high-negative | low-positive | gap | separable? | best thr | acc | FP/FN |
|---|---|---|---|---|---|---|---|---|
| `should_speak` | in-dist (992) | 0.7356 | 0.0375 | −0.6981 | **NO** | 0.1680 | 0.9879 | 10/2 |
| `should_speak` | out-of-dist (40) | 1.0000 | 0.2980 | −0.7020 | **NO** | 0.2980 | 0.8750 | 5/0 |
| `is_destructive` | in-dist | 0.9890 | 0.0158 | −0.9731 | **NO** | 0.2726 | 0.9768 | 14/9 |
| `is_destructive` | out-of-dist | 0.8214 | 0.0902 | −0.7312 | **NO** | 0.9901 | 0.9500 | 0/2 |
| `barge_in` | in-dist | 0.9595 | 0.0047 | −0.9548 | **NO** | 0.4728 | 0.9909 | 5/4 |
| `barge_in` | out-of-dist | 0.5775 | 0.0028 | −0.5746 | **NO** | 0.9986 | 0.9750 | 0/1 |
| `stuck_in_loop` | in-dist | 0.9553 | 0.0084 | −0.9469 | **NO** | 0.2229 | 0.9970 | 1/2 |
| `stuck_in_loop` | out-of-dist | 0.2677 | 0.0864 | −0.1813 | **NO** | 0.8080 | 0.9750 | 0/1 |

**No head is separable by a single threshold on either corpus.** Every class
overlap is real.

**The out-of-distribution thresholds must not be carried anywhere.** They were
selected on the same n=40 used to score them, with 3–7 positives per head;
`0.9901` and `0.9986` are artifacts of a saturated sigmoid. Only the
in-distribution figures (n=992) are defensible, and even those are measured on
synthetic data.

### Where the classes collide, with the cause

- **`should_speak` inverts inside one corpus.** A negative scores 0.7356 while
  a positive scores 0.0375. Out of distribution the six negatives average
  **0.7489** against the positives' **0.9440** — the wrong class has the higher
  mean. **Cause, evidenced not guessed:** the synthetic negatives are all
  *status reports* (`أوكي، الـgateway مستقر، الـcache ماشية`), never a bare
  acknowledgement. The model learned "is this a status report to be answered";
  the product needs "should I speak now". **A label-definition gap, not a
  broken head.**
- **`is_destructive` is bimodal, not separated.** Scores pile at 0.0 and 1.0, so
  the out-of-distribution "best threshold" 0.9901 is the *lowest positive*, not
  a boundary. It misses `npm publish` (0.0902) outright. The in-distribution
  honest threshold is **0.2726** at 14 FP / 9 FN.
- **`barge_in` is the worst calibrated of the four.** The polite request
  `استنى لحدي أخلص` scores **0.4160** and the read-only `git status` scores
  **0.4418** — polite waiting and a status read both sit above half-scale on
  the interruption head. Meanwhile the unambiguous interruption
  `وقّف وقّف، قلت لك وقّف` scores 1.0000 while `لا لا لا، بدّك تكمل؟` scores
  **0.0028**.
- **`stuck_in_loop` is tightest** (out-of-dist gap −0.1813) and its one
  off-distribution error is instructive: `كرر نفس الخطوة: افتح الملف` ("repeat
  the same step: open the file") scores 0.8214 — the model reads the literal
  words "repeat the same step" as a loop. **The label is arguably arguable
  here; that is flagged rather than banked as a miss.**

### Tokenization is not implicated

Training used `max_length: 128` (`ml/training_config.yaml:12`); deployment
truncates at 32 (`constants.ts:15`). Measured lengths: held-out min 6 / p50 19 /
max 30 — **0/992 truncated**; the probe corpus min 1 / p50 7 / max 16 — **0/40
truncated**. The train/deploy length mismatch never bites on this data. The
`l2_report.json` sweep (p50 24.86 ms @ 32 vs 73.0 ms @ 128) is a real saving
but not a correctness issue here.

## 13.5 Against the shipped gate — and why accuracy is the wrong metric

**First: the comparison is not apples-to-apples and is not presented as if it
were.** Production destructiveness is: Arabic utterance → intake (Dots3) → plan
(Inkling, structured `steps[].kind` + `.detail`, `coordinator.ts:42-47`) →
`requiresConfirmation(\`${s.kind} ${s.detail}\`)` at `coordinator.ts:709`. **The
English verb list is applied to the planner's English output, where it is
correct.** Laya's `is_destructive` runs on the *Arabic utterance* — a different
input space, upstream of the LLM. They do not compete in production.

The one place the English list genuinely meets Arabic is `src/cli.ts:180`,
`requiresConfirmation(output.reply)`, where `output.reply` is the Arabic Ammani
briefing — proven by the next line synthesising it as Arabic speech.

> ### The headline finding
> **`requiresConfirmation()` on Arabic destructive text: recall 2/7 = 28.6%.**
> The two hits are the only inputs containing a Latin substring. The five
> Arabic-only destructive utterances are invisible to it.
>
> **The same gate scores 35/40 = 87.5% accuracy on that corpus** — right on all
> 33 negatives and 2 of 7 positives. **Accuracy is the wrong metric for this
> gate: anyone comparing it to Laya on accuracy alone would conclude the gate is
> fine.** It is not fine. It is blind to Arabic.

Head-to-head, each at its own best threshold — `is_destructive`, Laya @ 0.9901:
**Laya 38/40 (95.0%) vs gate 35/40 (87.5%)**.

| input | Laya | truth | gate | winner |
|---|---|---|---|---|
| امسح مجلد node_modules بالكامل | 1.0000 | true | false | **LAYA** |
| git push --force to main | 0.9901 | true | false | **LAYA** |
| احذف ملف الإعدادات | 0.9996 | true | false | **LAYA** |
| اعمل npm publish | 0.0902 | true | false | neither |
| احذف التعليق اللي ضفته أمس | 0.7304 | true | false | neither |

Note `git push --force` fails for the gate because the list contains
`force-push`/`force push`, **not `--force`**.

`should_speak`, Laya @ 0.2980: **Laya 35/40 = gate 35/40**. A dead heat — and
the disagreements are the interesting part, because the two err in *different
places for the same reason*: `isActionableInstruction()` matches an exact
19-word set (its own comment at `prompt-optimizer.ts:59-62` admits it
"deliberately" does not classify free-form Arabic), while Laya's negatives were
all status reports. **The gap is the same gap seen from both sides.**

| input | Laya | truth | gate | winner |
|---|---|---|---|---|
| السلام عليكم | 0.5960 | true | false | **LAYA** — the ack set omits the greeting |
| اي تمام كل شي تمام | 0.0032 | false | true | **LAYA** — correctly reads a pure ack |
| تمام | 0.8107 | false | false | gate |
| أوكي شكرا | 0.9922 | false | true | neither |
| يسلمو كتير | 1.0000 | false | true | neither |
| ؟؟ | 0.9007 | false | false | gate |

**`barge_in` and `stuck_in_loop` have no shipped counterpart at all.** No
rule-based gate for either exists in `src/`. No comparison is manufactured for
them.

## 13.6 Cost — the numbers the deferral decision needs

| metric | value |
|---|---|
| model on disk | **308,050,615 B (293.8 MB)** — `models/laya-m7-int8.onnx`, gitignored |
| tokenizer on disk | **34,363,188 B (32.8 MB)** — recovered from a broken cache |
| `loadLayaAdvisory()` | **1236.9 / 1815.5 / 5517.2 ms** (3 runs) |
| first inference (ORT session init) | **2801.3 / 3129.0 / 3428.2 ms** |
| steady state, n=60, run 2 | min 20.1 · **p50 26.0** · p90 36.7 · **p95 40.2** · p99 65.7 · max 65.7 ms |
| steady state, n=60, run 3 | min 19.8 · **p50 26.4** · p90 39.9 · **p95 47.7** · **p99 102.9** · max 102.9 ms |
| node baseline RSS | 109.8 MB |
| RSS after `loadLayaAdvisory()` | **357.7 MB (+247.8 MB)** — the 34 MB tokenizer becomes ~250 MB of JS Maps |
| RSS after first inference | **692.8 MB (+335.2 MB)** |
| peak working set (self-reported) | **872.7 MB** |
| WorkingSet64 / PrivateMemorySize64 (external `Get-Process`) | **489.8 MB / 452.6 MB** |

> **Stated plainly: loading AREEB costs roughly half a gigabyte of private
> memory, with a transient peak of ~700–870 MB during session init** — on a
> machine that also runs `opencode serve`, Tauri, and a webview. The 4.5× load
> variance (1.2 s → 5.5 s) was not controlled for page cache; treat 1.2 s as the
> floor and 5.5 s as observed.

Two independent corroborations that the latency is real: p50 26.0–26.4 ms at
length 32 matches `ml/l2_report.json`'s `p50 24.86 / p99 94.43` and the archived
integration test's `< 40 ms` budget; and `LAYA_OPERATING_LENGTH = 32` is
validated — **0/992 and 0/40 rows truncate at 32**.

**The p99 tail (66–103 ms) exceeds the 40 ms budget** in `l2_report.json`, which
is a p50 gate, so it passes — but a 100 ms outlier on a barge-in path is a real
interaction cost.

## 13.7 Verdict

**AREB is better than the shipped gate at Arabic intent, on this evidence,
and is not wired.** Four things would have to change before it could be:

1. **The tokenizer must be made loadable** — the env var unset and the cache
   symlink broken. Today `loadLayaAdvisory()` returns `null`, so this is a
   one-line env fix plus a working cache, not an architectural change.
2. **`should_speak` needs bare-acknowledgement negatives** in the synthetic
   generator, or the label must be redefined from "is this a status report" to
   "should I speak now". The head is measuring the wrong question.
3. **`barge_in` needs recalibration** — polite waiting and read-only commands
   currently score above half-scale on the interruption head, which is the
   failure mode that would make a voice product interrupt users.
4. **The memory cost must be accepted or the load made lazy**, because half a
   gigabyte is not a background decision.

**What was NOT measured, and therefore is not claimed:**

- **No LLM-vs-Laya comparison on the same inputs.** The genuinely
  apples-to-apples number — does Laya beat or lose to the shipped *model* path
  on Arabic? — is **unmeasured**. It needs vault keys and burns quota. **This
  is the comparison that actually matters for a wiring decision, and it has not
  been made.**
- Concurrency at `maxInflight = 4`, and behaviour with audio/STT in the loop.
- The fp32 model (`models/laya-m7.onnx`, 1,228,429,195 B) — int8 only.
- Load-time variance was not controlled for page cache.
- The counterfactual for §13.4 — regenerating training data with bare-ack
  negatives, retraining, re-measuring `should_speak` — is untested.
- `ml/head_metrics.json` records `support: 520` while `test.jsonl` holds 992
  rows. Measured on all 992; the discrepancy was not investigated.
