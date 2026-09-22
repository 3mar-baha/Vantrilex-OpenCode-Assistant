#!/usr/bin/env python3
"""Score head probabilities for the integration-test phrases on FP32 vs INT8."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))

HF = (
    "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
    "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
)
HEADS = ["should_speak", "is_destructive", "barge_in", "stuck_in_loop"]

PHRASES = [
    "التيستات شغالة، ما في جديد",
    "امسح الداتابيز كلها",
    "وقف اللي بتعمله، في مشكلة",
    "خلص البيلد، كله أخضر",
    "امسح كل شي",
    "احذف الداتابيز",
    "اعمل drop للجدول",
]


def pad(tok, text, length):
    ids = tok.encode(text).ids[:length]
    mask = [1] * len(ids)
    while len(ids) < length:
        ids.append(0)
        mask.append(0)
    return np.asarray(ids, dtype=np.int64)[None, :], np.asarray(mask, dtype=np.int64)[None, :]


def main() -> None:
    tok = Tokenizer.from_file(HF)
    fp32 = ort.InferenceSession("models/laya-m7.onnx", providers=["CPUExecutionProvider"])
    int8 = ort.InferenceSession("models/laya-m7-int8.onnx", providers=["CPUExecutionProvider"])
    for length in (128, 32):
        print(f"=== pad length {length} ===")
        for text in PHRASES:
            ids, mask = pad(tok, text, length)
            row = []
            for name, sess in (("fp32", fp32), ("int8", int8)):
                logits = sess.run(None, {"input_ids": ids, "attention_mask": mask})
                probs = [1 / (1 + np.exp(-float(np.asarray(logits[i]).reshape(-1)[0]))) for i in range(4)]
                row.append((name, probs))
            print(f"{text}")
            for name, probs in row:
                pretty = " ".join(f"{h}={p:.3f}" for h, p in zip(HEADS, probs))
                print(f"  {name}: {pretty}")


if __name__ == "__main__":
    main()