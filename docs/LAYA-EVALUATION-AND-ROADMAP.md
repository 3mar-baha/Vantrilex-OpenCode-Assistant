# Laya Model Health, Vulnerability & Evolution Report

> **Status:** Living evaluation. **Owner:** Principal Architect + operator.
> **Subject:** Laya System-1 — 4-head multilingual speech-intent model (docs/09 ADR-008, docs/10 §10.7).
> **Artifacts:** `ml/eval_report.md`, `ml/quant_report.json`, `ml/head_metrics.json`,
> `ml/l2_report.json`, `ml/latency_compare.json`, `ml/negation_report.json`,
> `ml/data/synth_meta.json`, `ml/l2_report.json`.

This report is written to be uncomfortable. The headline metrics are high, but they are
high on a distribution the model was effectively allowed to memorise. Sections 2–3 are
the load-bearing part of this document.

---

## 1. Baseline Metrics Summary

### 1.1 Held-out test split (n=520, operating length 32 tokens)

Authoritative per-head numbers (`ml/head_metrics.json`). FP32 = reference; INT8 =
shipped artifact.

| Head | Variant | Accuracy | Precision | Recall | F1 | Mean BCE log-loss |
|------|---------|---------:|----------:|-------:|---:|------------------:|
| `should_speak` | FP32 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.0030 |
| `should_speak` | INT8 | 0.9308 | 0.9030 | 1.0000 | 0.9490 | 0.1576 |
| `is_destructive` | FP32 | 0.9673 | 0.9048 | 0.9314 | 0.9179 | 0.1475 |
| `is_destructive` | INT8 | 0.9038 | 0.7000 | 0.8922 | 0.7845 | 0.2353 |
| `barge_in` | FP32 | 0.9865 | 0.9528 | 0.9918 | 0.9719 | 0.0703 |
| `barge_in` | INT8 | 0.9481 | 0.8188 | 1.0000 | 0.9004 | 0.1461 |
| `stuck_in_loop` | FP32 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.0383 |
| `stuck_in_loop` | INT8 | 0.9923 | 0.9704 | 1.0000 | 0.9850 | 0.0702 |
| **macro** | **FP32** | **0.9885** | — | — | **0.9724** | **0.0648** |
| **macro** | **INT8** | **0.9438** | — | — | **0.9047** | **0.1523** |

Gates (docs/09 ADR-008): `should_speak`/`is_destructive` ≥ 0.90 accuracy,
`barge_in`/`stuck_in_loop` ≥ 0.85. **All heads pass on both variants.**

### 1.2 Quantization delta (INT8 − FP32, accuracy / F1 / log-loss)

| Head | Δ Accuracy | Δ F1 | Δ log-loss | Direction of risk |
|------|-----------:|-----:|-----------:|-------------------|
| `should_speak` | −0.0692 | −0.0510 | +0.1546 | precision collapse (1.0000 → 0.9030), recall pinned at 1.0 |
| `is_destructive` | −0.0635 | −0.1334 | +0.0878 | **precision 0.9048 → 0.7000** and recall −0.0392 |
| `barge_in` | −0.0384 | −0.0715 | +0.0758 | precision 0.9528 → 0.8188, recall pinned at 1.0 |
| `stuck_in_loop` | −0.0077 | −0.0150 | +0.0319 | mild |
| **macro** | **−0.0447** | **−0.0677** | **+0.0875** | — |

**Interpretation.** Dynamic INT8 shifts the decision boundary toward "positive": every
recall is 1.0000 while precision drops. That is the *safe* direction for a briefing gate
(over-cautious) but the *unsafe* direction for `is_destructive`, where recall itself fell
(0.9314 → 0.8922) — i.e. more destructive commands are missed. `is_destructive` is the
head that must not be quantized carelessly.

### 1.3 Training curve (seed 8, frozen backbone + linear heads)

`loss` is the per-epoch **sum** of per-batch mean BCE (130 batches, 4 heads); the
normalised column divides by 130 for readability.

