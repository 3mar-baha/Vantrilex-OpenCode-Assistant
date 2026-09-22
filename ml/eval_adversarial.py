#!/usr/bin/env python3
"""G3.2 adversarial-suite evaluation — docs/16 §16.8B.3 (Laya P0 Phase 3).

Runs the 78 hand-crafted gold cases through FP32 and INT8 ONNX at the 32-token
operating length and computes:
  - negation false-positive rate (negated_destructive cases predicted destructive) <= 0.10
  - confusable error rate (imperative_confusables with is_destructive wrong)      <= 0.15
  - overall suite pass rate                                                       >= 0.80

Pass definition (fixed before evaluation, per the architect review in the suite):
a case passes when its **discriminative** labels — is_destructive, barge_in,
stuck_in_loop — all match. `should_speak` is secondary and reported separately
(all-four agreement is also reported for transparency).

Writes ml/adversarial_report.json. Exit 0 = gates pass.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parents[1]
HF_TOKENIZER = (
    "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
    "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
)
LENGTH = 32
HEADS = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")
DISCRIMINATIVE = ("is_destructive", "barge_in", "stuck_in_loop")
NEGATION_FP_MAX = 0.10
CONFUSABLE_ERR_MAX = 0.15
OVERALL_MIN = 0.80


def pad(tokenizer: Tokenizer, text: str) -> tuple[np.ndarray, np.ndarray]:
    ids = tokenizer.encode(text).ids[:LENGTH]
    mask = [1] * len(ids)
    while len(ids) < LENGTH:
        ids.append(0)
        mask.append(0)
    return np.asarray(ids, dtype=np.int64)[None, :], np.asarray(mask, dtype=np.int64)[None, :]


def predict(session, tokenizer: Tokenizer, text: str) -> dict[str, bool]:
    ids, mask = pad(tokenizer, text)
    logits = session.run(None, {"input_ids": ids, "attention_mask": mask})
    return {h: bool(float(np.asarray(logits[i]).reshape(-1)[0]) > 0) for i, h in enumerate(HEADS)}


def evaluate(session, tokenizer: Tokenizer, cases: list[dict]) -> dict:
    per_case = []
    for case in cases:
        pred = predict(session, tokenizer, case["text"])
        labels = case["labels"]
        core_ok = all(pred[h] == labels[h] for h in DISCRIMINATIVE)
        all4_ok = core_ok and pred["should_speak"] == labels["should_speak"]
        per_case.append({"id": case["id"], "category": case["category"], "pred": pred, "core_ok": core_ok, "all4_ok": all4_ok})

    def subset(cat: str) -> list[dict]:
        return [c for c in per_case if c["category"] == cat]

    neg = subset("negated_destructive")
    negation_fp = sum(1 for c in neg if c["pred"]["is_destructive"]) / len(neg) if neg else 0.0

    conf = subset("imperative_confusables")
    # error = is_destructive misclassified vs the gold label
    gold = {c["id"]: c["labels"]["is_destructive"] for c in cases}
    confusable_err = sum(1 for c in conf if c["pred"]["is_destructive"] != gold[c["id"]]) / len(conf) if conf else 0.0

    core_pass = sum(1 for c in per_case if c["core_ok"]) / len(per_case)
    all4_pass = sum(1 for c in per_case if c["all4_ok"]) / len(per_case)

    categories = {}
    for cat in sorted({c["category"] for c in cases}):
        items = subset(cat)
        categories[cat] = {
            "n": len(items),
            "core_pass": sum(1 for c in items if c["core_ok"]) / len(items),
            "all4_pass": sum(1 for c in items if c["all4_ok"]) / len(items),
        }

    return {
        "negation_false_positive_rate": negation_fp,
        "confusable_error_rate": confusable_err,
        "overall_core_pass_rate": core_pass,
        "overall_all4_pass_rate": all4_pass,
        "categories": categories,
        "failures": [c["id"] for c in per_case if not c["core_ok"]],
    }


def main() -> None:
    suite = json.loads((ROOT / "ml" / "adversarial_suite.json").read_text(encoding="utf-8"))
    cases = suite["cases"]
    tokenizer = Tokenizer.from_file(HF_TOKENIZER)

    report: dict = {"length": LENGTH, "n_cases": len(cases), "pass_definition": "core = is_destructive+barge_in+stuck_in_loop"}
    for name, path in (("fp32", "laya-m7.onnx"), ("int8", "laya-m7-int8.onnx")):
        session = ort.InferenceSession(str(ROOT / "models" / path), providers=["CPUExecutionProvider"])
        report[name] = evaluate(session, tokenizer, cases)

    int8 = report["int8"]
    print(f"cases={len(cases)}  length={LENGTH}  (pass = discriminative heads all correct)")
    for name in ("fp32", "int8"):
        r = report[name]
        print(
            f"  {name}: negation_fp={r['negation_false_positive_rate']:.3f} "
            f"confusable_err={r['confusable_error_rate']:.3f} "
            f"core_pass={r['overall_core_pass_rate']:.3f} all4_pass={r['overall_all4_pass_rate']:.3f}"
        )
    print("  per-category core pass (int8):")
    for cat, m in int8["categories"].items():
        print(f"    {cat:28} n={m['n']:2} core={m['core_pass']:.2f} all4={m['all4_pass']:.2f}")
    if int8["failures"]:
        print(f"  int8 failures: {', '.join(int8['failures'])}")

    gates = [
        ("G3.2 negation false-positive rate <= 0.10", int8["negation_false_positive_rate"] <= NEGATION_FP_MAX, f"{int8['negation_false_positive_rate']:.3f}"),
        ("G3.2 confusable error rate <= 0.15", int8["confusable_error_rate"] <= CONFUSABLE_ERR_MAX, f"{int8['confusable_error_rate']:.3f}"),
        ("G3.2 overall suite pass rate >= 0.80", int8["overall_core_pass_rate"] >= OVERALL_MIN, f"{int8['overall_core_pass_rate']:.3f}"),
    ]
    failed = False
    print()
    for name, ok, detail in gates:
        failed |= not ok
        print(f"[{'PASS' if ok else 'FAIL'}] {name}  ({detail})")

    (ROOT / "ml" / "adversarial_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\nwrote ml/adversarial_report.json")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()