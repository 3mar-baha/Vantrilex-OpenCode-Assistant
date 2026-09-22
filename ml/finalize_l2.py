#!/usr/bin/env python3
"""M7 L2 finalize: ONNX parity gate + CPU latency probe over sequence lengths.

Parity: torch (remapped backbone + trained heads) vs FP32 ONNX, gate < 1e-4.
Latency: INT8 ONNX with ORT_ENABLE_ALL, swept across pad lengths. Masked mean
pooling makes logits invariant to pad length, so the smallest length that fits
the corpus is the correct operating point. CPU-only throughout.
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import torch
import yaml
from tokenizers import Tokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from laya_hub import load_backbone, stage_snapshot  # noqa: E402
from train_laya import HEADS, LayaHeads  # noqa: E402

PARITY_SAMPLES = 50
SWEEP_LENGTHS = (128, 64, 32, 24)
GATE_MS = 40.0


def pad(tokenizer: Tokenizer, text: str, length: int) -> tuple[np.ndarray, np.ndarray]:
    ids = tokenizer.encode(text).ids[:length]
    mask = [1] * len(ids)
    while len(ids) < length:
        ids.append(0)
        mask.append(0)
    return (
        np.asarray(ids, dtype=np.int64)[None, :],
        np.asarray(mask, dtype=np.int64)[None, :],
    )


def main() -> None:
    import onnxruntime as ort

    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    max_length = training["max_length"]
    threads = training["num_threads"] or (os.cpu_count() or 4)
    torch.set_num_threads(threads)

    fp32_path = root / "models" / "laya-m7.onnx"
    int8_path = root / "models" / "laya-m7-int8.onnx"
    for path in (fp32_path, int8_path):
        if not path.exists():
            raise SystemExit(f"missing {path} — run export_onnx.py first")

    snapshot = stage_snapshot(training["model_id"])
    tokenizer = Tokenizer.from_file(str(snapshot / "tokenizer" / "tokenizer.json"))

    rows = [
        json.loads(line)
        for line in (root / cfg["data"]["test"]).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    # ---- Parity gate (torch vs FP32 ONNX) ------------------------------------
    backbone = load_backbone(training["model_id"])
    model = LayaHeads(backbone, backbone.config.hidden_size)
    checkpoint = torch.load(
        root / cfg["output"]["dir"] / "best.pt", map_location="cpu", weights_only=True
    )
    for h in HEADS:
        model.heads[h].load_state_dict(checkpoint["heads"][h])
    model.eval()

    fp32 = ort.InferenceSession(str(fp32_path), providers=["CPUExecutionProvider"])
    max_diff = 0.0
    for row in rows[:PARITY_SAMPLES]:
        ids, mask = pad(tokenizer, row["text"], max_length)
        with torch.no_grad():
            torch_logits = np.stack(
                [model(torch.from_numpy(ids), torch.from_numpy(mask))[h].numpy() for h in HEADS],
                axis=1,
            )
        ort_logits = np.stack(
            fp32.run(None, {"input_ids": ids, "attention_mask": mask}), axis=1
        )
        max_diff = max(max_diff, float(np.abs(torch_logits - ort_logits).max()))
    print(f"parity max_diff={max_diff:.2e}")
    assert max_diff < 1e-4, "ONNX parity gate FAILED"

    # ---- Latency sweep on INT8 -----------------------------------------------
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    int8 = ort.InferenceSession(str(int8_path), sess_options=options, providers=["CPUExecutionProvider"])

    token_counts = [len(tokenizer.encode(r["text"]).ids) for r in rows]
    p99_tokens = int(np.percentile(token_counts, 99))
    print(f"token length: max={max(token_counts)} p99={p99_tokens} n={len(rows)}")

    results: dict[str, dict[str, float]] = {}
    for length in SWEEP_LENGTHS:
        for row in rows[:10]:
            ids, mask = pad(tokenizer, row["text"], length)
            int8.run(None, {"input_ids": ids, "attention_mask": mask})
        samples: list[float] = []
        for row in rows:
            ids, mask = pad(tokenizer, row["text"], length)
            started = time.perf_counter()
            int8.run(None, {"input_ids": ids, "attention_mask": mask})
            samples.append((time.perf_counter() - started) * 1000.0)
        ordered = sorted(samples)
        p50 = ordered[len(ordered) // 2]
        p99 = ordered[int(len(ordered) * 0.99)]
        results[str(length)] = {"p50": p50, "p99": p99, "mean": statistics.mean(samples)}
        print(f"len={length:>3} p50={p50:6.2f}ms p99={p99:7.2f}ms mean={statistics.mean(samples):6.2f}ms")

    # Operating point: smallest swept length that fits p99 of real token counts.
    operating = next((length for length in sorted(SWEEP_LENGTHS) if length >= p99_tokens), max(SWEEP_LENGTHS))
    gate_p50 = results[str(operating)]["p50"]
    print(f"operating length={operating} (covers p99={p99_tokens} tokens) p50={gate_p50:.2f}ms")
    if gate_p50 >= GATE_MS:
        raise SystemExit(f"latency gate FAILED: p50 {gate_p50:.2f}ms >= {GATE_MS}ms at length {operating}")
    print("latency gate PASS")

    report = {
        "parity_max_diff": max_diff,
        "parity_samples": PARITY_SAMPLES,
        "threads": threads,
        "token_length": {"max": max(token_counts), "p99": p99_tokens},
        "operating_length": operating,
        "gate_ms": GATE_MS,
        "sweep": results,
        "model": int8_path.name,
    }
    (root / "ml" / "l2_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("wrote ml/l2_report.json")


if __name__ == "__main__":
    main()