| Epoch | Sum loss | ≈ Mean loss | Val macro-F1 |
|------:|---------:|------------:|-------------:|
| 0 | 58.870 | 0.453 | 0.8176 |
| 1 | 31.677 | 0.244 | 0.9107 |
| 2 | 23.405 | 0.180 | 0.9528 |
| 3 | 18.873 | 0.145 | 0.9382 |
| 4 | 15.964 | 0.123 | 0.9475 |
| **5** | 13.900 | 0.107 | **0.9732** (best) |
| 6 | 12.276 | 0.094 | 0.9511 |
| 7 | 11.034 | 0.085 | 0.9707 |

Train loss keeps falling while val macro-F1 plateaus/oscillates after epoch 2 — the
signature of a memorisable, low-diversity task (see §2 V2/V3).

### 1.4 Export, parity and latency

| Property | Value | Gate |
|----------|-------|------|
| ONNX parity (torch vs FP32), max logit diff | **3.24e-05** | < 1e-4 ✅ |
| FP32 size / INT8 size | 1228.4 MB / 308.1 MB | — |
| FP32 latency @32 | p50 **57.58 ms**, p99 77.15 ms | < 40 ms ❌ |
| INT8 latency @32 | p50 **25.84 ms** (gate run) / 28.83 ms (re-measure) | < 40 ms ✅ |
| INT8 latency @64 | p50 40.80 ms | — |
| INT8 latency @128 | p50 66.40 ms | — |
| Corpus token length | max 35, p99 32 | operating length = 32 |

FP32 **cannot** meet the 40 ms budget on this CPU; INT8 is load-bearing, which is exactly
why its accuracy cost must be managed rather than waived.

---

## 2. Identified Vulnerabilities & Edge Cases

### V1 — The model is a lexical marker detector, not an intent classifier (critical)

Training labels are injected by marker presence: every `is_destructive=true` sample is
guaranteed to contain one of `["امسح", "احذف", "دمر", "ديبلوي", "force-push", "rm -rf", "drop"]`
(`ml/data/generate_synth.py` L51, L100). The head therefore learns *the marker*, not the
*act*. Consequence: it generalises to marker surface, not meaning.

### V2 — Train/test leakage inflates every headline metric (critical)

`ROUTINE_FRAMES` is a **5-string list** and `AMMANI_FRAMES × TECH_TASKS × RESULTS` is a
small combinatorial space. The split is a random shuffle (`generate_synth.py` L140–153),
so identical and near-identical strings appear in **both** train and test. `should_speak`
= 1.0000 is a memorisation artifact: the model has seen those exact strings. Treat §1.1
as an upper bound, not an estimate of field performance.

### V3 — `should_speak` is near-deterministic from the other labels (label leakage)

`should_speak = True`, then set `False` only when `roll < 0.25 and not (destructive or
barge or loop)` — using the *same* `roll` that drives the other three heads
(`generate_synth.py` L87–108). The four labels are therefore functionally coupled; the
model can recover `should_speak` from the other heads' surface cues. A perfect score here
carries almost no information.

### V4 — Semantically wrong markers cause systematic false positives

`"ديبلوي"` (deploy) is listed as a destructive marker, but deploy is a normal release
action. It also appears in `TECH_TASKS`, so the label is internally contradictory. The
probe confirms the model learned the ambiguity, not the rule:
`"ما تعمل ديبلوي"` → 0.305 FP32 / 0.190 INT8 (not flagged), i.e. the "marker" is not
reliably treated as destructive — the head has no coherent rule for it.

### V5 — `stuck_in_loop` marker hygiene is broken

The de-noising branch appends `"، وبعدنا بنحاول"` (`generate_synth.py` L104–105), but that
phrase is **not** in `LOOP_MARKERS = ["المحاولة", "لسّاني شغال", "ريتراي"]`. So
`stuck_in_loop=true` labels exist with no declared marker — the same markerless-positive
noise class that previously capped `is_destructive`. `stuck_in_loop`'s 1.0000 is therefore
partly the model keying on the injected suffix, not on loop semantics.

### V6 — Negation is not understood (critical, safety-relevant)

Measured on negated destructive commands (`ml/negation_report.json`, INT8@32):

