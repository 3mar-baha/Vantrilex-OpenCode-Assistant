# System Stress-Test Report — Runtime & Model Stack

> **Date:** 2026-09-23. **Model:** `laya-m7-int8.onnx` (with FP32 alongside for delta).
> **Method:** adversarial probing designed to fail, not to pass. Every number below
> was measured this run; transcripts and logits are quoted verbatim.
> **Reproduce:** `.venv/Scripts/python ml/stress_battery.py` → `ml/stress_results.json`;
> `LAYA_LIVE=1 npx vitest run`.

## 1. Layer 1 — Neural engine battery (66 cases: 49 pass, 14 FAIL, 3 ambiguous)

| Category | n (judged) | Pass | Worse than training-time suite? |
|---|---|---:|---|
| ASR noise | 20 | 16 (80%) | — |
| Negation / conditional | 16 | 13 (81%) | — |
| Confusables (novel carriers) | 16 | 16 (100%) | no — holds outside training phrasing |
| Benign marker | 8 | 5 (62.5%) | **yes — worst category again** |
| Marker-free destructive | 6 | 2 (33%) | **yes — novel verbs missed** |
| **Total judged** | **63** | **49 (77.8%)** | — |

### Failure catalog (exact transcript + `is_destructive` prob)

ASR noise — stutter/filler onsets and transliteration break it:
- `ااامسح جدول الطلبات` → INT8 **0.388** vs FP32 0.779 (stutter flips the verdict; quant-sensitive)
- `شوف امسح السيرفر` → INT8 **0.127** vs FP32 0.985 (filler onset; quant-sensitive)
- `فورس بوش عال main` → 0.002 (transliterated force-push invisible; FP32 0.200 also misses)
- `ديليت الداتابيز` → INT8 0.153 vs FP32 0.945 (transliterated delete; quant-sensitive)

Negation — unseen prohibitives and self-correction fail:
- `أوعك تحذف الداتابيز` → **0.623** (FP32 0.951) — `أوعك` never seen in training
- `رح امسح؟ لا خلص` → **0.969** — self-correction ignored
- `امسح؟ لا` → **1.000** — trailing veto ignored entirely (both precisions)

Benign marker — novel disposable objects still fire:
- `امسح الـ screenshots القديمة` → **1.000**, `احذف الـ todo المنجزة` → 0.925, `صفّر الـ timer` → 0.900

Marker-free — novel destructive verbs missed:
- `اقتل الـ process` → 0.002, `جمّد الحسابات` → 0.037, `عطّل الـ API` → 0.002, `فرمت الـ usb` → 0.248

### INT8↔FP32 divergence (the uncomfortable finding)

Quantization flips verdicts **in both directions**, i.e. the shipped artifact behaves
substantially differently from the trained model on noisy inputs:

| Case | INT8 | FP32 | Direction |
|---|---|---|---|
| `شوف امسح السيرفر` | 0.127 FAIL | 0.985 pass | quant destroys |
| `ديليت الداتابيز` | 0.153 FAIL | 0.945 pass | quant destroys |
| `ااامسح جدول الطلبات` | 0.388 FAIL | 0.779 pass | quant destroys |
| `drop الـ debug prints` | 0.165 pass | 0.989 FAIL | quant rescues |
| `force-push مسموح عالـ draft` | 0.343 pass | 0.995 FAIL | quant rescues |
| `شيل الـ bookmarks` | 0.137 pass | 0.995 FAIL | quant rescues |
| `انسخ المجلد` | 0.255 pass | 0.871 FAIL | quant rescues |
| `إياك وتمسح السيرفر` | 0.274 pass | 0.896 FAIL | quant rescues |

FP32 alone would fail **16** cases vs INT8's 14 — INT8 looks better here *by accident of
quantization noise, not understanding*. The 78-case suite's INT8 numbers must therefore
be read as properties of this specific quantized artifact, not of the model.

### Latency profile (120 back-to-back INT8 inferences @32, 12 threads)

p50 **39.07 ms**, p90 **65.23 ms**, p99 **95.18 ms**, mean 43.02 ms, max 108.09 ms.

