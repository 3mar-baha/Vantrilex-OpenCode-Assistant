#!/usr/bin/env python3
"""Per-head held-out metrics for the report: accuracy, precision, recall, F1 and
mean BCE log-loss, for FP32 vs INT8 at the 32-token operating length. Writes
ml/head_metrics.json. CPU-only.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import yaml
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))

HEADS = ["should_speak", "is_destructive", "barge_in", "stuck_in_loop"]
LENGTH = 32


def pad(tok, text, length):
    ids = tok.encode(text).ids[:length]
    mask = [1] * len(ids)
    while len(ids) < length:
        ids.append(0)
        mask.append(0)
    return np.asarray(ids, dtype=np.int64)[None, :], np.asarray(mask, dtype=np.int64)[None, :]


def logits_for(session, tok, rows):
    out = np.zeros((len(rows), len(HEADS)), dtype=np.float64)
    for i, row in enumerate(rows):
        ids, mask = pad(tok, row["text"], LENGTH)
        res = session.run(None, {"input_ids": ids, "attention_mask": mask})
        for j in range(len(HEADS)):
            out[i, j] = float(np.asarray(res[j]).reshape(-1)[0])
    return out


def bce(logits, labels):
    p = 1.0 / (1.0 + np.exp(-logits))
    eps = 1e-12
    p = np.clip(p, eps, 1 - eps)
    return float(-(labels * np.log(p) + (1 - labels) * np.log(1 - p)).mean())


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    tok = Tokenizer.from_file(
        "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
        "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
    )
    rows = [
        json.loads(line)
        for line in (root / cfg["data"]["test"]).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    labels = np.array([[1 if r["labels"][h] else 0 for h in HEADS] for r in rows], dtype=np.float64)
    report = {}
    for name, path in (("fp32", "laya-m7.onnx"), ("int8", "laya-m7-int8.onnx")):
        session = ort.InferenceSession(str(root / "models" / path), providers=["CPUExecutionProvider"])
        logits = logits_for(session, tok, rows)
        preds = (logits > 0).astype(np.int64)
        per_head = {}
        for j, h in enumerate(HEADS):
            y, p = labels[:, j], preds[:, j]
            per_head[h] = {
                "acc": float(accuracy_score(y, p)),
                "precision": float(precision_score(y, p, zero_division=0)),
                "recall": float(recall_score(y, p, zero_division=0)),
                "f1": float(f1_score(y, p, zero_division=0)),
                "logloss": bce(logits[:, j], y),
                "positives": int(y.sum()),
                "support": int(len(y)),
            }
        per_head["_macro"] = {
            "acc": float(np.mean([per_head[h]["acc"] for h in HEADS])),
            "f1": float(np.mean([per_head[h]["f1"] for h in HEADS])),
            "logloss": float(np.mean([per_head[h]["logloss"] for h in HEADS])),
        }
        report[name] = per_head
        print(f"--- {name} (n={len(rows)}, len={LENGTH}) ---")
        for h in HEADS:
            r = per_head[h]
            print(
                f"  {h:>14}: acc={r['acc']:.4f} P={r['precision']:.4f} R={r['recall']:.4f} "
                f"F1={r['f1']:.4f} logloss={r['logloss']:.4f}"
            )
        m = per_head["_macro"]
        print(f"  {'macro':>14}: acc={m['acc']:.4f} F1={m['f1']:.4f} logloss={m['logloss']:.4f}")
    (root / "ml" / "head_metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("wrote ml/head_metrics.json")


if __name__ == "__main__":
    main()