| Utterance | Meaning | FP32 `is_destructive` | INT8 `is_destructive` | Verdict |
|-----------|---------|----------------------:|----------------------:|---------|
| `ما تمسح شي` | don't erase anything | 0.134 | 0.092 | correct |
| `لا تحذف الداتابيز` | do not delete the database | **0.935** | **0.583** | **false positive** |
| `ما تعمل ديبلوي` | don't deploy | 0.305 | 0.190 | correct-ish |
| `مش وقتها force-push` | not the time to force-push | **0.772** | **0.877** | **false positive** |
| `لا تسوي drop للجدول` | don't drop the table | **0.575** | **0.727** | **false positive** |
| `اسمع، لا تمسح شي` | listen, don't erase | 0.264 | 0.430 | borderline |

3 of 6 negated commands fire. The marker survives negation. This is the *safe* failure
direction (over-caution → unnecessary FR-12 confirmation), but it erodes trust and it is
the mirror image of the dangerous direction: an **affirmative** destructive command using
a synonym outside the marker set (e.g. `فرمت`, `اطفي`, `نظّف`) is a likely **false
negative**.

### V7 — Out-of-distribution phrasing defeats an in-vocabulary marker

`"امسح الداتابيز كلها"` contains the marker `امسح` yet scores **0.193 (FP32)** /
**0.370 (INT8@32)** / 0.614 (INT8@128). The marker is present; the frame around it is not.
This is the concrete proof of V1.

### V8 — Imperative-verb confusability (`اسمع` / `امسح` and friends)

The requested edge case: `"اسمع"` (listen) is **not** in any marker set, so the head has
no explicit signal for it. It shares the Arabic imperative morphology and a leading
`ا…م` shape with `"امسح"`. A marker-driven model that over-fits the `امـ` prefix risks
confusing the two. The probe shows `"اسمع، لا تمسح شي"` at 0.264/0.430 — not currently a
false positive, but the mechanism (surface-form generalisation) that would cause one is
present and untested against a real confusable set. **Recommendation:** add a
counterfactual confusable suite (`اسمع`/`امسح`, `وقف`/`وقّف`, `احذف`/`احتفظ`) as a gate.

### V9 — Truncation at the operating length

The corpus max is 35 tokens but the operating length is 32 (p99). ~1% of utterances are
truncated at the tail, which can drop a trailing marker or negation. Acceptable for an
advisory gate; must be revisited if utterances lengthen.

### V10 — No acoustic or ASR realism

All data is text. There is no ASR-error augmentation, no disfluency, no partial words, no
speaker variation. The runtime receives STT output (docs/18), so the model is evaluated on
a distribution that is *cleaner* than production.

### V11 — `is_destructive` false negatives are silent and unmonitored

There is no runtime telemetry for "destructive head said no". A miss is invisible until a
downstream incident. FR-12 remains the hard backstop (ADR-006 boundary 2), which is why
advisory-only is the correct contract — but the miss rate is not currently observable.

---

## 3. Data Gap Analysis

Current corpus: 5,200 synthetic rows, seed 8, splits 4160/520/520
(`ml/data/synth_meta.json`). Balance: `should_speak` 61.5/38.5, `is_destructive`
21.4/78.6, `barge_in` 22.8/77.2, `stuck_in_loop` 24.6/75.4. It is a **template corpus
with injected markers**, not a sample of real Ammani speech.

| Gap | Why it matters | Concrete need |
|-----|----------------|---------------|
| **Template diversity** | V2 leakage; near-duplicate strings across splits | ≥ 50× more distinct frames; split **by template/frame**, not by row |
| **Marker-free positives** | V1; the head never learns semantics | Destructive intent expressed without any marker (e.g. paraphrases of "wipe the prod table") |
| **Negation & modality** | V6 | `لا/ما/مش/مو` + marker; conditional and hypothetical ("لو حذفت…") |
| **Hard negatives** | V4 | Benign sentences containing marker substrings: "امسح الـ cache لو سمحت بس مو الداتابيز", deploy announcements, "drop" in prose |
| **Levantine colloquial breadth** | Model is Ammani-narrow | Jordanian/Palestinian/Lebanese/Syrian phrasing, regional synonyms, idioms |
| **System-control intents** | The product routes commands, not just flags | affirmative/negative imperative pairs for deploy, rollback, restart, kill, wipe, pause, resume |
| **Real ASR noise** | V10 | STT hypotheses with errors/disfluencies paired with the clean intent label |
| **Barge-in realism** | `barge_in` is marker-only | Mid-utterance interruptions, overlapping speech transcripts, hesitation |
| **Loop realism** | V5 | Genuine repeated-failure transcripts, not a fixed suffix |
| **Code-switching beyond tech** | Current mix is Ammani + a fixed English tech vocabulary | Arabic↔English within a clause, transliteration variants (e.g. `ديبلوي/deploy/دِبلوي`) |
| **Calibration data** | INT8 boundary shift (V6/§1.2) | A rolling labelled sample to recalibrate thresholds per variant |

