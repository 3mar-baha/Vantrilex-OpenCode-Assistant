# Laya Final Synthesis & Future Roadmap — P0 Remediation Close-Out

> **Status:** Accepted 2026-09-23. **Scope:** everything from the honest baseline
> failure (`fc30fa0`) through the verified P0 close (`17abae6` lineage → present).
> **Companion tracker:** `ml/MISSION_P0_WORKFLOW.md` — delete at sign-off (this report
> is its permanent successor).

## 1. Chronological post-mortem

| Step | What happened | Evidence |
|---|---|---|
| 40-template baseline | Held-out looked strong on a leaked split; adversarial OOD regressed (negation FP 0.500, confusable 0.375) — marker-shortcut learning | `fc30fa0`, `ml/adversarial_report.json` (superseded) |
| Phase 1 diagnosis | Shortcut proved mathematically: Arabic markers at `P(destructive\|marker)=1.000`, only 11.2% benign marker-bearing rows; test acc\|marker 0.719 vs 0.890 absent | `63613b5`, `ml/phase1_diagnosis.json` |
| Phase 2 dataset v3 | 384 grounded frames, 10,008 samples; 1,248 benign-marker actions, 300 negation minimal pairs, 480 confusable rows; per-marker conditional forced to exactly 0.50; p99=32 | `072c393`, `c455ca7`, G1 10/10, G2 6/6 |
| Frozen-head retrain | Held-out recovered but adversarial still failed (negation 0.111, confusable 0.375): capacity limit diagnosed, not a data limit | `3b38beb` |
| Option 2 adaptation | Unfroze backbone blocks 20–21 at 2e-5, heads at 1e-3; 5 epochs, best val macro-F1 0.9949 | `8eea63a`, `e3dba91` |
| Verification | **All G3 gates pass**; Phase 4 runtime green (tsc 0, lint 0, 44 + 3/3) | this report §2 |

Two process failures are recorded honestly: (a) the top-up loop first balanced the
contrastive subset instead of the full corpus — caught by G1.9; (b) `finalize_l2.py`
once retained a stale passing latency report — now always writes with a pass flag.
Both were fixed fail-closed, never waived.

## 2. Final scorecard (INT8 @32 unless noted)

| Metric | 40-frame baseline | Frozen v3 | Final (unfrozen v3) | Gate |
|---|---|---:|---:|---|
| `should_speak` held-out | 0.9934 | 0.9819 | 0.9970 (0.9728 INT8) | 0.90 ✅ |
| `is_destructive` held-out | 0.9079 | 0.8498 | **0.9889** (0.9758 INT8) | 0.90 ✅ |
| `barge_in` held-out | 0.9224 | 0.9214 | 0.9990 (0.9909 INT8) | 0.85 ✅ |
| `stuck_in_loop` held-out | 0.9934 | 0.9899 | 1.0000 (0.9960 INT8) | 0.85 ✅ |
| Negation FP | 0.500 | 0.111 | **0.056** | ≤0.10 ✅ |
| Confusable error | 0.250 | 0.375 | **0.000** | ≤0.15 ✅ |
| Adversarial core pass | 0.628 | 0.718 | **0.872** | ≥0.80 ✅ |
| Parity max diff | 3.53e-05 | 4.63e-05 | 5.67e-05 | <1e-4 ✅ |
| Latency p50 @32 | 23.98 ms | 23.51 ms | **24.86 ms** (p99=32) | <40 ✅ |

## 3. Vulnerability matrix V1–V11

| ID | Status | Evidence |
|---|---|---|
| V1 marker detector | **Resolved** — per-marker conditional 0.50; 884 marker-free positives | G1.1/G1.9 |
| V2 split leakage | **Resolved** — group-aware splits, 0 cross-split frames, fills w/o replacement | G1.4 |
| V3 label leakage | **Resolved** — max \|φ\| with `should_speak` 0.0103 | G1.5 |
| V4 wrong markers | **Resolved** — `ديبلوي` removed; benign keyword cases in suite | G2 |
| V5 loop hygiene | **Resolved** — asserted 0 markerless | G1.1 |
| V6 negation | **Resolved** — FP 0.500→0.056 via 300 minimal pairs | G3.2 |
| V7 OOD phrasing | **Covered** — 78-case gold suite, core 0.872 | G3.2 |
| V8 confusables | **Resolved** — error 0.250→0.000 via capacity + 480 training rows | G3.2 |
| V9 truncation | **Open** — rows past 32 tokens truncate; p99=32 holds | backlog |
| V10 ASR realism | **Open** — text-only evaluation stands | backlog |
| V11 miss monitoring | **Open** — destructive-head misses unmonitored at runtime | backlog |

## 4. Systemic solutions inventory

- **Contrastive data pipeline** (`ml/data/generate_synth.py`): adaptive per-marker
  top-up, negation minimal pairs sharing barge/loop rolls, confusable pairs in
  training, claim-based global uniqueness, token-aware render with capped overflow,
  fail-closed hygiene/correlation/split/space/budget assertions.
- **Gate verifiers** (`ml/verify_g1.py` 10 gates, `ml/verify_g2.py` symmetric overlap).
- **Training discipline** (`ml/train_laya.py`): CPU-only assert, remap hard-abort,
  differential LRs, fail-closed block discovery, full tunable-state checkpoints,
  shared `load_trained_laya()` for export and parity.
- **Evidence discipline**: reports always written even on gate failure, with pass flags.

## 5. Future roadmap

1. **Benign-marker hardening** — weakest adversarial category (0.56 core). More benign
   marker-bearing actions + hard-negative mining from real usage.
2. **Student distillation for sub-20 ms** — distil the adapted teacher into a 20–60M
   student; INT8 student should clear 40 ms with headroom and quantize gracefully.
3. **Multi-layer / LoRA domain specialization** — if new intents arrive, prefer LoRA
   adapters over full unfreezing to protect general representations.
4. **Streaming voice-pipeline hooks** — connect `LayaSpeechAdvisor` scores to the
   barge-in path (`18` §18.2) with measured end-to-end budgets.
5. **ASR-noise robustness** — STT-error augmentation + disfluency in training; evaluate
   on real transcripts (closes V10).
6. **Miss monitoring** — log destructive-head score bands (never raw transcripts beyond
   the ledger contract) so false negatives become observable (closes V11).
7. **Operating-length policy** — re-measure if corpus p99 ever exceeds 32 tokens
   (closes V9).

*End of synthesis report. Companion tracker `ml/MISSION_P0_WORKFLOW.md` deleted at sign-off.*
