#!/usr/bin/env python3
"""M7 L2.3: ONNX Runtime CPU latency probe. Gate: p50 < 40 ms per forward pass.

500 iterations over real test sentences, intra_op_num_threads = core count.
"""
from __future__ import annotations

import json
import os
import statistics
import time
from pathlib import Path

import numpy as np
import yaml

MODEL_CANDIDATES = ["models/laya-m7-int8.onnx", "models/laya-m7.onnx"]


def main() -> None:
    import onnxruntime as ort
    from transformers import AutoTokenizer

    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    model_path = next((root / c for c in MODEL_CANDIDATES if (root / c).exists()), None)
    if model_path is None:
        raise SystemExit("no ONNX model found — run export first")

    threads = training["num_threads"] or (os.cpu_count() or 4)
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])

    tokenizer = AutoTokenizer.from_pretrained(training["model_id"], trust_remote_code=True)
    rows = [json.loads(line) for line in (root / cfg["data"]["test"]).read_text(encoding="utf-8").splitlines() if line.strip()]
    texts = [r["text"] for r in rows[:500]]

    # Warmup (excluded).
    for text in texts[:10]:
        enc = tokenizer(text, truncation=True, padding="max_length", max_length=training["max_length"], return_tensors="np")
        session.run(None, {"input_ids": enc["input_ids"].astype(np.int64), "attention_mask": enc["attention_mask"].astype(np.int64)})

    samples: list[float] = []
    for text in texts:
        enc = tokenizer(text, truncation=True, padding="max_length", max_length=training["max_length"], return_tensors="np")
        started = time.perf_counter()
        session.run(None, {"input_ids": enc["input_ids"].astype(np.int64), "attention_mask": enc["attention_mask"].astype(np.int64)})
        samples.append((time.perf_counter() - started) * 1000.0)

    ordered = sorted(samples)
    p50 = ordered[len(ordered) // 2]
    p99 = ordered[int(len(ordered) * 0.99)]
    print(f"model={model_path.name} threads={threads} n={len(samples)}")
    print(f"p50={p50:.2f}ms p99={p99:.2f}ms mean={statistics.mean(samples):.2f}ms")
    if p50 >= 40.0:
        raise SystemExit(f"latency gate FAILED: p50 {p50:.2f}ms >= 40ms")
    print("latency gate PASS")


if __name__ == "__main__":
    main()