---

## 4. Recommended Repositories & Datasets

> Availability, size and licence must be verified before ingestion; treat sizes as
> indicative. Prefer datasets with explicit dialect tags (Jordanian/Levantine) and
> permissive licences. Where a licence is unclear, use for evaluation only, not training.

### 4.1 Jordanian / Levantine dialect corpora

| Dataset / source | Domain | Notes |
|------------------|--------|-------|
| **JODA** (Jordanian Arabic Dataset) | General Jordanian | The originally targeted corpus for this milestone; confirm current Hub availability |
| **`KareemBb/Jordanian-Dialect-Instruct-QA`** (HuggingFace) | Jordanian instruction/QA | Already harvested as fallback (1,685 rows); expand and re-filter |
| **MADAR** (Multi-Arabic Dialect Applications & Resources) | 25 city dialects incl. **Amman** | City-level dialect sentences — directly relevant |
| **PADIC** (Parallel Arabic Dialect Corpus) | 5 dialects incl. Palestinian/Jordanian | Parallel across dialects; good for normalisation tests |
| **Curras** | Palestinian Arabic | Levantine neighbour; useful for transfer |
| **NADI** (Nuanced Arabic Dialect Identification) shared-task data | 100+ dialects incl. Jordanian | Dialect-tagged; good for dialect-aware hard negatives |
| **QADI** (Qatar Arabic Dialect) | Gulf | Control/diversity (not Levantine) |
| **ArSarcasm / ArSarcasm-v2** | Dialectal sentiment & sarcasm | Sarcasm is a real adversarial case for `should_speak` |
| **SHAMI / Levantine corpora** | Levantine social | Verify licence; good for colloquial phrasing |
| **DialectBench** | Dialect evaluation suite | Evaluation, not training |

### 4.2 Intent / command-routing corpora

| Dataset / source | Domain | Notes |
|------------------|--------|-------|
| **MASSIVE** (Amazon) | 51 languages incl. **Arabic**, ~60 intents, smart-speaker/assistant | Closest public analogue to command routing; **ar** is Gulf-leaning, so use for intent *structure* + negated commands, not dialect coverage |
| **MultiATIS++** | Multilingual NLU incl. Arabic (intent + slots) | Air-travel domain; strong for affirmative/negative intent pairs |
| **Arabic-ATIS** | Arabic ATIS | Classic NLU baseline |
| **CLINC150 / Banking77** | English intent | Not Arabic — use only after expert translation to build system-control intent pairs |
| **Snips NLU** | Multilingual intent | Arabic coverage limited; use as a schema reference |

### 4.3 Backbones & tooling for the next round

- **Encoders for distillation:** MARBERT, Arabic-BERT (AUB), AraBERT, CAMeLBERT, XLM-R —
  candidate students for §5.2.
- **Normalisation / dialect tooling:** CAMeL Tools (dialect ID, normalisation), Farasa,
  PyArabic — for preprocessing and for building dialect-aware hard negatives.
- **Synthetic generation:** an instruction LLM for paraphrase + counterfactual generation
  (§5.3), with mandatory human review of a sampled fraction.

---

## 5. Architectural Next Steps

Prioritised. P0 items are prerequisites for trusting any future number.

### P0 — Make the evaluation honest before making the model better

1. **Group-aware splits (fixes V2).** Split by frame/template hash so no template family
   crosses train/test. Re-publish §1.1 on the new split; expect materially lower numbers.
2. **De-correlate labels (fixes V3).** Sample each head's label independently; stop
   deriving `should_speak` from the same `roll`.
3. **Repair the marker set (fixes V4/V5).** Remove `ديبلوي` from destructive (or make
   deploy-vs-delete a separate intent); add the missing loop marker or drop the injected
   suffix; assert marker hygiene in a data unit test.