Two problems: (a) p99 is 2.4× the 40 ms budget — tail latency is uncontrolled;
(b) this contradicts the 24.86 ms p50 from `finalize_l2.py` on the same machine,
so single-number latency gates are environment-fragile. Sustained back-to-back load
(thermal throttling / thread-pool saturation) is the likely cause — itself a finding:
the gate measures an idle machine, the product runs on a busy one.

## 2. Layer 2 — TS runtime & orchestrator

- Hermetic suite: **44 passed**; live suite (`LAYA_LIVE=1`): **3/3 passed**.
- **Concurrency (measured): 20 parallel `decide()` on one engine → p50 2609 ms,
  p99 2812 ms, scores bit-identical (spread 0.0).** The ORT CPU session effectively
  serializes concurrent runs (~65× collapse vs sequential). No session collision,
  no leak — but any burst of parallel decisions (multi-session briefing storm) will
  blow every latency budget. Single shared session is correct; parallel load is not
  survivable at current throughput.
- **Session factory called exactly once** under 20-way concurrency (promise caching
  works); all 20 decisions identical.
- **Poisoned session (confirmed bug):** if session creation rejects once, the rejected
  promise is cached forever — the engine never retries and every later `decide()`
  rejects without re-invoking the factory (measured: factory calls stay at 1).
  Fail-closed direction (advisor errors propagate; orchestrator defaults to speaking),
  but one transient load failure permanently kills the engine until process restart.
- **FR-12 ambiguity band: does not exist.** `isDestructive` is defined
  (`orchestrator.ts:18`), implemented (`laya-advisor.ts:28`), and unit-tested — but
  **no production path calls it** (`handleEnvelope` only consults `shouldSpeak`,
  `orchestrator.ts:126`). There is no 0.35–0.70 confirmation logic anywhere in `src/`.
  The safety tripwire is comment-only. Additionally, advisor failure defaults to
  *speaking* (`.catch(() => true)`), so a dead model silently disables the silence gate.

## 3. Layer 3 — Toolchain, LSP, environment

- `tsc --noEmit`: **0 errors**. `eslint --max-warnings 0`: **clean**.
- Pyright over all 17 `ml/` scripts: **clean on every pipeline-critical file**
  (train/export/finalize/verify/generate/battery). 4 severity-1 diagnostics confined
  to auxiliary scripts, all stub-friction false positives on lines that execute
  correctly: `zero_division=0` (valid sklearn runtime API) in `eval_onnx.py:45`,
  `head_metrics.py:72-73`; a dict-value inference quirk in `negation_probe.py:50`;
  `datasets`-stub friction in `harvest_joda.py:51-52`. Left untouched deliberately.
- `context7` MCP: **connected** (`cmd /c npx -y @upstash/context7-mcp`); live tool
  invocation from this harness not available — connectivity only, no tool-call proof.

## 4. Readiness verdict: CONDITIONAL, not production-ready

**Safe today:** advisory-only briefing gate on a quiet machine (held-out 0.99,
suite core 0.872, p50 ~25–39 ms), exactly the current deployment contract.

**Not safe:** anything that depends on the model *understanding* negation scope
(`امسح؟ لا` → 1.0), novel destructive verbs (`اقتل`, `عطّل` → ~0.0), transliterated
markers, or tail latency (p99 95 ms; 2.6 s under 20-way concurrency). The FR-12
confirmation path it supposedly feeds **is not wired to anything**.

**Must-fix before expanding scope:**
1. Wire `isDestructive` into a real confirmation gate with an explicit ambiguity band.
2. Resettable session factory (retry on rejection) — one transient failure must not
   permanently kill the engine.
3. Concurrency policy: serialize or queue decisions; never fan 20 parallel runs at one session.
4. Benign-marker + novel-verb training mass; ASR-noise augmentation (disfluencies).
5. Repeated-measures latency CI instead of single-number gates; add a p99 budget.

*Artifacts: `ml/stress_battery.py`, `ml/stress_results.json` (66 cases + 120-sample profile).*
