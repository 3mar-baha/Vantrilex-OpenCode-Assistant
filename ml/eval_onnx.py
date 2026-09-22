#!/usr/bin/env python3
"""Evaluate FP32 vs INT8 ONNX on the held-out test split (per-head acc/F1).

Quantization is only trustworthy if the accuracy drop vs FP32 is within the
declared budget; this measures it rather than assuming it. CPU-only.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import yaml
from sklearn.metrics import accuracy_score, f1_score
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))

HEADS = ["should_speak", "is_destructive", "barge_in", "stuck_in_loop"]
GATES = {"should_speak": 0.90, "is_destructive": 0.90, "barge_in": 0.85, "stuck_in_loop": 0.85}


def pad(tok, text, length):
    ids = tok.encode(text).ids[:length]
    mask = [1] * len(ids)
    while len(ids) < length:
        ids.append(0)
        mask.append(0)
    return np.asarray(ids, dtype=np.int64)[None, :], np.asarray(mask, dtype=np.int64)[None, :]


def evaluate(session, tok, rows, length):
    labels = np.array([[1 if r["labels"][h] else 0 for h in HEADS] for r in rows])
    preds = np.zeros_like(labels)
    for i, row in enumerate(rows):
        ids, mask = pad(tok, row["text"], length)
        logits = session.run(None, {"input_ids": ids, "attention_mask": mask})
        for j in range(4):
            preds[i, j] = 1 if float(np.asarray(logits[j]).reshape(-1)[0]) > 0 else 0
    out = {}
    for j, h in enumerate(HEADS):
        out[h] = {
            "acc": float(accuracy_score(labels[:, j], preds[:, j])),
            "f1": float(f1_score(labels[:, j], preds[:, j], zero_division=0)),
            "gate": GATES[h],
        }
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    tok = Tokenizer.from_file(
        "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
        "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
    )
    rows = [
        json.loads(line)
        for line in (root / cfg["data"]["test"]).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    sessions = {
        "fp32": ort.InferenceSession(str(root / "models/laya-m7.onnx"), providers=["CPUExecutionProvider"]),
        "int8": ort.InferenceSession(str(root / "models/laya-m7-int8.onnx"), providers=["CPUExecutionProvider"]),
    }
    report = {}
    for length in (32, 128):
        for name, session in sessions.items():
            res = evaluate(session, tok, rows, length)
            report[f"{name}@{length}"] = res
            print(f"--- {name} len={length} (n={len(rows)}) ---")
            for h in HEADS:
                r = res[h]
                verdict = "PASS" if r["acc"] >= r["gate"] else "FAIL"
                print(f"  {h}: acc={r['acc']:.4f} f1={r['f1']:.4f} gate={r['gate']} {verdict}")
    (root / "ml" / "quant_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("wrote ml/quant_report.json")


if __name__ == "__main__":
    main()