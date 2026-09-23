#!/usr/bin/env python3
"""Phase 1 shortcut diagnosis — docs/16 §16.8B context, MISSION_P0_WORKFLOW.md.

Measures, on the committed corpus + INT8 model:
  1. Corpus conditionals: P(is_destructive|marker) per marker, PMI(marker; label).
  2. Model conditionals on the held-out test split: accuracy given marker
     present vs absent; FP rate on marker-bearing benign rows; FN rate on
     marker-free destructive rows; negated-subset accuracy.
  3. Per-frame is_destructive accuracy distribution (worst frames).

Writes ml/phase1_diagnosis.json. CPU-only; asserts no CUDA use.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import torch

assert not torch.cuda.is_available(), "CPU-only invariant violated"

ROOT = Path(__file__).resolve().parents[1]
TRAIN = ROOT / "ml" / "data" / "splits" / "train.jsonl"
TEST = ROOT / "ml" / "data" / "splits" / "test.jsonl"
META = ROOT / "ml" / "data" / "synth_meta.json"
MODEL = ROOT / "models" / "laya-m7-int8.onnx"
HF_TOKENIZER = (
    ROOT / ".hf_cache" / "hub" /
    "models--convaiinnovations--laya-multilingual" /
    "snapshots" / "052592a15d198d9ad47da779604259b10b47b7aa" /
    "tokenizer" / "tokenizer.json"
)
LENGTH = 32
NEGATIONS = ("لا", "ما", "مش", "مو", "بلاش", "دير بالك")


def load_rows(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def has_marker(text: str, markers: list[str]) -> list[str]:
    return [m for m in markers if m in text]


def is_negated(text: str) -> bool:
    return any(n in text for n in NEGATIONS)


def main() -> None:
    meta = json.loads(META.read_text(encoding="utf-8"))
    markers: list[str] = meta["destructive_markers"]
    train = load_rows(TRAIN)
    test = load_rows(TEST)

    # ---- 1. Corpus conditionals (train) ----
    n = len(train)
    n_d = sum(1 for r in train if r["labels"]["is_destructive"])
    p_d = n_d / n
    corpus_markers = {}
    for m in markers:
        with_m = [r for r in train if m in r["text"]]
        d_with = sum(1 for r in with_m if r["labels"]["is_destructive"])
        p_m = len(with_m) / n
        p_d_given_m = (d_with / len(with_m)) if with_m else 0.0
        pmi = math.log((d_with / n) / (p_m * p_d)) if d_with and p_m and p_d else 0.0
        corpus_markers[m] = {
            "n_with": len(with_m),
            "p_marker": round(p_m, 4),
            "p_destructive_given_marker": round(p_d_given_m, 4),
            "pmi": round(pmi, 4),
        }
    no_marker = [r for r in train if not has_marker(r["text"], markers)]
    p_d_given_no_m = sum(1 for r in no_marker if r["labels"]["is_destructive"]) / max(len(no_marker), 1)
    benign_with_marker = sum(
        1 for r in train if has_marker(r["text"], markers) and not r["labels"]["is_destructive"]
    )
    marker_bearing = sum(1 for r in train if has_marker(r["text"], markers))

    # ---- 2/3. Model conditionals on test ----
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(HF_TOKENIZER))
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])

    def predict_destructive(text: str) -> bool:
        ids = tokenizer.encode(text).ids[:LENGTH]
        mask = [1] * len(ids)
        while len(ids) < LENGTH:
            ids.append(0)
            mask.append(0)
        arr_ids = np.asarray(ids, dtype=np.int64)[None, :]
        arr_mask = np.asarray(mask, dtype=np.int64)[None, :]
        logits = session.run(None, {"input_ids": arr_ids, "attention_mask": arr_mask})
        return bool(float(np.asarray(logits[1]).reshape(-1)[0]) > 0)

    buckets: dict[str, list[bool]] = {
        "all": [], "marker": [], "no_marker": [],
        "marker_benign": [], "markerfree_destructive": [], "negated": [],
    }
    frame_hits: dict[str, list[int]] = {}
    for r in test:
        text = r["text"]
        gold = bool(r["labels"]["is_destructive"])
        pred = predict_destructive(text)
        ok = pred == gold
        buckets["all"].append(ok)
        ms = has_marker(text, markers)
        (buckets["marker"] if ms else buckets["no_marker"]).append(ok)
        if ms and not gold:
            buckets["marker_benign"].append(ok)
        if not ms and gold:
            buckets["markerfree_destructive"].append(ok)
        if is_negated(text):
            buckets["negated"].append(ok)
        frame_hits.setdefault(r.get("frame", "unknown"), []).append(int(ok))

    def rate(xs: list[bool]) -> float:
        return sum(xs) / len(xs) if xs else 0.0

    model_conditionals = {
        "n_test": len(test),
        "acc_all": round(rate(buckets["all"]), 4),
        "acc_given_marker": round(rate(buckets["marker"]), 4),
        "n_marker": len(buckets["marker"]),
        "acc_given_no_marker": round(rate(buckets["no_marker"]), 4),
        "n_no_marker": len(buckets["no_marker"]),
        "acc_marker_bearing_benign": round(rate(buckets["marker_benign"]), 4),
        "n_marker_benign": len(buckets["marker_benign"]),
        "acc_markerfree_destructive": round(rate(buckets["markerfree_destructive"]), 4),
        "n_markerfree_destructive": len(buckets["markerfree_destructive"]),
        "acc_negated": round(rate(buckets["negated"]), 4),
        "n_negated": len(buckets["negated"]),
    }
    per_frame = {
        f: {"n": len(v), "acc": round(sum(v) / len(v), 4)}
        for f, v in sorted(frame_hits.items())
    }
    worst_frames = sorted(per_frame.items(), key=lambda kv: (kv[1]["acc"], kv[1]["n"]))[:10]

    report = {
        "model": "laya-m7-int8.onnx",
        "length": LENGTH,
        "corpus_train": {
            "n": n,
            "p_destructive": round(p_d, 4),
            "p_destructive_given_no_marker": round(p_d_given_no_m, 4),
            "benign_marker_bearing_share": round(benign_with_marker / max(marker_bearing, 1), 4),
            "per_marker": corpus_markers,
        },
        "model_test_conditionals": model_conditionals,
        "per_frame_acc": per_frame,
        "worst_frames": [{"frame": f, **m} for f, m in worst_frames],
    }
    (ROOT / "ml" / "phase1_diagnosis.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"train n={n} P(destr)={p_d:.3f} P(destr|no marker)={p_d_given_no_m:.3f}")
    print(f"benign share of marker-bearing train rows: {benign_with_marker}/{marker_bearing}")
    for m, s in corpus_markers.items():
        print(f"  marker {m!r}: n={s['n_with']} P(d|m)={s['p_destructive_given_marker']:.3f} PMI={s['pmi']:.3f}")
    mc = model_conditionals
    print(f"test acc={mc['acc_all']:.3f} |marker={mc['acc_given_marker']:.3f} (n={mc['n_marker']}) "
          f"|no-marker={mc['acc_given_no_marker']:.3f} (n={mc['n_no_marker']})")
    print(f"marker-bearing benign acc={mc['acc_marker_bearing_benign']:.3f} "
          f"(n={mc['n_marker_benign']})")
    print(f"marker-free destructive acc={mc['acc_markerfree_destructive']:.3f} "
          f"(n={mc['n_markerfree_destructive']})")
    print(f"negated acc={mc['acc_negated']:.3f} (n={mc['n_negated']})")
    print("worst frames:", [(f, m["acc"]) for f, m in worst_frames[:5]])
    print("wrote ml/phase1_diagnosis.json")


if __name__ == "__main__":
    main()
