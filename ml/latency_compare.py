#!/usr/bin/env python3
"""Latency comparison FP32 vs INT8 at the 32-token operating length (p50/p99)."""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import yaml
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))

LENGTH = 32


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    threads = training["num_threads"] or (os.cpu_count() or 4)
    tok = Tokenizer.from_file(
        "O:/opencode-Vantrilex/.hf_cache/hub/models--convaiinnovations--laya-multilingual/"
        "snapshots/052592a15d198d9ad47da779604259b10b47b7aa/tokenizer/tokenizer.json"
    )
    rows = [
        json.loads(line)
        for line in (root / cfg["data"]["test"]).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    def pad(text):
        ids = tok.encode(text).ids[:LENGTH]
        mask = [1] * len(ids)
        while len(ids) < LENGTH:
            ids.append(0)
            mask.append(0)
        return np.asarray(ids, dtype=np.int64)[None, :], np.asarray(mask, dtype=np.int64)[None, :]

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    out = {}
    for name, path in (("fp32", "laya-m7.onnx"), ("int8", "laya-m7-int8.onnx")):
        session = ort.InferenceSession(str(root / "models" / path), sess_options=options, providers=["CPUExecutionProvider"])
        for row in rows[:10]:
            ids, mask = pad(row["text"])
            session.run(None, {"input_ids": ids, "attention_mask": mask})
        samples = []
        for row in rows:
            ids, mask = pad(row["text"])
            started = time.perf_counter()
            session.run(None, {"input_ids": ids, "attention_mask": mask})
            samples.append((time.perf_counter() - started) * 1000.0)
        ordered = sorted(samples)
        out[name] = {
            "p50": ordered[len(ordered) // 2],
            "p99": ordered[int(len(ordered) * 0.99)],
            "mean": statistics.mean(samples),
        }
        print(f"{name} len={LENGTH}: p50={out[name]['p50']:.2f}ms p99={out[name]['p99']:.2f}ms mean={out[name]['mean']:.2f}ms")
    (root / "ml" / "latency_compare.json").write_text(json.dumps(out, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()