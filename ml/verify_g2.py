#!/usr/bin/env python3
"""G2 exit-gate verifier — docs/16 §16.8B.2 (Laya P0 Phase 2).

Asserts the adversarial gold suite: schema, composition thresholds, category
distribution, confusable-pair count, zero overlap with the training corpus, and
a signed architect review. Exit 0 = pass.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "ml" / "adversarial_suite.json"
TRAIN = ROOT / "ml" / "data" / "splits" / "train.jsonl"

TOTAL_MIN, TOTAL_MAX = 50, 100
CATEGORY_MIN = {
    "negated_destructive": 15,
    "imperative_confusables": 10,
    "marker_free_destructive": 15,
    "benign_keyword_inclusions": 15,
    "barge_loop_edge": 10,
}
MIN_CONFUSABLE_PAIRS = 8
LABELS = ("should_speak", "is_destructive", "barge_in", "stuck_in_loop")
DIACRITICS = re.compile(r"[\u064b-\u0652\u0640]")


def norm(text: str) -> str:
    text = DIACRITICS.sub("", text.strip().lower())
    text = re.sub(r"[^\w\s\u0600-\u06ff]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def main() -> None:
    suite = json.loads(SUITE.read_text(encoding="utf-8"))
    cases = suite["cases"]
    results: list[tuple[str, bool, str]] = []

    # Schema
    schema_errors = []
    for c in cases:
        if not isinstance(c.get("text"), str) or not c["text"].strip():
            schema_errors.append(f"{c.get('id')}: bad text")
        labels = c.get("labels")
        if not isinstance(labels, dict) or set(labels) != set(LABELS) or not all(
            isinstance(v, bool) for v in labels.values()
        ):
            schema_errors.append(f"{c.get('id')}: bad labels")
        if c.get("category") not in CATEGORY_MIN:
            schema_errors.append(f"{c.get('id')}: bad category")
        if not isinstance(c.get("rationale"), str) or not c["rationale"].strip():
            schema_errors.append(f"{c.get('id')}: missing rationale")
    results.append(("G2.2 schema valid", not schema_errors, "; ".join(schema_errors) or "all cases valid"))

    # Composition
    total_ok = TOTAL_MIN <= len(cases) <= TOTAL_MAX
    results.append((f"G2.1 total cases in [{TOTAL_MIN}, {TOTAL_MAX}]", total_ok, f"total={len(cases)}"))

    counts: dict[str, int] = {}
    for c in cases:
        counts[c["category"]] = counts.get(c["category"], 0) + 1
    dist = ", ".join(f"{k}={counts.get(k, 0)}" for k in CATEGORY_MIN)
    cat_ok = all(counts.get(k, 0) >= v for k, v in CATEGORY_MIN.items())
    results.append(("G2.1 per-category minimums", cat_ok, dist))

    pairs = {c["pair"] for c in cases if c.get("category") == "imperative_confusables" and c.get("pair")}
    pair_ok = len(pairs) >= MIN_CONFUSABLE_PAIRS
    results.append((f"G2.1 confusable pairs >= {MIN_CONFUSABLE_PAIRS}", pair_ok, f"pairs={len(pairs)}"))

    # Zero overlap with the training corpus
    train_texts = [
        norm(json.loads(line)["text"]) for line in TRAIN.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    train_set = set(train_texts)
    exact = [c["id"] for c in cases if norm(c["text"]) in train_set]
    contained = [
        c["id"]
        for c in cases
        if any(norm(c["text"]) in t and norm(c["text"]) != t for t in train_texts)
    ]
    overlap_ok = not exact and not contained
    detail = f"exact={len(exact)} contained={len(contained)}"
    if not overlap_ok:
        detail += f" | exact_ids={exact} contained_ids={contained}"
    results.append(("G2.3 zero overlap with training corpus", overlap_ok, detail))

    # Architect review
    review = suite.get("review", {})
    review_ok = review.get("verdict") in ("APPROVED", "APPROVE", "APPROVE WITH NITS") and review.get(
        "overlap_with_training", ""
    ).startswith("zero")
    results.append(("G2.3 architect sign-off", review_ok, f"verdict={review.get('verdict')} overlap={review.get('overlap_with_training')}"))

    width = max(len(name) for name, _, _ in results)
    failed = False
    for name, ok, detail in results:
        status = "PASS" if ok else "FAIL"
        failed |= not ok
        print(f"[{status}] {name.ljust(width)}  {detail}")
    print(f"\nG2 {'PASS' if not failed else 'FAIL'} — {sum(1 for _, ok, _ in results if ok)}/{len(results)} gates")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()