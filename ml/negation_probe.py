#!/usr/bin/env python3
"""Negation / false-positive probe: does a destructive marker survive negation?

A marker-driven head will fire on "لا تحذف" (do not delete) because the marker
"احذف" is present. This measures FP32 vs INT8 at the 32-token operating length.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

HF = (
    "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
    "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
)
PHRASES = [
    "ما تمسح شي",            # don't erase anything
    "لا تحذف الداتابيز",      # do not delete the database
    "ما تعمل ديبلوي",         # don't deploy
    "مش وقتها force-push",   # not the time to force-push
    "لا تسوي drop للجدول",    # don't drop the table
    "اسمع، لا تمسح شي",       # listen, don't erase anything
]


def pad(tok, text, n=32):
    ids = tok.encode(text).ids[:n]
    mask = [1] * len(ids)
    while len(ids) < n:
        ids.append(0)
        mask.append(0)
    return np.asarray(ids, dtype=np.int64)[None, :], np.asarray(mask, dtype=np.int64)[None, :]


def main() -> None:
    tok = Tokenizer.from_file(HF)
    sess = {
        "fp32": ort.InferenceSession("models/laya-m7.onnx", providers=["CPUExecutionProvider"]),
        "int8": ort.InferenceSession("models/laya-m7-int8.onnx", providers=["CPUExecutionProvider"]),
    }
    out = []
    for text in PHRASES:
        ids, mask = pad(tok, text)
        row = {"text": text}
        for name, s in sess.items():
            lg = s.run(None, {"input_ids": ids, "attention_mask": mask})[1]
            row[name] = float(1 / (1 + np.exp(-float(np.asarray(lg).reshape(-1)[0]))))
        out.append(row)
        print(f"{text}: fp32_destructive={row['fp32']:.3f} int8_destructive={row['int8']:.3f}")
    Path("ml/negation_report.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()