#!/usr/bin/env python3
"""M7 L2: export the trained Laya heads model to ONNX (FP32 + INT8).

Backbone weights come from `laya_hub.load_backbone` (encoder-prefixed remap with
a hard abort on any missing key) — never a silently random-initialized encoder.
Both batch and sequence dimensions are dynamic so the runtime may pad shorter.
Parity + latency gates live in `finalize_l2.py`. CPU-only throughout.
"""
from __future__ import annotations

import sys
from pathlib import Path

import torch
import yaml
from onnxruntime.quantization import QuantType, quantize_dynamic

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_laya import HEADS, LayaHeads, load_trained_laya  # noqa: E402


class _Wrapper(torch.nn.Module):
    def __init__(self, model: LayaHeads):
        super().__init__()
        self.model = model

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor):
        logits = self.model(input_ids, attention_mask)
        return tuple(logits[h] for h in HEADS)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = yaml.safe_load((root / "ml" / "training_config.yaml").read_text(encoding="utf-8"))
    training = cfg["training"]
    torch.set_num_threads(training["num_threads"] or 4)

    model = load_trained_laya(root, training, cfg["output"])
    model.eval()

    models_dir = root / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    fp32_path = models_dir / "laya-m7.onnx"
    seq_len = training["max_length"]
    dummy_ids = torch.ones(1, seq_len, dtype=torch.long)
    dummy_mask = torch.ones(1, seq_len, dtype=torch.long)
    torch.onnx.export(
        _Wrapper(model),
        (dummy_ids, dummy_mask),
        str(fp32_path),
        input_names=["input_ids", "attention_mask"],
        output_names=[f"logit_{h}" for h in HEADS],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
        },
        opset_version=17,
    )
    print(f"exported {fp32_path} ({fp32_path.stat().st_size / 1e6:.1f} MB)")

    int8_path = models_dir / "laya-m7-int8.onnx"
    if int8_path.exists():
        int8_path.unlink()
    quantize_dynamic(str(fp32_path), str(int8_path), weight_type=QuantType.QInt8)
    print(f"exported {int8_path} ({int8_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()