---
name: Laya ML gates
description: The CPU-only train→export→parity→latency→quantization gate workflow for the Laya System-1 heads, including data hygiene and the "measure, never assume" rule. Use for any ml/ work on training, ONNX export, quantization, or evaluation.
---

# Laya ML gates

The `ml/` pipeline produces the advisory System-1 heads (docs/09 ADR-008). Every
stage has a gate; a stage is not done until its gate passes and its evidence file
is written.

## Invariants (non-negotiable)

- **CPU-only.** Every entry point asserts `torch.cuda.is_available()` is `False`.
  The reference GTX 750 Ti is deliberately unused. Never add a CUDA path.
- **No silent random init.** Backbone weights load through
  `ml/laya_hub.load_backbone`, which remaps the root checkpoint's `encoder.*`
  keys and hard-aborts on any missing key. Never call
  `AutoModel.from_pretrained` on the raw `encoder/` directory directly.
- **Seeded and reproducible.** Data and training are seeded (`--seed`, config
  `seed`). Report the seed with any number you publish.
- **Measure, never assume.** Quantization/accuracy trade-offs are measured on the
  held-out split, not asserted. If a gate fails, report the failure; do not
  restate the target as if it were the result.

## Pipeline and gates

| Stage | Command | Gate | Evidence |
|-------|---------|------|----------|
| Data | `ml/data/generate_synth.py` | every head ≥ 20% minority; every true label has a surface marker | `ml/data/synth_meta.json` |
| Train | `ml/train_laya.py` | held-out acc ≥ 0.90 (primary), ≥ 0.85 (secondary) | `ml/eval_report.md` |
| Export | `ml/export_onnx.py` | dynamic batch+seq dims; remap 0 missing | model sizes |
| Parity | `ml/finalize_l2.py` | max logit diff < 1e-4 vs torch | `ml/l2_report.json` |
| Latency | `ml/finalize_l2.py` | p50 < 40 ms at the operating length | `ml/l2_report.json` |
| Quant accuracy | `ml/eval_onnx.py`, `ml/head_metrics.py` | every head still clears its gate after INT8 | `ml/quant_report.json`, `ml/head_metrics.json` |

## Operating length

The corpus p99 is 32 tokens and masked mean pooling makes logits invariant to pad
length, so the runtime uses `LAYA_OPERATING_LENGTH = 32`. FP32 misses the 40 ms
budget (~58 ms); INT8 is load-bearing. Do not raise the operating length without
re-measuring latency.

## Data hygiene

- Labels must be deterministic from the surface; a true flag with no visible cue
  is unlearnable noise.
- Split by template/frame, not by row, or near-duplicates leak across splits and
  inflate every metric. Treat a random-shuffle split as an upper bound only.
- Prefer measuring per-head accuracy, precision, recall, F1 **and** log-loss;
  a lone accuracy number hides class-imbalance and boundary shifts.

## Evidence discipline

Every published number must trace to a committed artifact under `ml/`. If a claim
cannot be reproduced from a committed script + artifact, do not publish it.