4. **Add an adversarial gold set (fixes V6/V7/V8).** Hand-curated: negations, synonyms
   outside the marker set, confusables (`اسمع`/`امسح`), OOD phrasing. Wire it as a release
   gate alongside `ml/eval_report.md`.

### P1 — Fix the quantized head that matters

5. **Static QDQ quantization with calibration** for `is_destructive` (or per-channel
   weights), targeting recall ≥ FP32. Dynamic INT8 cost it 3.9 points of recall.
6. **Dual-threshold policy (fixes V6/V11).** Keep INT8 for `should_speak`/`barge_in`/
   `stuck_in_loop`; for destructive, run FP32 on the rare high-stakes path or require
   FR-12 confirmation whenever INT8 scores in an ambiguous band (e.g. 0.3–0.7).
7. **Threshold recalibration per variant.** Fit per-head operating points on a held-out
   calibration set separately for FP32 and INT8; the boundary shift is systematic.

### P2 — Model evolution

8. **Distillation to a small multilingual student** (20–60M params). The 322M teacher
   cannot meet 40 ms in FP32; a distilled student could meet it in FP32 *and* quantize
   more gracefully. Train with the 4 heads as auxiliary tasks.
9. **Synthetic data generation at scale (fixes V1/V6/V10).** LLM-driven paraphrase +
   counterfactual negation + ASR-error augmentation, with human review; target the §3 gap
   table explicitly. Track provenance per row.
10. **Continual calibration & drift monitoring.** Rolling labelled sample; monitor per-head
    precision/recall and score distributions; alert on drift. Log destructive-head
    decisions (counts and bands, never raw transcripts beyond the ledger contract) so
    false negatives become observable (V11).

### P3 — Runtime & integration hardening

11. **Confidence-gated batching** for concurrent sessions; keep the per-decision budget
    measured (extend `ml/latency_compare.py` to CI).
12. **Graph-level tuning.** Revisit ORT optimisation, thread pinning, and short-sequence
    padding policy as new ONNX opset/EPs land.
13. **Feed real STT transcripts** (docs/18) into the calibration loop once the voice
    pipeline runs in earnest — the text-only evaluation (V10) is the largest untested gap.

---

## 6. Reproduction

```bash
# Data (seed 8)
.venv/Scripts/python ml/data/generate_synth.py --count 5200 --seed 8 --out ml/data

# L1 train (CPU-only; asserts cuda unavailable)
HF_HOME=O:/opencode-Vantrilex/.hf_cache .venv/Scripts/python ml/train_laya.py

# L2 export (FP32 + INT8, remapped backbone, dynamic batch+seq)
.venv/Scripts/python ml/export_onnx.py

# L2 parity + latency gate
.venv/Scripts/python ml/finalize_l2.py

# This report's evidence
.venv/Scripts/python ml/head_metrics.py       # per-head acc/P/R/F1/logloss, FP32 vs INT8
.venv/Scripts/python ml/eval_onnx.py          # gates at len 32 and 128
.venv/Scripts/python ml/latency_compare.py    # FP32 vs INT8 latency
.venv/Scripts/python ml/negation_probe.py     # negation false positives
.venv/Scripts/python ml/gen_tokenizer_golden.py

# L3 live integration (tokenizer parity + latency + class separation)
LAYA_LIVE=1 npx vitest run src/runtime/laya/laya.integration.test.ts
```

---

## 7. Provenance

- Model: `convaiinnovations/laya-multilingual` (322M mmBERT backbone, frozen) + 4 linear
  heads, trained CPU-only on 5,200 synthetic Ammani SE samples (seed 8).
- Artifacts: FP32 1228.4 MB, INT8 308.1 MB under gitignored `models/`.
- Decision record: docs/09 **ADR-008**. Milestone ledger: docs/10 **§10.7**.
- Evidence files are tracked: `ml/head_metrics.json`, `ml/quant_report.json`,
  `ml/l2_report.json`, `ml/latency_compare.json`, `ml/negation_report.json`,
  `ml/eval_report.md`, `ml/data/synth_meta.json`.

*End of LAYA-EVALUATION-AND-ROADMAP.md.*