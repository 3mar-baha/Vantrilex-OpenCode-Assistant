# Laya P0 Mission Workflow — 17abae6 to production

Lifecycle note: temporary operational tracker. Delete this file at final
sign-off after the master report is published. It is not canonical docs.

Baseline: `17abae6`.
Evidence: `ml/eval_report.md:3-6`, `ml/quant_report.json:24-44`,
`ml/l2_report.json:2-11`, `ml/adversarial_report.json:68-98`,
`ml/data/synth_meta.json:2-16`.

Findings: held-out FP32 passes; INT8 `is_destructive` 0.8645 FAIL;
adversarial negation FP 0.50, confusable 0.3125, core 0.628 FAIL;
benign-marker 0.375 worst; latency 23.98ms @32 PASS.

Autonomy protocol: execute all steps inside a phase without micro-prompts.
Pause for user authorization ONLY at phase boundaries P1→P2→P3→P4→P5.

## Phase 1 — Diagnose and redesign data

Objective: prove shortcut mechanism; specify contrastive fix.
Agent: `laya-ml-engineer`.
Skills/tools: `laya-ml-gates`, `pyright`, native.
Inputs: `17abae6` reports, `ml/data/splits/*.jsonl`, `ml/adversarial_suite.json`.
Actions:
- Compute P(label|marker), marker PMI, per-template error.
- Define contrastive quotas: per marker balanced destructive/benign;
  negation minimal pairs; confusable pairs in training, not only eval.
Exit gates:
- Diagnosis artifact with measured conditional rates.
- Approved data spec: quotas, pair format, provenance tags.

## Phase 2 — Dataset v3 + G1

Objective: rebuild corpus with shortcut removed, length preserved.
Agent: `laya-ml-engineer`.
Skills/tools: `laya-ml-gates`, `pyright`, native.
Inputs: Phase 1 data + suite hashes.
Actions:
- Regenerate corpus per Phase 1 spec; keep group-aware splits.
- Run `verify_g1.py`, `verify_g2.py`.
Exit gates:
- G1 8/8 incl. p99 ≤32; G2 overlap zero both directions.

## Phase 3 — Retrain, quantize, evaluate

Objective: restore generalization without losing latency.
Agent: `laya-ml-engineer`.
Skills/tools: `laya-ml-gates`, `pyright`, `context7` for API questions.
Inputs: frozen Phase 2 data + suite hashes.
Actions:
- CPU-only retrain; export FP32/INT8 dynamic; parity; latency @32;
  adversarial eval; per-head threshold/temperature calibration;
  static/calibrated INT8 if dynamic INT8 still fails destructive gate.
Exit gates:
- G3.1 held-out pass; G3.3 parity <1e-4; G3.4 p50 <40ms @32.
- G3.2 negation FP ≤0.10, confusable ≤0.15, core ≥0.80.
- G3.5 all INT8 head gates pass with reported delta.

## Phase 4 — Runtime integration and verification

Objective: ship model behind advisory-only bridge with tests.
Agents: primary implements, `ts-reviewer` reviews.
Skills/tools: `vitest-live-gating`, `typescript-esm-strict`,
`typescript-language-server`, native.
Inputs: Phase 3 models + reports.
Actions:
- Update `src/runtime/laya/` only if labels/tokenizer/length change.
- Extend live test for negation/benign-marker separation.
- Run tsc, eslint, hermetic vitest, `LAYA_LIVE=1`.
Exit gates:
- tsc 0, lint 0, hermetic green, live 3/3 green, reviewer APPROVE.

## Phase 5 — Governance, report, cleanup

Objective: publish truthful close-out and remove tracker.
Agent: `architect`.
Skills/tools: native.
Inputs: all Phase 3-4 artifacts.
Actions:
- Update ADR-008, §10.7 ledger, evaluation roadmap vuln statuses.
- Write master synthesis report; commit/push as `3mar-baha`.
- Delete this tracker file at sign-off.
Exit gates:
- Every scoped vuln has status + evidence pointer; tree clean; pushed.
